import {
  CreateBucketCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

import { chunkSummarySchema, type ChunkSummary } from '@/lib/wealthsim/types';

// Object storage is the only shared state between workers and the app:
// workers put one summary object per chunk, the app lists/reads them to
// aggregate. Chunk keys are deterministic, so reprocessing a redelivered
// message overwrites an object with identical content instead of
// duplicating anything.

const endpoint = process.env.S3_ENDPOINT;

const globalForS3 = globalThis as unknown as { s3?: S3Client };

export const s3 =
  globalForS3.s3 ??
  new S3Client({
    region: process.env.AWS_REGION ?? 'us-east-1',
    // Endpoint override points at MinIO locally; unset on real AWS.
    // MinIO needs path-style addressing (no per-bucket DNS).
    ...(endpoint ? { endpoint, forcePathStyle: true } : {}),
  });

if (process.env.NODE_ENV !== 'production') globalForS3.s3 = s3;

export function bucketName(): string {
  const bucket = process.env.WEALTHSIM_BUCKET;
  if (!bucket) throw new Error('WEALTHSIM_BUCKET is not set');
  return bucket;
}

function chunkKey(jobId: string, chunkIndex: number): string {
  return `jobs/${jobId}/chunks/${String(chunkIndex).padStart(5, '0')}.json`;
}

function chunkPrefix(jobId: string): string {
  return `jobs/${jobId}/chunks/`;
}

// On real AWS the bucket is provisioned by Terraform and workers have no
// CreateBucket permission, so this only runs against a local emulator.
export async function ensureLocalBucket(): Promise<void> {
  if (!endpoint) return;
  try {
    await s3.send(new CreateBucketCommand({ Bucket: bucketName() }));
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    if (name !== 'BucketAlreadyOwnedByYou' && name !== 'BucketAlreadyExists') throw error;
  }
}

export async function putChunkSummary(summary: ChunkSummary): Promise<void> {
  await s3.send(
    new PutObjectCommand({
      Bucket: bucketName(),
      Key: chunkKey(summary.jobId, summary.chunkIndex),
      Body: JSON.stringify(summary),
      ContentType: 'application/json',
    }),
  );
}

export async function listChunkKeys(jobId: string): Promise<string[]> {
  const keys: string[] = [];
  let continuationToken: string | undefined;
  do {
    const result = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucketName(),
        Prefix: chunkPrefix(jobId),
        ContinuationToken: continuationToken,
      }),
    );
    for (const object of result.Contents ?? []) {
      if (object.Key) keys.push(object.Key);
    }
    continuationToken = result.IsTruncated ? result.NextContinuationToken : undefined;
  } while (continuationToken);
  return keys;
}

export async function getChunkSummaries(keys: string[]): Promise<ChunkSummary[]> {
  return Promise.all(
    keys.map(async (key) => {
      const result = await s3.send(new GetObjectCommand({ Bucket: bucketName(), Key: key }));
      const body = await result.Body?.transformToString();
      if (!body) throw new Error(`getChunkSummaries: empty object at ${key}`);
      return chunkSummarySchema.parse(JSON.parse(body));
    }),
  );
}
