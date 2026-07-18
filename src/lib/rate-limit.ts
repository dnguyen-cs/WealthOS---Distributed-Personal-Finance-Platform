import { redis } from '@/lib/redis';

// Redis-backed abuse guards for public endpoints. Both primitives are
// single Lua scripts so concurrent requests cannot interleave between the
// read and the write (same reasoning as the sync lock's token-guarded
// release). Failure mode is fail-closed by design: if Redis is down the
// caller should reject the request, because the guarded endpoints spend
// real money (compute) or feed credential stuffing (auth) when unguarded.

// Fixed-window counter. INCR creates the key at 1, and only that first
// request sets the TTL, so the window cannot be extended by later hits.
const FIXED_WINDOW = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return { count, redis.call('TTL', KEYS[1]) }
`;

// Daily budget. The increment and the limit check must be one atomic step:
// two racing requests may both overshoot, and each rolls back only its own
// contribution, so the counter never leaks upward on rejection.
const CONSUME_BUDGET = `
local total = redis.call('INCRBY', KEYS[1], ARGV[1])
if total == tonumber(ARGV[1]) then
  redis.call('EXPIRE', KEYS[1], ARGV[2])
end
if total > tonumber(ARGV[3]) then
  redis.call('DECRBY', KEYS[1], ARGV[1])
  return { 0, total - tonumber(ARGV[1]) }
end
return { 1, total }
`;

// Refund is conditional on the key still existing: after the daily key
// expires, a late refund must not create a negative counter.
const REFUND_BUDGET = `
if redis.call('EXISTS', KEYS[1]) == 1 then
  return redis.call('DECRBY', KEYS[1], ARGV[1])
end
return 0
`;

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
  const [count, ttl] = (await redis.eval(FIXED_WINDOW, 1, key, windowSeconds)) as [
    number,
    number,
  ];
  if (count <= limit) return { allowed: true, retryAfterSeconds: 0 };
  return { allowed: false, retryAfterSeconds: Math.max(ttl, 1) };
}

export interface BudgetDecision {
  allowed: boolean;
  /** Counter value after this call (excluding the rejected amount). */
  usedToday: number;
}

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
  const [allowed, used] = (await redis.eval(
    CONSUME_BUDGET,
    1,
    dailyBudgetKey(prefix),
    amount,
    DAY_KEY_TTL_SECONDS,
    budget,
  )) as [number, number];
  return { allowed: allowed === 1, usedToday: used };
}

export async function refundDailyBudget(prefix: string, amount: number): Promise<void> {
  await redis.eval(REFUND_BUDGET, 1, dailyBudgetKey(prefix), amount);
}
