// Local kernel throughput benchmark, the Go counterpart of
// scripts/bench-local.ts: same 50K-path chunk shape, same 30-year monthly
// GBM workload, single goroutine first (the control number), then a
// goroutine scaling sweep. Run with:
//
//	go run ./cmd/bench                    # antithetic pairing on (default)
//	ANTITHETIC=0 go run ./cmd/bench       # independent sampling
//	THREADS=1,2,4,8,16 PATHS=1000000 go run ./cmd/bench
package main

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"wealthos/go-worker/internal/sim"
)

const chunkPaths = 50_000

func envInt(name string, fallback int) int {
	raw := os.Getenv(name)
	if raw == "" {
		return fallback
	}
	value, err := strconv.Atoi(raw)
	if err != nil {
		panic(fmt.Sprintf("%s must be an integer, got %q", name, raw))
	}
	return value
}

func specFor(chunkIndex int, antithetic bool) sim.ChunkSpec {
	return sim.ChunkSpec{
		JobID:      "bench",
		ChunkIndex: chunkIndex,
		PathCount:  chunkPaths,
		Seed:       uint32(0x9e3779b9 + chunkIndex*2654435761),
		Params: sim.ModelParams{
			InitialValue:       100_000,
			AnnualContribution: 12_000,
			MeanReturn:         0.07,
			Volatility:         0.15,
			Years:              30,
			Antithetic:         &antithetic,
		},
	}
}

func runBlock(threads, totalPaths int, antithetic bool) float64 {
	chunkCount := totalPaths / chunkPaths
	var next atomic.Int64
	started := time.Now()
	var wg sync.WaitGroup
	for t := 0; t < threads; t++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				index := int(next.Add(1)) - 1
				if index >= chunkCount {
					return
				}
				sim.SimulateChunk(specFor(index, antithetic))
			}
		}()
	}
	wg.Wait()
	elapsed := time.Since(started).Seconds()
	return float64(chunkCount*chunkPaths) / elapsed
}

func main() {
	antithetic := os.Getenv("ANTITHETIC") != "0"
	totalPaths := envInt("PATHS", 1_000_000)
	threadsRaw := os.Getenv("THREADS")
	if threadsRaw == "" {
		threadsRaw = "1,2,4,8,16"
	}
	var threadCounts []int
	for _, part := range strings.Split(threadsRaw, ",") {
		value, err := strconv.Atoi(strings.TrimSpace(part))
		if err != nil {
			panic(fmt.Sprintf("THREADS entry %q is not an integer", part))
		}
		threadCounts = append(threadCounts, value)
	}

	fmt.Printf("Go kernel bench: %d paths per block, 30y monthly GBM, antithetic=%v\n",
		totalPaths, antithetic)

	// warmup so first-block numbers are not polluted by page faults etc.
	runBlock(1, 2*chunkPaths, antithetic)

	var baseline float64
	for _, threads := range threadCounts {
		rate := runBlock(threads, totalPaths, antithetic)
		if baseline == 0 {
			baseline = rate
		}
		stepsPerSecond := rate * 30 * 12
		fmt.Printf("%2d goroutine(s): %9.0f paths/s  (%5.1fM GBM steps/s, x%.2f)\n",
			threads, rate, stepsPerSecond/1e6, rate/baseline)
	}
}
