import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { resolveTxt } from 'node:dns/promises';
import type { FastifyInstance } from 'fastify';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { z } from 'zod';
import { database } from '@zerochack/database';
import { decryptSecret, encryptSecret, generateOpaqueToken, hashOpaqueToken } from '@zerochack/auth';
import { implementedEngines, normalizeWebsiteUrl, resolvePublicTarget, runSecurityScan, safeHttpRequest, scanQueuePolicy, TargetSecurityError, validateHostname, type EngineFinding } from '@zerochack/scanner';
import type { Environment } from '@zerochack/config';
import { ApiError } from '../../errors.js';
import { authenticate, requirePermission } from '../auth/security.js';
import { writeAudit } from '../auth/service.js';
import type { AiService } from '../ai/service.js';
import { AiGatewayError } from '@zerochack/ai-gateway';
import { verifyReport, reportTypes, type ReportDocument } from '@zerochack/reports';
import { publishTenantEvent } from '../communications/service.js';
import { connectSsh, inspectServerReadOnly, type ServerInspection, type ServerObservation } from './ssh-toolkit.js';

const websiteInput = z.object({ name: z.string().trim().min(2).max(120), url: z.string().url().max(2048) });
const websiteUpdate = websiteInput.partial().refine((value) => Object.keys(value).length > 0, 'At least one field is required');
const idParams = z.object({ websiteId: z.string().uuid() });
const messageInput = z.object({ content: z.string().trim().min(1).max(4000), findingId: z.string().uuid().optional(), ticketId: z.string().uuid().optional() });
const aiMessageInput = z.object({ content: z.string().trim().min(1).max(4000), idempotencyKey: z.string().uuid(), findingId: z.string().uuid().optional(), ticketId: z.string().uuid().optional(), providerId: z.string().uuid().optional(), modelId: z.string().uuid().optional() });
const ticketInput = z.object({ title: z.string().trim().min(2).max(240), description: z.string().trim().max(4000).optional(), findingId: z.string().uuid().optional() });
const verificationInput = z.object({ method: z.enum(['DNS', 'HTTP', 'CONNECTOR']) });
const accessInput = z.object({
  host: z.string().trim().min(1).max(253),
  port: z.number().int().min(1).max(65_535).default(22),
  username: z.string().trim().min(1).max(120),
  authMethod: z.enum(['PASSWORD', 'SSH_KEY']),
  secret: z.string().min(1).max(50_000),
  authorizationConfirmed: z.literal(true)
});
const chatEvents = new EventEmitter();
chatEvents.setMaxListeners(500);
const credentialLike = (value: string) => /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:password|passwd|private[_ -]?key|access[_ -]?token|secret)\s*[:=]\s*\S+/iu.test(value);
type PriceFinding={title:string;description?:string|null;severity:string;affectedResource:string;recommendation:string;cwe?:string|null;owaspCategory?:string|null};
function securityFixPriceMatches(price:{scope:string;severity:string|null;owaspCategory:string|null;cwe:string|null;matchTerms:string[]},finding:PriceFinding):boolean{if(price.scope==='PROJECT')return true;if(price.severity&&price.severity!==finding.severity)return false;if(price.owaspCategory&&price.owaspCategory.toLowerCase()!==(finding.owaspCategory??'').toLowerCase())return false;if(price.cwe&&price.cwe.toLowerCase()!==(finding.cwe??'').toLowerCase())return false;const text=[finding.title,finding.description,finding.affectedResource,finding.recommendation,finding.cwe,finding.owaspCategory].filter(Boolean).join(' ').toLowerCase();if(price.matchTerms.length&&!price.matchTerms.some((term)=>text.includes(term.toLowerCase())))return false;return Boolean(price.severity||price.owaspCategory||price.cwe||price.matchTerms.length);}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Request validation failed', result.error.flatten());
  return result.data;
}

function hostFromUrl(value: string): string {
  try { const url = new URL(normalizeWebsiteUrl(value)); validateHostname(url.hostname); return url.hostname; }
  catch (error) { if (error instanceof TargetSecurityError) throw new ApiError(400, error.code, error.message); throw error; }
}
function normalizeApiUrl(value: string): string { try { return normalizeWebsiteUrl(value); } catch (error) { if (error instanceof TargetSecurityError) throw new ApiError(400, error.code, error.message); throw error; } }
const evidenceHash = (value: string) => createHash('sha256').update(value).digest('hex');
const sshErrorCode = (error: unknown) => typeof error === 'object' && error && 'code' in error && typeof error.code === 'string' ? error.code : 'SSH_CONNECTION_FAILED';

function serverObservationFinding(observation: ServerObservation, inspection: ServerInspection, observedAt: Date): EngineFinding & { engine: string; engineVersion: string; observedAt: Date } {
  const rules: Record<ServerObservation['kind'], Pick<EngineFinding, 'title' | 'description' | 'severity' | 'confidence' | 'recommendation' | 'cwe' | 'owaspCategory'>> = {
    WORLD_WRITABLE: { title: 'Web file is writable by every server user', description: 'File permissions allow any local server user to modify this web file.', severity: 'HIGH', confidence: 0.98, recommendation: 'Restrict ownership and write permissions to the dedicated deployment user.', cwe: 'CWE-732', owaspCategory: 'A05:2021' },
    EXCESSIVE_SECRET_PERMISSIONS: { title: 'Credential-bearing web file is readable by other server users', description: 'A configuration, password, or private-key file beneath a web root is readable by unrelated local accounts.', severity: 'HIGH', confidence: 0.97, recommendation: 'Restrict the file to its owning deployment or service account and verify the web process retains only required access.', cwe: 'CWE-732', owaspCategory: 'A01:2021' },
    SSH_AUTH_FILE_WRITABLE: { title: 'SSH authorized-keys file has unsafe write permissions', description: 'The SSH account authorization file can be modified by group or other local users, enabling unauthorized key persistence.', severity: 'CRITICAL', confidence: 0.99, recommendation: 'Restrict ownership and write access immediately, review every authorized key, and investigate local account compromise.', cwe: 'CWE-732', owaspCategory: 'A01:2021' },
    SENSITIVE_FILE: { title: 'Sensitive or backup artifact exists beneath a web root', description: 'A credential, key, database dump, or backup filename was found in a web content tree. Public reachability requires separate confirmation.', severity: 'MEDIUM', confidence: 0.85, recommendation: 'Move the artifact outside every served document root and deny public access.', cwe: 'CWE-538', owaspCategory: 'A05:2021' },
    PUBLIC_VCS_DIRECTORY: { title: 'Version-control metadata exists beneath a web root', description: 'A Git, Subversion, or Mercurial metadata directory was found beneath web content and may disclose source or history if served.', severity: 'MEDIUM', confidence: 0.88, recommendation: 'Remove deployment metadata from the served tree and block dot-directory access in the web server.', cwe: 'CWE-538', owaspCategory: 'A05:2021' },
    PHP_IN_UPLOADS: { title: 'Executable server-side script found in an upload directory', description: 'A PHP or CGI-style executable exists in an upload path, a common web-shell persistence location.', severity: 'HIGH', confidence: 0.96, recommendation: 'Quarantine and review the file, then disable script execution throughout upload directories.', cwe: 'CWE-434', owaspCategory: 'A04:2021' },
    HIDDEN_SCRIPT: { title: 'Hidden server-side script found beneath a web root', description: 'A dot-prefixed PHP-family script was found. Hidden scripts are uncommon and require integrity review.', severity: 'MEDIUM', confidence: 0.75, recommendation: 'Compare the file with a trusted release and quarantine it if it is not an approved application file.', cwe: 'CWE-506', owaspCategory: 'A08:2021' },
    MALWARE_SIGNATURE: { title: 'High-confidence web-shell or obfuscated malware signature detected', description: 'Local content analysis matched a compound signature commonly used by obfuscated PHP web shells. File content was analyzed on the server and was not sent to AI.', severity: 'CRITICAL', confidence: 0.94, recommendation: 'Isolate the website, preserve forensic evidence, quarantine the file, rotate credentials, and investigate the initial access path.', cwe: 'CWE-506', owaspCategory: 'A08:2021' },
    CLAMAV_DETECTION: { title: 'Antivirus engine detected malicious content', description: `ClamAV reported a malware signature${observation.detail ? ` (${observation.detail})` : ''}.`, severity: 'CRITICAL', confidence: 0.99, recommendation: 'Isolate the affected workload, preserve evidence, quarantine the file, rotate credentials, and complete incident-response review.', cwe: 'CWE-506', owaspCategory: 'A08:2021' },
    SUSPICIOUS_PROCESS: { title: 'Known cryptominer or bot process indicator detected', description: 'A running process name matched a known cryptominer or commodity bot indicator.', severity: 'CRITICAL', confidence: 0.9, recommendation: 'Isolate the server, capture process and network evidence, terminate only through an approved incident-response workflow, and rotate credentials.', cwe: 'CWE-506', owaspCategory: 'A08:2021' },
    SUSPICIOUS_CRON: { title: 'Suspicious persistence pattern detected in user cron', description: 'The SSH user crontab contains a downloader, decoder, temporary-memory path, or known malware indicator. Command contents were not collected.', severity: 'HIGH', confidence: 0.86, recommendation: 'Preserve the crontab for evidence, validate each scheduled command, remove unauthorized persistence, and investigate account compromise.', cwe: 'CWE-506', owaspCategory: 'A08:2021' }
  };
  const rule = rules[observation.kind];
  return { fingerprint: evidenceHash(`ssh-forensics-v2\0${observation.kind}\0${observation.path}`), ...rule, affectedResource: observation.path, remediationSupported: true, evidence: { summary: `${rule.title} observed by the read-only SSH assessment. No credential or file content was returned to AI.`, metadata: { path: observation.path, detail: observation.detail ?? null, platform: inspection.platform, malwareScanner: inspection.malwareScanner, scannedFiles: inspection.scannedFiles, rootCount: inspection.roots.length } }, engine: 'ssh-forensics', engineVersion: '2.0.0', observedAt };
}

