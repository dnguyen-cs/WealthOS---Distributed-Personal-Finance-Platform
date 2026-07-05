import Redis from 'ioredis';

// cache on globalThis so Next.js dev hot-reload doesn't leak connections
const globalForRedis = globalThis as unknown as { redis?: Redis };

export const redis =
  globalForRedis.redis ??
  new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
    maxRetriesPerRequest: 2,
  });

if (process.env.NODE_ENV !== 'production') globalForRedis.redis = redis;
