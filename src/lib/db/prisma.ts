import { PrismaClient } from '@/generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

import { RDS_CA_BUNDLE } from './rds-ca';

// Hosted DATABASE_URL points at Aurora Serverless v2 with min 0 ACU:
// the database auto-pauses when idle and the first connection after a
// pause waits out the ~15s resume, so the connect timeout must be
// generous. There is no pooler in front (RDS Proxy is VPC-only and
// unreachable from Vercel), so each serverless instance keeps its own
// small pg pool - a handful of instances stays far under Aurora's
// connection limits at demo traffic. Migrations run from a local shell:
// `prisma migrate deploy` against the same endpoint.
function envInt(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

// node-postgres treats sslmode=require as verify-full (libpq treats it as
// encrypt-without-verify), and Node's trust store has no RDS roots, so a
// URL-level sslmode can never verify an RDS endpoint. Worse, pg lets the
// parsed connection string override an explicit ssl option. So for RDS the
// sslmode is stripped from the string and TLS is configured explicitly:
// pinned AWS CA bundle + full verification. The local compose Postgres
// speaks no TLS and gets none.
function tlsConfig(connectionString: string | undefined) {
  if (!connectionString?.includes('.rds.amazonaws.com')) return { connectionString };
  const url = new URL(connectionString);
  url.searchParams.delete('sslmode');
  return { connectionString: url.toString(), ssl: { ca: RDS_CA_BUNDLE } };
}

function createClient() {
  return new PrismaClient({
    adapter: new PrismaPg({
      ...tlsConfig(process.env.DATABASE_URL),
      max: envInt('DATABASE_POOL_MAX', 3),
      connectionTimeoutMillis: envInt('DATABASE_CONNECT_TIMEOUT_MS', 30_000),
    }),
  });
}

// cache on globalThis so Next.js dev hot-reload doesn't leak connections
const globalForPrisma = globalThis as unknown as { prisma?: ReturnType<typeof createClient> };

export const prisma = globalForPrisma.prisma ?? createClient();

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;
