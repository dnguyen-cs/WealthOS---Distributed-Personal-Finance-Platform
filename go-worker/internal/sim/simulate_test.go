package sim

import (
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

// --- cross-engine golden comparison ---------------------------------------

type goldenCase struct {
	Name    string          `json:"name"`
	Spec    json.RawMessage `json:"spec"`
	Summary ChunkSummary    `json:"summary"`
}

func loadGolden(t *testing.T) []goldenCase {
	t.Helper()
	path := filepath.Join("..", "..", "testdata", "kernel_golden.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			t.Skipf("golden summaries missing; generate with: pnpm exec tsx scripts/gen-parity-vectors.ts")
		}
		t.Fatalf("read golden: %v", err)
	}
	var cases []goldenCase
	if err := json.Unmarshal(raw, &cases); err != nil {
		t.Fatalf("decode golden: %v", err)
	}
	return cases
}

func relClose(got, expected, relTol float64) bool {
	return math.Abs(got-expected) <= relTol*math.Max(1, math.Abs(expected))
}

// The hard contract: moments within 1e-9 relative and bin counts within a
// tiny L1 budget (a value landing within a libm-ulp of a bin edge can hop
// one bin). The test additionally reports whether the comparison happened
// to be fully bit-exact, which is the expected outcome in practice since
// both runtimes ship fdlibm-derived exp/log.
func TestKernelMatchesNodeGoldenSummaries(t *testing.T) {
	for _, golden := range loadGolden(t) {
		t.Run(golden.Name, func(t *testing.T) {
			spec, err := ParseChunkSpec(golden.Spec)
			if err != nil {
				t.Fatalf("parse golden spec: %v", err)
			}
			got := SimulateChunk(spec)

			if got.JobID != golden.Summary.JobID ||
				got.ChunkIndex != golden.Summary.ChunkIndex ||
				got.PathCount != golden.Summary.PathCount ||
				got.Seed != golden.Summary.Seed {
				t.Fatalf("identity fields differ: got %+v", got)
			}
			for _, pair := range [][2]float64{
				{got.Histogram.Lo, golden.Summary.Histogram.Lo},
				{got.Histogram.Hi, golden.Summary.Histogram.Hi},
			} {
				if math.Float64bits(pair[0]) != math.Float64bits(pair[1]) {
					t.Fatalf("histogram bounds differ: got %v, node %v", got.Histogram, golden.Summary.Histogram)
				}
			}
			if len(got.Years) != len(golden.Summary.Years) {
				t.Fatalf("year count differs: got %d, node %d", len(got.Years), len(golden.Summary.Years))
			}

			bitExact := true
			maxRel := 0.0
			totalL1 := 0
			for i, year := range got.Years {
				expected := golden.Summary.Years[i]
				if year.Count != expected.Count || year.Year != expected.Year {
					t.Fatalf("year %d identity: got count=%d, node count=%d", year.Year, year.Count, expected.Count)
				}
				for _, m := range []struct {
					name          string
					got, expected float64
				}{
					{"sum", year.Sum, expected.Sum},
					{"sumSq", year.SumSq, expected.SumSq},
					{"min", year.Min, expected.Min},
					{"max", year.Max, expected.Max},
				} {
					if !relClose(m.got, m.expected, 1e-9) {
						t.Fatalf("year %d %s: got %v, node produced %v", year.Year, m.name, m.got, m.expected)
					}
					if math.Float64bits(m.got) != math.Float64bits(m.expected) {
						bitExact = false
						rel := math.Abs(m.got-m.expected) / math.Max(1, math.Abs(m.expected))
						if rel > maxRel {
							maxRel = rel
						}
					}
				}
				l1 := 0
				for bin := range year.Bins {
					diff := int(year.Bins[bin]) - int(expected.Bins[bin])
					if diff < 0 {
						diff = -diff
					}
					l1 += diff
				}
				if l1 > 4 {
					t.Fatalf("year %d bins: L1 distance %d exceeds edge-hop budget", year.Year, l1)
				}
				if l1 != 0 {
					bitExact = false
					totalL1 += l1
				}
			}
			t.Logf("%s: bit-exact with Node = %v (max moment rel diff %.3g, total bin L1 %d)",
				golden.Name, bitExact, maxRel, totalL1)
		})
	}
}

// --- closed forms and invariants (no vectors needed) -----------------------

func boolPtr(value bool) *bool { return &value }

func testParams(volatility float64, antithetic bool) ModelParams {
	return ModelParams{
		InitialValue:       100_000,
		AnnualContribution: 0,
		MeanReturn:         0.07,
		Volatility:         volatility,
		Years:              10,
		Antithetic:         boolPtr(antithetic),
	}
}

