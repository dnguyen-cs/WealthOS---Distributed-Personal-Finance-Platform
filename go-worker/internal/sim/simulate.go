package sim

import (
	"math"

	"wealthos/go-worker/internal/rng"
)

// SimulateChunk is the bit-faithful port of simulateChunk in simulate.ts:
// geometric Brownian motion with monthly steps and end-of-month
// contributions,
//
//	V_{n+1} = V_n * exp((mu - sigma^2/2) dt + sigma sqrt(dt) Z) + c
//
// generated as antithetic +Z/-Z pairs when enabled. Statement order,
// accumulation order, and the shared-draw structure all match the Node
// kernel exactly, so any cross-engine divergence can come only from the
// runtimes' exp/log implementations (last-ulp territory), never from the
// algorithm. Same-engine reruns are bit-identical, which is what makes
// queue redelivery idempotent.

const StepsPerYear = 12

type yearAccumulator struct {
	count     int
	sum       float64
	sumSq     float64
	min       float64
	max       float64
	histogram *LogHistogram
}

// SimulateChunk returns the summary with ComputeMs and WorkerID left at
// their zero values; the worker main loop fills those in, mirroring how
// the Node worker spreads them onto the kernel result.
func SimulateChunk(spec ChunkSpec) ChunkSummary {
	p := spec.Params
	dt := 1.0 / StepsPerYear
	drift := (p.MeanReturn - 0.5*p.Volatility*p.Volatility) * dt
	diffusion := p.Volatility * math.Sqrt(dt)
	monthlyContribution := p.AnnualContribution / StepsPerYear

	config := HistogramConfigFor(p)
	accumulators := make([]yearAccumulator, p.Years)
	for i := range accumulators {
		accumulators[i] = yearAccumulator{
			min:       math.Inf(1),
			max:       math.Inf(-1),
			histogram: NewLogHistogram(config),
		}
	}

	record := func(year int, value float64) {
		acc := &accumulators[year]
		acc.count++
		acc.sum += value
		acc.sumSq += value * value
		if value < acc.min {
			acc.min = value
		}
		if value > acc.max {
			acc.max = value
		}
		acc.histogram.Record(value)
	}

	source := rng.NewRandomSource(spec.Seed)

	if p.AntitheticOn() {
		pairCount := spec.PathCount / 2
		for pair := 0; pair < pairCount; pair++ {
			plus := p.InitialValue
			minus := p.InitialValue
			for year := 0; year < p.Years; year++ {
				for step := 0; step < StepsPerYear; step++ {
					shock := diffusion * source.NextNormal()
					plus = plus*math.Exp(drift+shock) + monthlyContribution
					minus = minus*math.Exp(drift-shock) + monthlyContribution
				}
				record(year, plus)
				record(year, minus)
			}
		}
		if spec.PathCount%2 == 1 {
			value := p.InitialValue
			for year := 0; year < p.Years; year++ {
				for step := 0; step < StepsPerYear; step++ {
					value = value*math.Exp(drift+diffusion*source.NextNormal()) + monthlyContribution
				}
				record(year, value)
			}
		}
	} else {
		for path := 0; path < spec.PathCount; path++ {
			value := p.InitialValue
			for year := 0; year < p.Years; year++ {
				for step := 0; step < StepsPerYear; step++ {
					value = value*math.Exp(drift+diffusion*source.NextNormal()) + monthlyContribution
				}
				record(year, value)
			}
		}
	}

	years := make([]YearSummary, p.Years)
	for i := range accumulators {
		acc := &accumulators[i]
		years[i] = YearSummary{
			Year:  i + 1,
			Count: acc.count,
			Sum:   acc.sum,
			SumSq: acc.sumSq,
			Min:   acc.min,
			Max:   acc.max,
			Bins:  acc.histogram.Counts,
		}
	}

	return ChunkSummary{
		JobID:      spec.JobID,
		ChunkIndex: spec.ChunkIndex,
		PathCount:  spec.PathCount,
		Seed:       spec.Seed,
		Histogram:  config,
		Years:      years,
	}
}
