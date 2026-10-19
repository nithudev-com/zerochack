import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { database } from '@zerochack/database';
import { z } from 'zod';
import type { Environment } from '@zerochack/config';
import { uuid } from '@zerochack/security-orchestration';
import { authenticate } from '../auth/security.js';
import { parse } from '../auth/routes.js';
import { createSecurityRepairProduct, securityProductError, type SecurityRepairProductOptions } from './product.js';
import { securityAdmissionRequestSchema, securityProductDecisionSchema } from './product-contracts.js';

export const securityRepairRoutes: FastifyPluginAsync<{ environment: Environment; product?: Omit<SecurityRepairProductOptions, 'database' | 'environment'> }> = async (app, options) => {
  const product = createSecurityRepairProduct({ database, environment: options.environment, ...options.product });
  app.addHook('preHandler', request => authenticate(request, options.environment));
  const actor = (request: FastifyRequest) => ({ actorId: request.userId!, tenantId: request.tenantId!, sessionId: request.sessionId! });
  const scope = (request: FastifyRequest) => parse(z.object({ websiteId: uuid, runId: uuid.optional() }).strict(), request.params);
  async function guarded<T>(work: () => Promise<T>): Promise<T> { try { return await work(); } catch (error) { securityProductError(error); } }
  const prefix = '/websites/:websiteId/security-repair';
  app.get(`${prefix}/capabilities`, request => guarded(() => product.capabilities(actor(request), scope(request).websiteId)));
  app.get(`${prefix}/enrollment`, request => guarded(async () => {
    const value = await product.capabilities(actor(request), scope(request).websiteId); return { enrollments: value.enrollments, blockers: value.blockers };
  }));
  app.get(`${prefix}/runs`, request => guarded(() => product.list(actor(request), scope(request).websiteId)));
  app.post(`${prefix}/runs`, async (request, reply) => {
    const body = parse(securityAdmissionRequestSchema, request.body);
    const result = await guarded(() => product.admit(actor(request), scope(request).websiteId, body));
    return reply.code(result.created ? 201 : 200).send(result);
  });
  app.get(`${prefix}/runs/:runId`, request => guarded(() => { const params = scope(request); return product.detail(actor(request), params.websiteId, params.runId!); }));
  for (const [path, kind] of [['candidate-decisions', 'CANDIDATE'], ['change-decisions', 'CHANGE']] as const) {
    app.post(`${prefix}/runs/:runId/${path}`, request => guarded(() => { const params = scope(request); return product.decide(actor(request), params.websiteId, params.runId!, kind, parse(securityProductDecisionSchema, request.body)); }));
  }
  app.post(`${prefix}/runs/:runId/cancel`, request => guarded(() => {
    parse(z.object({ requestKey: uuid }).strict(), request.body); const params = scope(request); return product.cancel(actor(request), params.websiteId, params.runId!);
  }));
};
