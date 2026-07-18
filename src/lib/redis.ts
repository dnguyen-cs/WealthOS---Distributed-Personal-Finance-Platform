import Redis from 'ioredis';

// cache on globalThis so Next.js dev hot-reload doesn't leak connections
const globalForRedis = globalThis as unknown as { redis?: Redis };

export const redis =
  globalForRedis.redis ??
  new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
    maxRetriesPerRequest: 2,
    // Serverless: modules that import this graph without touching Redis
    // (e.g. the auth proxy) must not open a socket per instance; the
    // connection is established on first command instead. Upstash TLS
    // works via a rediss:// REDIS_URL with no further config.
    lazyConnect: true,
  });

if (process.env.NODE_ENV !== 'production') globalForRedis.redis = redis;
