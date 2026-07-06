import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageBatchCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';

import { chunkSpecSchema, type ChunkSpec } from '@/lib/wealthsim/types';

// A standard queue, not FIFO: FIFO locks a message group while one of its
// messages is in flight, so grouping a job's chunks would serialize them
// and defeat the fan-out entirely. Standard SQS is at-least-once, which
// is safe here because chunk processing is idempotent by construction
// (same seed -> identical output at the same storage key).

const globalForSqs = globalThis as unknown as { sqs?: SQSClient };

export const sqs =
  globalForSqs.sqs ??
  new SQSClient({
    region: process.env.AWS_REGION ?? 'us-east-1',
    // Endpoint override points at ElasticMQ locally; unset on real AWS.
    ...(process.env.SQS_ENDPOINT ? { endpoint: process.env.SQS_ENDPOINT } : {}),
  });

if (process.env.NODE_ENV !== 'production') globalForSqs.sqs = sqs;

export function queueUrl(): string {
  const url = process.env.WEALTHSIM_QUEUE_URL;
  if (!url) throw new Error('WEALTHSIM_QUEUE_URL is not set');
  return url;
}

const BATCH_LIMIT = 10;

export async function enqueueChunks(chunks: ChunkSpec[]): Promise<void> {
  for (let offset = 0; offset < chunks.length; offset += BATCH_LIMIT) {
    let pending = chunks.slice(offset, offset + BATCH_LIMIT);
    // Retrying a partially failed batch cannot double-process work: a
    // duplicate chunk message reproduces the same result object.
    for (let attempt = 0; attempt < 3 && pending.length > 0; attempt++) {
      const result = await sqs.send(
        new SendMessageBatchCommand({
          QueueUrl: queueUrl(),
          Entries: pending.map((chunk) => ({
            Id: String(chunk.chunkIndex),
            MessageBody: JSON.stringify(chunk),
          })),
        }),
      );
      const failedIds = new Set((result.Failed ?? []).map((entry) => entry.Id));
      pending = pending.filter((chunk) => failedIds.has(String(chunk.chunkIndex)));
    }
    if (pending.length > 0) {
      throw new Error(
        `enqueueChunks: ${pending.length} chunk message(s) failed after retries`,
      );
    }
  }
}

export interface ReceivedMessage {
  body: string;
  receiptHandle: string;
}

export async function receiveMessage(waitTimeSeconds = 20): Promise<ReceivedMessage | null> {
  const result = await sqs.send(
    new ReceiveMessageCommand({
      QueueUrl: queueUrl(),
      MaxNumberOfMessages: 1,
      WaitTimeSeconds: waitTimeSeconds,
    }),
  );
  const message = result.Messages?.[0];
  if (!message?.Body || !message.ReceiptHandle) return null;
  return { body: message.Body, receiptHandle: message.ReceiptHandle };
}

export async function deleteMessage(receiptHandle: string): Promise<void> {
  await sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl(), ReceiptHandle: receiptHandle }));
}

export function parseChunkSpec(body: string): ChunkSpec {
  return chunkSpecSchema.parse(JSON.parse(body));
}
