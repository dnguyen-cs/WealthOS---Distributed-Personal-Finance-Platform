// Log-binned histograms are the unit of distributed aggregation: every
// chunk of a job records portfolio values into bins with identical bounds
// (derived deterministically from the job params), so merging chunk
// results is an exact element-wise sum of counts. Percentiles are then
// read off the merged histogram, accurate to within one bin width.
//
// This is the standard alternative to shipping raw path values around:
// a 1M-path job would need ~8 MB per year of raw doubles, versus ~4 KB
// of bins, and quantiles cannot be merged across workers any other way
// without approximation sketches (t-digest etc.).

export interface HistogramConfig {
  lo: number;
  hi: number;
  binCount: number;
}

export const DEFAULT_BIN_COUNT = 1024;

export interface HistogramModelParams {
  initialValue: number;
  annualContribution: number;
  years: number;
}

// Bounds must be a pure function of job params so every chunk agrees.
// base*1e-3 .. base*1e3 spans six orders of magnitude; with 1024 log bins
// each bin is ~1.4% wide, and geometric interpolation inside a bin keeps
// percentile error well under that. Outliers clamp to the edge bins but
// exact min/max are tracked separately by the accumulators.
export function histogramConfigFor(params: HistogramModelParams): HistogramConfig {
  const base = params.initialValue + params.annualContribution * params.years;
  return { lo: base * 1e-3, hi: base * 1e3, binCount: DEFAULT_BIN_COUNT };
}

export function sameConfig(a: HistogramConfig, b: HistogramConfig): boolean {
  return a.lo === b.lo && a.hi === b.hi && a.binCount === b.binCount;
}

export class LogHistogram {
  readonly counts: Uint32Array;
  private readonly logLo: number;
  private readonly scale: number;

  constructor(readonly config: HistogramConfig) {
    this.counts = new Uint32Array(config.binCount);
    this.logLo = Math.log(config.lo);
    this.scale = config.binCount / (Math.log(config.hi) - this.logLo);
  }

  indexFor(value: number): number {
    if (value <= this.config.lo) return 0;
    if (value >= this.config.hi) return this.config.binCount - 1;
    const index = Math.floor((Math.log(value) - this.logLo) * this.scale);
    return Math.min(Math.max(index, 0), this.config.binCount - 1);
  }

  record(value: number): void {
    this.counts[this.indexFor(value)]++;
  }
}

function binLowerBound(config: HistogramConfig, index: number): number {
  const logLo = Math.log(config.lo);
  const logRange = Math.log(config.hi) - logLo;
  return Math.exp(logLo + (index / config.binCount) * logRange);
}

// Quantile q in [0, 1] from merged bin counts, interpolated geometrically
// inside the containing bin (bins are log-spaced, so the geometric mean is
// the natural midpoint).
export function percentileFromBins(
  config: HistogramConfig,
  counts: ArrayLike<number>,
  totalCount: number,
  q: number,
): number {
  if (totalCount <= 0) throw new Error('percentileFromBins: empty histogram');
  const rank = q * totalCount;
  let cumulative = 0;
  for (let i = 0; i < config.binCount; i++) {
    const count = counts[i];
    if (count === 0) continue;
    if (cumulative + count >= rank) {
      const lower = binLowerBound(config, i);
      const upper = binLowerBound(config, i + 1);
      const fraction = Math.min(Math.max((rank - cumulative) / count, 0), 1);
      return lower * Math.pow(upper / lower, fraction);
    }
    cumulative += count;
  }
  return config.hi;
}
