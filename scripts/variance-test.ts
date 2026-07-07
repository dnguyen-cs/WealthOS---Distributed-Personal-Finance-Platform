// Quantifies what antithetic variates buy: run R independent replications
// per sampling mode at the same path count, measure the across-replication
// standard error of each estimator, and report the variance reduction
// factor (VRF) and its equivalent path savings (1 - 1/VRF, i.e. how many
// fewer paths reach the same confidence interval).
//
//   pnpm exec tsx scripts/variance-test.ts
//
// Fully seeded, so output is reproducible.

import { percentileFromBins } from '@/lib/wealthsim/histogram';
import { simulateChunk } from '@/lib/wealthsim/simulate';
import type { ModelParams } from '@/lib/wealthsim/types';

const baseParams: Omit<ModelParams, 'antithetic'> = {
  initialValue: 100_000,
  annualContribution: 12_000,
  meanReturn: 0.07,
  volatility: 0.15,
  years: 30,
};

const REPLICATIONS = 100;
const PATHS_PER_REPLICATION = 10_000;

interface Estimates {
  mean: number;
  p10: number;
  p50: number;
  p90: number;
}

function runReplications(antithetic: boolean): { estimates: Estimates[]; ms: number } {
  const params: ModelParams = { ...baseParams, antithetic };
  const estimates: Estimates[] = [];
  const started = performance.now();
  for (let seed = 1; seed <= REPLICATIONS; seed++) {
    const summary = simulateChunk({
      jobId: 'variance-test',
      chunkIndex: 0,
      pathCount: PATHS_PER_REPLICATION,
      seed: 900_000 + seed,
      params,
    });
    const final = summary.years[baseParams.years - 1];
    const quantile = (q: number) =>
      percentileFromBins(summary.histogram, final.bins, final.count, q);
    estimates.push({
      mean: final.sum / final.count,
      p10: quantile(0.1),
      p50: quantile(0.5),
      p90: quantile(0.9),
    });
  }
  return { estimates, ms: performance.now() - started };
}

function variance(values: number[]): number {
  const mean = values.reduce((total, value) => total + value, 0) / values.length;
  return values.reduce((total, value) => total + (value - mean) ** 2, 0) / (values.length - 1);
}

function main() {
  console.log(
    `Antithetic variance study: ${REPLICATIONS} replications x ` +
      `${PATHS_PER_REPLICATION.toLocaleString('en-US')} paths, ` +
      `${baseParams.years}y horizon, mu=${baseParams.meanReturn}, sigma=${baseParams.volatility}`,
  );

  const independent = runReplications(false);
  const antithetic = runReplications(true);
  console.log(
    `\nRuntime at equal path count: independent ${Math.round(independent.ms)}ms, ` +
      `antithetic ${Math.round(antithetic.ms)}ms ` +
      `(${(independent.ms / antithetic.ms).toFixed(2)}x faster from shared draws)\n`,
  );

  console.log('Estimator   SE(indep)   SE(anti)    VRF     equal-CI path savings');
  for (const key of ['mean', 'p10', 'p50', 'p90'] as const) {
    const indepValues = independent.estimates.map((e) => e[key]);
    const antiValues = antithetic.estimates.map((e) => e[key]);
    const vrf = variance(indepValues) / variance(antiValues);
    const savings = 1 - 1 / vrf;
    console.log(
      `${key.padEnd(9)} ${Math.sqrt(variance(indepValues)).toFixed(0).padStart(9)} ` +
        `${Math.sqrt(variance(antiValues)).toFixed(0).padStart(10)} ` +
        `${vrf.toFixed(2).padStart(7)} ${(savings * 100).toFixed(0).padStart(10)}%`,
    );
  }
}

main();
