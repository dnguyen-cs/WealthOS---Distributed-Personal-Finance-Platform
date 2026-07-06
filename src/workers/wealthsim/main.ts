// WealthSim compute worker: pulls chunk specs from SQS, runs the Monte
// Carlo kernel, writes one summary object per chunk to object storage.
//
// Deliberately stateless - no database, no Redis. Everything a chunk
// needs rides in the queue message, and results land at a deterministic
// storage key, so an at-least-once redelivery just overwrites the same
// object with identical bytes. That makes the worker safe to scale, kill,
// and retry freely, which is exactly what AWS Batch on Fargate assumes.
//
// Run locally with `pnpm worker` (against ElasticMQ + MinIO) or as the
// container CMD in docker/Dockerfile.worker.
import 'dotenv/config';

import { randomUUID } from 'node:crypto';
import os from 'node:os';

import {
  deleteMessage,
  parseChunkSpec,
  queueUrl,
  receiveMessage,
} from '@/lib/wealthsim/queue';
import { simulateChunk } from '@/lib/wealthsim/simulate';
import { ensureLocalBucket, putChunkSummary } from '@/lib/wealthsim/storage';

const workerId = `${os.hostname()}-${randomUUID().slice(0, 8)}`;

// When set (> 0), the worker exits cleanly after the queue has been empty
// this long. Local compose workers leave it unset and poll forever; AWS
// Batch jobs set it so a benchmark fleet drains the queue and terminates
// instead of billing Fargate time indefinitely.
const idleExitMs = Number(process.env.WORKER_IDLE_EXIT_SECONDS ?? 0) * 1000;

let shuttingDown = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    console.log(`[${workerId}] received ${signal}, finishing current chunk`);
    shuttingDown = true;
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  await ensureLocalBucket();
  console.log(`[${workerId}] polling ${queueUrl()}`);

  let idleSince = Date.now();
  while (!shuttingDown) {
    let message;
    try {
      message = await receiveMessage();
    } catch (error) {
      console.error(`[${workerId}] receive failed, backing off:`, error);
      await sleep(5_000);
      continue;
    }
    if (!message) {
      if (idleExitMs > 0 && Date.now() - idleSince >= idleExitMs) {
        console.log(`[${workerId}] queue idle for ${idleExitMs / 1000}s, exiting`);
        break;
      }
      continue;
    }
    idleSince = Date.now();

    let spec;
    try {
      spec = parseChunkSpec(message.body);
    } catch (error) {
      // A malformed message can never succeed; deleting it beats letting
      // it cycle through redelivery forever. On AWS the DLQ redrive
      // policy catches these before this branch does.
      console.error(`[${workerId}] dropping malformed message:`, error);
      await deleteMessage(message.receiptHandle);
      continue;
    }

    try {
      const started = performance.now();
      const summary = simulateChunk(spec);
      const computeMs = performance.now() - started;
      await putChunkSummary({ ...summary, computeMs, workerId });
      await deleteMessage(message.receiptHandle);
      const rate = Math.round(spec.pathCount / (computeMs / 1000));
      console.log(
        `[${workerId}] job=${spec.jobId} chunk=${spec.chunkIndex} paths=${spec.pathCount} ` +
          `${Math.round(computeMs)}ms (${rate.toLocaleString('en-US')} paths/s)`,
      );
    } catch (error) {
      // Leave the message in flight; it reappears after the visibility
      // timeout and another worker (or this one) retries it.
      console.error(
        `[${workerId}] chunk failed (job=${spec.jobId} chunk=${spec.chunkIndex}), will retry:`,
        error,
      );
    }
  }

  console.log(`[${workerId}] shut down cleanly`);
}

main().catch((error) => {
  console.error(`[${workerId}] fatal:`, error);
  process.exit(1);
});
