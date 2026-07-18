// PortfolioPulse ingest, Lambda edition: one invocation = one live-data
// session (up to ~14.5 min inside the 15-min Lambda cap). Started by the
// dashboard's "Go live"; single-flight via the DynamoDB lease; exits when
// viewers stop polling, the wall clock runs out, the source goes quiet,
// or the lease is lost to a takeover. The stream and the consumer's event
// source mapping are provisioned lazily here (and torn down by the
// janitor) because both bill by the hour whether or not events flow.
import { randomUUID } from 'node:crypto';

import { PutRecordsCommand } from '@aws-sdk/client-kinesis';

import {
  acquireSessionLease,
  HEARTBEAT_MS,
  releaseSessionLease,
  renewSessionLease,
  viewersActive,
} from '@/lib/pulse/lease';
import {
  ensureConsumerMapping,
  ensureStreamActive,
  kinesis,
  pulseStreamName,
} from '@/lib/pulse/stream';
import { ensureLocalPulseTable } from '@/lib/pulse/table';
import { PULSE_SYMBOLS, type PulseEvent } from '@/lib/pulse/types';
import { selectSource } from '@/workers/pulse/sources';

function envInt(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

// Kinesis caps a shard at 1,000 records/s but 1 MB/s; packing events per
// record is what buys per-shard headroom (quantified in bench-pulse).
const EVENTS_PER_RECORD = () => envInt('PULSE_EVENTS_PER_RECORD', 100);
const FLUSH_INTERVAL_MS = 200;
const PUT_BATCH_LIMIT = 500;

export class RecordBatcher {
  private buffers = new Map<string, PulseEvent[]>();
  private buffered = 0;
  sent = 0;
  putCalls = 0;

  add(event: PulseEvent): void {
    const buffer = this.buffers.get(event.symbol);
    if (buffer) buffer.push(event);
    else this.buffers.set(event.symbol, [event]);
    this.buffered += 1;
  }

  /** Pack per-symbol (a record's partition key must match its events). */
  private drainToRecords(): { PartitionKey: string; Data: Uint8Array }[] {
    const perRecord = EVENTS_PER_RECORD();
    const records: { PartitionKey: string; Data: Uint8Array }[] = [];
    for (const [symbol, events] of this.buffers) {
      for (let offset = 0; offset < events.length; offset += perRecord) {
        records.push({
          PartitionKey: symbol,
          Data: Buffer.from(
            JSON.stringify({ events: events.slice(offset, offset + perRecord) }),
          ),
        });
      }
    }
    this.buffers = new Map();
    this.buffered = 0;
    return records;
  }

  // Same partial-failure retry shape as enqueueChunks: a retried record
  // that actually landed becomes a duplicate, which the consumer's merge
  // design tolerates (order-insensitive bars; documented at-least-once
  // volume on that rare race).
  async flush(): Promise<void> {
    if (this.buffered === 0) return;
    let pending = this.drainToRecords();
    while (pending.length > 0) {
      const batch = pending.slice(0, PUT_BATCH_LIMIT);
      const rest = pending.slice(PUT_BATCH_LIMIT);
      let entries = batch;
      for (let attempt = 0; attempt < 3 && entries.length > 0; attempt++) {
        const result = await kinesis.send(
          new PutRecordsCommand({ StreamName: pulseStreamName(), Records: entries }),
        );
        this.putCalls += 1;
        if (!result.FailedRecordCount) {
          this.sent += entries.length;
          entries = [];
          break;
        }
        const failed: typeof entries = [];
        result.Records?.forEach((record, index) => {
          if (record.ErrorCode) failed.push(entries[index]);
          else this.sent += 1;
        });
        entries = failed;
        if (entries.length > 0) await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
      }
      if (entries.length > 0) {
        throw new Error(`kinesis put failed for ${entries.length} record(s) after retries`);
      }
      pending = rest;
    }
  }
}

export type IngestOutcome = 'ran' | 'lease-held';

export async function runIngestSession(): Promise<IngestOutcome> {
  const sessionId = randomUUID();
  await ensureLocalPulseTable(); // no-op on AWS; the lease lives in this table
  if (!(await acquireSessionLease(sessionId))) return 'lease-held';

  const maxSessionMs = envInt('PULSE_SESSION_MAX_MS', 870_000);
  const heartbeatMs = envInt('PULSE_HEARTBEAT_MS', HEARTBEAT_MS);
  const ignoreViewers = process.env.PULSE_IGNORE_VIEWERS === '1';
  const batcher = new RecordBatcher();
  const source = selectSource();
  const startedAt = Date.now();
  let lastEventAt = Date.now();
  let flushTimer: ReturnType<typeof setInterval> | null = null;

  try {
    await ensureStreamActive(envInt('PULSE_SHARDS', 1));
    await ensureConsumerMapping();

    await source.start([...PULSE_SYMBOLS], (event) => {
      lastEventAt = Date.now();
      batcher.add(event);
    });
    await renewSessionLease(sessionId, 'live', startedAt);
    console.log(`[pulse-ingest ${sessionId.slice(0, 8)}] live via ${source.name}`);

    let flushing = Promise.resolve();
    flushTimer = setInterval(() => {
      flushing = flushing.then(() => batcher.flush()).catch((error) => {
        console.error('flush failed:', error);
      });
    }, FLUSH_INTERVAL_MS);

    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, heartbeatMs));
      if (Date.now() - startedAt >= maxSessionMs) {
        console.log('session wall clock reached, exiting');
        break;
      }
      if (Date.now() - lastEventAt > 60_000) {
        console.log('source went quiet for 60s, exiting');
        break;
      }
      if (!ignoreViewers && !(await viewersActive())) {
        console.log('no viewers polling, exiting');
        break;
      }
      if (!(await renewSessionLease(sessionId, 'live'))) {
        console.log('lease lost to takeover, exiting');
        return 'ran';
      }
    }
    return 'ran';
  } finally {
    if (flushTimer) clearInterval(flushTimer);
    await source.stop();
    await batcher.flush().catch((error) => console.error('final flush failed:', error));
    await releaseSessionLease(sessionId);
    console.log(
      `[pulse-ingest ${sessionId.slice(0, 8)}] done: ${batcher.sent} records ` +
        `in ${batcher.putCalls} PutRecords calls over ${((Date.now() - startedAt) / 1000).toFixed(0)}s`,
    );
  }
}

export async function handler(): Promise<void> {
  await runIngestSession();
}
