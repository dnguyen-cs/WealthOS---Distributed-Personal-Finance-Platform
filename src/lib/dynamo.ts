import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

// Shared DynamoDB document client for everything the app keeps in
// DynamoDB: PortfolioPulse market data (lib/pulse/table.ts) and the
// app-state table (rate-limit windows, daily budgets, the Plaid sync
// lock - lib/app-state.ts). DynamoDB is the only coordination store in
// the hosted stack: it is reachable from Vercel, unlike anything
// VPC-bound, which is what retired Redis.

const globalForDynamo = globalThis as unknown as { wealthosDynamo?: DynamoDBDocumentClient };

function createClient(): DynamoDBDocumentClient {
  const client = new DynamoDBClient({
    region: process.env.AWS_REGION ?? 'us-east-1',
    // Endpoint override points at dynamodb-local locally; unset on real AWS.
    ...(process.env.DYNAMODB_ENDPOINT ? { endpoint: process.env.DYNAMODB_ENDPOINT } : {}),
  });
  return DynamoDBDocumentClient.from(client, {
    marshallOptions: { removeUndefinedValues: true },
  });
}

export const dynamo = globalForDynamo.wealthosDynamo ?? createClient();

// cache on globalThis so Next.js dev hot-reload doesn't leak clients
if (process.env.NODE_ENV !== 'production') globalForDynamo.wealthosDynamo = dynamo;
