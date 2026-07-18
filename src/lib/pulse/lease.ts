import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

import { dynamo, keys, pulseTable } from '@/lib/pulse/table';
import { sessionStateSchema, type SessionState } from '@/lib/pulse/types';

// Single-flight ingest sessions via a DynamoDB lease: at most one ingest
// holds the STATE item at a time, everyone else's acquire loses the
// conditional write. Same invariant family as the Plaid sync lock (SET NX
// + token-guarded release), rebuilt on conditional writes because the
// hosted stack is Vercel + AWS only. A crashed ingest is not a deadlock:
// its lease expires by wall clock and the next session start takes over.

export const LEASE_TTL_MS = 90_000;
export const HEARTBEAT_MS = 30_000;

export async function acquireSessionLease(sessionId: string): Promise<boolean> {
  try {
    await dynamo.send(
      new PutCommand({
        TableName: pulseTable(),
        Item: {
          ...keys.sessionState(),
          status: 'starting',
          sessionId,
          leaseUntil: Date.now() + LEASE_TTL_MS,
        },
        ConditionExpression: 'attribute_not_exists(pk) OR leaseUntil < :now',
        ExpressionAttributeValues: { ':now': Date.now() },
      }),
    );
    return true;
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) return false;
    throw error;
  }
}

// Renewal is token-guarded on sessionId: a session that lost its lease to
// a takeover can never extend the new owner's lease.
export async function renewSessionLease(
  sessionId: string,
  status: SessionState['status'],
  startedAt?: number,
): Promise<boolean> {
  try {
    await dynamo.send(
      new UpdateCommand({
        TableName: pulseTable(),
        Key: keys.sessionState(),
        UpdateExpression:
          'SET leaseUntil = :leaseUntil, #status = :status' +
          (startedAt !== undefined ? ', startedAt = :startedAt' : ''),
        ConditionExpression: 'sessionId = :sessionId',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':sessionId': sessionId,
          ':leaseUntil': Date.now() + LEASE_TTL_MS,
          ':status': status,
          ...(startedAt !== undefined ? { ':startedAt': startedAt } : {}),
        },
      }),
    );
    return true;
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) return false;
    throw error;
  }
}

export async function releaseSessionLease(sessionId: string): Promise<void> {
  try {
    await dynamo.send(
      new DeleteCommand({
        TableName: pulseTable(),
        Key: keys.sessionState(),
        ConditionExpression: 'sessionId = :sessionId',
        ExpressionAttributeValues: { ':sessionId': sessionId },
      }),
    );
  } catch (error) {
    // Losing the release race means a successor owns the lease; that is
    // the desired end state, not an error.
    if (!(error instanceof ConditionalCheckFailedException)) throw error;
  }
}

/** Current session as the outside world should see it (expired = idle). */
export async function readSessionState(): Promise<SessionState | null> {
  const result = await dynamo.send(
    new GetCommand({ TableName: pulseTable(), Key: keys.sessionState() }),
  );
  if (!result.Item) return null;
  const state = sessionStateSchema.parse({
    status: result.Item.status,
    sessionId: result.Item.sessionId,
    leaseUntil: result.Item.leaseUntil,
    ...(result.Item.startedAt !== undefined ? { startedAt: result.Item.startedAt } : {}),
  });
  return state.leaseUntil < Date.now() ? null : state;
}

const VIEWER_WINDOW_MS = 2 * 60 * 1000;

// Viewer keepalive: the dashboard's poll route touches this item; the
// ingest exits when nobody has polled inside the window, which is what
// makes sessions cost nothing once the audience leaves.
export async function touchViewers(): Promise<void> {
  await dynamo.send(
    new PutCommand({
      TableName: pulseTable(),
      Item: {
        ...keys.viewers(),
        lastSeenAt: Date.now(),
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      },
    }),
  );
}

export async function viewersActive(): Promise<boolean> {
  const result = await dynamo.send(
    new GetCommand({ TableName: pulseTable(), Key: keys.viewers() }),
  );
  const lastSeenAt = result.Item?.lastSeenAt;
  return typeof lastSeenAt === 'number' && Date.now() - lastSeenAt < VIEWER_WINDOW_MS;
}
