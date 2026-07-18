// PortfolioPulse janitor: runs on a daily EventBridge schedule and tears
// down the lazily-created stream + event source mapping once the pipeline
// has been idle long enough. This is the other half of the $0-idle rule:
// a provisioned shard bills hourly whether or not events flow, so idle
// days must end with no stream existing at all. The next "Go live" pays
// the one-time recreate cost (~30s stream + ESM warmup).
import {
  DeleteEventSourceMappingCommand,
  LambdaClient,
  ListEventSourceMappingsCommand,
} from '@aws-sdk/client-lambda';
import {
  DeleteStreamCommand,
  DescribeStreamSummaryCommand,
  ResourceNotFoundException,
} from '@aws-sdk/client-kinesis';
import { DeleteCommand, GetCommand } from '@aws-sdk/lib-dynamodb';

import { readSessionState } from '@/lib/pulse/lease';
import { kinesis, pulseStreamName } from '@/lib/pulse/stream';
import { dynamo, keys, pulseTable } from '@/lib/pulse/table';

function envInt(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

async function lastActivityTs(): Promise<number | null> {
  const result = await dynamo.send(
    new GetCommand({ TableName: pulseTable(), Key: keys.stats() }),
  );
  const windowEndTs = result.Item?.windowEndTs;
  return typeof windowEndTs === 'number' ? windowEndTs : null;
}

export async function runJanitor(): Promise<'kept' | 'torn-down' | 'nothing-to-do'> {
  const idleMs = envInt('PULSE_JANITOR_IDLE_HOURS', 6) * 60 * 60 * 1000;

  const session = await readSessionState();
  if (session) {
    console.log(`session ${session.sessionId.slice(0, 8)} is ${session.status}; keeping infra`);
    return 'kept';
  }
  const activity = await lastActivityTs();
  if (activity !== null && Date.now() - activity < idleMs) {
    console.log(`last activity ${Math.round((Date.now() - activity) / 60000)}min ago; keeping infra`);
    return 'kept';
  }

  let streamArn: string | undefined;
  try {
    const summary = await kinesis.send(
      new DescribeStreamSummaryCommand({ StreamName: pulseStreamName() }),
    );
    streamArn = summary.StreamDescriptionSummary?.StreamARN;
  } catch (error) {
    if (!(error instanceof ResourceNotFoundException)) throw error;
  }
  if (!streamArn) {
    console.log('no stream; nothing to tear down');
    return 'nothing-to-do';
  }

  // The mapping goes first: deleting the stream out from under a live
  // mapping leaves it erroring until the next session recreates things.
  const functionName = process.env.PULSE_CONSUMER_FUNCTION ?? 'pulse-consumer';
  const lambda = new LambdaClient({ region: process.env.AWS_REGION ?? 'us-east-1' });
  const mappings = await lambda.send(
    new ListEventSourceMappingsCommand({ FunctionName: functionName, EventSourceArn: streamArn }),
  );
  for (const mapping of mappings.EventSourceMappings ?? []) {
    if (mapping.UUID) {
      await lambda.send(new DeleteEventSourceMappingCommand({ UUID: mapping.UUID }));
      console.log(`deleted event source mapping ${mapping.UUID}`);
    }
  }

  await kinesis.send(new DeleteStreamCommand({ StreamName: pulseStreamName() }));
  console.log(`deleted stream ${pulseStreamName()}`);

  // Shard checkpoints are stream-scoped state, so they die with the
  // stream. (Recreated streams happen to get larger, time-derived
  // sequence numbers, which would make stale checkpoints harmless - but
  // that is an implementation detail of Kinesis, not an invariant worth
  // depending on.) Shard ids are deterministic, so a bounded sweep needs
  // no Scan permission.
  for (let shard = 0; shard < 10; shard++) {
    await dynamo.send(
      new DeleteCommand({
        TableName: pulseTable(),
        Key: keys.checkpoint(`shardId-${String(shard).padStart(12, '0')}`),
      }),
    );
  }
  console.log('cleared shard checkpoints');
  return 'torn-down';
}

export async function handler(): Promise<'kept' | 'torn-down' | 'nothing-to-do'> {
  return runJanitor();
}
