// Kill-a-worker chaos test against real AWS Batch: same design as the
// local scripts/chaos-test.ts, but the "kill" is a Batch TerminateJob on
// a live Fargate task, and the redelivery wait is the real queue's 300s
// visibility timeout. A control job and a chaos job share one fixed seed;
// the disrupted job must produce byte-identical yearlyStats.
//
// Same env contract as bench-aws.ts (no .env load):
//   DATABASE_URL, WEALTHSIM_QUEUE_URL, WEALTHSIM_BUCKET, AWS_REGION

import {
  BatchClient,
  DescribeJobsCommand,
  SubmitJobCommand,
  TerminateJobCommand,
} from '@aws-sdk/client-batch';

import { prisma } from '@/lib/db/prisma';
import { createSimulationJob, getJobStatus } from '@/lib/wealthsim/jobs';
import type { SimulationRequest } from '@/lib/wealthsim/types';

const CHAOS_EMAIL = 'aws-bench@local';
const SEED = 20260708;
const KILL_AFTER_CHUNKS = 8;

const request: SimulationRequest = {
  initialValue: 100_000,
  annualContribution: 12_000,
  meanReturn: 0.07,
  volatility: 0.15,
  years: 30,
  antithetic: true,
  pathCount: 2_000_000,
  seed: SEED,
};

const batch = new BatchClient({ region: process.env.AWS_REGION ?? 'us-east-1' });

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function submitFleet(size: number): Promise<string[]> {
  const ids: string[] = [];
  for (let index = 0; index < size; index++) {
    const result = await batch.send(
      new SubmitJobCommand({
        jobName: `chaos-fleet-${index}`,
        jobQueue: 'wealthsim',
        jobDefinition: 'wealthsim-worker',
        // survivors must outlive the 300s visibility timeout or the
        // redelivered chunk finds no consumer (the bug this test caught)
        containerOverrides: {
          environment: [{ name: 'WORKER_IDLE_EXIT_SECONDS', value: '360' }],
        },
      }),
    );
    ids.push(result.jobId!);
  }
  return ids;
}

async function waitAllRunning(jobIds: string[]): Promise<void> {
  const started = performance.now();
  while (performance.now() - started < 8 * 60 * 1000) {
    const described = await batch.send(new DescribeJobsCommand({ jobs: jobIds }));
    const running = (described.jobs ?? []).filter((job) => job.status === 'RUNNING').length;
    if (running === jobIds.length) return;
    await sleep(3_000);
  }
  throw new Error('fleet did not reach RUNNING in time');
}

async function terminateFleet(jobIds: string[], reason: string): Promise<void> {
  for (const jobId of jobIds) {
    try {
      await batch.send(new TerminateJobCommand({ jobId, reason }));
    } catch {
      // already exited
    }
  }
}

async function runJob(
  userId: string,
  label: string,
  killJobId: string | null,
): Promise<{ yearlyStats: string; wallMs: number }> {
  const started = performance.now();
  const job = await createSimulationJob(userId, request);
  console.log(`[${label}] submitted job ${job.id} (${job.chunkCount} chunks, seed ${SEED})`);

  let killed = false;
  const timeoutMs = 15 * 60 * 1000;
  while (performance.now() - started < timeoutMs) {
    await sleep(2_000);
    const status = await getJobStatus(userId, job.id);
    if (!status) throw new Error(`[${label}] job disappeared`);

    if (killJobId && !killed && status.chunksCompleted >= KILL_AFTER_CHUNKS) {
      await batch.send(
        new TerminateJobCommand({ jobId: killJobId, reason: 'chaos test: killing worker mid-run' }),
      );
      killed = true;
      console.log(
        `[${label}] terminated Batch task ${killJobId} at ` +
          `${status.chunksCompleted}/${status.chunkCount} chunks`,
      );
    }

    if (status.status === 'completed' && status.result) {
      const wallMs = Math.round(performance.now() - started);
      console.log(
        `[${label}] completed in ${(wallMs / 1000).toFixed(1)}s` +
          (killed ? ' (with a Fargate task terminated mid-run)' : ''),
      );
      if (killJobId && !killed) {
        throw new Error(`[${label}] finished before the kill trigger`);
      }
      return { yearlyStats: JSON.stringify(status.result.yearlyStats), wallMs };
    }
    if (status.status === 'failed') throw new Error(`[${label}] failed: ${status.error}`);
  }
  throw new Error(`[${label}] timed out`);
}

async function main() {
  if (process.env.SQS_ENDPOINT || process.env.S3_ENDPOINT) {
    throw new Error('endpoint overrides are set; this script targets real AWS only');
  }

  const user = await prisma.user.upsert({
    where: { email: CHAOS_EMAIL },
    create: { email: CHAOS_EMAIL, passwordHash: 'not-a-login-account' },
    update: {},
  });

  console.log('starting fleet of 2 Fargate workers');
  const fleet = await submitFleet(2);
  try {
    await waitAllRunning(fleet);
    console.log('fleet RUNNING');

    const control = await runJob(user.id, 'control', null);
    const chaos = await runJob(user.id, 'chaos', fleet[0]);

    console.log('');
    if (control.yearlyStats !== chaos.yearlyStats) {
      console.error('FAIL: yearlyStats differ between control and chaos runs');
      process.exit(1);
    }
    console.log(
      `PASS: chaos run byte-identical to control (control ${(control.wallMs / 1000).toFixed(1)}s, ` +
        `chaos ${(chaos.wallMs / 1000).toFixed(1)}s including the 300s visibility-timeout redelivery).`,
    );
  } finally {
    await terminateFleet(fleet, 'chaos test teardown');
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