async function websiteForTenant(tenantId: string, websiteId: string) {
  const website = await database.website.findFirst({ where: { id: websiteId, tenantId, lifecycle: 'ACTIVE' } });
  if (!website) throw new ApiError(404, 'WEBSITE_NOT_FOUND', 'Website was not found');
  return website;
}

type QueueSet = { scans?: Queue; monitoring?: Queue; backups?: Queue; reports?: Queue; notifications?: Queue };

export async function customerRoutes(app: FastifyInstance, options: { environment: Environment; queues?: QueueSet; ai: AiService }): Promise<void> {
  const chatPublisher = options.environment.NODE_ENV === 'test' ? undefined : new Redis(options.environment.REDIS_URL, { maxRetriesPerRequest: 1 });
  const chatSubscriber = chatPublisher?.duplicate();
  if (chatSubscriber && chatPublisher) {
    await chatSubscriber.subscribe('zerochack:chat');
    chatSubscriber.on('message', (_channel, payload) => {
      try { const event = JSON.parse(payload) as { key: string; message: unknown }; chatEvents.emit(event.key, event.message); }
      catch { app.log.warn({ errorCode: 'CHAT_EVENT_INVALID' }, 'chat.event.invalid'); }
    });
    app.addHook('onClose', async () => { chatPublisher.disconnect(); chatSubscriber.disconnect(); });
  }
  app.addHook('preHandler', async (request) => authenticate(request, options.environment));

  const publishChat = async (tenantId: string, websiteId: string, message: unknown) => {
    const key = `${tenantId}:${websiteId}`;
    if (chatPublisher) await chatPublisher.publish('zerochack:chat', JSON.stringify({ key, message })); else chatEvents.emit(key, message);
  };

  const createSupportConversation = async (input: { tenantId: string; userId: string; requestId: string; ipAddress: string; subject: string; message: string }) => {
    const conversation = await database.$transaction(async (tx) => {
      const created = await tx.supportConversation.create({ data: { tenantId: input.tenantId, customerUserId: input.userId, subject: input.subject } });
      await tx.supportMessage.create({ data: { conversationId: created.id, authorUserId: input.userId, type: 'CUSTOMER', content: input.message } });
      return created;
    });
    await writeAudit({ tenantId: input.tenantId, actorUserId: input.userId, requestId: input.requestId, action: 'support.conversation_created', resourceType: 'support_conversation', resourceId: conversation.id, ipAddress: input.ipAddress });
    return conversation;
  };

  const checkWebsiteAccess = async (input: { tenantId: string; websiteId: string; actorUserId: string; requestId: string; ipAddress: string; announce?: boolean }) => {
    await websiteForTenant(input.tenantId, input.websiteId);
    const access = await database.websiteAccessCredential.findFirst({ where: { tenantId: input.tenantId, websiteId: input.websiteId } });
    if (!access) throw new ApiError(409, 'ACCESS_NOT_CONFIGURED', 'Add your scoped server access in the encrypted Secure Access form before checking it.');
    try {
      const connection = await connectSsh({ host: access.host, port: access.port, username: access.username, authMethod: access.authMethod, secret: decryptSecret(access.encryptedSecret, options.environment.INTEGRATION_CREDENTIAL_ENCRYPTION_KEY), hostKeyFingerprint: access.hostKeyFingerprint });
      connection.client.end();
      const [updated] = await database.$transaction([
        database.websiteAccessCredential.update({ where: { websiteId: input.websiteId }, data: { status: 'READY_FOR_SECURE_SESSION', hostKeyFingerprint: connection.fingerprint, lastCheckedAt: new Date(), lastErrorCode: null }, select: { host: true, port: true, username: true, authMethod: true, status: true, lastCheckedAt: true, lastErrorCode: true, updatedAt: true } }),
        database.website.update({ where: { id: input.websiteId }, data: { connectionStatus: 'VERIFIED', connectedAt: new Date(), connectionErrorCode: null } })
      ]);
      if (input.announce !== false) {
        const message = await database.chatMessage.create({ data: { tenantId: input.tenantId, websiteId: input.websiteId, type: 'AI', content: 'Your SSH details are correct and the server identity has been pinned. I am ready to run the bounded read-only security assessment. I will never place your password or private key in this chat or in an AI prompt.' } });
        await publishChat(input.tenantId, input.websiteId, message);
      }
      await writeAudit({ tenantId: input.tenantId, actorUserId: input.actorUserId, requestId: input.requestId, action: 'website.ssh_access_checked', resourceType: 'website', resourceId: input.websiteId, ipAddress: input.ipAddress, metadata: { hostKeyPinned: true } });
      return { ...updated, secretStored: true, guidance: 'SSH authentication succeeded. The server key is pinned and secure access is ready.' };
    } catch (error) {
      const code = error instanceof TargetSecurityError ? error.code : sshErrorCode(error);
      await database.websiteAccessCredential.update({ where: { websiteId: input.websiteId }, data: { status: 'NEEDS_ATTENTION', lastCheckedAt: new Date(), lastErrorCode: code } });
      const guidance = code === 'SSH_AUTH_FAILED' ? 'I could reach the SSH server, but authentication failed. Recheck the SSH username and use a current password or private key from your hosting dashboard. If you do not know where to find it, tell me your hosting company in chat or choose live support.' : code === 'SSH_HOST_KEY_CHANGED' ? 'The server identity changed since the last successful connection. For safety I stopped. Confirm the change with your hosting provider before rotating the saved access.' : 'I could not reach the SSH service. Confirm the SSH host and port in your hosting dashboard and check whether remote SSH access is enabled.';
      if (input.announce !== false) {
        const message = await database.chatMessage.create({ data: { tenantId: input.tenantId, websiteId: input.websiteId, type: 'AI', content: guidance } });
        await publishChat(input.tenantId, input.websiteId, message);
      }
      throw new ApiError(409, code, guidance);
    }
  };

  const assessWebsite = async (input: { tenantId: string; websiteId: string; actorUserId: string; roles: string[]; requestId: string; ipAddress: string; announce?: boolean; summarizeWithAi?: boolean }) => {
    const website = await websiteForTenant(input.tenantId, input.websiteId);
    const access = await database.websiteAccessCredential.findFirst({ where: { tenantId: input.tenantId, websiteId: input.websiteId, status: 'READY_FOR_SECURE_SESSION' } });
    if (!access) throw new ApiError(409, 'ACCESS_NOT_READY', 'First add and verify the SSH details in Secure Access, or ask for live support.');
    const totalEngines = implementedEngines.length + 1;
    const scan = await database.scan.create({ data: { tenantId: input.tenantId, websiteId: input.websiteId, status: 'RUNNING', startedAt: new Date(), progress: 5, engineCount: totalEngines } });
    const reportProgress = async (progress: number, content: string) => {
      await database.scan.update({ where: { id: scan.id }, data: { progress } });
      if (input.announce === false) return;
      const message = await database.chatMessage.create({ data: { tenantId: input.tenantId, websiteId: input.websiteId, type: 'SYSTEM', content } });
      await publishChat(input.tenantId, input.websiteId, message);
    };
    try {
      await reportProgress(10, 'Assessment started: opening the pinned SSH server identity. No server changes are permitted.');
      const connection = await connectSsh({ host: access.host, port: access.port, username: access.username, authMethod: access.authMethod, secret: decryptSecret(access.encryptedSecret, options.environment.INTEGRATION_CREDENTIAL_ENCRYPTION_KEY), hostKeyFingerprint: access.hostKeyFingerprint });
      let server; try { server = await inspectServerReadOnly(connection.client); } finally { connection.client.end(); }
      await reportProgress(70, `SSH file inspection finished: ${server.roots.length} web root(s), ${server.scannedFiles} PHP/JavaScript file(s), malware mode ${server.malwareScanner}. Running public web checks now.`);
      const web = await runSecurityScan(website.url, { timeoutMs: options.environment.SCANNER_TIMEOUT_MS, maxRedirects: options.environment.SCANNER_MAX_REDIRECTS, maxBytes: options.environment.SCANNER_MAX_RESPONSE_BYTES });
      await reportProgress(85, `Public web checks finished with ${web.findings.length} configuration indicator(s). Correlating server evidence and saving integrity hashes.`);
      const observedAt = new Date();
      const uniqueObservations = [...new Map(server.observations.map((observation) => [`${observation.kind}\0${observation.path}`, observation])).values()];
      const serverFindings = uniqueObservations.map((observation) => serverObservationFinding(observation, server, observedAt));
      const findings = [...web.findings, ...serverFindings];
      const fixPrices = await database.securityFixPrice.findMany({ where: { active: true, archivedAt: null }, orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }] });
      await database.$transaction(async (tx) => {
        for (const resultFinding of findings) {
          const { evidence, engine, engineVersion, observedAt: findingObservedAt, ...finding } = resultFinding;
          const created = await tx.securityFinding.create({ data: { tenantId: input.tenantId, websiteId: input.websiteId, scanId: scan.id, ...finding } });
          const metadata = evidence.metadata; const summary = evidence.summary.slice(0, 8000);
          await tx.findingEvidence.create({ data: { tenantId: input.tenantId, websiteId: input.websiteId, scanId: scan.id, findingId: created.id, engine, engineVersion, observedAt: findingObservedAt, summary, metadata, integrityHash: evidenceHash(JSON.stringify({ engine, engineVersion, findingObservedAt, summary, metadata })) } });
        }
        await tx.scan.update({ where: { id: scan.id }, data: { status: 'SUCCEEDED', progress: 100, completedEngines: totalEngines, completedAt: new Date(), finalUrl: web.response.url } });
        await tx.website.update({ where: { id: input.websiteId }, data: { lastScanAt: new Date(), securityStatus: findings.some((item) => item.severity === 'CRITICAL') ? 'CRITICAL' : findings.some((item) => ['HIGH', 'MEDIUM'].includes(item.severity)) ? 'ATTENTION' : 'HEALTHY' } });
      });
      const serverIssueLines = serverFindings.length ? serverFindings.slice(0, 20).map((item, index) => `${index + 1}. [${item.severity}] ${item.title} — ${item.affectedResource}`).join('\n') : 'No server-side indicator matched the implemented rules.';
      const webIssueLines = web.findings.length ? web.findings.slice(0, 10).map((item, index) => `${index + 1}. [${item.severity}] ${item.title} — ${item.affectedResource}`).join('\n') : 'No public HTTP issue matched the implemented rules.';
      const matched = fixPrices.filter((price) => price.scope === 'PROJECT' || findings.some((finding) => securityFixPriceMatches(price, finding))); const priceLines = matched.map((item) => `• ${item.name} (${item.scope.toLowerCase()}): ${new Intl.NumberFormat('en-US', { style: 'currency', currency: item.currency }).format(item.priceMinor / 100)} one time`).join('\n') || 'No owner-published security-fix price reliably matches yet; I can connect you to live support for manual scoping.';
      const coverage = { platform: server.platform, webRoots: server.roots, codeFilesAnalyzed: server.scannedFiles, scanLimitReached: server.scanLimitReached, malwareScanner: server.malwareScanner, serverIndicators: serverFindings.length, publicWebIndicators: web.findings.length };
      const context = JSON.stringify({ website: { name: website.name, origin: new URL(website.url).origin }, coverage, findings: findings.map((item) => ({ title: item.title, severity: item.severity, affectedResource: item.affectedResource, recommendation: item.recommendation })), securityFixPrices: matched.map((item) => ({ id: item.id, name: item.name, scope: item.scope, priceMinor: item.priceMinor, currency: item.currency, includedWork: item.includedWork })), pricingRule: 'Use only these owner-published one-time security-fix prices. Subscriptions are separate. Never invent or estimate a price.' });
      let content = `Real read-only server assessment completed over SSH.\n\nCoverage\n• Platform: ${server.platform}\n• Web roots inspected: ${server.roots.length}${server.roots.length ? ` (${server.roots.slice(0, 4).join(', ')})` : ''}\n• PHP/JavaScript files content-analyzed locally: ${server.scannedFiles}\n• Malware engine: ${server.malwareScanner === 'CLAMAV' ? 'ClamAV plus high-confidence web-shell signatures' : 'high-confidence web-shell signatures; ClamAV is not installed for this SSH account'}\n• Scan bound reached: ${server.scanLimitReached ? 'yes — a larger asynchronous scan is required for complete coverage' : 'no'}\n\nServer/file findings\n${serverIssueLines}\n\nPublic website findings\n${webIssueLines}\n\nImportant limitation: no scanner can prove that every malware family or past attack is absent. This result reports only observed evidence and explicitly states its coverage; it does not claim the server is “secured.”\n\nPricing\n${priceLines}`;
      let usageId: string | undefined;
      if (input.summarizeWithAi === true) {
        try { const result = await options.ai.execute({ tenantId: input.tenantId, userId: input.actorUserId, roles: input.roles, requestId: input.requestId, idempotencyKey: crypto.randomUUID(), prompt: 'Report the supplied assessment coverage first, separate server/file evidence from public HTTP findings, preserve every stated limitation, and never claim the server is secured or malware-free.', untrustedContext: context, purpose: 'SECURITY_CHAT' }); content = result.text; usageId = result.usageId; } catch (error) { app.log.info({ errorCode: error instanceof AiGatewayError ? error.code : 'AI_UNAVAILABLE', websiteId: input.websiteId }, 'assessment.ai_fallback'); }
      }
      let message;
      if (input.announce !== false) {
        message = await database.chatMessage.create({ data: { tenantId: input.tenantId, websiteId: input.websiteId, type: 'AI', content: content.slice(0, 4000) } });
        if (usageId) await database.aiUsage.update({ where: { id: usageId }, data: { responseMessageId: message.id } });
        await publishChat(input.tenantId, input.websiteId, message);
      }
      await writeAudit({ tenantId: input.tenantId, actorUserId: input.actorUserId, requestId: input.requestId, action: 'website.ai_assessment_completed', resourceType: 'scan', resourceId: scan.id, ipAddress: input.ipAddress, metadata: { findingCount: findings.length, sshObservationCount: serverFindings.length, codeFilesAnalyzed: server.scannedFiles, webRootCount: server.roots.length, malwareScanner: server.malwareScanner, scanLimitReached: server.scanLimitReached, initiatedBy: input.announce === false ? 'AI_TOOL' : 'USER_ACTION' } });
      return { scanId: scan.id, findingCount: findings.length, serverPlatform: server.platform, coverage, findings: findings.slice(0, 30).map((item) => ({ title: item.title, severity: item.severity, affectedResource: item.affectedResource, recommendation: item.recommendation })), matchedPrices: matched.map((item) => ({ name: item.name, scope: item.scope, priceMinor: item.priceMinor, currency: item.currency })), ...(message ? { message } : {}) };
    } catch (error) {
      const code = error instanceof TargetSecurityError ? error.code : sshErrorCode(error); await database.scan.update({ where: { id: scan.id }, data: { status: 'FAILED', errorCode: code, completedAt: new Date() } });
      const guidance = code === 'SSH_AUTH_FAILED' ? 'The SSH details are no longer valid. Update them securely; never paste credentials into chat.' : code === 'SSH_INSPECTION_TIMEOUT' ? 'SSH connected successfully, but the server file inspection took too long and was stopped safely. No files were changed and no findings were claimed. The server may have a very large or slow web directory; retry after checking server load, or contact live support for a narrower scan.' : 'The bounded assessment could not connect. Check Secure Access or contact live support.';
      if (input.announce !== false) {
        const message = await database.chatMessage.create({ data: { tenantId: input.tenantId, websiteId: input.websiteId, type: 'AI', content: guidance } });
        await publishChat(input.tenantId, input.websiteId, message);
      }
      throw new ApiError(409, code, guidance);
    }
  };

  app.get('/customer/overview', async (request) => {
    requirePermission(request, 'websites.read');
    const tenantId = request.tenantId!;
    const [websites, openFindings, criticalFindings, latestScan, openTickets, subscription, unreadNotifications] = await Promise.all([
      database.website.findMany({ where: { tenantId, lifecycle: 'ACTIVE' }, select: { connectionStatus: true, securityStatus: true, monitoringStatus: true, backupStatus: true } }),
      database.securityFinding.count({ where: { tenantId, status: 'OPEN' } }),
      database.securityFinding.count({ where: { tenantId, status: 'OPEN', severity: 'CRITICAL' } }),
      database.scan.findFirst({ where: { tenantId }, orderBy: { requestedAt: 'desc' }, select: { id: true, status: true, requestedAt: true, completedAt: true, websiteId: true } }),
      database.ticket.count({ where: { tenantId, status: { notIn: ['RESOLVED', 'CLOSED', 'CANCELLED'] } } }),
      database.subscription.findFirst({ where: { tenantId }, orderBy: { createdAt: 'desc' }, select: { planName: true, status: true, currentPeriodEnd: true } }),
      database.notification.count({ where: { tenantId, readAt: null, OR: [{ recipientUserId: request.userId! }, { recipientUserId: null }] } })
    ]);
    return {
      protectedWebsites: websites.filter((item) => item.connectionStatus === 'VERIFIED').length,
      securityPosture: websites.length === 0 ? null : websites.some((item) => item.securityStatus === 'CRITICAL') ? 'CRITICAL' : websites.some((item) => item.securityStatus === 'ATTENTION') ? 'ATTENTION' : websites.every((item) => item.securityStatus === 'HEALTHY') ? 'HEALTHY' : 'UNKNOWN',
      openFindings, criticalFindings, latestScan,
      monitoring: { active: websites.filter((item) => item.monitoringStatus === 'ACTIVE').length, total: websites.length },
      backups: { active: websites.filter((item) => item.backupStatus === 'ACTIVE').length, total: websites.length },
      openTickets, subscription, unreadNotifications
    };
  });

  app.get('/websites', async (request) => {
    requirePermission(request, 'websites.read');
    return database.website.findMany({
      where: { tenantId: request.tenantId!, lifecycle: 'ACTIVE' }, orderBy: { createdAt: 'desc' },
      include: { _count: { select: { findings: { where: { status: 'OPEN' } } } } }
    });
  });

  app.post('/websites', async (request, reply) => {
    requirePermission(request, 'websites.manage');
    const input = parse(websiteInput, request.body); const normalizedUrl = normalizeApiUrl(input.url); const normalizedHost = hostFromUrl(normalizedUrl);
    const website = await database.website.create({ data: { tenantId: request.tenantId!, name: input.name, url: normalizedUrl, normalizedHost } }).catch((error: unknown) => {
      if (typeof error === 'object' && error && 'code' in error && error.code === 'P2002') throw new ApiError(409, 'WEBSITE_EXISTS', 'This website already exists in the tenant');
      throw error;
    });
    await writeAudit({ tenantId: request.tenantId!, actorUserId: request.userId!, requestId: request.id, action: 'website.created', resourceType: 'website', resourceId: website.id, ipAddress: request.ip });
    return reply.code(201).send(website);
  });

  app.get('/websites/:websiteId', async (request) => {
    requirePermission(request, 'websites.read');
    const { websiteId } = parse(idParams, request.params); const tenantId = request.tenantId!;
    await websiteForTenant(tenantId, websiteId);
    return database.website.findFirst({ where: { id: websiteId, tenantId }, include: {
      findings: { orderBy: { createdAt: 'desc' }, include: { evidence: { orderBy: { observedAt: 'desc' } } } }, scans: { orderBy: { requestedAt: 'desc' }, take: 50 },
      tickets: { orderBy: { createdAt: 'desc' } }, backups: { orderBy: { requestedAt: 'desc' }, take: 50 }, reports: { orderBy: { createdAt: 'desc' }, take: 50 }
    } });
  });

  app.patch('/websites/:websiteId', async (request) => {
    requirePermission(request, 'websites.manage');
    const { websiteId } = parse(idParams, request.params); const input = parse(websiteUpdate, request.body); const tenantId = request.tenantId!;
    await websiteForTenant(tenantId, websiteId);
    const normalizedUrl = input.url ? normalizeApiUrl(input.url) : undefined;
    const website = await database.website.update({ where: { id: websiteId }, data: { ...(input.name ? { name: input.name } : {}), ...(normalizedUrl ? { url: normalizedUrl, normalizedHost: hostFromUrl(normalizedUrl), connectionStatus: 'PENDING' as const, connectedAt: null, connectionErrorCode: null } : {}) } });
    await writeAudit({ tenantId, actorUserId: request.userId!, requestId: request.id, action: 'website.updated', resourceType: 'website', resourceId: websiteId, ipAddress: request.ip });
    return website;
  });

  app.delete('/websites/:websiteId', async (request, reply) => {
    requirePermission(request, 'websites.manage');
    const { websiteId } = parse(idParams, request.params); const tenantId = request.tenantId!;
    await websiteForTenant(tenantId, websiteId);
    await database.website.update({ where: { id: websiteId }, data: { lifecycle: 'ARCHIVED', archivedAt: new Date(), monitoringStatus: 'PAUSED', backupStatus: 'PAUSED' } });
    await writeAudit({ tenantId, actorUserId: request.userId!, requestId: request.id, action: 'website.archived', resourceType: 'website', resourceId: websiteId, ipAddress: request.ip });
    return reply.code(204).send();
  });

  app.get('/websites/:websiteId/access', async (request) => {
    requirePermission(request, 'websites.read');
    const { websiteId } = parse(idParams, request.params); const tenantId = request.tenantId!;
    await websiteForTenant(tenantId, websiteId);
    const access = await database.websiteAccessCredential.findFirst({ where: { tenantId, websiteId }, select: { id: true, host: true, port: true, username: true, authMethod: true, status: true, lastCheckedAt: true, lastErrorCode: true, updatedAt: true } });
    return access ? { ...access, secretStored: true } : null;
  });

  app.put('/websites/:websiteId/access', async (request) => {
    requirePermission(request, 'websites.manage');
    const { websiteId } = parse(idParams, request.params); const tenantId = request.tenantId!; const input = parse(accessInput, request.body);
    await websiteForTenant(tenantId, websiteId);
    const host = input.host.toLowerCase();
    try { validateHostname(host); } catch (error) { if (error instanceof TargetSecurityError) throw new ApiError(400, error.code, error.message); throw error; }
    const encryptedSecret = encryptSecret(input.secret, options.environment.INTEGRATION_CREDENTIAL_ENCRYPTION_KEY);
    const access = await database.websiteAccessCredential.upsert({
      where: { websiteId },
      create: { tenantId, websiteId, host, port: input.port, username: input.username, authMethod: input.authMethod, encryptedSecret },
      update: { host, port: input.port, username: input.username, authMethod: input.authMethod, encryptedSecret, hostKeyFingerprint: null, status: 'CONFIGURED', lastCheckedAt: null, lastErrorCode: null },
      select: { id: true, host: true, port: true, username: true, authMethod: true, status: true, lastCheckedAt: true, lastErrorCode: true, updatedAt: true }
    });
    await writeAudit({ tenantId, actorUserId: request.userId!, requestId: request.id, action: 'website.access_saved', resourceType: 'website', resourceId: websiteId, ipAddress: request.ip, metadata: { host, port: input.port, authMethod: input.authMethod, secretStored: true } });
    return { ...access, secretStored: true };
  });

  app.post('/websites/:websiteId/access/check', async (request) => {
    requirePermission(request, 'websites.manage');
    const { websiteId } = parse(idParams, request.params);
    return checkWebsiteAccess({ tenantId: request.tenantId!, websiteId, actorUserId: request.userId!, requestId: request.id, ipAddress: request.ip });
  });

  app.delete('/websites/:websiteId/access', async (request, reply) => {
    requirePermission(request, 'websites.manage'); const { websiteId } = parse(idParams, request.params); const tenantId = request.tenantId!;
    await websiteForTenant(tenantId, websiteId); await database.websiteAccessCredential.deleteMany({ where: { tenantId, websiteId } });
    await writeAudit({ tenantId, actorUserId: request.userId!, requestId: request.id, action: 'website.access_revoked', resourceType: 'website', resourceId: websiteId, ipAddress: request.ip });
    return reply.code(204).send();
  });

  app.post('/websites/:websiteId/verification', async (request, reply) => {
    requirePermission(request, 'websites.manage'); const { websiteId } = parse(idParams, request.params); const tenantId = request.tenantId!;
    const website = await websiteForTenant(tenantId, websiteId); const { method } = parse(verificationInput, request.body); const token = generateOpaqueToken(); const now = new Date();
    await database.$transaction([
      database.websiteVerification.updateMany({ where: { tenantId, websiteId, status: 'PENDING' }, data: { status: 'EXPIRED' } }),
      database.websiteVerification.create({ data: { tenantId, websiteId, method, tokenHash: hashOpaqueToken(token, options.environment.SESSION_SECRET), expiresAt: new Date(now.getTime() + 60 * 60_000) } })
    ]);
    await writeAudit({ tenantId, actorUserId: request.userId!, requestId: request.id, action: 'website.verification_requested', resourceType: 'website', resourceId: websiteId, ipAddress: request.ip });
    return reply.code(201).send({ method, ...(method === 'DNS' ? { recordName: `_zerochack.${website.normalizedHost}`, recordValue: token } : method === 'HTTP' ? { path: '/.well-known/zerochack-verification.txt', fileContent: token } : { path: '/.well-known/zerochack-connector-token', connectorToken: token }), expiresAt: new Date(now.getTime() + 60 * 60_000) });
  });

  app.post('/websites/:websiteId/verification/check', async (request) => {
    requirePermission(request, 'websites.manage'); const { websiteId } = parse(idParams, request.params); const tenantId = request.tenantId!;
    const website = await websiteForTenant(tenantId, websiteId);
    const challenge = await database.websiteVerification.findFirst({ where: { tenantId, websiteId, status: 'PENDING' }, orderBy: { createdAt: 'desc' } });
    if (!challenge || challenge.expiresAt <= new Date()) {
      if (challenge) await database.websiteVerification.update({ where: { id: challenge.id }, data: { status: 'EXPIRED' } });
      throw new ApiError(400, 'VERIFICATION_EXPIRED', 'Create a new verification challenge');
    }
    let supplied: string[] = [];
    try {
      await resolvePublicTarget(new URL(website.url));
      if (challenge.method === 'DNS') supplied = (await resolveTxt(`_zerochack.${website.normalizedHost}`)).flat();
      else { const path = challenge.method === 'HTTP' ? '/.well-known/zerochack-verification.txt' : '/.well-known/zerochack-connector-token'; const proof = await safeHttpRequest(new URL(path, website.url).toString(), { maxBytes: 4096, timeoutMs: options.environment.SCANNER_TIMEOUT_MS, maxRedirects: options.environment.SCANNER_MAX_REDIRECTS, allowedHostname: website.normalizedHost }); supplied = proof.status >= 200 && proof.status < 300 ? [new TextDecoder().decode(proof.body).trim()] : []; }
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (error instanceof TargetSecurityError) throw new ApiError(409, error.code, error.message);
      throw new ApiError(409, 'VERIFICATION_NOT_FOUND', 'The ownership verification proof was not found');
    }
    const matches = supplied.some((value) => hashOpaqueToken(value.trim(), options.environment.SESSION_SECRET) === challenge.tokenHash);
    if (!matches) throw new ApiError(409, 'VERIFICATION_MISMATCH', 'The ownership proof does not match the active challenge');
    let connection;
    try { connection = await safeHttpRequest(website.url, { method: 'HEAD', maxBytes: 0, timeoutMs: options.environment.SCANNER_TIMEOUT_MS, maxRedirects: options.environment.SCANNER_MAX_REDIRECTS, allowedHostname: website.normalizedHost }); }
    catch (error) { const code = error instanceof TargetSecurityError ? error.code : 'CONNECTION_FAILED'; await database.website.update({ where: { id: websiteId }, data: { connectionStatus: 'FAILED', connectionErrorCode: code } }); await writeAudit({ tenantId, actorUserId: request.userId!, requestId: request.id, action: 'website.connection_failed', resourceType: 'website', resourceId: websiteId, metadata: { errorCode: code }, ipAddress: request.ip }); throw new ApiError(409, code, 'Ownership was proven, but the safe connection test failed'); }
    await database.$transaction([
      database.websiteVerification.update({ where: { id: challenge.id }, data: { status: 'VERIFIED', verifiedAt: new Date() } }),
      database.website.update({ where: { id: websiteId }, data: { connectionStatus: 'VERIFIED', connectedAt: new Date(), connectionErrorCode: null, url: connection.url, normalizedHost: new URL(connection.url).hostname } })
    ]);
    await writeAudit({ tenantId, actorUserId: request.userId!, requestId: request.id, action: 'website.verified_and_connected', resourceType: 'website', resourceId: websiteId, metadata: { method: challenge.method, responseStatus: connection.status }, ipAddress: request.ip });
    return { verified: true };
  });

  app.post('/websites/:websiteId/scans', async (request, reply) => {
    requirePermission(request, 'scans.run'); const { websiteId } = parse(idParams, request.params); const tenantId = request.tenantId!;
    const website = await websiteForTenant(tenantId, websiteId);
    const access = await database.websiteAccessCredential.findFirst({ where: { tenantId, websiteId, status: 'READY_FOR_SECURE_SESSION' }, select: { id: true } });
    if (!access) throw new ApiError(409, 'ACCESS_NOT_READY', 'Add encrypted server access and complete the safe endpoint check before scanning');
    const scan = await database.scan.create({ data: { tenantId, websiteId } }).catch((error: unknown) => { if (typeof error === 'object' && error && 'code' in error && error.code === 'P2002') throw new ApiError(409, 'SCAN_ALREADY_ACTIVE', 'A scan is already queued or running for this website'); throw error; });
    try { await options.queues?.scans?.add('scan.requested', { scanId: scan.id, websiteId, tenantId }, { jobId: scan.id, ...scanQueuePolicy, removeOnComplete: 1000, removeOnFail: 5000 }); }
    catch { await database.scan.update({ where: { id: scan.id }, data: { status: 'FAILED', errorCode: 'QUEUE_UNAVAILABLE', completedAt: new Date() } }); throw new ApiError(503, 'QUEUE_UNAVAILABLE', 'The scan could not be queued. Retry shortly.'); }
    await writeAudit({ tenantId, actorUserId: request.userId!, requestId: request.id, action: 'scan.requested', resourceType: 'scan', resourceId: scan.id, ipAddress: request.ip });
    await publishTenantEvent({ tenantId, recipientId: request.userId!, eventType: 'SCAN_STARTED', deduplicationKey: `scan-started:${scan.id}`, title: 'Security scan started', message: `A security scan has started for ${website.name}.`, actionUrl: `/customer/websites/${websiteId}/scans`, data: { websiteId, scanId: scan.id } }, options.queues?.notifications);
    return reply.code(202).send(scan);
  });

  app.post('/websites/:websiteId/assessment', async (request, reply) => {
    requirePermission(request, 'scans.run'); requirePermission(request, 'ai.security_context');
    const { websiteId } = parse(idParams, request.params);
    const result = await assessWebsite({ tenantId: request.tenantId!, websiteId, actorUserId: request.userId!, roles: request.roleNames ?? [], requestId: request.id, ipAddress: request.ip });
    return reply.code(201).send(result);
  });

  app.patch('/websites/:websiteId/monitoring', async (request) => {
    requirePermission(request, 'monitoring.manage'); const { websiteId } = parse(idParams, request.params); const tenantId = request.tenantId!;
    const { enabled } = parse(z.object({ enabled: z.boolean() }), request.body); await websiteForTenant(tenantId, websiteId); const intervalMinutes = (await database.monitoringPolicy.findUnique({ where: { websiteId } }))?.intervalMinutes ?? 60;
    await database.monitoringPolicy.upsert({ where: { websiteId }, create: { websiteId, tenantId, enabled, intervalMinutes }, update: { enabled } });
    const website = await database.website.update({ where: { id: websiteId }, data: { monitoringStatus: enabled ? 'PENDING' : 'PAUSED' } });
    try { if (!options.queues?.monitoring) throw new Error('queue unavailable'); if (enabled) { await options.queues.monitoring.upsertJobScheduler(`monitor-${websiteId}`, { every: intervalMinutes * 60_000 }, { name: 'monitoring.scheduled', data: { websiteId, tenantId }, opts: { removeOnComplete: 1000, removeOnFail: 5000 } }); await options.queues.monitoring.add('monitoring.immediate', { websiteId, tenantId }, { jobId: `monitor-${websiteId}-${crypto.randomUUID()}`, removeOnComplete: 1000, removeOnFail: 5000 }); } else await options.queues.monitoring.removeJobScheduler(`monitor-${websiteId}`); }
    catch { await database.$transaction([database.monitoringPolicy.update({ where: { websiteId }, data: { enabled: false } }), database.website.update({ where: { id: websiteId }, data: { monitoringStatus: 'ERROR' } })]); throw new ApiError(503, 'SCHEDULER_UNAVAILABLE', 'Monitoring could not be scheduled. Retry shortly.'); }
    await writeAudit({ tenantId, actorUserId: request.userId!, requestId: request.id, action: enabled ? 'monitoring.enabled' : 'monitoring.paused', resourceType: 'website', resourceId: websiteId, ipAddress: request.ip });
    return website;
  });

  app.post('/websites/:websiteId/backups', async (request, reply) => {
    requirePermission(request, 'backups.manage'); const { websiteId } = parse(idParams, request.params); const tenantId = request.tenantId!;
    await websiteForTenant(tenantId, websiteId); const policy = await database.backupPolicy.findUnique({ where: { websiteId } }); const backup = await database.backup.create({ data: { tenantId, websiteId, purpose: 'MANUAL', retentionUntil: new Date(Date.now() + (policy?.retentionDays ?? 30) * 86_400_000) } });
    try { if (!options.queues?.backups) throw new Error('queue unavailable'); await options.queues.backups.add('backup.requested', { action: 'CREATE', backupId: backup.id, websiteId, tenantId }, { jobId: backup.id, attempts: 3, backoff: { type: 'exponential', delay: 5000 }, removeOnComplete: 1000, removeOnFail: 5000 }); } catch { await database.backup.update({ where: { id: backup.id }, data: { status: 'FAILED', errorCode: 'QUEUE_UNAVAILABLE', completedAt: new Date() } }); throw new ApiError(503, 'QUEUE_UNAVAILABLE', 'The backup could not be queued. Retry shortly.'); }
    await writeAudit({ tenantId, actorUserId: request.userId, requestId: request.id, action: 'backup.requested', resourceType: 'backup', resourceId: backup.id, ipAddress: request.ip, metadata: { purpose: 'MANUAL' } });
    return reply.code(202).send(backup);
  });

  app.post('/websites/:websiteId/reports', async (request, reply) => {
    requirePermission(request, 'reports.read'); const { websiteId } = parse(idParams, request.params); const tenantId = request.tenantId!;
    const { title, type, sourceId } = parse(z.object({ title: z.string().trim().min(2).max(240), type: z.enum(reportTypes).default('SECURITY_SCAN'), sourceId: z.string().uuid().optional() }), request.body); await websiteForTenant(tenantId, websiteId);
    const report = await database.report.create({ data: { tenantId, websiteId, requestedByUserId: request.userId!, title, type, ...(sourceId ? { sourceId } : {}) } });
    try { if (!options.queues?.reports) throw new Error('queue unavailable'); await options.queues.reports.add('report.requested', { reportId: report.id, websiteId, tenantId }, { jobId: report.id, attempts: 3, backoff: { type: 'exponential', delay: 2_000 }, removeOnComplete: 1000, removeOnFail: 5000 }); }
    catch { await database.report.update({ where: { id: report.id }, data: { status: 'FAILED', errorCode: 'QUEUE_UNAVAILABLE', completedAt: new Date() } }); throw new ApiError(503, 'QUEUE_UNAVAILABLE', 'The report could not be queued. Retry shortly.'); }
    await writeAudit({ tenantId, actorUserId: request.userId, requestId: request.id, action: 'report.requested', resourceType: 'report', resourceId: report.id, ipAddress: request.ip, metadata: { type, sourceId } });
    return reply.code(202).send(report);
  });

  app.get('/websites/:websiteId/reports/:reportId/download', async (request, reply) => {
    requirePermission(request, 'reports.read'); const { websiteId, reportId } = parse(z.object({ websiteId: z.string().uuid(), reportId: z.string().uuid() }), request.params); const tenantId = request.tenantId!; await websiteForTenant(tenantId, websiteId);
    const report = await database.report.findFirst({ where: { id: reportId, tenantId, websiteId, status: 'SUCCEEDED' } }); if (!report?.content || !report.integrityHash || !report.signature) throw new ApiError(404, 'REPORT_NOT_FOUND', 'Completed report was not found');
    const document = report.content as unknown as ReportDocument; if (!verifyReport(document, report.integrityHash, report.signature, options.environment.REPORT_SIGNING_KEY)) throw new ApiError(409, 'REPORT_INTEGRITY_FAILED', 'Report integrity verification failed');
    await writeAudit({ tenantId, actorUserId: request.userId, requestId: request.id, action: 'report.downloaded', resourceType: 'report', resourceId: report.id, ipAddress: request.ip });
    reply.header('content-type', 'application/json; charset=utf-8').header('content-disposition', `attachment; filename="zerochack-${report.type.toLowerCase()}-${report.id}.json"`).header('x-content-sha256', report.integrityHash).header('x-zerochack-signature', report.signature); return document;
  });

  app.post('/websites/:websiteId/tickets', async (request, reply) => {
    requirePermission(request, 'tickets.create'); const { websiteId } = parse(idParams, request.params); const tenantId = request.tenantId!; const input = parse(ticketInput, request.body);
    await websiteForTenant(tenantId, websiteId);
    if (input.findingId && !(await database.securityFinding.findFirst({ where: { id: input.findingId, tenantId, websiteId } }))) throw new ApiError(400, 'INVALID_FINDING_REFERENCE', 'Finding does not belong to this website');
    const ticket = await database.ticket.create({ data: { tenantId, websiteId, title: input.title, ...(input.description ? { description: input.description } : {}), ...(input.findingId ? { findingId: input.findingId } : {}) } });
    await publishTenantEvent({ tenantId, recipientId: request.userId!, eventType: 'TICKET_CREATED', deduplicationKey: `ticket-created:${ticket.id}`, title: 'Support ticket created', message: `Your ticket “${ticket.title}” was created.`, actionUrl: `/customer/websites/${websiteId}/tickets`, data: { websiteId, ticketId: ticket.id } }, options.queues?.notifications);
    return reply.code(201).send(ticket);
  });

  app.post('/websites/:websiteId/findings/:findingId/request-fix', async (request, reply) => {
    requirePermission(request, 'tickets.create');
    const { websiteId, findingId } = parse(z.object({ websiteId: z.string().uuid(), findingId: z.string().uuid() }), request.params); const tenantId = request.tenantId!;
    const website = await websiteForTenant(tenantId, websiteId);
    const finding = await database.securityFinding.findFirst({ where: { id: findingId, tenantId, websiteId } });
    if (!finding) throw new ApiError(404, 'FINDING_NOT_FOUND', 'Finding was not found');
    const paidOrder=await database.securityFixOrder.findFirst({where:{tenantId,websiteId,status:{in:['PAID','QUEUED','IN_PROGRESS']},OR:[{findingId},{scope:'PROJECT'}]},orderBy:{paidAt:'desc'}});
    if(!paidOrder)throw new ApiError(402,'SECURITY_FIX_PAYMENT_REQUIRED','Complete payment for the applicable owner-published security-fix scope before connecting a fixing specialist. Subscriptions are separate and do not count as remediation payment.');
    const duplicate = await database.ticket.findFirst({ where: { tenantId, websiteId, findingId, status: { notIn: ['RESOLVED', 'CLOSED', 'CANCELLED'] } } });
    if (duplicate) return reply.code(200).send(duplicate);
    const [ticket, , message] = await database.$transaction([
      database.ticket.create({ data: { tenantId, websiteId, findingId, title: `Fix: ${finding.title}`, description: `Customer requested specialist remediation for this ${finding.severity.toLowerCase()} severity finding.`, status: 'QUEUED' } }),
      database.securityFinding.update({ where: { id: findingId }, data: { status: 'IN_REMEDIATION' } }),
      database.chatMessage.create({ data: { tenantId, websiteId, type: 'SYSTEM', findingId, content: `A specialist fix was requested for “${finding.title}”. The request is now live in the specialist queue.` } })
    ]);
    await database.securityFixOrder.update({where:{id:paidOrder.id},data:{ticketId:ticket.id,status:'QUEUED'}});
    const eventKey = `${tenantId}:${websiteId}`; if (chatPublisher) await chatPublisher.publish('zerochack:chat', JSON.stringify({ key: eventKey, message })); else chatEvents.emit(eventKey, message);
    await writeAudit({ tenantId, actorUserId: request.userId!, requestId: request.id, action: 'finding.remediation_requested', resourceType: 'ticket', resourceId: ticket.id, ipAddress: request.ip, metadata: { websiteId, findingId } });
    await publishTenantEvent({ tenantId, recipientId: request.userId!, eventType: 'TICKET_CREATED', deduplicationKey: `fix-request:${ticket.id}`, title: 'Specialist fix requested', message: `Your request for ${website.name} is live in the specialist queue.`, actionUrl: `/customer/websites/${websiteId}/tickets`, data: { websiteId, ticketId: ticket.id, findingId } }, options.queues?.notifications);
    return reply.code(201).send(ticket);
  });

  app.get('/websites/:websiteId/chat', async (request) => {
    requirePermission(request, 'chat.read'); const { websiteId } = parse(idParams, request.params); const tenantId = request.tenantId!; await websiteForTenant(tenantId, websiteId);
    return database.chatMessage.findMany({ where: { tenantId, websiteId }, orderBy: { createdAt: 'asc' }, take: 200, include: { author: { select: { displayName: true } } } });
  });

  app.patch('/websites/:websiteId/findings/:findingId/status', async (request) => {
    requirePermission(request, 'findings.manage'); const { websiteId, findingId } = parse(z.object({ websiteId: z.string().uuid(), findingId: z.string().uuid() }), request.params); const tenantId = request.tenantId!;
    await websiteForTenant(tenantId, websiteId); const { status } = parse(z.object({ status: z.enum(['OPEN', 'ACKNOWLEDGED', 'IN_REMEDIATION', 'RESOLVED', 'ACCEPTED_RISK', 'FALSE_POSITIVE', 'REOPENED']) }), request.body);
    const changed = await database.securityFinding.updateMany({ where: { id: findingId, tenantId, websiteId }, data: { status } });
    if (changed.count !== 1) throw new ApiError(404, 'FINDING_NOT_FOUND', 'Finding was not found');
    await writeAudit({ tenantId, actorUserId: request.userId!, requestId: request.id, action: 'finding.status_changed', resourceType: 'finding', resourceId: findingId, metadata: { status }, ipAddress: request.ip });
    return database.securityFinding.findFirst({ where: { id: findingId, tenantId, websiteId }, include: { evidence: true } });
  });

  app.post('/websites/:websiteId/chat', async (request, reply) => {
    requirePermission(request, 'chat.write'); const { websiteId } = parse(idParams, request.params); const tenantId = request.tenantId!; const input = parse(messageInput, request.body); await websiteForTenant(tenantId, websiteId);
    if (credentialLike(input.content)) throw new ApiError(400, 'CHAT_SECRET_BLOCKED', 'Do not paste passwords, private keys, or access tokens into chat. Use the encrypted Secure Access form.');
    if (input.findingId && !(await database.securityFinding.findFirst({ where: { id: input.findingId, tenantId, websiteId } }))) throw new ApiError(400, 'INVALID_FINDING_REFERENCE', 'Finding does not belong to this website');
    if (input.ticketId && !(await database.ticket.findFirst({ where: { id: input.ticketId, tenantId, websiteId } }))) throw new ApiError(400, 'INVALID_TICKET_REFERENCE', 'Ticket does not belong to this website');
    const role = request.roleNames?.includes('Cybersecurity Specialist') ? 'SPECIALIST' : 'CUSTOMER';
    const message = await database.chatMessage.create({ data: { tenantId, websiteId, authorUserId: request.userId!, type: role, content: input.content, ...(input.findingId ? { findingId: input.findingId } : {}), ...(input.ticketId ? { ticketId: input.ticketId } : {}) }, include: { author: { select: { displayName: true } } } });
    const eventKey = `${tenantId}:${websiteId}`;
    if (chatPublisher) await chatPublisher.publish('zerochack:chat', JSON.stringify({ key: eventKey, message }));
    else chatEvents.emit(eventKey, message);
    return reply.code(201).send(message);
  });

  app.post('/websites/:websiteId/chat/ai', async (request, reply) => {
    requirePermission(request, 'ai.use'); requirePermission(request, 'ai.security_context');
    const { websiteId } = parse(idParams, request.params); const tenantId = request.tenantId!; const input = parse(aiMessageInput, request.body);
    const website = await websiteForTenant(tenantId, websiteId);
    if (credentialLike(input.content)) throw new ApiError(400, 'CHAT_SECRET_BLOCKED', 'I did not accept that credential. Put passwords and private keys only in the encrypted Secure Access form.');
    const quickAnswer = async (content: string) => { const [, message] = await database.$transaction([database.chatMessage.create({ data: { tenantId, websiteId, authorUserId: request.userId!, type: 'CUSTOMER', content: input.content } }), database.chatMessage.create({ data: { tenantId, websiteId, type: 'AI', content } })]); const eventKey = `${tenantId}:${websiteId}`; if (chatPublisher) await chatPublisher.publish('zerochack:chat', JSON.stringify({ key: eventKey, message })); else chatEvents.emit(eventKey, message); return reply.code(201).send(message); };
    if (/\b(?:price|pricing|package|cost|pay|payment)\b/iu.test(input.content)) { const [prices,pricedFinding]=await Promise.all([database.securityFixPrice.findMany({where:{active:true,archivedAt:null},orderBy:[{priority:'desc'},{createdAt:'asc'}]}),input.findingId?database.securityFinding.findFirst({where:{id:input.findingId,tenantId,websiteId}}):null]);const matched=prices.filter((price)=>price.scope==='PROJECT'||Boolean(pricedFinding&&securityFixPriceMatches(price,pricedFinding)));const lines=matched.map((item)=>`• ${item.name} (${item.scope.toLowerCase()}): ${new Intl.NumberFormat('en-US',{style:'currency',currency:item.currency}).format(item.priceMinor/100)} one time\n  Includes: ${item.includedWork.join(', ')}`).join('\n');return quickAnswer(lines?`These are the applicable one-time security-fix prices published by the owner for ${website.name}:\n\n${lines}\n\nSubscriptions are separate. Open Pricing to confirm the exact scope and pay; provider confirmation automatically queues a human specialist.`:'No owner-published security-fix price reliably matches this issue yet. I will not invent an amount; please ask live support for manual scoping.'); }
    const finding = input.findingId ? await database.securityFinding.findFirst({ where: { id: input.findingId, tenantId, websiteId }, include: { evidence: { select: { engine: true, observedAt: true, summary: true } } } }) : undefined;
    if (input.findingId && !finding) throw new ApiError(400, 'INVALID_FINDING_REFERENCE', 'Finding does not belong to this website');
    const ticket = input.ticketId ? await database.ticket.findFirst({ where: { id: input.ticketId, tenantId, websiteId }, select: { id: true, title: true, description: true, status: true } }) : undefined;
    if (input.ticketId && !ticket) throw new ApiError(400, 'INVALID_TICKET_REFERENCE', 'Ticket does not belong to this website');
    const [recentFindings, access, fixPrices, successfulPayment, recentMessages, latestScan] = await Promise.all([
      finding ? Promise.resolve([]) : database.securityFinding.findMany({ where: { tenantId, websiteId }, orderBy: { createdAt: 'desc' }, take: 10, select: { id: true, title: true, severity: true, status: true, recommendation: true, affectedResource: true, scanId: true } }),
      database.websiteAccessCredential.findFirst({ where: { tenantId, websiteId }, select: { status: true, lastErrorCode: true, lastCheckedAt: true } }),
      database.securityFixPrice.findMany({where:{active:true,archivedAt:null},orderBy:[{priority:'desc'},{createdAt:'asc'}]}),
      database.securityFixOrder.findFirst({ where: { tenantId,websiteId,status:{in:['PAID','QUEUED','IN_PROGRESS','COMPLETED']} }, select: { id: true } }),
      database.chatMessage.findMany({ where: { tenantId, websiteId }, orderBy: { createdAt: 'desc' }, take: 12, select: { type: true, content: true, createdAt: true } }),
      database.scan.findFirst({ where: { tenantId, websiteId }, orderBy: { requestedAt: 'desc' }, select: { id: true, status: true, progress: true, engineCount: true, completedEngines: true, requestedAt: true, completedAt: true, errorCode: true } })
    ]);
    const latestAssessmentAudit = latestScan ? await database.auditLog.findFirst({ where: { tenantId, action: 'website.ai_assessment_completed', resourceType: 'scan', resourceId: latestScan.id }, orderBy: { createdAt: 'desc' }, select: { metadata: true, createdAt: true } }) : null;
    const applicablePrices=fixPrices.filter((price)=>price.scope==='PROJECT'||Boolean(finding&&securityFixPriceMatches(price,finding)));const context = JSON.stringify({ website: { name: website.name, origin: new URL(website.url).origin, connectionStatus: website.connectionStatus, securityStatus: website.securityStatus }, secureAccess: access, latestScan, latestMeasuredCoverage: latestAssessmentAudit?.metadata, securityFixPaymentConfirmed: Boolean(successfulPayment), securityFixPrices:applicablePrices.map((item)=>({name:item.name,scope:item.scope,priceMinor:item.priceMinor,currency:item.currency,includedWork:item.includedWork})),pricingRule:'Only quote the supplied owner-published security-fix prices. Never estimate or invent an amount. Subscriptions are unrelated.', finding: finding ? { id: finding.id, scanId: finding.scanId, title: finding.title, description: finding.description, authoritativeSeverity: finding.severity, authoritativeStatus: finding.status, recommendation: finding.recommendation, evidence: finding.evidence } : undefined, ticket, recentFindings, recentConversation: recentMessages.reverse().map((message) => ({ role: message.type, content: message.content, at: message.createdAt })) });
    const emptyToolSchema = { type: 'object', properties: {}, additionalProperties: false, required: [] };
    const tools = [{
      name: 'plan_security_assessment',
      description: 'Build the authoritative next-step plan from current access and scan state. Call this first when the user asks for a scan, deep assessment, security review, malware review, or what should happen next. This tool plans only and makes no server change.',
      parameters: emptyToolSchema,
      execute: async () => ({ ok: true, objective: `Evidence-based read-only assessment for ${website.name}`, currentState: { sshAccess: access?.status ?? 'NOT_CONFIGURED', latestScan: latestScan ?? null, latestMeasuredCoverage: latestAssessmentAudit?.metadata ?? null }, steps: [{ order: 1, action: access?.status === 'READY_FOR_SECURE_SESSION' ? 'Use pinned SSH access' : 'Verify encrypted SSH access', gate: 'SSH authentication and host-key validation' }, { order: 2, action: 'Inspect accessible web roots, permissions, server-side scripts, malware signatures, persistence, and available antivirus', gate: 'Read-only commands only' }, { order: 3, action: 'Run bounded public web configuration checks', gate: 'Verified hostname only' }, { order: 4, action: 'Correlate and persist findings with evidence hashes, confidence, severity, coverage, and limitations', gate: 'No unsupported claims' }, { order: 5, action: 'Prioritize verified findings and provide remediation guidance', gate: 'No remediation without payment and scoped authorization' }], secretExposed: false }),
    }, {
      name: 'get_latest_assessment_evidence',
      description: 'Read the latest persisted scan coverage and evidence-backed findings. Use this before explaining, prioritizing, comparing, or answering questions about existing results. It performs no new scan and returns no credentials or raw file contents.',
      parameters: emptyToolSchema,
      execute: async () => {
        requirePermission(request, 'findings.read');
        if (!latestScan) return { ok: true, latestScan: null, coverage: null, findings: [], guidance: 'No assessment exists yet. Build a plan and run the read-only assessment.' };
        const evidenceFindings = await database.securityFinding.findMany({ where: { tenantId, websiteId, scanId: latestScan.id }, orderBy: [{ severity: 'desc' }, { createdAt: 'asc' }], take: 30, select: { id: true, title: true, description: true, severity: true, confidence: true, status: true, affectedResource: true, recommendation: true, cwe: true, owaspCategory: true, evidence: { select: { engine: true, engineVersion: true, observedAt: true, summary: true, integrityHash: true }, take: 3 } } });
        return { ok: true, latestScan, coverage: latestAssessmentAudit?.metadata ?? null, findings: evidenceFindings, limitationsRequired: true, secretExposed: false, rawFileContentsExposed: false };
      }
    }, {
      name: 'check_ssh_access',
      description: 'Test the SSH credentials already stored in the encrypted Secure Access vault for this website. Use only when the user explicitly asks to test, check, verify, or connect the saved SSH access. The tool never reveals the password or private key.',
      parameters: emptyToolSchema,
      execute: async () => {
        try {
          requirePermission(request, 'websites.manage');
          const checked = await checkWebsiteAccess({ tenantId, websiteId, actorUserId: request.userId!, requestId: request.id, ipAddress: request.ip, announce: false });
          return { ok: true, status: checked.status, lastCheckedAt: checked.lastCheckedAt, guidance: checked.guidance, secretExposed: false };
        } catch (error) {
          if (error instanceof ApiError) return { ok: false, errorCode: error.code, guidance: error.message, secureAccessPath: `/customer/websites/${websiteId}/access`, secretExposed: false };
          return { ok: false, errorCode: 'SSH_CONNECTION_FAILED', guidance: 'The SSH check failed safely. Confirm the host, port, username, firewall, and authentication method in Secure Access.', secureAccessPath: `/customer/websites/${websiteId}/access`, secretExposed: false };
        }
      }
    }, {
      name: 'run_read_only_security_assessment',
      description: 'Run the approved read-only SSH inspection and public web security checks for this website. Use only when the user explicitly asks to scan, assess, inspect, audit, or find security issues. Saved SSH access must already be verified. This tool never fixes or changes server files.',
      parameters: emptyToolSchema,
      execute: async () => {
        try {
          requirePermission(request, 'scans.run');
          const assessment = await assessWebsite({ tenantId, websiteId, actorUserId: request.userId!, roles: request.roleNames ?? [], requestId: request.id, ipAddress: request.ip, announce: false, summarizeWithAi: false });
          return { ok: true, ...assessment, readOnly: true, secretExposed: false, findingsPath: `/customer/websites/${websiteId}/findings` };
        } catch (error) {
          if (error instanceof ApiError) return { ok: false, errorCode: error.code, guidance: error.message, secureAccessPath: `/customer/websites/${websiteId}/access`, secretExposed: false };
          return { ok: false, errorCode: 'ASSESSMENT_FAILED', guidance: 'The read-only assessment failed safely. Check Secure Access and retry.', secureAccessPath: `/customer/websites/${websiteId}/access`, secretExposed: false };
        }
      }
    }, {
      name: 'inspect_security_finding',
      description: 'Retrieve the authoritative stored evidence for one finding ID from this website. Use when the user asks why a particular finding exists, whether it is credible, what resource is affected, or how to prioritize it. Never invent an ID; obtain it from assessment evidence first.',
      parameters: { type: 'object', properties: { findingId: { type: 'string', description: 'UUID of a finding returned by get_latest_assessment_evidence.' } }, additionalProperties: false, required: ['findingId'] },
      execute: async (argumentsValue: unknown) => {
        requirePermission(request, 'findings.read');
        const { findingId } = parse(z.object({ findingId: z.string().uuid() }), argumentsValue);
        const inspected = await database.securityFinding.findFirst({ where: { id: findingId, tenantId, websiteId }, select: { id: true, scanId: true, title: true, description: true, severity: true, confidence: true, status: true, affectedResource: true, recommendation: true, cwe: true, cve: true, owaspCategory: true, remediationSupported: true, evidence: { select: { engine: true, engineVersion: true, observedAt: true, summary: true, metadata: true, integrityHash: true } } } });
        return inspected ? { ok: true, finding: inspected, secretExposed: false, rawFileContentsExposed: false } : { ok: false, errorCode: 'FINDING_NOT_FOUND', guidance: 'The requested finding does not belong to this website or no longer exists.' };
      }
    }, {
      name: 'request_live_access_specialist',
      description: 'Create a live support request for this website when the customer says they do not know their SSH details, cannot find them, or explicitly asks for a human specialist. Never use this tool merely to offer support; use it only when the customer requests or clearly needs the handoff.',
      parameters: emptyToolSchema,
      execute: async () => {
        try {
          requirePermission(request, 'chat.write');
          const conversation = await createSupportConversation({ tenantId, userId: request.userId!, requestId: request.id, ipAddress: request.ip, subject: `Connect ${website.name}`, message: `I do not have the SSH details for ${website.name} (${website.url}). Please help me connect the website and continue the read-only security assessment.` });
          return { ok: true, conversationId: conversation.id, status: conversation.status, supportPath: '/customer/support' };
        } catch {
          return { ok: false, errorCode: 'SUPPORT_HANDOFF_FAILED', guidance: 'The live-specialist request could not be created. Open Live Support and retry.', supportPath: '/customer/support' };
        }
      }
    }];
    let result; try { result = await options.ai.execute({ tenantId, userId: request.userId!, roles: request.roleNames ?? [], requestId: request.id, idempotencyKey: input.idempotencyKey, prompt: input.content, untrustedContext: context, purpose: 'SECURITY_CHAT', tools }, { ...(input.providerId ? { providerId: input.providerId } : {}), ...(input.modelId ? { modelId: input.modelId } : {}) }); } catch (error) { if (error instanceof AiGatewayError) throw new ApiError(error.statusCode, error.code, error.message); throw error; }
    const existing = await database.aiUsage.findUnique({ where: { id: result.usageId }, include: { responseMessage: { include: { author: { select: { displayName: true } } } } } });
    if (existing?.responseMessage) return reply.code(200).send(existing.responseMessage);
    const [, aiMessage] = await database.$transaction([
      database.chatMessage.create({ data: { tenantId, websiteId, authorUserId: request.userId!, type: 'CUSTOMER', content: input.content, ...(input.findingId ? { findingId: input.findingId } : {}), ...(input.ticketId ? { ticketId: input.ticketId } : {}) } }),
      database.chatMessage.create({ data: { tenantId, websiteId, type: 'AI', content: result.text.slice(0, 4000), ...(input.findingId ? { findingId: input.findingId } : {}), ...(input.ticketId ? { ticketId: input.ticketId } : {}) }, include: { author: { select: { displayName: true } } } })
    ]);
    await database.aiUsage.update({ where: { id: result.usageId }, data: { responseMessageId: aiMessage.id } });
    const eventKey = `${tenantId}:${websiteId}`; if (chatPublisher) await chatPublisher.publish('zerochack:chat', JSON.stringify({ key: eventKey, message: aiMessage })); else chatEvents.emit(eventKey, aiMessage);
    await writeAudit({ tenantId, actorUserId: request.userId, requestId: request.id, action: 'ai.security_chat_completed', resourceType: 'ai_usage', resourceId: result.usageId, ipAddress: request.ip, metadata: { websiteId, findingId: input.findingId } });
    return reply.code(201).send(aiMessage);
  });

  app.post('/websites/:websiteId/findings/:findingId/explain', async (request, reply) => {
    requirePermission(request, 'ai.use'); requirePermission(request, 'ai.security_context');
    const { websiteId, findingId } = parse(z.object({ websiteId: z.string().uuid(), findingId: z.string().uuid() }), request.params); const { idempotencyKey, providerId, modelId } = parse(z.object({ idempotencyKey: z.string().uuid(), providerId: z.string().uuid().optional(), modelId: z.string().uuid().optional() }), request.body); const tenantId = request.tenantId!;
    await websiteForTenant(tenantId, websiteId); const finding = await database.securityFinding.findFirst({ where: { id: findingId, tenantId, websiteId }, include: { evidence: { select: { engine: true, observedAt: true, summary: true, integrityHash: true } } } });
    if (!finding) throw new ApiError(404, 'FINDING_NOT_FOUND', 'Finding was not found');
    const context = JSON.stringify({ title: finding.title, description: finding.description, authoritativeSeverity: finding.severity, authoritativeStatus: finding.status, affectedResource: finding.affectedResource, recommendation: finding.recommendation, cwe: finding.cwe, cve: finding.cve, owaspCategory: finding.owaspCategory, evidence: finding.evidence });
    let result; try { result = await options.ai.execute({ tenantId, userId: request.userId!, roles: request.roleNames ?? [], requestId: request.id, idempotencyKey, prompt: 'Explain this security finding to me without changing its authoritative security data.', untrustedContext: context, purpose: 'FINDING_EXPLANATION' }, { ...(providerId ? { providerId } : {}), ...(modelId ? { modelId } : {}) }); } catch (error) { if (error instanceof AiGatewayError) throw new ApiError(error.statusCode, error.code, error.message); throw error; }
    const existing = await database.aiUsage.findUnique({ where: { id: result.usageId }, include: { responseMessage: { include: { author: { select: { displayName: true } } } } } }); if (existing?.responseMessage) return existing.responseMessage;
    const message = await database.chatMessage.create({ data: { tenantId, websiteId, type: 'AI', content: result.text.slice(0, 4000), findingId }, include: { author: { select: { displayName: true } } } }); await database.aiUsage.update({ where: { id: result.usageId }, data: { responseMessageId: message.id } });
    const eventKey = `${tenantId}:${websiteId}`; if (chatPublisher) await chatPublisher.publish('zerochack:chat', JSON.stringify({ key: eventKey, message })); else chatEvents.emit(eventKey, message);
    return reply.code(201).send(message);
  });

  app.get('/websites/:websiteId/chat/stream', async (request, reply) => {
    requirePermission(request, 'chat.read'); const { websiteId } = parse(idParams, request.params); const tenantId = request.tenantId!; await websiteForTenant(tenantId, websiteId);
    reply.hijack(); reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    reply.raw.write(': connected\n\n'); const event = `${tenantId}:${websiteId}`;
    const send = (message: unknown) => reply.raw.write(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
    let checking = false;
    const keepAlive = setInterval(() => {
      if (checking) return; checking = true;
      void database.session.findFirst({ where: { id: request.sessionId!, userId: request.userId!, tenantId, revokedAt: null, expiresAt: { gt: new Date() }, user: { status: 'APPROVED' }, tenant: { memberships: { some: { userId: request.userId!, status: 'ACTIVE' } } } }, select: { id: true } })
        .then((session) => { if (!session) reply.raw.destroy(); else reply.raw.write(': keepalive\n\n'); })
        .catch(() => reply.raw.destroy()).finally(() => { checking = false; });
    }, 10_000); chatEvents.on(event, send);
    request.raw.on('close', () => { clearInterval(keepAlive); chatEvents.off(event, send); });
  });

  app.get('/support/conversations', async (request) => {
    requirePermission(request, 'chat.read');
    return database.supportConversation.findMany({ where: { tenantId: request.tenantId!, customerUserId: request.userId! }, orderBy: { updatedAt: 'desc' }, include: { assignedSpecialist: { select: { displayName: true } }, _count: { select: { messages: true } } } });
  });

  app.post('/support/conversations', async (request, reply) => {
    requirePermission(request, 'chat.write'); const { subject, message } = parse(z.object({ subject: z.string().trim().min(2).max(240), message: z.string().trim().min(1).max(4000) }), request.body);
    const conversation = await createSupportConversation({ tenantId: request.tenantId!, userId: request.userId!, requestId: request.id, ipAddress: request.ip, subject, message });
    return reply.code(201).send(conversation);
  });

  app.get('/support/conversations/:conversationId/messages', async (request) => {
    requirePermission(request, 'chat.read'); const conversationId = parse(z.string().uuid(), (request.params as { conversationId?: string }).conversationId);
    const conversation = await database.supportConversation.findFirst({ where: { id: conversationId, tenantId: request.tenantId!, customerUserId: request.userId! }, select: { id: true } });
    if (!conversation) throw new ApiError(404, 'SUPPORT_CONVERSATION_NOT_FOUND', 'General Live Help conversation was not found');
    return database.supportMessage.findMany({ where: { conversationId }, orderBy: { createdAt: 'asc' }, take: 300, include: { author: { select: { displayName: true } } } });
  });

  app.post('/support/conversations/:conversationId/messages', async (request, reply) => {
    requirePermission(request, 'chat.write'); const conversationId = parse(z.string().uuid(), (request.params as { conversationId?: string }).conversationId); const { content } = parse(z.object({ content: z.string().trim().min(1).max(4000) }), request.body);
    const conversation = await database.supportConversation.findFirst({ where: { id: conversationId, tenantId: request.tenantId!, customerUserId: request.userId!, status: { not: 'CLOSED' } }, select: { id: true } });
    if (!conversation) throw new ApiError(404, 'SUPPORT_CONVERSATION_NOT_FOUND', 'Open General Live Help conversation was not found');
    const message = await database.supportMessage.create({ data: { conversationId, authorUserId: request.userId!, type: 'CUSTOMER', content }, include: { author: { select: { displayName: true } } } });
    await database.supportConversation.update({ where: { id: conversationId }, data: { updatedAt: new Date() } });
    return reply.code(201).send(message);
  });

  app.get('/customer/subscription', async (request) => {
    requirePermission(request, 'billing.read'); return database.subscription.findFirst({ where: { tenantId: request.tenantId! }, orderBy: { createdAt: 'desc' } });
  });
  app.get('/customer/billing', async (request) => {
    requirePermission(request, 'billing.read'); return database.invoice.findMany({ where: { tenantId: request.tenantId! }, orderBy: { issuedAt: 'desc' } });
  });
  app.get('/customer/notifications', async (request) => {
    requirePermission(request, 'profile.read'); return database.notification.findMany({ where: { tenantId: request.tenantId!,OR:[{recipientUserId:request.userId!},{recipientUserId:null}] }, orderBy: { createdAt: 'desc' }, take: 100 });
  });
  app.patch('/customer/notifications/:notificationId/read', async (request) => {
    requirePermission(request, 'profile.read'); const { notificationId } = parse(z.object({ notificationId: z.string().uuid() }), request.params);
    const updated = await database.notification.updateMany({ where: { id: notificationId, tenantId: request.tenantId!,OR:[{recipientUserId:request.userId!},{recipientUserId:null}] }, data: { readAt: new Date() } });
    if (updated.count !== 1) throw new ApiError(404, 'NOTIFICATION_NOT_FOUND', 'Notification was not found'); return { read: true };
  });
}
