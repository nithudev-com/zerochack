import type { FastifyPluginAsync } from 'fastify';

export const foundationRoutes: FastifyPluginAsync = async (app) => {
  app.get('/configuration', { schema: { tags: ['configuration'], summary: 'API public configuration', response: { 200: { type: 'object', properties: { apiVersion: { type: 'string' } } } } } }, async () => ({ apiVersion: 'v1' }));
};
