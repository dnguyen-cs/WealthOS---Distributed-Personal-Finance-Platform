import { randomInt } from 'node:crypto';

import { prisma } from '@/lib/db/prisma';
import { aggregateChunkSummaries } from '@/lib/wealthsim/aggregate';
import { DEFAULT_CHUNK_SIZE, planChunks } from '@/lib/wealthsim/chunking';
import { enqueueChunks } from '@/lib/wealthsim/queue';
import { getChunkSummaries, listChunkKeys } from '@/lib/wealthsim/storage';
import {
  modelParamsSchema,
  type SimulationRequest,
  type YearlyStat,
} from '@/lib/wealthsim/types';
import type { Prisma, SimulationJob, SimulationResult } from '@/generated/prisma/client';

// Job lifecycle. Submission writes the job row and fans chunk messages
// out to the queue. Completion is detected lazily on status reads: when
// every chunk summary exists in object storage, the reader aggregates
// them and records the final result. There is no coordinator process to
// operate or crash - the object store is the source of truth for
// progress, and a concurrent double-finalize is resolved by the unique
// constraint on SimulationResult.jobId.

export interface JobStatusPayload {
  id: string;
  status: SimulationJob['status'];
  params: Prisma.JsonValue;
  pathCount: number;
  chunkCount: number;
  chunksCompleted: number;
  createdAt: string;
  completedAt: string | null;
  error: string | null;
  result: {
    yearlyStats: YearlyStat[];
    pathsCompleted: number;
    totalComputeMs: number;
    wallMs: number;
  } | null;
}

function toPayload(
  job: SimulationJob & { result: SimulationResult | null },
  chunksCompleted: number,
): JobStatusPayload {
  return {
    id: job.id,
    status: job.status,
    params: job.params,
    pathCount: job.pathCount,
    chunkCount: job.chunkCount,
    chunksCompleted,
    createdAt: job.createdAt.toISOString(),
    completedAt: job.completedAt?.toISOString() ?? null,
    error: job.error,
    result: job.result
      ? {
          yearlyStats: job.result.yearlyStats as unknown as YearlyStat[],
          pathsCompleted: job.result.pathsCompleted,
          totalComputeMs: job.result.totalComputeMs,
          wallMs: job.result.wallMs,
        }
      : null,
  };
}

export async function createSimulationJob(
  userId: string,
  request: SimulationRequest,
): Promise<SimulationJob> {
  const { pathCount, seed: requestedSeed, ...params } = request;
  // Postgres int4 caps at 2^31 - 1; the seed is remixed through
  // splitmix32 anyway, so 31 bits of entropy is as good as 32 here.
  const seed = requestedSeed ?? randomInt(0, 2 ** 31);
  const chunkSize = DEFAULT_CHUNK_SIZE;
  const chunkCount = Math.ceil(pathCount / chunkSize);

  const job = await prisma.simulationJob.create({
    data: {
      userId,
      params,
      pathCount,
      chunkCount,
      chunkSize,
      seed,
    },
  });

  try {
    await enqueueChunks(planChunks(job.id, pathCount, seed, params, chunkSize));
  } catch (error) {
    await prisma.simulationJob.update({
      where: { id: job.id },
      data: { status: 'failed', error: 'Failed to enqueue simulation work' },
    });
    throw error;
  }
  return job;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as { code?: string }).code === 'P2002'
  );
}

export async function getJobStatus(
  userId: string,
  jobId: string,
): Promise<JobStatusPayload | null> {
  const job = await prisma.simulationJob.findFirst({
    where: { id: jobId, userId },
    include: { result: true },
  });
  if (!job) return null;

  if (job.status === 'completed' || job.status === 'failed') {
    return toPayload(job, job.status === 'completed' ? job.chunkCount : 0);
  }

  const keys = await listChunkKeys(job.id);
  if (keys.length < job.chunkCount) {
    if (keys.length > 0 && job.status === 'queued') {
      await prisma.simulationJob.update({
        where: { id: job.id },
        data: { status: 'running' },
      });
      job.status = 'running';
    }
    return toPayload(job, keys.length);
  }

  const summaries = await getChunkSummaries(keys);
  const params = modelParamsSchema.parse(job.params);
  const { pathCount, yearlyStats } = aggregateChunkSummaries(params, summaries);
  const totalComputeMs = Math.round(
    summaries.reduce((total, summary) => total + summary.computeMs, 0),
  );
  const completedAt = new Date();
  const wallMs = completedAt.getTime() - job.createdAt.getTime();

  try {
    const [result] = await prisma.$transaction([
      prisma.simulationResult.create({
        data: {
          jobId: job.id,
          yearlyStats: yearlyStats as unknown as Prisma.InputJsonValue,
          pathsCompleted: pathCount,
          totalComputeMs,
          wallMs,
        },
      }),
      prisma.simulationJob.update({
        where: { id: job.id },
        data: { status: 'completed', completedAt },
      }),
    ]);
    return toPayload({ ...job, status: 'completed', completedAt, result }, job.chunkCount);
  } catch (error) {
    if (isUniqueViolation(error)) {
      // Another status read finalized this job concurrently; theirs won.
      const finalized = await prisma.simulationJob.findFirst({
        where: { id: jobId, userId },
        include: { result: true },
      });
      return finalized ? toPayload(finalized, finalized.chunkCount) : null;
    }
    throw error;
  }
}
