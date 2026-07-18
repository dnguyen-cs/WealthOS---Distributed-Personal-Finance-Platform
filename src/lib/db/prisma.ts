import { PrismaClient } from '@/generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

// DATABASE_URL may point at a transaction-mode pooler (Neon's -pooler
// PgBouncer endpoint in the hosted deploy): the pg adapter speaks the
// extended protocol with unnamed prepared statements only, which
// transaction pooling supports. Serverless fan-out therefore multiplexes
// through the pooler instead of exhausting direct Postgres connections.
// Migrations are the exception - run `prisma migrate deploy` against the
// direct (non-pooled) endpoint.
function createClient() {
  return new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });
}

// cache on globalThis so Next.js dev hot-reload doesn't leak connections
const globalForPrisma = globalThis as unknown as { prisma?: ReturnType<typeof createClient> };

export const prisma = globalForPrisma.prisma ?? createClient();

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;
