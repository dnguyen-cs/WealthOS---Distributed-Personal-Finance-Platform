import { LogHistogram, histogramConfigFor } from '@/lib/wealthsim/histogram';
import { RandomSource } from '@/lib/wealthsim/rng';
import type { ChunkSpec, ChunkSummary, YearSummary } from '@/lib/wealthsim/types';

// Geometric Brownian motion with monthly steps and end-of-month
// contributions:
//
//   V_{n+1} = V_n * exp((mu - sigma^2/2) dt + sigma sqrt(dt) Z) + c
//
// where mu/sigma are annual arithmetic drift/volatility, dt = 1/12, and
// c is the monthly contribution. Without contributions this has the
// closed forms E[V_t] = V_0 e^{mu t} and median[V_t] =
// V_0 e^{(mu - sigma^2/2) t}, which the tests assert against.

export const STEPS_PER_YEAR = 12;

interface YearAccumulator {
  count: number;
  sum: number;
  sumSq: number;
  min: number;
  max: number;
  histogram: LogHistogram;
}

export function simulateChunk(spec: ChunkSpec): Omit<ChunkSummary, 'computeMs' | 'workerId'> {
  const { initialValue, annualContribution, meanReturn, volatility, years, antithetic } =
    spec.params;
  const dt = 1 / STEPS_PER_YEAR;
  const drift = (meanReturn - 0.5 * volatility * volatility) * dt;
  const diffusion = volatility * Math.sqrt(dt);
  const monthlyContribution = annualContribution / STEPS_PER_YEAR;

  const config = histogramConfigFor(spec.params);
  const accumulators: YearAccumulator[] = Array.from({ length: years }, () => ({
    count: 0,
    sum: 0,
    sumSq: 0,
    min: Infinity,
    max: -Infinity,
    histogram: new LogHistogram(config),
  }));

  const record = (year: number, value: number) => {
    const acc = accumulators[year];
    acc.count++;
    acc.sum += value;
    acc.sumSq += value * value;
    if (value < acc.min) acc.min = value;
    if (value > acc.max) acc.max = value;
    acc.histogram.record(value);
  };

  const rng = new RandomSource(spec.seed);

  if (antithetic) {
    // Antithetic variates: each draw drives a +Z path and a -Z twin. The
    // marginal distribution of each path is unchanged (Z and -Z are
    // identically distributed), but the pair's average has sharply lower
    // variance because GBM terminal wealth is monotone in the summed
    // shocks, making the twins strongly negatively correlated. An odd
    // final path falls back to independent sampling.
    const pairCount = Math.floor(spec.pathCount / 2);
    for (let pair = 0; pair < pairCount; pair++) {
      let plus = initialValue;
      let minus = initialValue;
      for (let year = 0; year < years; year++) {
        for (let step = 0; step < STEPS_PER_YEAR; step++) {
          const shock = diffusion * rng.nextNormal();
          plus = plus * Math.exp(drift + shock) + monthlyContribution;
          minus = minus * Math.exp(drift - shock) + monthlyContribution;
        }
        record(year, plus);
        record(year, minus);
      }
    }
    if (spec.pathCount % 2 === 1) {
      let value = initialValue;
      for (let year = 0; year < years; year++) {
        for (let step = 0; step < STEPS_PER_YEAR; step++) {
          value = value * Math.exp(drift + diffusion * rng.nextNormal()) + monthlyContribution;
        }
        record(year, value);
      }
    }
  } else {
    for (let path = 0; path < spec.pathCount; path++) {
      let value = initialValue;
      for (let year = 0; year < years; year++) {
        for (let step = 0; step < STEPS_PER_YEAR; step++) {
          value = value * Math.exp(drift + diffusion * rng.nextNormal()) + monthlyContribution;
        }
        record(year, value);
      }
    }
  }

  const yearSummaries: YearSummary[] = accumulators.map((acc, index) => ({
    year: index + 1,
    count: acc.count,
    sum: acc.sum,
    sumSq: acc.sumSq,
    min: acc.min,
    max: acc.max,
    bins: Array.from(acc.histogram.counts),
  }));

  return {
    jobId: spec.jobId,
    chunkIndex: spec.chunkIndex,
    pathCount: spec.pathCount,
    seed: spec.seed,
    histogram: config,
    years: yearSummaries,
  };
}
