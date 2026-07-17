// Cross-engine parity test: the acceptance check for the polyglot fleet.
//
// Three jobs run with one fixed seed through the full local pipeline
// (queue -> containerized workers -> object store -> aggregation-on-read):
//
//   1. engine=node   - the reference
//   2. engine=go     - must match node within float-ulp tolerance
//   3. engine=go     - rerun; must match job 2 BYTE-identically, proving
//                      per-engine determinism end to end
//
// Cross-engine results are compared as parsed numbers, not bytes: the Go
// and Node kernels share a bit-exact RNG stream, but exp/log are not
// required to be correctly rounded by IEEE 754, so float accumulators can
// drift by a few ulps between runtimes (measured ~5e-16 relative at the
// kernel level). The assertion here is max relative divergence < 1e-9;
// the script also reports whether the runs happened to be byte-identical.
//
// Preconditions: docker compose up -d db queue objectstore worker worker-go
// Run: pnpm exec tsx scripts/parity-test.ts
import 'dotenv/config';

import { prisma } from '@/lib/db/prisma';
import { createSimulationJob, getJobStatus } from '@/lib/wealthsim/jobs';
import type { Engine, SimulationRequest, YearlyStat } from '@/lib/wealthsim/types';

const PARITY_EMAIL = 'parity-test@local';
const SEED = 20260713;

function requestFor(engine: Engine): SimulationRequest {
  return {
    initialValue: 100_000,
    annualContribution: 12_000,
    meanReturn: 0.07,
    volatility: 0.15,
    years: 30,
    antithetic: true,
    pathCount: 1_000_000,
    seed: SEED,
    engine,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runJob(userId: string, label: string, engine: Engine): Promise<string> {
  const started = performance.now();
  const job = await createSimulationJob(userId, requestFor(engine));
  console.log(`[${label}] submitted job ${job.id} (engine=${engine}, seed ${SEED})`);
  const timeoutMs = 5 * 60 * 1000;
  while (performance.now() - started < timeoutMs) {
    await sleep(1_000);
    const status = await getJobStatus(userId, job.id);
    if (!status) throw new Error(`[${label}] job disappeared`);
    if (status.status === 'completed' && status.result) {
      console.log(`[${label}] completed in ${((performance.now() - started) / 1000).toFixed(1)}s`);
      return JSON.stringify(status.result.yearlyStats);
    }
    if (status.status === 'failed') throw new Error(`[${label}] failed: ${status.error}`);
  }
  throw new Error(`[${label}] timed out`);
}

const STAT_FIELDS = [
  'mean',
  'stddev',
  'min',
  'max',
  'p05',
  'p10',
  'p25',
  'p50',
  'p75',
  'p90',
  'p95',
] as const;

function maxRelativeDivergence(aJson: string, bJson: string): { field: string; rel: number } {
  const a = JSON.parse(aJson) as YearlyStat[];
  const b = JSON.parse(bJson) as YearlyStat[];
  if (a.length !== b.length) throw new Error(`year counts differ: ${a.length} vs ${b.length}`);
  let worst = { field: 'none', rel: 0 };
  for (let i = 0; i < a.length; i++) {
    if (a[i].year !== b[i].year) throw new Error(`year labels differ at index ${i}`);
    for (const field of STAT_FIELDS) {
      const rel = Math.abs(a[i][field] - b[i][field]) / Math.max(1, Math.abs(b[i][field]));
      if (rel > worst.rel) worst = { field: `year ${a[i].year} ${field}`, rel };
    }
  }
  return worst;
}

async function main() {
  const user = await prisma.user.upsert({
    where: { email: PARITY_EMAIL },
    create: { email: PARITY_EMAIL, passwordHash: 'not-a-login-account' },
    update: {},
  });
  // idempotent reruns: clear previous parity jobs
  await prisma.simulationJob.deleteMany({ where: { userId: user.id } });

  const node = await runJob(user.id, 'node', 'node');
  const go = await runJob(user.id, 'go', 'go');
  const goAgain = await runJob(user.id, 'go-rerun', 'go');

  console.log('');
  if (go !== goAgain) {
    console.error('FAIL: two go-engine runs with the same seed are not byte-identical');
    process.exit(1);
  }
  console.log('PASS: go engine is deterministic end to end (rerun byte-identical)');

  const worst = maxRelativeDivergence(node, go);
  const byteIdentical = node === go;
  if (worst.rel >= 1e-9) {
    console.error(
      `FAIL: cross-engine divergence ${worst.rel.toExponential(2)} at ${worst.field} ` +
        'exceeds the 1e-9 tolerance',
    );
    process.exit(1);
  }
  console.log(
    `PASS: node and go agree within tolerance (max relative divergence ` +
      `${worst.rel.toExponential(2)} at ${worst.field}; byte-identical: ${byteIdentical})`,
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
