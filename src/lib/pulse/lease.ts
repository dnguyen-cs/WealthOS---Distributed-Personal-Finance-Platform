import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';

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
  const [result, stop] = await Promise.all([
    dynamo.send(new GetCommand({ TableName: pulseTable(), Key: keys.sessionState() })),
    dynamo.send(new GetCommand({ TableName: pulseTable(), Key: keys.stop() })),
  ]);
  if (!result.Item) return null;
  const state = sessionStateSchema.parse({
    status: result.Item.status,
    sessionId: result.Item.sessionId,
    leaseUntil: result.Item.leaseUntil,
    ...(result.Item.startedAt !== undefined ? { startedAt: result.Item.startedAt } : {}),
    stopRequested: stop.Item?.sessionId === result.Item.sessionId && stop.Item?.stop === true,
  });
  return state.leaseUntil < Date.now() ? null : state;
}

// Stopping. The STATE item stays ingest-owned (only the lease holder
// writes it); a stop is a separate SESSION/STOP control item that the
// app writes and the ingest polls every couple of seconds. It names the
// session it targets, so a stale request can never stop a later session,
// and a "Go live" that lands before the ingest acts overwrites it with
// stop=false. Plain Puts in the SESSION partition, so the app needs no
// write access beyond what the viewer keepalive already has.

const STOP_TTL_SECONDS = 60 * 60;

async function writeStop(sessionId: string, stop: boolean): Promise<void> {
  await dynamo.send(
    new PutCommand({
      TableName: pulseTable(),
      Item: {
        ...keys.stop(),
        sessionId,
        stop,
        at: Date.now(),
        expiresAt: Math.floor(Date.now() / 1000) + STOP_TTL_SECONDS,
      },
    }),
  );
}

export function requestStop(sessionId: string): Promise<void> {
  return writeStop(sessionId, true);
}

export function cancelStop(sessionId: string): Promise<void> {
  return writeStop(sessionId, false);
}

/** Ingest side: has a viewer asked this exact session to stop? */
export async function stopRequestedFor(sessionId: string): Promise<boolean> {
  const result = await dynamo.send(
    new GetCommand({ TableName: pulseTable(), Key: keys.stop(), ConsistentRead: true }),
  );
  return result.Item?.sessionId === sessionId && result.Item?.stop === true;
}

const VIEWER_WINDOW_MS = 2 * 60 * 1000;
// A watching tile polls every 1.5s, so anyone silent for 30s has left;
// that is the bar for "someone else is still watching" when a viewer
// presses Stop.
const ACTIVE_VIEWER_MS = 30_000;
const VIEWER_TTL_SECONDS = 60 * 60;

// Viewer keepalive, two items per touch. VIEWERS is the single
// any-viewer heartbeat the ingest checks (one cheap GetItem; the ingest
// role cannot Query): it exits once nobody has polled inside the window,
// which is what makes sessions cost nothing once the audience leaves.
// VIEWER#<userId> is per-user presence, read only when someone presses
// Stop, so one viewer leaving never cuts off another who is still watching.
export async function touchViewer(userId: string): Promise<void> {
  const now = Date.now();
  const expiresAt = Math.floor(now / 1000) + VIEWER_TTL_SECONDS;
  await Promise.all([
    dynamo.send(
      new PutCommand({
        TableName: pulseTable(),
        Item: { ...keys.viewers(), lastSeenAt: now, expiresAt },
      }),
    ),
    dynamo.send(
      new PutCommand({
        TableName: pulseTable(),
        Item: { ...keys.viewer(userId), lastSeenAt: now, expiresAt },
      }),
    ),
  ]);
}

/** Marks the user as gone (a Put, not a Delete: the app has no DeleteItem grant). */
export async function leaveViewer(userId: string): Promise<void> {
  await dynamo.send(
    new PutCommand({
      TableName: pulseTable(),
      Item: {
        ...keys.viewer(userId),
        leftAt: Date.now(),
        expiresAt: Math.floor(Date.now() / 1000) + VIEWER_TTL_SECONDS,
      },
    }),
  );
}

/** How many users other than `userId` are actively watching right now. */
export async function otherActiveViewers(userId: string): Promise<number> {
  const result = await dynamo.send(
    new QueryCommand({
      TableName: pulseTable(),
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :viewer)',
      ExpressionAttributeValues: { ':pk': keys.viewers().pk, ':viewer': 'VIEWER#' },
      ConsistentRead: true,
    }),
  );
  const self = keys.viewer(userId).sk;
  const cutoff = Date.now() - ACTIVE_VIEWER_MS;
  return (result.Items ?? []).filter(
    (item) => item.sk !== self && typeof item.lastSeenAt === 'number' && item.lastSeenAt > cutoff,
  ).length;
}

export async function viewersActive(): Promise<boolean> {
  const result = await dynamo.send(
    new GetCommand({ TableName: pulseTable(), Key: keys.viewers() }),
  );
  const lastSeenAt = result.Item?.lastSeenAt;
  return typeof lastSeenAt === 'number' && Date.now() - lastSeenAt < VIEWER_WINDOW_MS;
}
