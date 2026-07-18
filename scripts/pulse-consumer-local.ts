// Poll-loop stand-in for the Kinesis event source mapping, for local dev
// against the compose emulators (the pulse counterpart of `pnpm worker`):
//
//   DYNAMODB_ENDPOINT=http://localhost:8000 KINESIS_ENDPOINT=http://localhost:4568 \
//   AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test \
//   pnpm exec tsx scripts/pulse-consumer-local.ts
//
// Resumes after the persisted per-shard checkpoint like the real mapping
// would. PULSE_CONSUMER_ONCE=1 drains and exits (for scripted E2E);
// PULSE_CONSUMER_FROM_START=1 re-reads from TRIM_HORIZON, which is how
// the dedupe replay proof exercises the checkpoint filter.
import {
  GetRecordsCommand,
  GetShardIteratorCommand,
  ListShardsCommand,
} from '@aws-sdk/client-kinesis';
import { GetCommand } from '@aws-sdk/lib-dynamodb';

import { kinesis, pulseStreamName } from '@/lib/pulse/stream';
import { dynamo, ensureLocalPulseTable, keys, pulseTable } from '@/lib/pulse/table';
import { processShardBatch, type ConsumerRecord } from '@/workers/pulse/consumer';

const once = process.env.PULSE_CONSUMER_ONCE === '1';
const fromStart = process.env.PULSE_CONSUMER_FROM_START === '1';

async function shardIterator(shardId: string): Promise<string | undefined> {
  if (!fromStart) {
    const checkpoint = await dynamo.send(
      new GetCommand({ TableName: pulseTable(), Key: keys.checkpoint(shardId) }),
    );
    const lastSeq = checkpoint.Item?.lastSeq;
    if (typeof lastSeq === 'string') {
      const result = await kinesis.send(
        new GetShardIteratorCommand({
          StreamName: pulseStreamName(),
          ShardId: shardId,
          ShardIteratorType: 'AFTER_SEQUENCE_NUMBER',
          StartingSequenceNumber: BigInt(lastSeq).toString(),
        }),
      );
      return result.ShardIterator;
    }
  }
  const result = await kinesis.send(
    new GetShardIteratorCommand({
      StreamName: pulseStreamName(),
      ShardId: shardId,
      ShardIteratorType: 'TRIM_HORIZON',
    }),
  );
  return result.ShardIterator;
}

async function main() {
  await ensureLocalPulseTable();
  const shards = await kinesis.send(new ListShardsCommand({ StreamName: pulseStreamName() }));
  const iterators = new Map<string, string>();
  for (const shard of shards.Shards ?? []) {
    const iterator = await shardIterator(shard.ShardId!);
    if (iterator) iterators.set(shard.ShardId!, iterator);
  }
  console.log(`[pulse-consumer-local] polling ${iterators.size} shard(s)`);

  let totalApplied = 0;
  let totalSkipped = 0;
  for (;;) {
    let sawRecords = false;
    let caughtUp = true;
    for (const [shardId, iterator] of iterators) {
      const result = await kinesis.send(new GetRecordsCommand({ ShardIterator: iterator }));
      if (result.NextShardIterator) iterators.set(shardId, result.NextShardIterator);
      if ((result.MillisBehindLatest ?? 0) > 0) caughtUp = false;
      const records: ConsumerRecord[] = (result.Records ?? []).map((record) => ({
        sequenceNumber: record.SequenceNumber!,
        data: Buffer.from(record.Data!).toString('base64'),
      }));
      if (records.length === 0) continue;
      sawRecords = true;
      const { applied, skipped } = await processShardBatch(shardId, records);
      totalApplied += applied;
      totalSkipped += skipped;
      console.log(`${shardId}: applied ${applied}, skipped ${skipped}`);
    }
    if (once && !sawRecords && caughtUp) break;
    if (!sawRecords) await new Promise((resolve) => setTimeout(resolve, 500));
  }
  console.log(`[pulse-consumer-local] done: applied ${totalApplied}, skipped ${totalSkipped}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
