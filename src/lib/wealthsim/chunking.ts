import { deriveChunkSeed } from '@/lib/wealthsim/rng';
import type { ChunkSpec, ModelParams } from '@/lib/wealthsim/types';

// A job fans out as one queue message per chunk, so chunk size sets the
// unit of parallelism: 50K paths x 30 years x 12 steps is ~18M GBM steps,
// a few seconds of work - long enough to amortize queue overhead, short
// enough that a 1M-path job spreads across 20 workers.
export const DEFAULT_CHUNK_SIZE = 50_000;

export function planChunks(
  jobId: string,
  pathCount: number,
  jobSeed: number,
  params: ModelParams,
  chunkSize: number = DEFAULT_CHUNK_SIZE,
): ChunkSpec[] {
  if (pathCount <= 0) throw new Error('planChunks: pathCount must be positive');
  if (chunkSize <= 0) throw new Error('planChunks: chunkSize must be positive');
  const chunkCount = Math.ceil(pathCount / chunkSize);
  return Array.from({ length: chunkCount }, (_, index) => ({
    jobId,
    chunkIndex: index,
    pathCount: index === chunkCount - 1 ? pathCount - chunkSize * index : chunkSize,
    seed: deriveChunkSeed(jobSeed, index),
    params,
  }));
}
