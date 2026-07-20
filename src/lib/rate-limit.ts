import { addToCounterIfExists, bumpCounter } from '@/lib/app-state';

// DynamoDB-backed abuse guards for public endpoints (ported from Redis
// when the hosted stack became Vercel + AWS only - ElastiCache is
// VPC-bound and unreachable from Vercel). The conditional-write
// primitives in lib/app-state.ts carry the atomicity the old Lua scripts
// provided. Failure mode is fail-closed by design: if DynamoDB is down
// the caller should reject the request, because the guarded endpoints
// spend real money (compute) or feed credential stuffing (auth) when
// unguarded.
//
// One honest semantic delta from the Lua version, documented in
// MASTER.md 9.12: the budget check and its rollback are two atomic
// writes rather than one script, so a racing request at the exact budget
// boundary can observe a doomed contribution and be rejected
// conservatively. The budget can never be exceeded; it can only round
// down under contention.

export interface RateLimitDecision {
  allowed: boolean;
  /** Seconds until the current window resets; 0 when allowed. */
  retryAfterSeconds: number;
}

export async function fixedWindowLimit(
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<RateLimitDecision> {
  const { count, expiresAt } = await bumpCounter(key, 1, windowSeconds);
  if (count <= limit) return { allowed: true, retryAfterSeconds: 0 };
  return {
    allowed: false,
    retryAfterSeconds: Math.max(expiresAt - Math.floor(Date.now() / 1000), 1),
  };
}

export interface BudgetDecision {
  allowed: boolean;
  /** Counter value after this call (excluding the rejected amount). */
  usedToday: number;
}

// The UTC day lives in the key, so a window rollover is a new item and
// needs no reset race handling; the TTL just garbage-collects old days.
const DAY_KEY_TTL_SECONDS = 48 * 60 * 60;

function utcDay(): string {
  return new Date().toISOString().slice(0, 10);
}

export function dailyBudgetKey(prefix: string): string {
  return `${prefix}:${utcDay()}`;
}

export async function consumeDailyBudget(
  prefix: string,
  amount: number,
  budget: number,
): Promise<BudgetDecision> {
  const key = dailyBudgetKey(prefix);
  const { count: used } = await bumpCounter(key, amount, DAY_KEY_TTL_SECONDS);
  if (used > budget) {
    // Roll back only this call's contribution, so the counter never
    // leaks upward on rejection even when two requests overshoot at once.
    await addToCounterIfExists(key, -amount);
    return { allowed: false, usedToday: used - amount };
  }
  return { allowed: true, usedToday: used };
}

export async function refundDailyBudget(prefix: string, amount: number): Promise<void> {
  await addToCounterIfExists(dailyBudgetKey(prefix), -amount);
}
