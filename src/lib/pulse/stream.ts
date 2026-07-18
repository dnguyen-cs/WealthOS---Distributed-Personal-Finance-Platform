import {
  CreateStreamCommand,
  DescribeStreamSummaryCommand,
  KinesisClient,
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
    // The Kinesis client defaults to HTTP/2 (only needed for
    // SubscribeToShard enhanced fan-out, which this pipeline doesn't use);
    // plain HTTP/1.1 behaves identically on AWS and sidesteps the local
    // emulator's flaky h2 handling.
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

/**
 * AWS only: the consumer's event source mapping, created lazily alongside
 * the stream (by the ingest session, or by the bench harness).
 * TRIM_HORIZON so events that beat the mapping into a fresh stream are
 * still consumed. Skipped against the local emulator, where
 * scripts/pulse-consumer-local.ts is the poll loop instead.
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
    new ListEventSourceMappingsCommand({ FunctionName: functionName, EventSourceArn: streamArn }),
  );
  if ((existing.EventSourceMappings ?? []).length > 0) return;

  const dlqArn = process.env.PULSE_DLQ_ARN;
  await lambda.send(
    new CreateEventSourceMappingCommand({
      FunctionName: functionName,
      EventSourceArn: streamArn,
      StartingPosition: 'TRIM_HORIZON',
      BatchSize: envInt('PULSE_BATCH_SIZE', 200),
      MaximumBatchingWindowInSeconds: envInt('PULSE_BATCH_WINDOW_SECONDS', 1),
      ParallelizationFactor: 1, // single writer per shard, by design
      MaximumRetryAttempts: 3,
      BisectBatchOnFunctionError: true, // isolates a poison record
      ...(dlqArn ? { DestinationConfig: { OnFailure: { Destination: dlqArn } } } : {}),
    }),
  );
}
