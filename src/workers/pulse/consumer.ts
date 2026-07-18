// PortfolioPulse consumer: folds Kinesis batches into 1-minute OHLCV bars,
// latest quotes, and pipeline latency stats in DynamoDB.
//
// Delivery is at-least-once, so correctness rests on two layers:
// 1. Order-insensitive merges (lib/pulse/bars.ts) make prices immune to
//    replays and reordering outright.
// 2. A per-shard sequence-number checkpoint, committed atomically WITH the
//    bar writes in one TransactWriteItems, filters replayed records so
//    volume/count are applied exactly once per consumer-side delivery.
//    (The one hole is a producer-side PutRecords retry whose "failure"
//    actually landed: that duplicate has a fresh sequence number and is
//    indistinguishable from a real event - bounded, rare, and documented
//    rather than hidden.)
//
// Single-writer invariant: partition key = symbol and parallelization
// factor 1 mean exactly one in-flight invocation per shard, and a symbol
// never spans shards, so read-merge-write needs no locking.
import type { KinesisStreamEvent } from 'aws-lambda';

import { BatchGetCommand, GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';

import { foldEvents, mergeBars, percentile } from '@/lib/pulse/bars';
import { dynamo, keys, pulseTable } from '@/lib/pulse/table';
import { pulseBarSchema, pulseRecordSchema, type PulseBar, type PulseEvent } from '@/lib/pulse/types';

const BAR_TTL_SECONDS = 48 * 60 * 60;
const STATS_TTL_SECONDS = 60 * 60;

// Kinesis sequence numbers are huge decimal strings; stored zero-padded to
// fixed width so DynamoDB's lexical string comparison in the checkpoint
// condition is exactly numeric comparison (unpadded, "99" > "100").
const SEQ_WIDTH = 64;

function padSeq(seq: bigint): string {
  return seq.toString().padStart(SEQ_WIDTH, '0');
}

export interface ConsumerRecord {
  sequenceNumber: string;
  data: string; // base64
}

async function readCheckpoint(shardId: string): Promise<bigint | null> {
  const result = await dynamo.send(
    new GetCommand({ TableName: pulseTable(), Key: keys.checkpoint(shardId) }),
  );
  const lastSeq = result.Item?.lastSeq;
  return typeof lastSeq === 'string' ? BigInt(lastSeq) : null;
}

async function readExistingBars(barKeys: Map<string, PulseBar>): Promise<Map<string, PulseBar>> {
  const existing = new Map<string, PulseBar>();
  const requestKeys = [...barKeys.values()].map((bar) => keys.bar(bar.symbol, bar.minuteTs));
  if (requestKeys.length === 0) return existing;
  const result = await dynamo.send(
    new BatchGetCommand({
      RequestItems: { [pulseTable()]: { Keys: requestKeys } },
    }),
  );
  for (const item of result.Responses?.[pulseTable()] ?? []) {
    const bar = pulseBarSchema.parse({
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
    });
    existing.set(`${bar.symbol}|${bar.minuteTs}`, bar);
  }
  return existing;
}

export async function processShardBatch(shardId: string, records: ConsumerRecord[]): Promise<{
  applied: number;
  skipped: number;
}> {
  const checkpoint = await readCheckpoint(shardId);

  const fresh: { seq: bigint; events: PulseEvent[] }[] = [];
  let skipped = 0;
  for (const record of records) {
    const seq = BigInt(record.sequenceNumber);
    if (checkpoint !== null && seq <= checkpoint) {
      skipped += 1;
      continue;
    }
    const envelope = pulseRecordSchema.parse(
      JSON.parse(Buffer.from(record.data, 'base64').toString('utf8')),
    );
    fresh.push({ seq, events: envelope.events });
  }
  if (fresh.length === 0) return { applied: 0, skipped };

  const now = Date.now();
  const events = fresh.flatMap((record) => record.events);
  const { bars, quotes } = foldEvents(events, now);
  const existing = await readExistingBars(bars);

  const merged = new Map<string, PulseBar>();
  for (const [key, partial] of bars) {
    const prior = existing.get(key);
    merged.set(key, prior ? mergeBars(prior, partial) : partial);
  }

  // Pipeline latency: our clock end to end (ingest stamp -> this write).
  const latencies = events.map((event) => Math.max(0, now - event.ingestTs)).sort((a, b) => a - b);
  const sourceLatencies = events
    .map((event) => event.ingestTs - event.exchangeTs)
    .sort((a, b) => a - b);
  const spanMs = Math.max(
    1_000,
    Math.max(...events.map((e) => e.ingestTs)) - Math.min(...events.map((e) => e.ingestTs)),
  );

  const maxSeq = fresh.reduce((max, record) => (record.seq > max ? record.seq : max), fresh[0].seq);
  const nowSeconds = Math.floor(now / 1000);

  await dynamo.send(
    new TransactWriteCommand({
      TransactItems: [
        ...[...merged.values()].map((bar) => ({
          Put: {
            TableName: pulseTable(),
            Item: {
              ...keys.bar(bar.symbol, bar.minuteTs),
              ...bar,
              expiresAt: nowSeconds + BAR_TTL_SECONDS,
            },
          },
        })),
        ...[...quotes.values()].map((quote) => ({
          Put: {
            TableName: pulseTable(),
            Item: { ...keys.latest(quote.symbol), ...quote },
          },
        })),
        {
          Put: {
            TableName: pulseTable(),
            Item: {
              ...keys.stats(),
              windowEndTs: now,
              eventsPerSec: events.length / (spanMs / 1000),
              pipelineP50Ms: percentile(latencies, 50),
              pipelineP99Ms: percentile(latencies, 99),
              sourceP50Ms: percentile(sourceLatencies, 50),
              sampleCount: events.length,
              expiresAt: nowSeconds + STATS_TTL_SECONDS,
            },
          },
        },
        {
          // The checkpoint rides in the same transaction as the data it
          // covers: either both commit or neither, which is what turns
          // at-least-once delivery into exactly-once application here.
          Put: {
            TableName: pulseTable(),
            Item: { ...keys.checkpoint(shardId), lastSeq: padSeq(maxSeq) },
            ConditionExpression: 'attribute_not_exists(pk) OR lastSeq < :seq',
            ExpressionAttributeValues: { ':seq': padSeq(maxSeq) },
          },
        },
      ],
    }),
  );

  return { applied: fresh.length, skipped };
}

export async function handler(event: KinesisStreamEvent): Promise<void> {
  const byShard = new Map<string, ConsumerRecord[]>();
  for (const record of event.Records) {
    const shardId = record.eventID.split(':')[0];
    const list = byShard.get(shardId);
    const entry = { sequenceNumber: record.kinesis.sequenceNumber, data: record.kinesis.data };
    if (list) list.push(entry);
    else byShard.set(shardId, [entry]);
  }
  for (const [shardId, records] of byShard) {
    const { applied, skipped } = await processShardBatch(shardId, records);
    console.log(`[pulse-consumer] ${shardId}: applied ${applied}, skipped ${skipped}`);
  }
}
