import {
  ConditionalCheckFailedException,
  CreateTableCommand,
  ResourceInUseException,
  UpdateTimeToLiveCommand,
} from '@aws-sdk/client-dynamodb';
import { DeleteCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

import { dynamo } from '@/lib/dynamo';

// The app-state table: small coordination items (rate-limit windows,
// daily budgets, the Plaid sync lock) as single-key records with a TTL
// attribute. This replaced Redis wholesale: every primitive here is one
// or two conditional writes, and DynamoDB's conditional writes give the
// same cannot-interleave guarantees the old Lua scripts did - the same
// family of invariants as the PortfolioPulse session lease
// (lib/pulse/lease.ts).
//
// One DynamoDB-specific rule runs through all of it: TTL deletion lags
// (documented as up to ~48h, typically minutes), so an item whose
// expiresAt has passed MUST be treated as absent by every condition -
// expiry is enforced by the conditions, and TTL is only garbage
// collection.

export function appStateTable(): string {
  return process.env.APP_STATE_TABLE ?? 'app-state';
}

// On real AWS the table is provisioned by Terraform and the app user has
// no CreateTable permission; this only runs against dynamodb-local.
// Deliberately NOT memoized (mirrors ensureLocalPulseTable): the local
// emulator is in-memory and restarts wipe it under a running dev server,
// so every call must be able to recreate the table. On AWS this is an
// immediate return.
export async function ensureLocalAppStateTable(): Promise<void> {
  if (!process.env.DYNAMODB_ENDPOINT) return;
  try {
    await dynamo.send(
      new CreateTableCommand({
        TableName: appStateTable(),
        BillingMode: 'PAY_PER_REQUEST',
        AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
        KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
      }),
    );
    await dynamo.send(
      new UpdateTimeToLiveCommand({
        TableName: appStateTable(),
        TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: true },
      }),
    );
  } catch (error) {
    if (!(error instanceof ResourceInUseException)) throw error;
  }
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export interface CounterResult {
  /** Counter value after this call's contribution. */
  count: number;
  /** Epoch seconds when the current window ends. */
  expiresAt: number;
}

/**
 * Add `amount` to a windowed counter, creating a fresh window when none
 * is live. Replaces Redis INCR/INCRBY + first-writer-sets-EXPIRE: the ADD
 * never touches expiresAt, so later hits cannot extend a window.
 *
 * Three-step ladder, each step atomic:
 * 1. ADD onto a live window (condition: exists and not expired).
 * 2. If that fails, PutItem a fresh window (condition: absent or expired).
 * 3. If THAT fails, another request just started the fresh window in the
 *    gap - retry the ADD once. A second miss would need the fresh window
 *    to expire inside this request, which windows (>= 60s) cannot do;
 *    if it somehow happens the error propagates and the caller's
 *    fail-closed stance rejects the request.
 */
export async function bumpCounter(
  key: string,
  amount: number,
  windowSeconds: number,
): Promise<CounterResult> {
  await ensureLocalAppStateTable();
  const addOnce = async (): Promise<CounterResult | null> => {
    try {
      const result = await dynamo.send(
        new UpdateCommand({
          TableName: appStateTable(),
          Key: { pk: key },
          UpdateExpression: 'ADD #count :amount',
          ConditionExpression: 'attribute_exists(pk) AND expiresAt > :now',
          ExpressionAttributeNames: { '#count': 'count' }, // COUNT is a reserved word
          ExpressionAttributeValues: { ':amount': amount, ':now': nowSeconds() },
          ReturnValues: 'ALL_NEW',
        }),
      );
      return {
        count: result.Attributes?.count as number,
        expiresAt: result.Attributes?.expiresAt as number,
      };
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) return null;
      throw error;
    }
  };

  const onLive = await addOnce();
  if (onLive) return onLive;

  const expiresAt = nowSeconds() + windowSeconds;
  try {
    await dynamo.send(
      new PutCommand({
        TableName: appStateTable(),
        Item: { pk: key, count: amount, expiresAt },
        ConditionExpression: 'attribute_not_exists(pk) OR expiresAt <= :now',
        ExpressionAttributeValues: { ':now': nowSeconds() },
      }),
    );
    return { count: amount, expiresAt };
  } catch (error) {
    if (!(error instanceof ConditionalCheckFailedException)) throw error;
  }

  const retried = await addOnce();
  if (retried) return retried;
  throw new Error(`counter ${key}: window vanished between conditional writes`);
}

/**
 * Add `amount` (typically negative: budget rollback, refund) to a counter
 * only if it still exists. After the TTL sweep deletes an expired day
 * key, a late rollback must not create a negative counter - the same
 * invariant the Redis version enforced with an EXISTS check.
 */
export async function addToCounterIfExists(key: string, amount: number): Promise<void> {
  await ensureLocalAppStateTable();
  try {
    await dynamo.send(
      new UpdateCommand({
        TableName: appStateTable(),
        Key: { pk: key },
        UpdateExpression: 'ADD #count :amount',
        ConditionExpression: 'attribute_exists(pk)',
        ExpressionAttributeNames: { '#count': 'count' },
        ExpressionAttributeValues: { ':amount': amount },
      }),
    );
  } catch (error) {
    if (!(error instanceof ConditionalCheckFailedException)) throw error;
  }
}

/**
 * Token-holding lock with TTL takeover, replacing Redis SET NX EX. The
 * same conditional-write lease as PortfolioPulse's session lease: acquire
 * succeeds when the lock is absent or expired; release deletes only if
 * the token still matches, so an expired lock taken over by another
 * holder is never deleted from under it.
 */
export async function acquireLock(
  key: string,
  token: string,
  ttlSeconds: number,
): Promise<boolean> {
  await ensureLocalAppStateTable();
  try {
    await dynamo.send(
      new PutCommand({
        TableName: appStateTable(),
        Item: { pk: key, holderToken: token, expiresAt: nowSeconds() + ttlSeconds },
        ConditionExpression: 'attribute_not_exists(pk) OR expiresAt <= :now',
        ExpressionAttributeValues: { ':now': nowSeconds() },
      }),
    );
    return true;
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) return false;
    throw error;
  }
}

export async function releaseLock(key: string, token: string): Promise<void> {
  await ensureLocalAppStateTable();
  try {
    await dynamo.send(
      new DeleteCommand({
        TableName: appStateTable(),
        Key: { pk: key },
        ConditionExpression: 'holderToken = :token',
        ExpressionAttributeValues: { ':token': token },
      }),
    );
  } catch (error) {
    // Token mismatch: the lock expired and was taken over - theirs now.
    if (!(error instanceof ConditionalCheckFailedException)) throw error;
  }
}
