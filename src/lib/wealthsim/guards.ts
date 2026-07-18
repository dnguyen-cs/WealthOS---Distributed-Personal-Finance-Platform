import { consumeDailyBudget, fixedWindowLimit, refundDailyBudget } from '@/lib/rate-limit';

// Abuse policy for the public run endpoint. These guards live at the route
// layer, not in createSimulationJob: the library is the trusted internal
// path (bench/chaos/parity scripts submit through it deliberately), while
// the HTTP surface is what a hosted demo exposes to strangers with a
// compute bill attached. All knobs are env-tunable so the public deploy
// can be stricter than local dev without a code fork.

function envInt(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

// Absolute schema cap is 10M paths; the hosted demo lowers this via env.
export function maxPathsPerJob(): number {
  return Math.min(envInt('WEALTHSIM_MAX_PATHS', 10_000_000), 10_000_000);
}

const BUDGET_PREFIX = 'wealthsim:budget';

export interface GuardVerdict {
  ok: boolean;
  status: number;
  error: string;
  retryAfterSeconds?: number;
}

const ALLOWED: GuardVerdict = { ok: true, status: 0, error: '' };

// Per-user fixed window, then the global daily path budget. Order matters:
// a spamming user is turned away by their own limit before they can touch
// (and roll back) the shared counter.
export async function checkRunGuards(userId: string, pathCount: number): Promise<GuardVerdict> {
  if (pathCount > maxPathsPerJob()) {
    return {
      ok: false,
      status: 400,
      error: `pathCount exceeds the maximum of ${maxPathsPerJob().toLocaleString('en-US')} for this deployment`,
    };
  }

  const perUser = await fixedWindowLimit(
    `rl:wealthsim:run:${userId}`,
    envInt('WEALTHSIM_RUNS_PER_MINUTE', 6),
    60,
  );
  if (!perUser.allowed) {
    return {
      ok: false,
      status: 429,
      error: 'Too many simulations; wait a moment and try again',
      retryAfterSeconds: perUser.retryAfterSeconds,
    };
  }

  const budget = await consumeDailyBudget(
    BUDGET_PREFIX,
    pathCount,
    envInt('WEALTHSIM_DAILY_PATH_BUDGET', 1_000_000_000),
  );
  if (!budget.allowed) {
    return {
      ok: false,
      status: 429,
      error: "The demo's daily compute budget is exhausted; it resets at midnight UTC",
    };
  }

  return ALLOWED;
}

// A job that consumed budget but never made it onto the queue did no work;
// give the paths back so enqueue outages don't eat the day's budget.
export async function refundRunBudget(pathCount: number): Promise<void> {
  await refundDailyBudget(BUDGET_PREFIX, pathCount);
}
