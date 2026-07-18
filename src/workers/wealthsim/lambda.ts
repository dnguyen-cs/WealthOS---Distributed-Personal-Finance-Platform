// WealthSim chunk consumer, Lambda edition: the scale-to-zero demo lane
// (AWS Batch stays the benchmark lane). Same kernel and storage contract
// as main.ts; polling, retry, and scaling belong to the event source
// mapping instead of a poll loop. Bundled by scripts/build-lambdas.mjs
// for nodejs22.x on x86_64 - the same instruction set the Fargate fleet
// was parity- and chaos-tested on.
//
// Error semantics with batch size 1: a throw returns the one message to
// the queue; after maxReceiveCount deliveries SQS parks it in the DLQ and
// the CloudWatch alarm emails. Malformed messages ride the same path -
// the DLQ redrive is the drop path here, so nothing is silently deleted.
import { randomUUID } from 'node:crypto';

import type { SQSEvent } from 'aws-lambda';

import { simulateChunk } from '@/lib/wealthsim/simulate';
import { putChunkSummary } from '@/lib/wealthsim/storage';
import { chunkSpecSchema } from '@/lib/wealthsim/types';

// One id per execution environment, mirroring the container workers'
// hostname-suffix scheme.
const workerId = `lambda-node-${randomUUID().slice(0, 8)}`;

export async function handler(event: SQSEvent): Promise<void> {
  for (const record of event.Records) {
    // Parsed against the schema directly (not via queue.ts) so the bundle
    // carries no SQS client - delivery is the event source mapping's job.
    const spec = chunkSpecSchema.parse(JSON.parse(record.body));
    const started = performance.now();
    const summary = simulateChunk(spec);
    const computeMs = performance.now() - started;
    await putChunkSummary({ ...summary, computeMs, workerId });
    console.log(
      `[${workerId}] job=${spec.jobId} chunk=${spec.chunkIndex} paths=${spec.pathCount} ` +
        `${Math.round(computeMs)}ms`,
    );
  }
}
