import { PrismaClient } from '@/generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

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

function createClient() {
  return new PrismaClient({
    adapter: new PrismaPg({
      connectionString: process.env.DATABASE_URL,
      max: envInt('DATABASE_POOL_MAX', 3),
      connectionTimeoutMillis: envInt('DATABASE_CONNECT_TIMEOUT_MS', 30_000),
    }),
  });
}

// cache on globalThis so Next.js dev hot-reload doesn't leak connections
const globalForPrisma = globalThis as unknown as { prisma?: ReturnType<typeof createClient> };

export const prisma = globalForPrisma.prisma ?? createClient();

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;
