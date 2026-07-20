import {
  CreateTableCommand,
  ResourceInUseException,
  UpdateTimeToLiveCommand,
} from '@aws-sdk/client-dynamodb';

import { dynamo } from '@/lib/dynamo';

// Single-table layout for PortfolioPulse. One on-demand table holds market
// data and coordination state; the generic pk/sk scheme keeps hot items
// (LATEST quotes, the session lease) on their own partitions:
//
//   pk                 sk               item
//   SYM#<symbol>       LATEST           latest quote (PulseQuote)
//   SYM#<symbol>       BAR#<isoMinute>  1-min OHLCV bar (+expiresAt TTL)
//   SESSION            STATE            ingest lease + status (SessionState)
//   SESSION            VIEWERS          viewer keepalive {lastSeenAt} (+TTL)
//   SHARD#<shardId>    CHECKPOINT       consumer's last applied sequence number
//   STATS              LATEST           rolling pipeline stats (+TTL)
//
// BAR sort keys are ISO timestamps so a Query with begins_with(sk, 'BAR#')
// returns bars in time order.

// The document client is shared app-wide (lib/dynamo.ts); this module
// keeps the pulse table's name, key layout, and local provisioning.
export { dynamo } from '@/lib/dynamo';

export function pulseTable(): string {
  return process.env.PULSE_TABLE ?? 'pulse';
}

export interface PulseKey {
  pk: string;
  sk: string;
}

export const keys = {
  latest: (symbol: string): PulseKey => ({ pk: `SYM#${symbol}`, sk: 'LATEST' }),
  bar: (symbol: string, minuteTs: number): PulseKey => ({
    pk: `SYM#${symbol}`,
    sk: `BAR#${new Date(minuteTs).toISOString()}`,
  }),
  sessionState: (): PulseKey => ({ pk: 'SESSION', sk: 'STATE' }),
  viewers: (): PulseKey => ({ pk: 'SESSION', sk: 'VIEWERS' }),
  checkpoint: (shardId: string): PulseKey => ({ pk: `SHARD#${shardId}`, sk: 'CHECKPOINT' }),
  stats: (): PulseKey => ({ pk: 'STATS', sk: 'LATEST' }),
};

// On real AWS the table is provisioned by Terraform and callers have no
// CreateTable permission; this only runs against LocalStack (mirrors
// ensureLocalBucket in wealthsim/storage.ts).
export async function ensureLocalPulseTable(): Promise<void> {
  if (!process.env.DYNAMODB_ENDPOINT) return;
  try {
    await dynamo.send(
      new CreateTableCommand({
        TableName: pulseTable(),
        BillingMode: 'PAY_PER_REQUEST',
        AttributeDefinitions: [
          { AttributeName: 'pk', AttributeType: 'S' },
          { AttributeName: 'sk', AttributeType: 'S' },
        ],
        KeySchema: [
          { AttributeName: 'pk', KeyType: 'HASH' },
          { AttributeName: 'sk', KeyType: 'RANGE' },
        ],
      }),
    );
    await dynamo.send(
      new UpdateTimeToLiveCommand({
        TableName: pulseTable(),
        TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: true },
      }),
    );
  } catch (error) {
    if (error instanceof ResourceInUseException) return;
    throw error;
  }
}
