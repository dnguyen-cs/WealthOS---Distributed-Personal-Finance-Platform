// Local Monte Carlo benchmark: the single-machine control group that the
// distributed (AWS Batch) scaling curve gets compared against.
//
//   pnpm bench
//
// Section 1 measures single-threaded kernel throughput at increasing path
// counts. Section 2 fans the same total workload out across
// worker_threads to measure intra-machine scaling.

import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

import { deriveChunkSeed } from '@/lib/wealthsim/rng';
import { STEPS_PER_YEAR, simulateChunk } from '@/lib/wealthsim/simulate';
import type { ChunkSpec, ModelParams } from '@/lib/wealthsim/types';

const params: ModelParams = {
  initialValue: 100_000,
  annualContribution: 12_000,
  meanReturn: 0.07,
  volatility: 0.15,
  years: 30,
  antithetic: true,
};

const stepsPerPath = params.years * STEPS_PER_YEAR;

function spec(pathCount: number, chunkIndex: number): ChunkSpec {
  return {
    jobId: 'bench',
    chunkIndex,
    pathCount,
    seed: deriveChunkSeed(20260705, chunkIndex),
    params,
  };
}

function formatRate(pathsPerSecond: number): string {
  return `${Math.round(pathsPerSecond).toLocaleString('en-US')} paths/s`;
}

async function runThreads(totalPaths: number, workerCount: number): Promise<number> {
  const perWorker = Math.ceil(totalPaths / workerCount);
  const workerFile = fileURLToPath(new URL('./bench-thread.mjs', import.meta.url));
  const started = performance.now();
  await Promise.all(
    Array.from({ length: workerCount }, (_, index) => {
      const pathCount =
        index === workerCount - 1 ? totalPaths - perWorker * (workerCount - 1) : perWorker;
      return new Promise<void>((resolve, reject) => {
        const worker = new Worker(workerFile, {
          workerData: spec(pathCount, index),
        });
        worker.once('message', () => resolve());
        worker.once('error', reject);
        worker.once('exit', (code) => {
          if (code !== 0) reject(new Error(`bench worker exited with code ${code}`));
        });
      });
    }),
  );
  return performance.now() - started;
}

async function main() {
  const cpu = os.cpus()[0]?.model ?? 'unknown CPU';
  const cores = os.availableParallelism();
  console.log(`WealthSim local benchmark`);
  console.log(`${cpu} | ${cores} logical cores | node ${process.version}`);
  console.log(
    `Model: GBM, ${params.years}y horizon, ${STEPS_PER_YEAR} steps/year (${stepsPerPath} steps/path)\n`,
  );

  // JIT warmup so the first measurement is not compiling the hot loop.
  simulateChunk(spec(10_000, 999));

  console.log('Single-threaded throughput');
  for (const pathCount of [10_000, 100_000, 1_000_000]) {
    const started = performance.now();
    simulateChunk(spec(pathCount, 0));
    const ms = performance.now() - started;
    const rate = pathCount / (ms / 1000);
    console.log(
      `  ${pathCount.toLocaleString('en-US').padStart(9)} paths  ${Math.round(ms)
        .toLocaleString('en-US')
        .padStart(7)} ms  ${formatRate(rate).padStart(20)}  ${Math.round(
        (rate * stepsPerPath) / 1e6,
      )}M steps/s`,
    );
  }

  const totalPaths = 1_000_000;
  console.log(`\nworker_threads scaling (${totalPaths.toLocaleString('en-US')} paths total)`);
  const counts = [1, 2, 4, 8, 16].filter((count) => count <= cores);
  let baselineMs: number | null = null;
  for (const workerCount of counts) {
    const ms = await runThreads(totalPaths, workerCount);
    baselineMs ??= ms;
    const rate = totalPaths / (ms / 1000);
    console.log(
      `  ${String(workerCount).padStart(2)} workers  ${Math.round(ms)
        .toLocaleString('en-US')
        .padStart(7)} ms  ${formatRate(rate).padStart(20)}  speedup x${(baselineMs / ms).toFixed(
        2,
      )}`,
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
