import {
  CreateStreamCommand,
  DescribeStreamConsumerCommand,
  DescribeStreamSummaryCommand,
  KinesisClient,
  RegisterStreamConsumerCommand,
  ResourceInUseException,
  ResourceNotFoundException,
} from '@aws-sdk/client-kinesis';
import {
  CreateEventSourceMappingCommand,
  LambdaClient,
  ListEventSourceMappingsCommand,
} from '@aws-sdk/client-lambda';
import { NodeHttpHandler } from '@smithy/node-http-handler';

// Kinesis client for PortfolioPulse. The stream itself is deliberately
// NOT Terraform-managed: it is created lazily by the first ingest session
// and deleted by the janitor after idle hours, because a provisioned
// shard bills by the hour whether or not events flow ($0-idle rule).

const globalForKinesis = globalThis as unknown as { pulseKinesis?: KinesisClient };

export const kinesis =
  globalForKinesis.pulseKinesis ??
  new KinesisClient({
    region: process.env.AWS_REGION ?? 'us-east-1',
    // Endpoint override points at kinesis-mock locally; unset on real AWS.
    ...(process.env.KINESIS_ENDPOINT ? { endpoint: process.env.KINESIS_ENDPOINT } : {}),
    // The Kinesis client defaults to HTTP/2 (only needed to call
    // SubscribeToShard directly; with enhanced fan-out the Lambda mapping
    // makes that call, never this client); plain HTTP/1.1 behaves
    // identically on AWS and sidesteps the local emulator's flaky h2.
    requestHandler: new NodeHttpHandler(),
  });

if (process.env.NODE_ENV !== 'production') globalForKinesis.pulseKinesis = kinesis;

export function pulseStreamName(): string {
  return process.env.PULSE_STREAM ?? 'pulse-events';
}

/**
 * Lazy stream provisioning: create the stream if it is missing (the first
 * session after a janitor teardown pays the ~30s ACTIVE wait; later
 * sessions find it warm) and return once it accepts writes.
 */
