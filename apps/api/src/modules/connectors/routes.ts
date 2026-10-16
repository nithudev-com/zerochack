import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { database } from '@zerochack/database';
import { decryptSecret, encryptSecret } from '@zerochack/auth';
import type { Environment } from '@zerochack/config';
import { ApiError } from '../../errors.js';
import { authenticate, requirePermission } from '../auth/security.js';
import { writeAudit } from '../auth/service.js';
import { connectorDefinitions, connectorEndpoint, connectorInput, connectionRequest, ConnectorError, providers, verifyConnector } from './adapters.js';
import research from './research.json';

const params = z.object({ websiteId: z.string().uuid(), provider: z.enum(providers).optional() });
const confirmation = z.object({ confirm: z.literal(true), revision: z.number().int().positive() }).strict();
const publicFields = { id: true, provider: true, endpoint: true, websiteUrl: true, revision: true, status: true, authorizationExpiresAt: true, lastCheckedAt: true, lastErrorCode: true } as const;
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new ApiError(400, 'CONNECTOR_INPUT_INVALID', 'Check the connector fields and explicit authorization.');
  return result.data;
}
async function website(tenantId: string, id: string) {
  const site = await database.website.findFirst({ where: { tenantId, id, lifecycle: 'ACTIVE' } });
  if (!site) throw new ApiError(404, 'WEBSITE_NOT_FOUND', 'Website not found.');
  return site;
}
function changed(): never { throw new ApiError(409, 'CONNECTOR_CHANGED', 'Connection changed in another request. Refresh and try again.'); }
export const connectorRoutes: FastifyPluginAsync<{ environment: Environment }> = async (app, { environment }) => {
  app.addHook('preHandler', async request => { await authenticate(request, environment); requirePermission(request, request.method === 'GET' ? 'websites.read' : 'websites.manage'); });
  app.addHook('onSend', async (_request, reply) => { void reply.header('cache-control', 'private, no-store'); });
  const limited = { bodyLimit: 16384, config: { rateLimit: { max: environment.NODE_ENV === 'test' ? 10000 : 6, timeWindow: '1 minute' } } };
  app.get('/connectors/catalog', async () => ({
    adapters: connectorDefinitions,
    research: { ...research, sourceSha256: 'b61ee080692702de9e438e5abea37aea46905e002d090a299ea75e470a134b54' }
  }));
  app.get('/websites/:websiteId/connectors', async request => {
    const { websiteId } = parse(params, request.params); const tenantId = request.tenantId!;
    const site = await website(tenantId, websiteId);
    const rows = await database.websiteConnector.findMany({ where: { tenantId, websiteId }, select: publicFields, orderBy: { provider: 'asc' } });
    return rows.map(row => ({ ...row, status: row.status === 'REVOKED' ? 'REVOKED' : row.websiteUrl !== site.url || site.connectionStatus !== 'VERIFIED' ? 'WEBSITE_REVERIFICATION_REQUIRED' : row.authorizationExpiresAt <= new Date() ? 'AUTHORIZATION_EXPIRED' : row.status, secretStored: row.status !== 'REVOKED' }));
  });
  app.put('/websites/:websiteId/connectors', limited, async request => {
    const { websiteId } = parse(params, request.params); const tenantId = request.tenantId!;
    const input = parse(connectorInput, request.body); const site = await website(tenantId, websiteId);
    if (site.connectionStatus !== 'VERIFIED') throw new ApiError(409, 'OWNERSHIP_REQUIRED', 'Verify website ownership in Settings before adding an API connector.');
    let endpoint: string;
    try { endpoint = connectorEndpoint(input.endpoint, site.normalizedHost, input.provider); connectionRequest({ ...input, endpoint }); }
    catch { throw new ApiError(400, 'CONNECTOR_CONFIGURATION_INVALID', 'Use the adapter’s documented HTTPS root and credential format. Hosted APIs accept only their reviewed vendor hosts; self-hosted APIs require the verified website hostname.'); }
    const encryptedSecret = encryptSecret(JSON.stringify({ tenantId, websiteId, provider: input.provider, endpoint, username: input.username, secret: input.secret }), environment.INTEGRATION_CREDENTIAL_ENCRYPTION_KEY);
    const where = { tenantId, websiteId, provider: input.provider };
    const data = { endpoint, websiteUrl: site.url, encryptedSecret, status: 'CONFIGURED', authorizedBy: request.userId!, authorizationExpiresAt: new Date(Date.now() + 30 * 86400000), lastCheckedAt: null, lastErrorCode: null, checkStartedAt: null };
    const result = await database.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM websites WHERE id = ${websiteId}::uuid FOR UPDATE`;
      const currentSite = await tx.website.findFirst({ where: { id: websiteId, tenantId, lifecycle: 'ACTIVE', connectionStatus: 'VERIFIED', url: site.url } });
      if (!currentSite) changed();
      const existing = await tx.websiteConnector.findUnique({ where: { tenantId_websiteId_provider: where } });
      if ((existing?.revision ?? 0) !== input.revision) changed();
      return existing ? tx.websiteConnector.update({ where: { id: existing.id }, data: { ...data, revision: { increment: 1 } }, select: publicFields }) : tx.websiteConnector.create({ data: { ...where, ...data }, select: publicFields });
    });
    await writeAudit({ tenantId, actorUserId: request.userId, requestId: request.id, action: 'website.connector_saved', resourceType: 'website_connector', resourceId: result.id, metadata: { provider: input.provider, revision: result.revision, mode: 'READ_ONLY_AUTH_CHECK' } });
    return { ...result, secretStored: true };
  });
  app.post('/websites/:websiteId/connectors/:provider/check', limited, async request => {
    const { websiteId, provider } = parse(params.required(), request.params); const tenantId = request.tenantId!;
    const input = parse(confirmation, request.body); const site = await website(tenantId, websiteId);
    const row = await database.websiteConnector.findUnique({ where: { tenantId_websiteId_provider: { tenantId, websiteId, provider } } });
    if (!row || row.status === 'REVOKED') throw new ApiError(404, 'CONNECTOR_NOT_FOUND', 'Save connector credentials first.');
    if (row.revision !== input.revision) changed();
    if (site.connectionStatus !== 'VERIFIED' || row.websiteUrl !== site.url || row.authorizationExpiresAt <= new Date()) throw new ApiError(409, 'CONNECTOR_AUTHORIZATION_REQUIRED', 'Verify ownership and save credentials again with renewed authorization.');
    if (row.checkStartedAt && row.checkStartedAt.getTime() > Date.now() - 60000) throw new ApiError(409, 'CHECK_IN_PROGRESS', 'A connection check is already running.');
    const claim = await database.websiteConnector.updateMany({ where: { id: row.id, tenantId, revision: row.revision }, data: { checkStartedAt: new Date(), status: 'CHECKING', revision: { increment: 1 } } });
    if (claim.count !== 1) changed();
    let errorCode: string | null = null;
    let successStatus = 'AUTHENTICATED_READ';
    try {
      const envelope = z.object({ tenantId: z.literal(tenantId), websiteId: z.literal(websiteId), provider: z.literal(provider), endpoint: z.literal(row.endpoint), username: z.string(), secret: z.string() }).parse(JSON.parse(decryptSecret(row.encryptedSecret, environment.INTEGRATION_CREDENTIAL_ENCRYPTION_KEY)));
      connectorEndpoint(envelope.endpoint, site.normalizedHost, provider);
      successStatus = await verifyConnector({ ...envelope, websiteHost: site.normalizedHost }) ?? 'AUTHENTICATED_READ';
    } catch (error) { errorCode = error instanceof ConnectorError ? error.code : 'CONNECTION_FAILED'; }
    const lastCheckedAt = new Date();
    const result = await database.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM websites WHERE id = ${websiteId}::uuid FOR UPDATE`;
      const stillAuthorized = await tx.website.count({ where: { id: websiteId, tenantId, lifecycle: 'ACTIVE', connectionStatus: 'VERIFIED', url: row.websiteUrl } });
      const completed = await tx.websiteConnector.updateMany({ where: { id: row.id, tenantId, revision: row.revision + 1, status: 'CHECKING' }, data: { checkStartedAt: null, lastCheckedAt, lastErrorCode: stillAuthorized ? errorCode : 'WEBSITE_CHANGED', status: !stillAuthorized || errorCode ? 'NEEDS_ATTENTION' : successStatus } });
      if (completed.count !== 1) changed();
      return tx.websiteConnector.findUniqueOrThrow({ where: { id: row.id }, select: publicFields });
    });
    await writeAudit({ tenantId, actorUserId: request.userId, requestId: request.id, action: 'website.connector_checked', resourceType: 'website_connector', resourceId: row.id, metadata: { provider, status: result.status, errorCode: result.lastErrorCode } });
    return { ...result, secretStored: true };
  });
  app.delete('/websites/:websiteId/connectors/:provider', limited, async (request, reply) => {
    const { websiteId, provider } = parse(params.required(), request.params); const tenantId = request.tenantId!;
    const input = parse(confirmation, request.body); await website(tenantId, websiteId);
    const result = await database.websiteConnector.updateMany({ where: { tenantId, websiteId, provider, revision: input.revision }, data: { encryptedSecret: '', status: 'REVOKED', checkStartedAt: null, lastCheckedAt: null, lastErrorCode: null, revision: { increment: 1 } } });
    if (result.count !== 1) changed();
    await writeAudit({ tenantId, actorUserId: request.userId, requestId: request.id, action: 'website.connector_revoked', resourceType: 'website', resourceId: websiteId, metadata: { provider } });
    return reply.code(204).send();
  });
};
