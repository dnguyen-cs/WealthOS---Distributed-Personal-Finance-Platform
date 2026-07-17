package rng

import (
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"testing"
)

// Vectors are generated from the Node kernel (the reference
// implementation) by scripts/gen-parity-vectors.ts. Integer streams and
// uniform floats must match bit-for-bit; normals are allowed last-ulp
// slack because Math.log and math.Log are not required to be correctly
// rounded (the test still reports how many matched exactly).

type rngVectors struct {
	Splitmix32 []struct {
		Seed   uint32   `json:"seed"`
		Values []uint32 `json:"values"`
	} `json:"splitmix32"`
	RandomSource []struct {
		Seed    uint32    `json:"seed"`
		Uint32  []uint32  `json:"uint32"`
		Floats  []float64 `json:"floats"`
		Normals []float64 `json:"normals"`
	} `json:"randomSource"`
	DeriveChunkSeed []struct {
		JobSeed    uint32 `json:"jobSeed"`
		ChunkIndex int    `json:"chunkIndex"`
		Value      uint32 `json:"value"`
	} `json:"deriveChunkSeed"`
}

func loadVectors(t *testing.T) rngVectors {
	t.Helper()
	path := filepath.Join("..", "..", "testdata", "rng_vectors.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			t.Skipf("parity vectors missing; generate with: pnpm exec tsx scripts/gen-parity-vectors.ts")
		}
		t.Fatalf("read vectors: %v", err)
	}
	var vectors rngVectors
	if err := json.Unmarshal(raw, &vectors); err != nil {
		t.Fatalf("decode vectors: %v", err)
	}
	return vectors
}

func TestSplitmix32MatchesNodeBitExactly(t *testing.T) {
	for _, vector := range loadVectors(t).Splitmix32 {
		next := Splitmix32(vector.Seed)
		for i, expected := range vector.Values {
			if got := next(); got != expected {
				t.Fatalf("seed %d value %d: got %d, node produced %d", vector.Seed, i, got, expected)
			}
		}
	}
}

func TestRandomSourceUint32MatchesNodeBitExactly(t *testing.T) {
	for _, vector := range loadVectors(t).RandomSource {
		source := NewRandomSource(vector.Seed)
		for i, expected := range vector.Uint32 {
			if got := source.NextUint32(); got != expected {
				t.Fatalf("seed %d uint32 %d: got %d, node produced %d", vector.Seed, i, got, expected)
			}
		}
	}
}

func TestRandomSourceFloatMatchesNodeBitExactly(t *testing.T) {
	for _, vector := range loadVectors(t).RandomSource {
		source := NewRandomSource(vector.Seed)
		for i, expected := range vector.Floats {
			got := source.NextFloat()
			if math.Float64bits(got) != math.Float64bits(expected) {
				t.Fatalf("seed %d float %d: got %v (%x), node produced %v (%x)",
					vector.Seed, i, got, math.Float64bits(got), expected, math.Float64bits(expected))
			}
		}
	}
}

func TestRandomSourceNormalsMatchNodeWithinUlps(t *testing.T) {
	bitExact := 0
	total := 0
	for _, vector := range loadVectors(t).RandomSource {
		source := NewRandomSource(vector.Seed)
		for i, expected := range vector.Normals {
			got := source.NextNormal()
			total++
			if math.Float64bits(got) == math.Float64bits(expected) {
				bitExact++
				continue
			}
			limit := 1e-12 * math.Max(1, math.Abs(expected))
			if math.Abs(got-expected) > limit {
				t.Fatalf("seed %d normal %d: got %v, node produced %v (diff %g beyond libm slack)",
					vector.Seed, i, got, expected, math.Abs(got-expected))
			}
		}
	}
	t.Logf("normals bit-exact vs Node: %d/%d", bitExact, total)
}

func TestDeriveChunkSeedMatchesNodeBitExactly(t *testing.T) {
	for _, vector := range loadVectors(t).DeriveChunkSeed {
		if got := DeriveChunkSeed(vector.JobSeed, vector.ChunkIndex); got != vector.Value {
			t.Fatalf("jobSeed %d chunk %d: got %d, node produced %d",
				vector.JobSeed, vector.ChunkIndex, got, vector.Value)
		}
	}
}
