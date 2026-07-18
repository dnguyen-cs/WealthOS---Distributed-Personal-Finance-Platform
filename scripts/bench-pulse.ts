// PortfolioPulse benchmarks against REAL AWS. Same env contract as
// bench-aws.ts: deliberately no dotenv (emulator endpoints and dummy
// creds must never leak into a real-AWS run); credentials come from the
// CLI profile. The synthetic producer runs here on the host and writes
// straight to Kinesis, so ingest-Lambda limits are not part of what is
// measured - this benchmarks the stream, the mapping, and the consumer.
//
//   AWS_REGION=us-east-1 MODE=latency pnpm exec tsx scripts/bench-pulse.ts
//   MODE=latency     steady rates, sampling the consumer's stats item;
//                    then re-checks one rate with the batching window at 0s
//   MODE=throughput  30s max-rate bursts to find the per-shard PutRecords
//                    ceiling at 1/10/100 events packed per record
//   MODE=drain       builds a backlog with the mapping disabled, re-enables,
//                    measures catch-up from the stats item
//   MODE=cleanup     waits for the consumer to go quiet, deletes bench
//                    items, and invokes the janitor back to $0 idle
//
// Run in that order: latency first, so its samples never sit behind a
// throughput-mode backlog. Results append to bench-results/pulse.jsonl.
// Latency caveat: synthetic events stamp ingestTs with THIS host's clock,
// so pipeline latencies include the host-vs-AWS clock offset (bounded
// with w32tm against time.aws.com and noted alongside the results).
import { appendFileSync, mkdirSync } from 'node:fs';

