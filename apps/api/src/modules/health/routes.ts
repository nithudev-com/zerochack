import type { FastifyPluginAsync } from 'fastify';
import Redis from 'ioredis';
import { databaseHealthcheck } from '@zerochack/database';

export const healthRoutes: FastifyPluginAsync<{ redisUrl: string }> = async (app, options) => {
  app.get('/health/live', { schema: { tags: ['health'], summary: 'Liveness probe' } }, async () => ({ status: 'ok' }));
  app.get('/health/ready', { schema: { tags: ['health'], summary: 'Readiness probe' } }, async (_request, reply) => {
    const redis = new Redis(options.redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 });
    redis.on('error', () => undefined);
    try {
      await Promise.all([databaseHealthcheck(), redis.connect().then(() => redis.ping())]);
      return { status: 'ready', checks: { database: 'up', redis: 'up' } };
    } catch {
      return reply.code(503).send({ status: 'unavailable' });
    } finally {
      redis.disconnect();
    }
  });
};