export async function ensureStreamActive(shardCount = 1, timeoutMs = 90_000): Promise<void> {
  const started = Date.now();
  let created = false;
  while (Date.now() - started < timeoutMs) {
    try {
      const summary = await kinesis.send(
        new DescribeStreamSummaryCommand({ StreamName: pulseStreamName() }),
      );
      const status = summary.StreamDescriptionSummary?.StreamStatus;
      if (status === 'ACTIVE') return;
      // CREATING / UPDATING: fall through to the wait below.
    } catch (error) {
      if (error instanceof ResourceNotFoundException && !created) {
        try {
          await kinesis.send(
            new CreateStreamCommand({ StreamName: pulseStreamName(), ShardCount: shardCount }),
          );
        } catch (createError) {
          // Lost a create race to a concurrent session; theirs counts.
          if (!(createError instanceof ResourceInUseException)) throw createError;
        }
        created = true;
      } else if (!(error instanceof ResourceNotFoundException)) {
        throw error;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`stream ${pulseStreamName()} did not reach ACTIVE within ${timeoutMs}ms`);
}

function envInt(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

/** Like envInt, but 0 is a real value (a batching window of 0 = invoke at once). */
function envSeconds(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

/**
 * Enhanced fan-out (default on; PULSE_ENHANCED_FAN_OUT=0 opts out for an
 * A/B benchmark). A standard mapping polls each shard about once a second,
 * so an event waits ~0.5s on average before the consumer even sees it;
 * that poll was the floor under the tile's p50. A registered stream
 * consumer instead gets records pushed over a dedicated HTTP/2
 * connection as they land. Its cost is $0.015 per consumer-shard-hour
 * while the stream exists (the janitor deletes it with the stream), plus
 * more frequent, smaller consumer invocations while a session is live.
 */
export function enhancedFanOut(): boolean {
  return process.env.PULSE_ENHANCED_FAN_OUT !== '0';
}

export function streamConsumerName(): string {
  return process.env.PULSE_STREAM_CONSUMER ?? 'pulse-consumer';
}

/**
 * True when a mapping reads this stream: a standard mapping names the
 * stream ARN, an enhanced fan-out mapping names one of its consumers
 * (`<stream ARN>/consumer/<name>:<timestamp>`).
 */
export function isStreamMapping(eventSourceArn: string | undefined, streamArn: string): boolean {
  return (
    eventSourceArn !== undefined &&
    (eventSourceArn === streamArn || eventSourceArn.startsWith(`${streamArn}/consumer/`))
  );
}

/** Registers the stream's dedicated consumer (idempotent) and waits for ACTIVE. */
async function ensureStreamConsumer(streamArn: string, timeoutMs = 60_000): Promise<string> {
  try {
    await kinesis.send(
      new RegisterStreamConsumerCommand({ StreamARN: streamArn, ConsumerName: streamConsumerName() }),
    );
  } catch (error) {
    // Already registered by an earlier session on this stream.
    if (!(error instanceof ResourceInUseException)) throw error;
  }
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const { ConsumerDescription: consumer } = await kinesis.send(
        new DescribeStreamConsumerCommand({
          StreamARN: streamArn,
          ConsumerName: streamConsumerName(),
        }),
      );
      // A mapping onto a consumer that is still CREATING is rejected.
      if (consumer?.ConsumerStatus === 'ACTIVE' && consumer.ConsumerARN) {
        return consumer.ConsumerARN;
      }
    } catch (error) {
      // Registration is eventually consistent: a describe right after it
      // can briefly miss the new consumer.
      if (!(error instanceof ResourceNotFoundException)) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`stream consumer ${streamConsumerName()} did not reach ACTIVE within ${timeoutMs}ms`);
}

/**
 * AWS only: the consumer's event source mapping, created lazily alongside
 * the stream (by the ingest session, or by the bench harness).
 * TRIM_HORIZON so events that beat the mapping into a fresh stream are
 * still consumed. Skipped against the local emulator, where
 * scripts/pulse-consumer-local.ts is the poll loop instead.
 *
 * Any existing mapping on this stream, standard or fan-out, is kept as
 * is: two mappings would mean two concurrent writers per shard, breaking
 * the consumer's single-writer invariant. So a stream created before
 * fan-out keeps standard polling until the janitor recreates it.
 */
export async function ensureConsumerMapping(): Promise<void> {
  if (process.env.KINESIS_ENDPOINT) return;
  const functionName = process.env.PULSE_CONSUMER_FUNCTION ?? 'pulse-consumer';
  const lambda = new LambdaClient({ region: process.env.AWS_REGION ?? 'us-east-1' });

  const summary = await kinesis.send(
    new DescribeStreamSummaryCommand({ StreamName: pulseStreamName() }),
  );
  const streamArn = summary.StreamDescriptionSummary?.StreamARN;
  if (!streamArn) throw new Error('stream ARN unavailable');

  const existing = await lambda.send(
    new ListEventSourceMappingsCommand({ FunctionName: functionName }),
  );
  if (
    (existing.EventSourceMappings ?? []).some((mapping) =>
      isStreamMapping(mapping.EventSourceArn, streamArn),
    )
  ) {
    return;
  }

  const fanOut = enhancedFanOut();
  const eventSourceArn = fanOut ? await ensureStreamConsumer(streamArn) : streamArn;
  const dlqArn = process.env.PULSE_DLQ_ARN;
  await lambda.send(
    new CreateEventSourceMappingCommand({
      FunctionName: functionName,
      EventSourceArn: eventSourceArn,
      StartingPosition: 'TRIM_HORIZON',
      BatchSize: envInt('PULSE_BATCH_SIZE', 200),
      // Fan-out pushes records the moment they land, so any window only
      // adds latency; the ingest's 200ms flush already batches at the
      // source. Standard polling keeps the 1s window the July benchmark
      // chose (0s there cost +41% worst-case p99 for a 40ms median gain).
      MaximumBatchingWindowInSeconds: envSeconds('PULSE_BATCH_WINDOW_SECONDS', fanOut ? 0 : 1),
      ParallelizationFactor: 1, // single writer per shard, by design
      MaximumRetryAttempts: 3,
      BisectBatchOnFunctionError: true, // isolates a poison record
      ...(dlqArn ? { DestinationConfig: { OnFailure: { Destination: dlqArn } } } : {}),
    }),
  );
}
