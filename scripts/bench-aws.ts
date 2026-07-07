// AWS Batch scaling benchmark: the headline numbers.
//
// For each worker count, submits a fleet of Batch worker jobs, waits until
// every task is RUNNING (excluding Fargate cold-start from measurements),
// then runs REPEATS seeded simulation jobs per path count and measures
// submit-to-completed wall time. The fleet is terminated between blocks so
// counts never overlap. Results append to bench-results/aws.jsonl.
//
// Same env contract as run-aws-job.ts (no .env load - emulator creds must
// not leak in): DATABASE_URL, WEALTHSIM_QUEUE_URL, WEALTHSIM_BUCKET,
// AWS_REGION, plus optional WORKERS / PATHS_LIST / REPEATS.
//
// Fixed seed per path count means every run of the same workload must
// produce identical yearlyStats regardless of worker count - asserted,
// which doubles as a determinism check across the whole distributed path.

import { appendFileSync, mkdirSync } from 'node:fs';

import {
  BatchClient,
  DescribeJobsCommand,
  SubmitJobCommand,
  TerminateJobCommand,
} from '@aws-sdk/client-batch';

import { prisma } from '@/lib/db/prisma';
import { createSimulationJob, getJobStatus } from '@/lib/wealthsim/jobs';
import type { SimulationRequest } from '@/lib/wealthsim/types';

const BENCH_EMAIL = 'aws-bench@local';
const JOB_QUEUE = 'wealthsim';
const JOB_DEFINITION = 'wealthsim-worker';
// Fargate us-east-1: $0.04048/vCPU-hr + $0.004445/GB-hr; worker = 1 vCPU + 2GB
const WORKER_DOLLARS_PER_SECOND = (0.04048 + 2 * 0.004445) / 3600;

const workerCounts = (process.env.WORKERS ?? '1,2,4,8').split(',').map(Number);
const pathCounts = (process.env.PATHS_LIST ?? '1000000,10000000').split(',').map(Number);
const repeats = Number(process.env.REPEATS ?? 3);

const batch = new BatchClient({ region: process.env.AWS_REGION ?? 'us-east-1' });

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requestFor(pathCount: number): SimulationRequest {
  return {
    initialValue: 100_000,
    annualContribution: 12_000,
    meanReturn: 0.07,
    volatility: 0.15,
    years: 30,
    antithetic: true,
    pathCount,
    seed: 20260700 + pathCount / 1_000_000,
  };
}

async function submitFleet(size: number): Promise<string[]> {
  const ids: string[] = [];
  for (let index = 0; index < size; index++) {
    const result = await batch.send(
      new SubmitJobCommand({
        jobName: `bench-fleet-${size}-${index}`,
        jobQueue: JOB_QUEUE,
        jobDefinition: JOB_DEFINITION,
      }),
    );
    ids.push(result.jobId!);
  }
  return ids;
}

async function waitAllRunning(jobIds: string[]): Promise<number> {
  const started = performance.now();
  const timeoutMs = 8 * 60 * 1000;
  while (performance.now() - started < timeoutMs) {
    const described = await batch.send(new DescribeJobsCommand({ jobs: jobIds }));
    const statuses = (described.jobs ?? []).map((job) => job.status);
    const running = statuses.filter((status) => status === 'RUNNING').length;
    const dead = statuses.filter((status) => status === 'FAILED' || status === 'SUCCEEDED');
    if (dead.length > 0) {
      throw new Error(`fleet member exited early (${dead.length} FAILED/SUCCEEDED)`);
    }
    if (running === jobIds.length) return performance.now() - started;
    await sleep(3_000);
  }
  throw new Error('fleet did not reach RUNNING in time');
}

async function terminateFleet(jobIds: string[]): Promise<void> {
  for (const jobId of jobIds) {
    try {
      await batch.send(
        new TerminateJobCommand({ jobId, reason: 'bench fleet teardown between blocks' }),
      );
    } catch {
      // already exited via idle-exit - fine
    }
  }
}

