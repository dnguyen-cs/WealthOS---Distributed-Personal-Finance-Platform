import type { YearlyStat } from '@/lib/wealthsim/types';

// Cross-engine result comparison. Per-engine reruns are byte-identical,
// but node-vs-go results agree only to floating-point ulps (exp/log are
// not correctly rounded, so accumulators drift ~1e-15 relative; measured
// max 2.53e-15 end to end). The tolerance sits six orders of magnitude
// above that drift and twelve below anything a real kernel bug produces.
export const CROSS_ENGINE_TOLERANCE = 1e-9;

const STAT_FIELDS = [
  'mean',
  'stddev',
  'min',
  'max',
  'p05',
  'p10',
  'p25',
  'p50',
  'p75',
  'p90',
  'p95',
] as const;

/**
 * Largest relative difference across every year and statistic, or null
 * when the shapes differ (which is itself a mismatch, never rounding).
 */
export function maxRelativeDivergence(a: YearlyStat[], b: YearlyStat[]): number | null {
  if (a.length !== b.length) return null;
  let max = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i].year !== b[i].year) return null;
    for (const field of STAT_FIELDS) {
      const va = a[i][field];
      const vb = b[i][field];
      const scale = Math.max(Math.abs(va), Math.abs(vb), 1);
      const relative = Math.abs(va - vb) / scale;
      if (relative > max) max = relative;
    }
  }
  return max;
}
