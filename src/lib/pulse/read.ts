import { BatchGetCommand, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';

import { readSessionState } from '@/lib/pulse/lease';
import { dynamo, keys, pulseTable } from '@/lib/pulse/table';
import {
  PULSE_SYMBOLS,
  pulseBarSchema,
  pulseQuoteSchema,
  pulseStatsSchema,
  type PulseBar,
  type PulseQuote,
  type PulseStats,
  type SessionState,
} from '@/lib/pulse/types';

// Read model for the dashboard tile: everything one poll needs in a
// single payload. Reads go straight to DynamoDB (no cache layer) - a
// polling viewer costs a handful of on-demand reads per tick, which is
// the cost model this table's key design optimizes for.

export interface PulseSnapshot {
  session: SessionState | null;
  quotes: PulseQuote[];
  /** most-recent-first bars per symbol */
  bars: Record<string, PulseBar[]>;
  stats: PulseStats | null;
}

const BARS_PER_SYMBOL = 30;

export async function readPulseSnapshot(): Promise<PulseSnapshot> {
  const [session, quotesResult, statsResult, ...barResults] = await Promise.all([
    readSessionState(),
    dynamo.send(
      new BatchGetCommand({
        RequestItems: {
          [pulseTable()]: { Keys: PULSE_SYMBOLS.map((symbol) => keys.latest(symbol)) },
        },
      }),
    ),
    dynamo.send(new GetCommand({ TableName: pulseTable(), Key: keys.stats() })),
    ...PULSE_SYMBOLS.map((symbol) =>
      dynamo.send(
        new QueryCommand({
          TableName: pulseTable(),
          KeyConditionExpression: 'pk = :pk AND begins_with(sk, :bar)',
          ExpressionAttributeValues: { ':pk': `SYM#${symbol}`, ':bar': 'BAR#' },
          ScanIndexForward: false,
          Limit: BARS_PER_SYMBOL,
        }),
      ),
    ),
  ]);

  const quotes = (quotesResult.Responses?.[pulseTable()] ?? [])
    .map((item) =>
      pulseQuoteSchema.parse({
        symbol: item.symbol,
        price: item.price,
        exchangeTs: item.exchangeTs,
        ingestTs: item.ingestTs,
        updatedAt: item.updatedAt,
      }),
    )
    .sort((a, b) => a.symbol.localeCompare(b.symbol));

  const bars: Record<string, PulseBar[]> = {};
  PULSE_SYMBOLS.forEach((symbol, index) => {
    bars[symbol] = (barResults[index].Items ?? []).map((item) =>
      pulseBarSchema.parse({
        symbol: item.symbol,
        minuteTs: item.minuteTs,
        open: item.open,
        openTs: item.openTs,
        high: item.high,
        low: item.low,
        close: item.close,
        closeTs: item.closeTs,
        volume: item.volume,
        count: item.count,
      }),
    );
  });

  const stats = statsResult.Item
    ? pulseStatsSchema.parse({
        windowEndTs: statsResult.Item.windowEndTs,
        eventsPerSec: statsResult.Item.eventsPerSec,
        pipelineP50Ms: statsResult.Item.pipelineP50Ms,
        pipelineP99Ms: statsResult.Item.pipelineP99Ms,
        sourceP50Ms: statsResult.Item.sourceP50Ms,
        sampleCount: statsResult.Item.sampleCount,
      })
    : null;

  return { session, quotes, bars, stats };
}
