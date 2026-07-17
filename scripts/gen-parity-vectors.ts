// Generates the cross-engine parity test vectors consumed by the Go
// worker's test suite (go-worker/testdata/). The Node kernel is the
// reference implementation: these files pin its exact behavior so
// `go test ./...` can prove the Go port produces the same raw random
// streams bit-for-bit and the same chunk summaries to within documented
// tolerance.
//
// Regenerate after any intentional kernel change:
//   pnpm exec tsx scripts/gen-parity-vectors.ts
//
// JSON numbers round-trip doubles exactly (shortest round-trip printing
// on the JS side, correctly rounded parsing on the Go side), so float
// vectors support bit-level comparison via math.Float64bits.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { RandomSource, deriveChunkSeed, splitmix32 } from '@/lib/wealthsim/rng';
import { simulateChunk } from '@/lib/wealthsim/simulate';
import type { ChunkSpec } from '@/lib/wealthsim/types';

const OUT_DIR = join('go-worker', 'testdata');

const SPLITMIX_SEEDS = [0, 1, 42, 123456789, 2147483647, 3735928559];
const SOURCE_SEEDS = [0, 1, 42, 20260712, 2147483647, 4294967295];
const JOB_SEEDS = [0, 1, 20260712, 2147483647];
const CHUNK_INDEXES = [0, 1, 2, 39, 1999, 100000];

function take<T>(count: number, next: () => T): T[] {
  return Array.from({ length: count }, next);
}

const rngVectors = {
  // each array uses a FRESH generator instance so consumption order is
  // unambiguous for the Go side
  splitmix32: SPLITMIX_SEEDS.map((seed) => ({
    seed,
    values: take(16, splitmix32(seed)),
  })),
  randomSource: SOURCE_SEEDS.map((seed) => ({
    seed,
    uint32: (() => {
      const source = new RandomSource(seed);
      return take(64, () => source.nextUint32());
    })(),
    floats: (() => {
      const source = new RandomSource(seed);
      return take(16, () => source.nextFloat());
    })(),
    normals: (() => {
      const source = new RandomSource(seed);
      return take(16, () => source.nextNormal());
    })(),
  })),
  deriveChunkSeed: JOB_SEEDS.flatMap((jobSeed) =>
    CHUNK_INDEXES.map((chunkIndex) => ({
      jobSeed,
      chunkIndex,
      value: deriveChunkSeed(jobSeed, chunkIndex),
    })),
  ),
};

const baseParams = {
  initialValue: 100_000,
  annualContribution: 12_000,
  meanReturn: 0.07,
  volatility: 0.15,
  years: 5,
};

const goldenSpecs: Array<{ name: string; spec: ChunkSpec }> = [
  {
    name: 'antithetic-even',
    spec: {
      jobId: 'golden-a',
      chunkIndex: 0,
      pathCount: 1_000,
      seed: 424242,
      params: { ...baseParams, antithetic: true },
    },
  },
  {
    name: 'antithetic-odd',
    spec: {
      jobId: 'golden-b',
      chunkIndex: 3,
      pathCount: 999,
      seed: 777,
      params: { ...baseParams, antithetic: true },
    },
  },
  {
    name: 'independent',
    spec: {
      jobId: 'golden-c',
      chunkIndex: 0,
      pathCount: 1_000,
      seed: 424242,
      params: { ...baseParams, antithetic: false },
    },
  },
  {
    name: 'zero-vol',
    spec: {
      jobId: 'golden-d',
      chunkIndex: 0,
      pathCount: 100,
      seed: 1,
      params: { ...baseParams, volatility: 0, antithetic: true },
    },
  },
];

const kernelGolden = goldenSpecs.map(({ name, spec }) => ({
  name,
  spec,
  summary: simulateChunk(spec),
}));

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, 'rng_vectors.json'), JSON.stringify(rngVectors));
writeFileSync(join(OUT_DIR, 'kernel_golden.json'), JSON.stringify(kernelGolden));
console.log(
  `wrote ${OUT_DIR}/rng_vectors.json (${rngVectors.randomSource.length} source seeds) and ` +
    `${OUT_DIR}/kernel_golden.json (${kernelGolden.length} cases)`,
);