import {
  DescribeStreamSummaryCommand,
  PutRecordsCommand,
  ResourceNotFoundException,
} from '@aws-sdk/client-kinesis';
import {
  InvokeCommand,
  LambdaClient,
  ListEventSourceMappingsCommand,
  UpdateEventSourceMappingCommand,
} from '@aws-sdk/client-lambda';
import { DeleteCommand, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';

import { ensureConsumerMapping, ensureStreamActive, kinesis, pulseStreamName } from '@/lib/pulse/stream';
import { dynamo, keys, pulseTable } from '@/lib/pulse/table';
import type { PulseEvent } from '@/lib/pulse/types';

if (process.env.KINESIS_ENDPOINT || process.env.DYNAMODB_ENDPOINT) {
  throw new Error('endpoint overrides are set; this script targets real AWS only');
}

const MODE = process.env.MODE ?? 'latency';
const RESULTS = 'bench-results/pulse.jsonl';
const BENCH_SYMBOL = 'BENCH-USD';

const lambda = new LambdaClient({ region: process.env.AWS_REGION ?? 'us-east-1' });

function consumerFunction(): string {
  return process.env.PULSE_CONSUMER_FUNCTION ?? 'pulse-consumer';
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function record(entry: Record<string, unknown>) {
  mkdirSync('bench-results', { recursive: true });
  appendFileSync(RESULTS, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`);
}

function makeEvent(): PulseEvent {
  const now = Date.now();
  return {
    symbol: BENCH_SYMBOL,
    price: 100 + Math.random() * 10,
    size: Math.random(),
    exchangeTs: now,
    ingestTs: now,
  };
}

function packRecords(eventsPerRecord: number, recordCount: number) {
  return Array.from({ length: recordCount }, () => ({
    PartitionKey: BENCH_SYMBOL,
    Data: Buffer.from(
      JSON.stringify({ events: Array.from({ length: eventsPerRecord }, makeEvent) }),
    ),
  }));
}

interface PutStats {
  accepted: number;
  throttled: number;
  bytes: number;
  calls: number;
}

function newPutStats(): PutStats {
  return { accepted: 0, throttled: 0, bytes: 0, calls: 0 };
}

/** One PutRecords call; throttled entries are counted, not retried - the
 *  whole point of throughput mode is to find the rejection ceiling. */
async function putOnce(records: { PartitionKey: string; Data: Buffer }[], stats: PutStats) {
  const result = await kinesis.send(
    new PutRecordsCommand({ StreamName: pulseStreamName(), Records: records }),
  );
  stats.calls += 1;
  result.Records?.forEach((entry, index) => {
    if (entry.ErrorCode) {
      stats.throttled += 1;
    } else {
      stats.accepted += 1;
      stats.bytes += records[index].Data.length;
    }
  });
}

async function readStats() {
  const result = await dynamo.send(
    new GetCommand({ TableName: pulseTable(), Key: keys.stats() }),
  );
  return result.Item ?? null;
}

/** Wait until the consumer stops writing stats windows: either it has no
 *  backlog left or there is nothing flowing at all. */
async function quiesceConsumer(quietMs = 15_000, timeoutMs = 15 * 60_000): Promise<void> {
  const started = Date.now();
  let lastWindow = -1;
  let lastChange = Date.now();
  for (;;) {
    const item = await readStats();
    const window = typeof item?.windowEndTs === 'number' ? item.windowEndTs : 0;
    if (window !== lastWindow) {
      lastWindow = window;
      lastChange = Date.now();
    } else if (Date.now() - lastChange >= quietMs) {
      return;
    }
    if (Date.now() - started > timeoutMs) throw new Error('consumer did not quiesce');
    await sleep(3_000);
  }
}

/** Probe until the consumer is live AND current: a fresh stats window with
 *  a small pipeline p50 means the ESM warmup is over and any TRIM_HORIZON
 *  backlog from earlier activity has been chewed through. */
async function settleConsumer(timeoutMs = 10 * 60_000): Promise<void> {
  const started = Date.now();
  for (;;) {
    await putOnce(packRecords(1, 1), newPutStats());
    await sleep(2_000);
    const item = await readStats();
    if (
      item &&
      typeof item.windowEndTs === 'number' &&
      item.windowEndTs > started &&
      (item.pipelineP50Ms as number) < 3_000
    ) {
      return;
    }
    if (Date.now() - started > timeoutMs) throw new Error('consumer did not settle');
  }
}

async function getMapping() {
  const mappings = await lambda.send(
    new ListEventSourceMappingsCommand({ FunctionName: consumerFunction() }),
  );
  const mapping = (mappings.EventSourceMappings ?? [])[0];
  if (!mapping?.UUID) throw new Error('no event source mapping on the consumer');
  return mapping;
}

/** Enabling/Disabling/Updating are async; wait for the state to settle. */
async function awaitMappingState(target: 'Enabled' | 'Disabled'): Promise<void> {
  for (let i = 0; i < 60; i++) {
    if ((await getMapping()).State === target) return;
    await sleep(2_000);
  }
  throw new Error(`mapping did not reach ${target}`);
}

async function setMappingEnabled(enabled: boolean): Promise<void> {
  const mapping = await getMapping();
  await lambda.send(new UpdateEventSourceMappingCommand({ UUID: mapping.UUID, Enabled: enabled }));
  await awaitMappingState(enabled ? 'Enabled' : 'Disabled');
}

async function setBatchWindow(seconds: number): Promise<void> {
  const mapping = await getMapping();
  await lambda.send(
    new UpdateEventSourceMappingCommand({
      UUID: mapping.UUID,
      MaximumBatchingWindowInSeconds: seconds,
    }),
  );
  await awaitMappingState('Enabled');
}

async function throughputMode() {
  await ensureStreamActive();
  console.log('MODE=throughput: 30s max-rate bursts per packing level, 1 shard');
  for (const eventsPerRecord of [1, 10, 100]) {
    const stats = newPutStats();
    const started = Date.now();
    // Two concurrent senders keep the pipe full without local CPU binding.
    const runFor = 30_000;
    await Promise.all(
      [0, 1].map(async () => {
        while (Date.now() - started < runFor) {
          await putOnce(packRecords(eventsPerRecord, 250), stats);
        }
      }),
    );
    const seconds = (Date.now() - started) / 1000;
    const entry = {
      mode: 'throughput',
      eventsPerRecord,
      seconds: Number(seconds.toFixed(1)),
      acceptedRecordsPerSec: Math.round(stats.accepted / seconds),
      acceptedEventsPerSec: Math.round((stats.accepted * eventsPerRecord) / seconds),
      throttledRecords: stats.throttled,
      throttleRate: Number((stats.throttled / (stats.accepted + stats.throttled)).toFixed(3)),
      mbPerSec: Number((stats.bytes / seconds / 1e6).toFixed(2)),
      putCalls: stats.calls,
    };
    record(entry);
    console.log(
      `pack=${String(eventsPerRecord).padStart(3)}: ` +
        `${entry.acceptedRecordsPerSec} rec/s accepted = ${entry.acceptedEventsPerSec} ev/s, ` +
        `${entry.mbPerSec} MB/s, throttled ${(entry.throttleRate * 100).toFixed(1)}%`,
    );
    await sleep(5_000); // let the shard cool
  }
}

async function runLatencyLevel(eventsPerSec: number, batchWindowSeconds: number) {
  const eventsPerRecord = Math.max(1, Math.min(100, Math.round(eventsPerSec / 50)));
  const recordsPerTick = Math.max(1, Math.round(eventsPerSec / eventsPerRecord / 5));
  const samples: { p50: number; p99: number }[] = [];
  const put = newPutStats();
  const started = Date.now();
  let producerSeconds = 60;
  const producer = (async () => {
    while (Date.now() - started < 60_000) {
      const tickStart = Date.now();
      await putOnce(packRecords(eventsPerRecord, recordsPerTick), put);
      const elapsed = Date.now() - tickStart;
      if (elapsed < 200) await sleep(200 - elapsed);
    }
    producerSeconds = (Date.now() - started) / 1000;
  })();
  const sampler = (async () => {
    let lastWindow = 0;
    while (Date.now() - started < 64_000) {
      await sleep(2_000);
      const item = await readStats();
      if (
        item &&
        typeof item.windowEndTs === 'number' &&
        item.windowEndTs > started &&
        item.windowEndTs !== lastWindow
      ) {
        lastWindow = item.windowEndTs;
        samples.push({ p50: item.pipelineP50Ms as number, p99: item.pipelineP99Ms as number });
      }
    }
  })();
  await Promise.all([producer, sampler]);
  const median = (values: number[]) => values[Math.floor(values.length / 2)] ?? 0;
  const p50s = samples.map((s) => s.p50).sort((a, b) => a - b);
  const p99s = samples.map((s) => s.p99).sort((a, b) => a - b);
  const entry = {
    mode: 'latency',
    targetEventsPerSec: eventsPerSec,
    achievedEventsPerSec: Math.round((put.accepted * eventsPerRecord) / producerSeconds),
    eventsPerRecord,
    batchWindowSeconds,
    batches: samples.length,
    medianP50Ms: Math.round(median(p50s)),
    medianP99Ms: Math.round(median(p99s)),
    worstP99Ms: Math.round(Math.max(...p99s, 0)),
    throttledRecords: put.throttled,
  };
  record(entry);
  console.log(
    `rate=${String(eventsPerSec).padStart(4)} ev/s (window ${batchWindowSeconds}s): ` +
      `${entry.batches} batches sampled, median p50 ${entry.medianP50Ms}ms, ` +
      `median p99 ${entry.medianP99Ms}ms, worst p99 ${entry.worstP99Ms}ms`,
  );
}

async function latencyMode() {
  await ensureStreamActive();
  await ensureConsumerMapping();
  console.log('MODE=latency: steady rates, sampling the consumer stats item');
  console.log('settling consumer (ESM warmup / prior backlog)...');
  await settleConsumer();
  for (const eventsPerSec of [100, 1000, 5000]) {
    await runLatencyLevel(eventsPerSec, 1);
  }
  console.log('re-checking 1000 ev/s with the batching window at 0s');
  await setBatchWindow(0);
  await settleConsumer();
  await runLatencyLevel(1000, 0);
  await setBatchWindow(1); // restore the production setting
}

async function drainMode() {
  await ensureStreamActive();
  await ensureConsumerMapping();
  console.log('MODE=drain: disable mapping, build backlog, re-enable, measure catch-up');
  console.log('waiting for the consumer to quiesce before disabling...');
  await quiesceConsumer();
  await setMappingEnabled(false);

  const backlogEvents = 100_000;
  const eventsPerRecord = 100;
  const stats = newPutStats();
  while (stats.accepted * eventsPerRecord < backlogEvents) {
    await putOnce(packRecords(eventsPerRecord, 250), stats);
  }
  const backlog = stats.accepted * eventsPerRecord;
  console.log(`backlog built: ${backlog.toLocaleString('en-US')} events in ${stats.accepted} records`);

  const enableStart = Date.now();
  await setMappingEnabled(true);
  let firstBatchTs: number | null = null;
  // caught up when consumer batches land (stats window advances past enable)
  for (;;) {
    await sleep(2_000);
    const item = await readStats();
    if (item && typeof item.windowEndTs === 'number' && item.windowEndTs > enableStart) {
      if (firstBatchTs === null) firstBatchTs = item.windowEndTs;
      // wait until the checkpointed batches stop advancing = fully drained
      const settledAt = item.windowEndTs;
      await sleep(6_000);
      const again = await readStats();
      if (again && again.windowEndTs === settledAt) {
        const drainSeconds = (settledAt - enableStart) / 1000;
        const entry = {
          mode: 'drain',
          backlogEvents: backlog,
          backlogRecords: stats.accepted,
          firstBatchSeconds: Number(((firstBatchTs - enableStart) / 1000).toFixed(1)),
          drainSeconds: Number(drainSeconds.toFixed(1)),
          drainEventsPerSec: Math.round(backlog / drainSeconds),
        };
        record(entry);
        console.log(
          `first batch ${entry.firstBatchSeconds}s after enable; drained ` +
            `${backlog.toLocaleString('en-US')} events in ${entry.drainSeconds}s ` +
            `(${entry.drainEventsPerSec.toLocaleString('en-US')} ev/s)`,
        );
        return;
      }
    }
    if (Date.now() - enableStart > 15 * 60 * 1000) throw new Error('drain timed out');
  }
}

async function cleanupMode() {
  console.log('MODE=cleanup: quiesce, delete bench items, janitor teardown');
  await quiesceConsumer();

  // Bench leftovers: the stats item (its freshness would make the janitor
  // keep the infra), the BENCH quote (no TTL), BENCH bars (48h TTL, but be
  // tidy), and shard checkpoints (stale once the stream is deleted; safe
  // even if kept - recreated streams get larger, time-derived sequence
  // numbers - but there is no reason to rely on that here).
  const bars = await dynamo.send(
    new QueryCommand({
      TableName: pulseTable(),
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :bar)',
      ExpressionAttributeValues: { ':pk': `SYM#${BENCH_SYMBOL}`, ':bar': 'BAR#' },
    }),
  );
  const doomed = [
    keys.stats(),
    keys.latest(BENCH_SYMBOL),
    ...Array.from({ length: 10 }, (_, i) =>
      keys.checkpoint(`shardId-${String(i).padStart(12, '0')}`),
    ),
    ...(bars.Items ?? []).map((item) => ({ pk: item.pk as string, sk: item.sk as string })),
  ];
  for (const key of doomed) {
    await dynamo.send(new DeleteCommand({ TableName: pulseTable(), Key: key }));
  }
  console.log(`deleted ${doomed.length} bench items from ${pulseTable()}`);

  const janitor = process.env.PULSE_JANITOR_FUNCTION ?? 'pulse-janitor';
  const result = await lambda.send(new InvokeCommand({ FunctionName: janitor }));
  console.log(`janitor: ${Buffer.from(result.Payload ?? []).toString('utf8')}`);

  for (let i = 0; i < 45; i++) {
    try {
      const summary = await kinesis.send(
        new DescribeStreamSummaryCommand({ StreamName: pulseStreamName() }),
      );
      console.log(`stream ${summary.StreamDescriptionSummary?.StreamStatus}...`);
    } catch (error) {
      if (error instanceof ResourceNotFoundException) {
        console.log('stream deleted; back to $0 idle');
        return;
      }
      throw error;
    }
    await sleep(2_000);
  }
  throw new Error('stream still present after janitor run');
}

async function main() {
  if (MODE === 'throughput') await throughputMode();
  else if (MODE === 'latency') await latencyMode();
  else if (MODE === 'drain') await drainMode();
  else if (MODE === 'cleanup') await cleanupMode();
  else throw new Error(`unknown MODE ${MODE}`);
  console.log(`done; results in ${RESULTS}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
