package sim

import "math"

// Log-binned histograms are the unit of distributed aggregation; see
// src/lib/wealthsim/histogram.ts for the full rationale. This port only
// needs the recording half: merging and percentile extraction stay on the
// Node side (aggregation-on-read), so they are deliberately not
// duplicated here.

type HistogramConfig struct {
	Lo       float64 `json:"lo"`
	Hi       float64 `json:"hi"`
	BinCount int     `json:"binCount"`
}

const DefaultBinCount = 1024

// HistogramConfigFor mirrors histogramConfigFor in histogram.ts. Bounds
// must be a pure function of job params so every chunk of a job agrees,
// across both engines: the arithmetic is add/multiply only (correctly
// rounded per IEEE 754), so Node and Go derive bit-identical bounds.
func HistogramConfigFor(params ModelParams) HistogramConfig {
	base := params.InitialValue + params.AnnualContribution*float64(params.Years)
	return HistogramConfig{Lo: base * 1e-3, Hi: base * 1e3, BinCount: DefaultBinCount}
}

type LogHistogram struct {
	Counts []uint32
	config HistogramConfig
	logLo  float64
	scale  float64
}

func NewLogHistogram(config HistogramConfig) *LogHistogram {
	logLo := math.Log(config.Lo)
	return &LogHistogram{
		Counts: make([]uint32, config.BinCount),
		config: config,
		logLo:  logLo,
		scale:  float64(config.BinCount) / (math.Log(config.Hi) - logLo),
	}
}

func (h *LogHistogram) indexFor(value float64) int {
	if value <= h.config.Lo {
		return 0
	}
	if value >= h.config.Hi {
		return h.config.BinCount - 1
	}
	index := int(math.Floor((math.Log(value) - h.logLo) * h.scale))
	if index < 0 {
		index = 0
	}
	if index > h.config.BinCount-1 {
		index = h.config.BinCount - 1
	}
	return index
}

func (h *LogHistogram) Record(value float64) {
	h.Counts[h.indexFor(value)]++
}