async function runSimJob(
  userId: string,
  pathCount: number,
): Promise<{ wallMs: number; computeMs: number; yearlyStats: string }> {
  const started = performance.now();
  const job = await createSimulationJob(userId, requestFor(pathCount));
  const timeoutMs = 20 * 60 * 1000;
  while (performance.now() - started < timeoutMs) {
    await sleep(1_000);
    const status = await getJobStatus(userId, job.id);
    if (!status) throw new Error('job disappeared');
    if (status.status === 'completed' && status.result) {
      return {
        wallMs: performance.now() - started,
        computeMs: status.result.totalComputeMs,
        yearlyStats: JSON.stringify(status.result.yearlyStats),
      };
    }
    if (status.status === 'failed') throw new Error(`job failed: ${status.error}`);
  }
  throw new Error('sim job timed out');
}

async function main() {
  if (process.env.SQS_ENDPOINT || process.env.S3_ENDPOINT) {
    throw new Error('endpoint overrides are set; this script targets real AWS only');
  }
  if (!(process.env.WEALTHSIM_QUEUE_URL ?? '').includes('sqs.us-east-1.amazonaws.com')) {
    throw new Error('WEALTHSIM_QUEUE_URL does not look like a real SQS URL');
  }

  const user = await prisma.user.upsert({
    where: { email: BENCH_EMAIL },
    create: { email: BENCH_EMAIL, passwordHash: 'not-a-login-account' },
    update: {},
  });

  mkdirSync('bench-results', { recursive: true });
  const resultsFile = 'bench-results/aws.jsonl';
  const reference = new Map<number, string>();

  console.log(
    `AWS Batch scaling benchmark: workers=[${workerCounts}] paths=[${pathCounts}] repeats=${repeats}`,
  );

  for (const workers of workerCounts) {
    console.log(`\n=== fleet of ${workers} worker(s) ===`);
    const fleet = await submitFleet(workers);
    const startupMs = await waitAllRunning(fleet);
    console.log(`fleet RUNNING after ${(startupMs / 1000).toFixed(0)}s`);

    try {
      for (const pathCount of pathCounts) {
        for (let rep = 1; rep <= repeats; rep++) {
          const { wallMs, computeMs, yearlyStats } = await runSimJob(user.id, pathCount);

          const expected = reference.get(pathCount);
          if (expected === undefined) {
            reference.set(pathCount, yearlyStats);
          } else if (expected !== yearlyStats) {
            throw new Error(
              `determinism violation: ${pathCount}-path results differ from reference`,
            );
          }

          const pathsPerSecond = pathCount / (wallMs / 1000);
          const dollars = workers * (wallMs / 1000) * WORKER_DOLLARS_PER_SECOND;
          const record = {
            timestamp: new Date().toISOString(),
            workers,
            pathCount,
            rep,
            wallMs: Math.round(wallMs),
            computeMs: Math.round(computeMs),
            pathsPerSecond: Math.round(pathsPerSecond),
            fleetDollars: Number(dollars.toFixed(6)),
            dollarsPerMillionPaths: Number(((dollars * 1_000_000) / pathCount).toFixed(6)),
            startupMs: Math.round(startupMs),
          };
          appendFileSync(resultsFile, `${JSON.stringify(record)}\n`);
          console.log(
            `${workers}w ${(pathCount / 1e6).toFixed(0)}M rep${rep}: ` +
              `${(wallMs / 1000).toFixed(1)}s wall, ` +
              `${Math.round(pathsPerSecond).toLocaleString('en-US')} paths/s, ` +
              `$${record.dollarsPerMillionPaths.toFixed(4)}/M paths`,
          );
        }
      }
    } finally {
      await terminateFleet(fleet);
      console.log(`fleet of ${workers} terminated`);
    }
  }

  console.log(`\ndone; results in ${resultsFile}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
