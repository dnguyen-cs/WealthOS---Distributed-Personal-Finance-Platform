// Submits one seeded simulation job against the REAL AWS queue/bucket and
// waits for completion (Postgres stays local). Deliberately does NOT load
// .env: the local emulator credentials (minioadmin) must never leak into
// an AWS-targeted run, so the caller provides all env explicitly:
//
//   DATABASE_URL=postgresql://wealthos:wealthos@localhost:5434/wealthos \
//   WEALTHSIM_QUEUE_URL=https://sqs.us-east-1.amazonaws.com/<acct>/wealthsim-jobs \
//   WEALTHSIM_BUCKET=wealthos-wealthsim-<acct> \
//   AWS_REGION=us-east-1 \
//   PATHS=200000 SEED=20260707 pnpm exec tsx scripts/run-aws-job.ts
//
// AWS credentials come from the default provider chain (CLI profile).
// Start Batch workers separately: aws batch submit-job --job-queue wealthsim ...

import { prisma } from '@/lib/db/prisma';
import { createSimulationJob, getJobStatus } from '@/lib/wealthsim/jobs';
import type { SimulationRequest } from '@/lib/wealthsim/types';

const BENCH_EMAIL = 'aws-bench@local';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set`);
  return value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  if (process.env.SQS_ENDPOINT || process.env.S3_ENDPOINT) {
    throw new Error('endpoint overrides are set; this script targets real AWS only');
  }
  if (!requireEnv('WEALTHSIM_QUEUE_URL').includes('sqs.us-east-1.amazonaws.com')) {
    throw new Error('WEALTHSIM_QUEUE_URL does not look like a real SQS URL');
  }
  requireEnv('WEALTHSIM_BUCKET');
  requireEnv('DATABASE_URL');

  const pathCount = Number(process.env.PATHS ?? 200_000);
  const seed = Number(process.env.SEED ?? 20260707);

  const request: SimulationRequest = {
    initialValue: 100_000,
    annualContribution: 12_000,
    meanReturn: 0.07,
    volatility: 0.15,
    years: 30,
    antithetic: true,
    pathCount,
    seed,
  };

  const user = await prisma.user.upsert({
    where: { email: BENCH_EMAIL },
    create: { email: BENCH_EMAIL, passwordHash: 'not-a-login-account' },
    update: {},
  });

  const started = performance.now();
  const job = await createSimulationJob(user.id, request);
  console.log(
    `submitted job ${job.id}: ${pathCount.toLocaleString('en-US')} paths, ` +
      `${job.chunkCount} chunks, seed ${seed}`,
  );

  let lastChunks = -1;
  const timeoutMs = 15 * 60 * 1000;
  while (performance.now() - started < timeoutMs) {
    await sleep(2_000);
    const status = await getJobStatus(user.id, job.id);
    if (!status) throw new Error('job disappeared');
    if (status.chunksCompleted !== lastChunks) {
      lastChunks = status.chunksCompleted;
      console.log(
        `t=${((performance.now() - started) / 1000).toFixed(0)}s ` +
          `${status.status} ${status.chunksCompleted}/${status.chunkCount} chunks`,
      );
    }
    if (status.status === 'completed' && status.result) {
      const final = status.result.yearlyStats[status.result.yearlyStats.length - 1];
      console.log(
        `completed: ${status.result.pathsCompleted.toLocaleString('en-US')} paths, ` +
          `wall ${(status.result.wallMs / 1000).toFixed(1)}s, ` +
          `compute ${(status.result.totalComputeMs / 1000).toFixed(1)}s, ` +
          `median $${Math.round(final.p50).toLocaleString('en-US')}`,
      );
      return;
    }
    if (status.status === 'failed') throw new Error(`job failed: ${status.error}`);
  }
  throw new Error('timed out');
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