// The monthly-discretized GBM product is exactly lognormal, so the
// continuous closed forms E[V_t] = V0 e^{mu t} and
// Var[V_t] = V0^2 e^{2 mu t} (e^{sigma^2 t} - 1) hold without
// discretization error; only Monte Carlo noise remains.
func TestGBMClosedForms(t *testing.T) {
	for _, antithetic := range []bool{true, false} {
		params := testParams(0.15, antithetic)
		summary := SimulateChunk(ChunkSpec{
			JobID: "closed-form", ChunkIndex: 0, PathCount: 200_000, Seed: 20260712, Params: params,
		})
		final := summary.Years[len(summary.Years)-1]
		mean := final.Sum / float64(final.Count)
		variance := final.SumSq/float64(final.Count) - mean*mean

		years := float64(params.Years)
		expectedMean := params.InitialValue * math.Exp(params.MeanReturn*years)
		expectedVar := params.InitialValue * params.InitialValue *
			math.Exp(2*params.MeanReturn*years) *
			(math.Exp(params.Volatility*params.Volatility*years) - 1)

		if !relClose(mean, expectedMean, 0.01) {
			t.Fatalf("antithetic=%v mean: got %v, closed form %v", antithetic, mean, expectedMean)
		}
		if !relClose(variance, expectedVar, 0.05) {
			t.Fatalf("antithetic=%v variance: got %v, closed form %v", antithetic, variance, expectedVar)
		}
	}
}

// Zero volatility turns the kernel into a deterministic annuity: every
// path is identical, so min == max == the recurrence value.
func TestZeroVolatilityAnnuity(t *testing.T) {
	params := testParams(0, true)
	params.AnnualContribution = 12_000
	summary := SimulateChunk(ChunkSpec{
		JobID: "annuity", ChunkIndex: 0, PathCount: 100, Seed: 1, Params: params,
	})

	value := params.InitialValue
	drift := params.MeanReturn / StepsPerYear
	monthly := params.AnnualContribution / StepsPerYear
	for year := 0; year < params.Years; year++ {
		for step := 0; step < StepsPerYear; step++ {
			value = value*math.Exp(drift) + monthly
		}
		got := summary.Years[year]
		if got.Min != got.Max {
			t.Fatalf("year %d: zero-vol paths diverged (min %v, max %v)", year+1, got.Min, got.Max)
		}
		if math.Float64bits(got.Min) != math.Float64bits(value) {
			t.Fatalf("year %d: got %v, recurrence gives %v", year+1, got.Min, value)
		}
	}
}

func TestSameSeedIsBitIdentical(t *testing.T) {
	spec := ChunkSpec{
		JobID: "det", ChunkIndex: 5, PathCount: 10_000, Seed: 987654321, Params: testParams(0.15, true),
	}
	if !reflect.DeepEqual(SimulateChunk(spec), SimulateChunk(spec)) {
		t.Fatal("same spec produced different summaries")
	}
}

func TestOddPathCountRecordsEveryPath(t *testing.T) {
	spec := ChunkSpec{
		JobID: "odd", ChunkIndex: 0, PathCount: 999, Seed: 42, Params: testParams(0.15, true),
	}
	for _, year := range SimulateChunk(spec).Years {
		if year.Count != 999 {
			t.Fatalf("year %d: recorded %d paths, want 999", year.Year, year.Count)
		}
		total := 0
		for _, count := range year.Bins {
			total += int(count)
		}
		if total != 999 {
			t.Fatalf("year %d: histogram holds %d samples, want 999", year.Year, total)
		}
	}
}

func TestParseChunkSpecValidation(t *testing.T) {
	valid := []byte(`{"jobId":"j","chunkIndex":0,"pathCount":10,"seed":1,` +
		`"params":{"initialValue":1000,"annualContribution":0,"meanReturn":0.07,"volatility":0.15,"years":5}}`)
	spec, err := ParseChunkSpec(valid)
	if err != nil {
		t.Fatalf("valid spec rejected: %v", err)
	}
	if !spec.Params.AntitheticOn() {
		t.Fatal("absent antithetic field must default to on (zod .default(true) parity)")
	}

	invalid := [][]byte{
		[]byte(`not json`),
		[]byte(`{"jobId":"","chunkIndex":0,"pathCount":10,"seed":1,"params":{"initialValue":1000,"annualContribution":0,"meanReturn":0.07,"volatility":0.15,"years":5}}`),
		[]byte(`{"jobId":"j","chunkIndex":0,"pathCount":0,"seed":1,"params":{"initialValue":1000,"annualContribution":0,"meanReturn":0.07,"volatility":0.15,"years":5}}`),
		[]byte(`{"jobId":"j","chunkIndex":0,"pathCount":10,"seed":1,"params":{"initialValue":-5,"annualContribution":0,"meanReturn":0.07,"volatility":0.15,"years":5}}`),
		[]byte(`{"jobId":"j","chunkIndex":0,"pathCount":10,"seed":1,"params":{"initialValue":1000,"annualContribution":0,"meanReturn":0.07,"volatility":0.15,"years":61}}`),
	}
	for i, body := range invalid {
		if _, err := ParseChunkSpec(body); err == nil {
			t.Fatalf("invalid spec %d accepted", i)
		}
	}
}

func TestHistogramIndexEdges(t *testing.T) {
	config := HistogramConfig{Lo: 1, Hi: 1e6, BinCount: 1024}
	histogram := NewLogHistogram(config)
	if got := histogram.indexFor(0.5); got != 0 {
		t.Fatalf("below lo: got bin %d, want 0", got)
	}
	if got := histogram.indexFor(1e9); got != 1023 {
		t.Fatalf("above hi: got bin %d, want 1023", got)
	}
	previous := -1
	for value := 1.0; value <= 1e6; value *= 1.5 {
		index := histogram.indexFor(value)
		if index < previous {
			t.Fatalf("indexFor not monotonic at %v: %d < %d", value, index, previous)
		}
		previous = index
	}
}
