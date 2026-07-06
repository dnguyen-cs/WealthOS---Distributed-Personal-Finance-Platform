import { percentileFromBins, sameConfig } from '@/lib/wealthsim/histogram';
import type { ChunkSummary, ModelParams, YearlyStat } from '@/lib/wealthsim/types';

// Merging chunk summaries is exact for count/sum/sumSq/min/max (plain
// sums and extrema) and exact-to-bin-width for percentiles (bin counts
// add element-wise because every chunk used identical bounds).

export interface AggregateResult {
  pathCount: number;
  yearlyStats: YearlyStat[];
}

export function aggregateChunkSummaries(
  params: ModelParams,
  summaries: ChunkSummary[],
): AggregateResult {
  if (summaries.length === 0) throw new Error('aggregateChunkSummaries: no summaries');

  const config = summaries[0].histogram;
  const years = params.years;
  for (const summary of summaries) {
    if (!sameConfig(summary.histogram, config)) {
      throw new Error(
        `aggregateChunkSummaries: chunk ${summary.chunkIndex} has mismatched histogram config`,
      );
    }
    if (summary.years.length !== years) {
      throw new Error(
        `aggregateChunkSummaries: chunk ${summary.chunkIndex} has ${summary.years.length} years, expected ${years}`,
      );
    }
  }

  const pathCount = summaries.reduce((total, summary) => total + summary.pathCount, 0);

  const yearlyStats: YearlyStat[] = [
    {
      year: 0,
      mean: params.initialValue,
      stddev: 0,
      min: params.initialValue,
      max: params.initialValue,
      p05: params.initialValue,
      p10: params.initialValue,
      p25: params.initialValue,
      p50: params.initialValue,
      p75: params.initialValue,
      p90: params.initialValue,
      p95: params.initialValue,
    },
  ];

  for (let yearIndex = 0; yearIndex < years; yearIndex++) {
    let count = 0;
    let sum = 0;
    let sumSq = 0;
    let min = Infinity;
    let max = -Infinity;
    const bins = new Float64Array(config.binCount);

    for (const summary of summaries) {
      const year = summary.years[yearIndex];
      count += year.count;
      sum += year.sum;
      sumSq += year.sumSq;
      if (year.min < min) min = year.min;
      if (year.max > max) max = year.max;
      for (let bin = 0; bin < config.binCount; bin++) bins[bin] += year.bins[bin];
    }

    if (count !== pathCount) {
      throw new Error(
        `aggregateChunkSummaries: year ${yearIndex + 1} has ${count} samples, expected ${pathCount}`,
      );
    }

    const mean = sum / count;
    const variance = Math.max(sumSq / count - mean * mean, 0);
    const quantile = (q: number) => percentileFromBins(config, bins, count, q);

    yearlyStats.push({
      year: yearIndex + 1,
      mean,
      stddev: Math.sqrt(variance),
      min,
      max,
      p05: quantile(0.05),
      p10: quantile(0.1),
      p25: quantile(0.25),
      p50: quantile(0.5),
      p75: quantile(0.75),
      p90: quantile(0.9),
      p95: quantile(0.95),
    });
  }

  return { pathCount, yearlyStats };
}
