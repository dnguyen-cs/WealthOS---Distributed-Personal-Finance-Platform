// Kill-a-worker chaos test: empirical proof of the idempotency claim.
//
// Two jobs run with the same fixed seed. The control job completes
// undisturbed. During the chaos job, one of the (at least two) worker
// containers is killed mid-run; SQS redelivers its in-flight chunk after
// the visibility timeout and the surviving worker picks it up. Because
// chunk processing is deterministic and results land at deterministic
// object keys, the disrupted job must produce byte-identical yearlyStats
// to the control run - and this script asserts exactly that.
//
// Preconditions: docker compose stack up with at least two workers:
//   docker compose up -d db queue objectstore --scale worker=2 worker
// Run:
//   pnpm exec tsx scripts/chaos-test.ts
import 'dotenv/config';

import { execSync } from 'node:child_process';

import { prisma } from '@/lib/db/prisma';
import { createSimulationJob, getJobStatus } from '@/lib/wealthsim/jobs';
import { engineSchema, type SimulationRequest } from '@/lib/wealthsim/types';

const CHAOS_EMAIL = 'chaos-test@local';
const SEED = 20260706;
const KILL_AFTER_CHUNKS = 8;

// ENGINE=go targets the Go worker fleet (compose service "worker-go");
// default is the Node fleet. The idempotency claim must hold per engine.
const engine = engineSchema.parse(process.env.ENGINE ?? 'node');
const workerService = engine === 'go' ? 'worker-go' : 'worker';

const request: SimulationRequest = {
  initialValue: 100_000,
  annualContribution: 12_000,
  meanReturn: 0.07,
  volatility: 0.15,
  years: 30,
  antithetic: true,
  pathCount: 2_000_000,
  seed: SEED,
  engine,
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function workerContainerIds(): string[] {
  return execSync(`docker compose ps -q ${workerService}`, { encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

async function runJob(
  userId: string,
  label: string,
  killDuring: boolean,
): Promise<{ yearlyStats: string; pathsCompleted: number; wallMs: number }> {
  const started = performance.now();
  const job = await createSimulationJob(userId, request);
  console.log(`[${label}] submitted job ${job.id} (${job.chunkCount} chunks, seed ${SEED})`);

  let killed = false;
  const timeoutMs = 6 * 60 * 1000;
  while (performance.now() - started < timeoutMs) {
    await sleep(1_000);
    const status = await getJobStatus(userId, job.id);
    if (!status) throw new Error(`[${label}] job disappeared`);

    if (killDuring && !killed && status.chunksCompleted >= KILL_AFTER_CHUNKS) {
      const victim = workerContainerIds()[0];
      execSync(`docker kill ${victim}`);
      killed = true;
      console.log(
        `[${label}] killed worker ${victim.slice(0, 12)} at ` +
          `${status.chunksCompleted}/${status.chunkCount} chunks`,
      );
    }

    if (status.status === 'completed' && status.result) {
      const wallMs = Math.round(performance.now() - started);
      console.log(
        `[${label}] completed: ${status.result.pathsCompleted.toLocaleString('en-US')} paths ` +
          `in ${(wallMs / 1000).toFixed(1)}s${killed ? ' (with a worker killed mid-run)' : ''}`,
      );
      if (killDuring && !killed) {
        throw new Error(
          `[${label}] job finished before the kill trigger; increase pathCount or lower KILL_AFTER_CHUNKS`,
        );
      }
      return {
        yearlyStats: JSON.stringify(status.result.yearlyStats),
        pathsCompleted: status.result.pathsCompleted,
        wallMs,
      };
    }
    if (status.status === 'failed') {
      throw new Error(`[${label}] job failed: ${status.error}`);
    }
  }
  throw new Error(`[${label}] timed out after ${timeoutMs / 1000}s`);
}

async function main() {
  const workers = workerContainerIds();
  if (workers.length < 2) {
    console.error(
      `Need at least 2 ${engine} workers (found ${workers.length}). Start them with:\n` +
        `  docker compose up -d --scale ${workerService}=2 ${workerService}`,
    );
    process.exit(1);
  }

  const user = await prisma.user.upsert({
    where: { email: CHAOS_EMAIL },
    create: { email: CHAOS_EMAIL, passwordHash: 'not-a-login-account' },
    update: {},
  });
  // idempotent reruns: clear previous chaos jobs
  await prisma.simulationJob.deleteMany({ where: { userId: user.id } });

  const control = await runJob(user.id, 'control', false);
  const chaos = await runJob(user.id, 'chaos', true);

  console.log('');
  if (control.pathsCompleted !== chaos.pathsCompleted) {
    console.error(
      `FAIL: path counts differ (${control.pathsCompleted} vs ${chaos.pathsCompleted})`,
    );
    process.exit(1);
  }
  if (control.yearlyStats !== chaos.yearlyStats) {
    console.error('FAIL: yearlyStats differ between control and chaos runs');
    process.exit(1);
  }
  console.log(
    'PASS: chaos run produced byte-identical yearlyStats to the control run ' +
      `(${control.pathsCompleted.toLocaleString('en-US')} paths; ` +
      `control ${(control.wallMs / 1000).toFixed(1)}s, chaos ${(chaos.wallMs / 1000).toFixed(1)}s ` +
      'including redelivery wait).',
  );
  console.log(
    `Restore the worker fleet with: docker compose up -d --scale ${workerService}=2 ${workerService}`,
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
