import Fastify, { LogController } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import cookie from '@fastify/cookie';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { createLogger, type Environment } from '@zerochack/config';
import { ApiError } from './errors.js';
import { healthRoutes } from './modules/health/routes.js';
import { foundationRoutes } from './modules/foundation/routes.js';
import { authRoutes } from './modules/auth/routes.js';
import { mfaRoutes } from './modules/auth/mfa-routes.js';
import { authorizationRoutes } from './modules/authorization/routes.js';
import { SmtpEmailProvider, type EmailProvider } from '@zerochack/email';
import Redis from 'ioredis';
import { Queue } from 'bullmq';
import { careRoutes } from './modules/care/routes.js';
import { customerRoutes } from './modules/customer/routes.js';
import { aiRoutes } from './modules/ai/routes.js';
import { AiService } from './modules/ai/service.js';
import type { AiProviderAdapter } from '@zerochack/ai-gateway';
import { specialistRoutes } from './modules/specialist/routes.js';
import { commercialRoutes } from './modules/commercial/routes.js';
import type { PaymentProvider } from '@zerochack/payments';
import { operationsRoutes } from './modules/operations/routes.js';
import { agencyRoutes } from './modules/agency/routes.js';
import { affiliateRoutes } from './modules/affiliate/routes.js';
import { ownerRoutes } from './modules/owner/routes.js';
import { communicationRoutes } from './modules/communications/routes.js';
import { authenticateMetricsToken, observeRequest, renderMetrics } from './metrics.js';

