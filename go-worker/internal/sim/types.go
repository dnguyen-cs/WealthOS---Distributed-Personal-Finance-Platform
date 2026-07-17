// Package sim is the Go implementation of the WealthSim chunk kernel:
// the same GBM Monte Carlo, log-binned histograms, and JSON contracts as
// src/lib/wealthsim/{types,histogram,simulate}.ts. The zod schemas on the
// Node side are the source of truth for the wire format; the structs and
// validation here mirror them field for field.
package sim

import (
	"encoding/json"
	"fmt"
)

// ModelParams mirrors modelParamsSchema in types.ts. Antithetic is a
// pointer to reproduce zod's `.default(true)`: an absent field means on.
type ModelParams struct {
	InitialValue       float64 `json:"initialValue"`
	AnnualContribution float64 `json:"annualContribution"`
	MeanReturn         float64 `json:"meanReturn"`
	Volatility         float64 `json:"volatility"`
	Years              int     `json:"years"`
	Antithetic         *bool   `json:"antithetic,omitempty"`
}

func (p ModelParams) AntitheticOn() bool {
	return p.Antithetic == nil || *p.Antithetic
}

func (p ModelParams) validate() error {
	switch {
	case !(p.InitialValue > 0 && p.InitialValue <= 1e12):
		return fmt.Errorf("initialValue %v out of range", p.InitialValue)
	case !(p.AnnualContribution >= 0 && p.AnnualContribution <= 1e9):
		return fmt.Errorf("annualContribution %v out of range", p.AnnualContribution)
	case !(p.MeanReturn >= -0.5 && p.MeanReturn <= 0.5):
		return fmt.Errorf("meanReturn %v out of range", p.MeanReturn)
	case !(p.Volatility >= 0 && p.Volatility <= 1):
		return fmt.Errorf("volatility %v out of range", p.Volatility)
	case p.Years < 1 || p.Years > 60:
		return fmt.Errorf("years %d out of range", p.Years)
	}
	return nil
}

// ChunkSpec mirrors chunkSpecSchema in types.ts: the self-contained queue
// message payload, everything a worker needs with no database access.
type ChunkSpec struct {
	JobID      string      `json:"jobId"`
	ChunkIndex int         `json:"chunkIndex"`
	PathCount  int         `json:"pathCount"`
	Seed       uint32      `json:"seed"`
	Params     ModelParams `json:"params"`
}

// ParseChunkSpec decodes and validates a queue message body. A failure
// here means the message can never succeed (the worker deletes it), so
// validation is as strict as the zod schema it mirrors.
func ParseChunkSpec(body []byte) (ChunkSpec, error) {
	var spec ChunkSpec
	if err := json.Unmarshal(body, &spec); err != nil {
		return ChunkSpec{}, fmt.Errorf("chunk spec: %w", err)
	}
	switch {
	case spec.JobID == "":
		return ChunkSpec{}, fmt.Errorf("chunk spec: empty jobId")
	case spec.ChunkIndex < 0:
		return ChunkSpec{}, fmt.Errorf("chunk spec: negative chunkIndex %d", spec.ChunkIndex)
	case spec.PathCount <= 0:
		return ChunkSpec{}, fmt.Errorf("chunk spec: non-positive pathCount %d", spec.PathCount)
	}
	if err := spec.Params.validate(); err != nil {
		return ChunkSpec{}, fmt.Errorf("chunk spec params: %w", err)
	}
	return spec, nil
}

// YearSummary mirrors yearSummarySchema in types.ts.
type YearSummary struct {
	Year  int      `json:"year"`
	Count int      `json:"count"`
	Sum   float64  `json:"sum"`
	SumSq float64  `json:"sumSq"`
	Min   float64  `json:"min"`
	Max   float64  `json:"max"`
	Bins  []uint32 `json:"bins"`
}

// ChunkSummary mirrors chunkSummarySchema in types.ts: the S3 object the
// aggregation step reads. Field names must satisfy the zod schema exactly.
type ChunkSummary struct {
	JobID      string          `json:"jobId"`
	ChunkIndex int             `json:"chunkIndex"`
	PathCount  int             `json:"pathCount"`
	Seed       uint32          `json:"seed"`
	ComputeMs  float64         `json:"computeMs"`
	WorkerID   string          `json:"workerId"`
	Histogram  HistogramConfig `json:"histogram"`
	Years      []YearSummary   `json:"years"`
}