export async function buildApp(environment: Environment, dependencies?: { email?: EmailProvider; aiAdapters?: AiProviderAdapter[]; paymentProviders?: PaymentProvider[] }) {
  const logger = createLogger('api', environment.LOG_LEVEL);
  const app = Fastify({ loggerInstance: logger, logController: new LogController({ disableRequestLogging: true }), trustProxy: environment.TRUST_PROXY, bodyLimit: 1_048_576, requestIdHeader: false, genReqId: () => crypto.randomUUID() });
  const rateLimitRedis = environment.NODE_ENV === 'test' ? undefined : new Redis(environment.REDIS_URL, { maxRetriesPerRequest: 1 });
  const queueConnection = environment.NODE_ENV === 'test' ? undefined : new Redis(environment.REDIS_URL, { maxRetriesPerRequest: null });
  const customerQueues = queueConnection ? {
    scans: new Queue('scans', { connection: queueConnection }),
    monitoring: new Queue('monitoring', { connection: queueConnection }),
    backups: new Queue('backups', { connection: queueConnection }),
    reports: new Queue('reports', { connection: queueConnection }),
    notifications: new Queue('notifications', { connection: queueConnection }),
    email: new Queue('email', { connection: queueConnection })
  } : undefined;
  const ai = new AiService(environment, rateLimitRedis, dependencies?.aiAdapters);

  await app.register(helmet, { global: true, contentSecurityPolicy: environment.NODE_ENV === 'production' ? { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"], baseUri: ["'none'"], formAction: ["'none'"] } } : false, strictTransportSecurity: environment.NODE_ENV === 'production' ? { maxAge: 63_072_000, includeSubDomains: true, preload: true } : false });
  await app.register(cors, { origin: environment.corsOrigins, credentials: true, methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] });
  await app.register(rateLimit, { max: environment.NODE_ENV === 'test' ? 10_000 : 100, timeWindow: '1 minute', keyGenerator: (request) => request.ip, ...(rateLimitRedis ? { redis: rateLimitRedis } : {}) });
  await app.register(cookie);
  await app.register(swagger, { openapi: { info: { title: 'ZeroRoot API', version: '1.0.0', description: 'Secure identity, RBAC, tenant isolation, scanning, chat, and central AI gateway API.' }, servers: [{ url: '/v1' }] } });
  await app.register(swaggerUi, { routePrefix: '/docs', uiConfig: { docExpansion: 'list' } });

  app.addHook('onRequest', async (request, reply) => {
    request.startedAt = process.hrtime.bigint();
    void reply.header('x-request-id', request.id);
    void reply.header('cache-control', 'no-store');
    const origin = request.headers.origin;
    if (origin && !['GET', 'HEAD', 'OPTIONS'].includes(request.method) && !environment.corsOrigins.includes(origin)) throw new ApiError(403, 'ORIGIN_DENIED', 'Request origin is not allowed');
    if (request.headers['sec-fetch-site'] === 'cross-site' && !['GET', 'HEAD', 'OPTIONS'].includes(request.method)) throw new ApiError(403, 'CROSS_SITE_REQUEST_DENIED', 'Cross-site state changes are not allowed');
  });
  app.addHook('onResponse', async (request, reply) => {
    const duration = Number(process.hrtime.bigint() - request.startedAt) / 1e6; observeRequest(request.method, request.routeOptions.url ?? 'unmatched', reply.statusCode, duration);
    request.log.info({ requestId: request.id, userId: request.userId, tenantId: request.tenantId, duration, statusCode: reply.statusCode }, 'request.completed');
  });
  if (rateLimitRedis) app.addHook('onClose', async () => { rateLimitRedis.disconnect(); });
  if (queueConnection && customerQueues) app.addHook('onClose', async () => {
    await Promise.all(Object.values(customerQueues).map((queue) => queue.close()));
    queueConnection.disconnect();
  });

  app.setErrorHandler((caught: unknown, request, reply) => {
    const error = caught instanceof Error ? caught : new Error('Unknown error');
    const known = error instanceof ApiError;
    const possibleStatus = 'statusCode' in error ? error.statusCode : undefined;
    const statusCode = known ? error.statusCode : (typeof possibleStatus === 'number' && possibleStatus < 500 ? possibleStatus : 500);
    const code = known ? error.code : statusCode === 500 ? 'INTERNAL_SERVER_ERROR' : 'REQUEST_ERROR';
    request.log.error({ requestId: request.id, userId: request.userId, tenantId: request.tenantId, errorCode: code }, 'request.failed');
    void reply.code(statusCode).send({ error: { code, message: statusCode === 500 ? 'An unexpected error occurred' : error.message, requestId: request.id, ...(known && error.details !== undefined ? { details: error.details } : {}) } });
  });

  await app.register(async (v1) => {
    const email = dependencies?.email ?? new SmtpEmailProvider({ host: environment.SMTP_HOST, port: environment.SMTP_PORT, secure: environment.SMTP_SECURE, from: environment.SMTP_FROM, ...(environment.SMTP_USER && environment.SMTP_PASSWORD ? { user: environment.SMTP_USER, password: environment.SMTP_PASSWORD } : {}) });
    await v1.register(healthRoutes, { redisUrl: environment.REDIS_URL });
    await v1.register(foundationRoutes);
    await v1.register(authRoutes, { environment, email, ...(customerQueues ? { notificationsQueue: customerQueues.notifications } : {}) });
    await v1.register(mfaRoutes, { environment });
    await v1.register(authorizationRoutes, { environment, ...(customerQueues ? { notificationsQueue: customerQueues.notifications } : {}) });
    await v1.register(aiRoutes, { environment, ai });
    await v1.register(careRoutes, { environment });
    await v1.register(customerRoutes, { environment, ai, ...(customerQueues ? { queues: customerQueues } : {}) });
    await v1.register(specialistRoutes, { environment, ...(customerQueues ? { queues: { backups: customerQueues.backups, scans: customerQueues.scans, notifications:customerQueues.notifications,reports:customerQueues.reports } } : {}) });
    await v1.register(commercialRoutes, { environment, ...(dependencies?.paymentProviders ? { providers: dependencies.paymentProviders } : {}),...(customerQueues?{notificationsQueue:customerQueues.notifications}:{}) });
    await v1.register(operationsRoutes, { environment, ...(customerQueues ? { queues: { backups: customerQueues.backups, monitoring: customerQueues.monitoring } } : {}) });
    await v1.register(agencyRoutes, { environment });
    await v1.register(affiliateRoutes, { environment,...(customerQueues?{notificationsQueue:customerQueues.notifications}:{}) });
    await v1.register(ownerRoutes, { environment, email });
    await v1.register(communicationRoutes, { environment, email, ...(customerQueues ? { notificationsQueue: customerQueues.notifications } : {}) });
    v1.get('/health/metrics', async (request, reply) => { if (!authenticateMetricsToken(request.headers.authorization, environment.METRICS_TOKEN)) throw new ApiError(404, 'NOT_FOUND', 'Resource not found'); return reply.type('text/plain; version=0.0.4; charset=utf-8').send(renderMetrics()); });
  }, { prefix: '/v1' });
  return app;
}
