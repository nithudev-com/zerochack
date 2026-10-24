import type { RouteHandlerMethod } from 'fastify';
import type { Prisma } from '@prisma/client';
import { looksSensitive } from '@zerochack/care';
import { brokerSecret, captureAccess, trackedChat, finishChat } from '../care/service.js';
import { EventEmitter } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { resolveTxt } from 'node:dns/promises';
import type { FastifyInstance } from 'fastify';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { z } from 'zod';
import { database } from '@zerochack/database';
import { generateOpaqueToken, hashOpaqueToken } from '@zerochack/auth';
import { implementedEngines, normalizeWebsiteUrl, resolvePublicTarget, runSecurityScan, safeHttpRequest, scanQueuePolicy, TargetSecurityError, validateHostname, validatePublicHttpTarget, type EngineFinding } from '@zerochack/scanner';
import type { Environment } from '@zerochack/config';
import { ApiError } from '../../errors.js';
import { authenticate, requirePermission } from '../auth/security.js';
import { writeAudit } from '../auth/service.js';
import type { AiService } from '../ai/service.js';
import { AiGatewayError } from '@zerochack/ai-gateway';
import { verifyReport, reportTypes, type ReportDocument } from '@zerochack/reports';
import { publishTenantEvent } from '../communications/service.js';
import { connectSsh, inspectServerReadOnly, applyRemediationFix, rollbackRemediationFix, type ServerInspection, type ServerObservation } from './ssh-toolkit.js';
import { planFixForFinding, type FixActionKey } from '@zerochack/security';
import { connectionSummary } from './connection-summary.js';
import { verifySshHost } from './ssh-host-trust.js';
import { navigationActivity, navigationClickAction, navigationClickInput } from './overview-activity.js';
import { inspectionNextStep, needsInspectionConfirmation } from './conversation-guidance.js';
import { assessmentAccessDigest, assertActiveAssessment, lockAssessmentAuthority, retryAssessmentAuthority, type AssessmentBinding } from './assessment-authority.js';
import { assessmentView, assessmentAudit, lockAssessmentWebsite } from './assessment-state.js';
import { assertWebsiteInspectionScope, websiteFindingScope } from './assessment-scope.js';

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
  hostKeyFingerprint: z.string().regex(/^SHA256:[A-Za-z0-9+/]{43}=?$/).optional(),
  firstConnectionTrustConfirmed: z.boolean().default(false),
  idempotencyKey: z.string().uuid().optional(),
  secret: z.string().min(1).max(50_000),
  authorizationConfirmed: z.literal(true)
});
const chatEvents = new EventEmitter();
chatEvents.setMaxListeners(500);
const legacyCredentialLike = (value: string) => /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:password|passwd|private[_ -]?key|access[_ -]?token|secret)\s*[:=]\s*\S+/iu.test(value);
const credentialLike = (value: string) => looksSensitive(value) || legacyCredentialLike(value);
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

function serverObservationFinding(observation: ServerObservation, inspection: ServerInspection, observedAt: Date): Omit<EngineFinding, 'evidence'> & { evidence: { summary: string; metadata: Prisma.InputJsonObject }; engine: string; engineVersion: string; observedAt: Date } {
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
  return { fingerprint: evidenceHash(`ssh-forensics-v3\0${inspection.scope.hostname}\0${observation.kind}\0${observation.path}`), ...rule, affectedResource: observation.path, remediationSupported: false, evidence: { summary: `${rule.title} observed by the website-only SSH assessment. No credential or file content was returned to AI.`, metadata: { kind: observation.kind, path: observation.path, detail: observation.detail ?? null, scope: inspection.scope, platform: inspection.platform, malwareScanner: inspection.malwareScanner, scannedFiles: inspection.scannedFiles, rootCount: inspection.roots.length, roots: inspection.roots.join('\n') } }, engine: 'ssh-forensics', engineVersion: '3.0.0', observedAt };
}

async function websiteForTenant(tenantId: string, websiteId: string) {
  const website = await database.website.findFirst({ where: { id: websiteId, tenantId, lifecycle: 'ACTIVE' } });
  if (!website) throw new ApiError(404, 'WEBSITE_NOT_FOUND', 'Website was not found');
  return website;
}

type QueueSet = { scans?: Queue; monitoring?: Queue; backups?: Queue; reports?: Queue; notifications?: Queue };

export type AssessmentRunners = { connect: typeof connectSsh; inspect: typeof inspectServerReadOnly; web: typeof runSecurityScan };

export async function customerRoutes(app: FastifyInstance, options: { environment: Environment; queues?: QueueSet; ai: AiService; assessmentRunners?: AssessmentRunners }): Promise<void> {
  const runners = options.assessmentRunners ?? { connect: connectSsh, inspect: inspectServerReadOnly, web: runSecurityScan };
  const backgroundAssessments = new Set<Promise<void>>();
  const assessmentStops = new Set<() => void>();
  let closing = false;
  app.addHook('preClose', async () => {
    closing = true;
    for (const stop of assessmentStops) stop();
    await Promise.allSettled([...backgroundAssessments]);
  });
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

  type CheckInput = { tenantId: string; websiteId: string; actorUserId: string; requestId: string; ipAddress: string; announce?: boolean };
  const activeSshChecks = new Set<string>();
  const checkWebsiteAccess = async (input: CheckInput) => {
    const key = `${input.tenantId}:${input.websiteId}`;
    if (activeSshChecks.has(key)) throw new ApiError(409, 'SSH_CHECK_IN_PROGRESS', 'An SSH check is already running for this website.');
    if (activeSshChecks.size >= 4) throw new ApiError(429, 'SSH_CHECK_LIMIT', 'SSH checks are busy. Retry shortly.');
    activeSshChecks.add(key);
    try { return await performWebsiteAccessCheck(input); } finally { activeSshChecks.delete(key); }
  };
  const performWebsiteAccessCheck = async (input: CheckInput) => {
    await websiteForTenant(input.tenantId, input.websiteId);
    const access = await database.websiteAccessCredential.findFirst({ where: { tenantId: input.tenantId, websiteId: input.websiteId } });
    if (!access) throw new ApiError(409, 'ACCESS_NOT_CONFIGURED', 'Add your scoped server access in the encrypted Secure Access form before checking it.');
    const unchanged = { id: access.id, tenantId: input.tenantId, websiteId: input.websiteId, host: access.host, port: access.port, username: access.username, authMethod: access.authMethod, encryptedSecret: access.encryptedSecret, vaultCredentialId: access.vaultCredentialId, hostKeyFingerprint: access.hostKeyFingerprint, updatedAt: access.updatedAt };
    try {
      const connection = await connectSsh({ host: access.host, port: access.port, username: access.username, authMethod: access.authMethod, secret: await brokerSecret(access, options.environment), hostKeyFingerprint: access.hostKeyFingerprint }, verifySshHost(access, input.actorUserId, input.requestId));
      connection.client.end();
      const updated = await database.$transaction(async tx => {
        const changed = await tx.websiteAccessCredential.updateMany({ where: { ...unchanged, website: { is: { tenantId: input.tenantId, lifecycle: 'ACTIVE' } }, ...(access.vaultCredentialId ? { vaultCredential: { is: { tenantId: input.tenantId, websiteId: input.websiteId, status: 'STORED', authorizationExpiresAt: { gt: new Date() } } } } : {}) }, data: { status: 'READY_FOR_SECURE_SESSION', hostKeyFingerprint: connection.fingerprint, lastCheckedAt: new Date(), lastErrorCode: null } });
        if (changed.count !== 1) throw new ApiError(409, 'SSH_ACCESS_CHANGED', 'SSH access changed or expired during this check. Check the current saved account.');
        await tx.website.update({ where: { id: input.websiteId }, data: { connectionStatus: 'VERIFIED', connectedAt: new Date(), connectionErrorCode: null } });
        return tx.websiteAccessCredential.findUniqueOrThrow({ where: { websiteId: input.websiteId }, select: { host: true, port: true, username: true, authMethod: true, status: true, lastCheckedAt: true, lastErrorCode: true, updatedAt: true, vaultCredential: { select: { authorizationExpiresAt: true } } } });
      });
      if (input.announce !== false) {
        const message = await database.chatMessage.create({ data: { tenantId: input.tenantId, websiteId: input.websiteId, type: 'SYSTEM', content: 'SSH authentication succeeded. The server identity is saved and later changes will be blocked. No assessment, cleanup or changes started. Your password or private key was not added to chat or sent to AI.' } });
        await publishChat(input.tenantId, input.websiteId, message);
      }
      await writeAudit({ tenantId: input.tenantId, actorUserId: input.actorUserId, requestId: input.requestId, action: 'website.ssh_access_checked', resourceType: 'website', resourceId: input.websiteId, ipAddress: input.ipAddress, metadata: { hostKeyPinned: true } });
      const { vaultCredential, ...metadata } = updated;
      return { ...metadata, secretStored: true, authorizationExpiresAt: vaultCredential?.authorizationExpiresAt ?? null, guidance: 'SSH authentication succeeded. No assessment or changes started.' };
    } catch (error) {
      const code = error instanceof TargetSecurityError ? error.code : sshErrorCode(error);
      await database.websiteAccessCredential.updateMany({ where: unchanged, data: { status: 'NEEDS_ATTENTION', lastCheckedAt: new Date(), lastErrorCode: code } });
      const guidance = code === 'AUTHORIZATION_REQUIRED' ? 'Stored SSH authorization expired or was revoked. Re-enter access in the secure form and approve a new connection check.' : code === 'SSH_ACCESS_CHANGED' ? 'The saved account changed or expired during this check. Check the current saved account; the old result was not applied.' : code === 'SSH_AUTH_FAILED' ? 'The SSH server rejected authentication. Check the username and current key or password in your hosting dashboard.' : code === 'SSH_HOST_KEY_CHANGED' ? 'The server identity did not match your trusted fingerprint. Confirm the identity through your hosting provider before changing the saved fingerprint.' : 'SSH was not verified. Check the SSH host and port from your provider, DNS, firewall and account details. A website domain may point to a CDN rather than its SSH server.';
      if (input.announce !== false) {
        const message = await database.chatMessage.create({ data: { tenantId: input.tenantId, websiteId: input.websiteId, type: 'SYSTEM', content: guidance } });
        await publishChat(input.tenantId, input.websiteId, message);
      }
      throw new ApiError(409, code, guidance);
    }
  };

  const assessWebsite = async (input: { tenantId: string; websiteId: string; actorUserId: string; sessionId: string; roles: string[]; requestId: string; ipAddress: string; announce?: boolean; summarizeWithAi?: boolean; onAdmitted?: (value: { scanId: string; status: 'RUNNING'; repairApplied: false }) => void }) => {
    if (closing) throw new ApiError(503, 'ASSESSMENT_UNAVAILABLE', 'The inspection service is restarting. Retry shortly.');
    const website = await websiteForTenant(input.tenantId, input.websiteId);
    const access = await database.websiteAccessCredential.findFirst({ where: { tenantId: input.tenantId, websiteId: input.websiteId, status: 'READY_FOR_SECURE_SESSION' }, include: { vaultCredential: { select: { version: true } } } });
    if (!access) throw new ApiError(409, 'ACCESS_NOT_READY', 'First add and verify the SSH details in Secure Access, or ask for live support.');
    const totalEngines = implementedEngines.length + 1;
    const event = (action: string, stage: string) => ({ tenantId: input.tenantId, actorUserId: input.actorUserId, requestId: input.requestId, action, resourceType: 'scan', ipAddress: input.ipAddress, metadata: { websiteId: input.websiteId, stage, scope: { mode: 'WEBSITE', hostname: website.normalizedHost } } });
    const scan = await database.$transaction(async tx => {
      // Global admission lock only covers local database work, never network I/O.
      await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(684991205)`;
      const recent = await tx.auditLog.findMany({ where: { action: assessmentAudit.started, resourceType: 'scan', createdAt: { gt: new Date(Date.now() - 180_000) } }, select: { resourceId: true } });
      const active = await tx.scan.count({ where: { id: { in: recent.flatMap(row => row.resourceId ? [row.resourceId] : []) }, status: 'RUNNING' } });
      if (active >= 2) throw new ApiError(429, 'ASSESSMENT_CAPACITY', 'Inspection capacity is busy. Retry shortly.');
      const created = await tx.scan.create({ data: { tenantId: input.tenantId, websiteId: input.websiteId, status: 'RUNNING', startedAt: new Date(), progress: 5, engineCount: totalEngines } });
      await tx.auditLog.create({ data: { ...event(assessmentAudit.started, 'CONNECTING'), resourceId: created.id } });
      return created;
    }).catch((error: unknown) => { if (typeof error === 'object' && error && 'code' in error && error.code === 'P2002') throw new ApiError(409, 'SCAN_ALREADY_ACTIVE', 'An inspection is already queued or running. Review saved progress before starting another.'); throw error; });
    const binding: AssessmentBinding = { tenantId: input.tenantId, websiteId: input.websiteId, scanId: scan.id, userId: input.actorUserId, sessionId: input.sessionId, url: website.url, normalizedHost: website.normalizedHost, accessDigest: assessmentAccessDigest(access), vaultVersion: access.vaultCredential?.version ?? null };
    let client: Awaited<ReturnType<typeof connectSsh>>['client'] | undefined;
    let stopped: unknown;
    let checking = false;
    let persisted = false;
    const assessmentController = new AbortController();
    const guard = async () => { if (stopped) throw stopped; await assertActiveAssessment(database, binding); if (stopped) throw stopped; };
    const stop = (error: unknown) => { stopped ??= error; assessmentController.abort(); client?.end(); };
    const shutdown = () => stop(new ApiError(409, 'ASSESSMENT_INTERRUPTED', 'The service restarted during inspection. No repair was applied.'));
    assessmentStops.add(shutdown);
    // Admission can await the database while preClose begins. A newly registered
    // run must observe that shutdown too, before it can acknowledge or connect.
    if (closing) shutdown();
    const poll = setInterval(() => {
      if (checking || stopped) return;
      checking = true;
      void guard().catch(stop).finally(() => { checking = false; });
    }, 2000);
    poll.unref();
    const deadline = setTimeout(() => stop(new ApiError(409, 'ASSESSMENT_TIMEOUT', 'The bounded assessment deadline expired. No repair was applied.')), 150_000);
    deadline.unref();
    const safePublish = async (message: unknown) => { try { await publishChat(input.tenantId, input.websiteId, message); } catch { app.log.warn({ scanId: scan.id, errorCode: 'ASSESSMENT_EVENT_UNAVAILABLE' }, 'assessment.event_unavailable'); } };
    const reportProgress = async (progress: number, stage: string, content: string) => {
      const message = await retryAssessmentAuthority(() => database.$transaction(async tx => {
        await lockAssessmentWebsite(tx, input.tenantId, input.websiteId);
        await lockAssessmentAuthority(tx, binding);
        await tx.scan.update({ where: { id: scan.id }, data: { progress } });
        await tx.auditLog.create({ data: { ...event(assessmentAudit.progress, stage), resourceId: scan.id } });
        return input.announce === false ? null : tx.chatMessage.create({ data: { tenantId: input.tenantId, websiteId: input.websiteId, type: 'SYSTEM', content } });
      }), guard);
      if (message) await safePublish(message);
    };
    try {
      await reportProgress(10, 'CONNECTING', `Opening the saved SSH identity for a bounded inspection of ${website.normalizedHost} only. Other websites and account-wide checks are excluded. No repair is running.`);
      // Explicit browser inspections return acceptance after durable admission,
      // rather than depending on an open HTTP request through the proxy timeout.
      input.onAdmitted?.({ scanId: scan.id, status: 'RUNNING', repairApplied: false });
      const secret = await brokerSecret(access, options.environment);
      await guard();
      const connection = await runners.connect({ host: access.host, port: access.port, username: access.username, authMethod: access.authMethod, secret, hostKeyFingerprint: access.hostKeyFingerprint });
      client = connection.client;
      await reportProgress(20, 'INSPECTING_SSH', `SSH authenticated. Locating only the ${website.normalizedHost} website directory; no file changes are permitted.`);
      let server: ServerInspection;
      try { server = await runners.inspect(client, website.normalizedHost, { onProgress: async ({ stage, scannedFiles }) => {
        const phases = { DISCOVERING_ROOTS: [25, 'Locating the selected website folder only.'], INSPECTING_FILES: [35, 'Checking a bounded sample inside the selected website folder.'], ANTIVIRUS: [50, 'Recording website-scoped antivirus availability and limitations.'], CHECKING_PERSISTENCE: [60, 'Recording website-only scope limitations; account-wide checks are excluded.'] } as const;
        const [progress, message] = phases[stage];
        await reportProgress(progress, 'INSPECTING_SSH', `${message} ${scannedFiles} code files analyzed. No file changes are permitted.`);
      } }); } finally { client.end(); client = undefined; }
      // A buggy or substituted runner must not persist sibling-site/account results.
      assertWebsiteInspectionScope(server, website.normalizedHost);
      await reportProgress(70, 'CHECKING_PUBLIC_SITE', 'Server inspection returned. Checking the public website; coverage limitations will be retained.');
      const web = await runners.web(website.url, { timeoutMs: options.environment.SCANNER_TIMEOUT_MS, maxRedirects: options.environment.SCANNER_MAX_REDIRECTS, maxBytes: options.environment.SCANNER_MAX_RESPONSE_BYTES, signal: assessmentController.signal });
      await reportProgress(85, 'SAVING_EVIDENCE', 'Public checks returned. Validating current authorization before saving evidence.');
      const observedAt = new Date();
      const uniqueObservations = [...new Map(server.observations.map(observation => [`${observation.kind}\0${observation.path}`, observation])).values()];
      const serverFindings = uniqueObservations.map(observation => ({ ...serverObservationFinding(observation, server, observedAt), remediationSupported: false }));
      const findings = [...web.findings.map(finding => ({ ...finding, remediationSupported: false })), ...serverFindings];
      const fixPrices = await database.securityFixPrice.findMany({ where: { active: true, archivedAt: null }, orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }] });
      const matched = fixPrices.filter(price => price.scope === 'PROJECT' || findings.some(finding => securityFixPriceMatches(price, finding)));
      const coverage = { scope: server.scope, platform: server.platform, webRoots: server.roots, codeFilesAnalyzed: server.scannedFiles, scanLimitReached: server.scanLimitReached, malwareScanner: server.malwareScanner, malwareScannerStatus: server.malwareScannerStatus, coverageState: server.coverageState, coverageLimitations: server.coverageLimitations, serverIndicators: serverFindings.length, publicWebIndicators: web.findings.length };
      const lines = findings.length ? findings.slice(0, 20).map((finding, index) => `${index + 1}. [${finding.severity}] ${finding.title} — ${finding.affectedResource}`).join('\n') : 'No indicator matched the implemented rules within the inspected scope.';
      const priceLines = matched.map(item => `• ${item.name}: ${new Intl.NumberFormat('en-US', { style: 'currency', currency: item.currency }).format(item.priceMinor / 100)} one time`).join('\n') || 'No owner-published security-fix price reliably matches. Contact support for scoping.';
      const content = `Website-only inspection finished for ${website.normalizedHost}. No repair was applied. This is not proof that the website is malware-free or secured. Other websites and account-wide checks were excluded.\n\nCoverage: ${server.coverageState}\n• Directory binding: ${server.scope.rootBinding}\n• Web roots: ${server.roots.length}\n• Code files analyzed locally: ${server.scannedFiles}\n• Malware scanner: ${server.malwareScanner} (${server.malwareScannerStatus})\n• File limit reached: ${server.scanLimitReached ? 'yes' : 'no'}\n${server.coverageLimitations.map(limit => `• ${limit}`).join('\n')}\n\nObserved findings\n${lines}\n\nLive automated repair is unavailable; these are saved observations, not completed fixes. Full limitations are available in the inspection status.\n\nPublished pricing\n${priceLines}`;
      const message = await retryAssessmentAuthority(() => database.$transaction(async tx => {
        await lockAssessmentWebsite(tx, input.tenantId, input.websiteId);
        await lockAssessmentAuthority(tx, binding);
        if (stopped) throw stopped;
        for (const resultFinding of findings) {
          const { evidence, engine, engineVersion, observedAt: findingObservedAt, ...finding } = resultFinding;
          const created = await tx.securityFinding.create({ data: { tenantId: input.tenantId, websiteId: input.websiteId, scanId: scan.id, ...finding } });
          const metadata = evidence.metadata; const summary = evidence.summary.slice(0, 8000);
          await tx.findingEvidence.create({ data: { tenantId: input.tenantId, websiteId: input.websiteId, scanId: scan.id, findingId: created.id, engine, engineVersion, observedAt: findingObservedAt, summary, metadata, integrityHash: evidenceHash(JSON.stringify({ engine, engineVersion, findingObservedAt, summary, metadata })) } });
        }
        await tx.scan.update({ where: { id: scan.id }, data: { status: 'SUCCEEDED', progress: 100, completedEngines: totalEngines, completedAt: new Date(), finalUrl: web.response.url } });
        await tx.website.update({ where: { id: input.websiteId }, data: { lastScanAt: new Date(), securityStatus: findings.some(item => item.severity === 'CRITICAL') ? 'CRITICAL' : findings.some(item => ['HIGH', 'MEDIUM'].includes(item.severity)) ? 'ATTENTION' : server.coverageState === 'INCOMPLETE' ? 'UNKNOWN' : 'HEALTHY' } });
        await tx.auditLog.create({ data: { ...event(assessmentAudit.completed, 'COMPLETED'), resourceId: scan.id, metadata: { ...event(assessmentAudit.completed, 'COMPLETED').metadata, ...coverage, findingCount: findings.length, repairApplied: false } } });
        return input.announce === false ? null : tx.chatMessage.create({ data: { tenantId: input.tenantId, websiteId: input.websiteId, type: 'AI', content: content.slice(0, 4000) } });
      }, { timeout: 15_000 }), guard);
      persisted = true;
      if (message) await safePublish(message);
      return { scanId: scan.id, findingCount: findings.length, serverPlatform: server.platform, coverage, findings: findings.slice(0, 30).map(item => ({ title: item.title, severity: item.severity, affectedResource: item.affectedResource, recommendation: item.recommendation })), matchedPrices: matched.map(item => ({ name: item.name, scope: item.scope, priceMinor: item.priceMinor, currency: item.currency })), ...(message ? { message } : {}) };
    } catch (error) {
      if (persisted) throw error; // A notification failure must never undo saved evidence.
      const effective = stopped ?? error;
      const candidate = effective && typeof effective === 'object' && 'code' in effective ? effective.code : undefined;
      const code = typeof candidate === 'string' && /^[A-Z][A-Z0-9_]{1,79}$/.test(candidate) ? candidate : 'ASSESSMENT_FAILED';
      const guidance = code === 'ASSESSMENT_CANCELLED' ? 'Inspection cancelled. No repair was applied. A bounded in-flight read request may finish, but its results will not be accepted.' : code === 'ASSESSMENT_BINDING_CHANGED' || code === 'AUTHORIZATION_REQUIRED' ? 'Inspection stopped because access, authorization or the website changed. Its results were not accepted. No repair was applied.' : 'The bounded inspection did not complete. No findings or repair success were claimed. Check saved access and retry, or contact support.';
      await database.$transaction(async tx => {
        await lockAssessmentWebsite(tx, input.tenantId, input.websiteId);
        const changed = await tx.scan.updateMany({ where: { id: scan.id, tenantId: input.tenantId, websiteId: input.websiteId, status: 'RUNNING' }, data: { status: 'FAILED', errorCode: code, completedAt: new Date() } });
        if (changed.count) await tx.auditLog.create({ data: { ...event(assessmentAudit.failed, 'FAILED'), resourceId: scan.id } });
      });
      throw new ApiError(effective instanceof ApiError ? effective.statusCode : 409, code, guidance);
    } finally { clearInterval(poll); clearTimeout(deadline); assessmentStops.delete(shutdown); client?.end(); }
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
    const websites = await database.website.findMany({
      where: { tenantId: request.tenantId!, lifecycle: 'ACTIVE' }, orderBy: { createdAt: 'desc' },
      include: {
        _count: { select: { findings: { where: { status: 'OPEN' } } } },
        accessCredential: { where: { tenantId: request.tenantId! }, select: { status: true, lastCheckedAt: true, lastErrorCode: true, vaultCredentialId: true, vaultCredential: { select: { status: true, authorizationExpiresAt: true } } } },
        connectors: { where: { tenantId: request.tenantId! }, select: { provider: true, websiteUrl: true, status: true, authorizationExpiresAt: true, lastCheckedAt: true, lastErrorCode: true }, orderBy: { provider: 'asc' } }
      }
    });
    return websites.map(({ accessCredential, connectors, ...site }) => ({ ...site, connectionSummary: connectionSummary({ ...site, accessCredential, connectors }) }));
  });

  app.get('/websites/:websiteId/navigation-activity', { schema: { tags: ['websites'], summary: 'My latest website option clicks; not work results' } }, async (request) => {
    requirePermission(request, 'websites.read');
    const { websiteId } = parse(idParams, request.params);
    await websiteForTenant(request.tenantId!, websiteId);
    const rows = await database.auditLog.findMany({
      where: { tenantId: request.tenantId!, actorUserId: request.userId!, action: navigationClickAction, resourceType: 'website', resourceId: websiteId },
      select: { id: true, createdAt: true, metadata: true }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 50
    });
    return rows.flatMap(row => { const entry = navigationActivity(row); return entry ? [entry] : []; });
  });

  app.post('/websites/:websiteId/navigation-activity', { schema: { tags: ['websites'], summary: 'Record a personal option click without starting work', response: { 204: { type: 'null', description: 'Click recorded; no work started' } } }, bodyLimit: 512, config: { rateLimit: { max: options.environment.NODE_ENV === 'test' ? 10000 : 60, timeWindow: '1 minute' } } }, async (request, reply) => {
    requirePermission(request, 'websites.read');
    const { websiteId } = parse(idParams, request.params);
    const click = parse(navigationClickInput, request.body);
    await websiteForTenant(request.tenantId!, websiteId);
    await writeAudit({ tenantId: request.tenantId!, actorUserId: request.userId!, requestId: request.id, action: navigationClickAction, resourceType: 'website', resourceId: websiteId, metadata: click });
    // A click receipt is not a job, approval, provider result or proof of work.
    return reply.code(204).send();
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
    const website = await websiteForTenant(tenantId, websiteId);
    const scopedFindings = websiteFindingScope(website.normalizedHost);
    const [site, historicalUnscopedFindingCount] = await Promise.all([database.website.findFirst({ where: { id: websiteId, tenantId }, include: {
      findings: { where: scopedFindings, orderBy: { createdAt: 'desc' }, include: { evidence: { orderBy: { observedAt: 'desc' } } } }, scans: { orderBy: { requestedAt: 'desc' }, take: 50 },
      tickets: { orderBy: { createdAt: 'desc' } }, backups: { orderBy: { requestedAt: 'desc' }, take: 50 }, reports: { orderBy: { createdAt: 'desc' }, take: 50 },
      securityFixRuns: { where: { status: 'APPLIED', rolledBackAt: null }, orderBy: { appliedAt: 'desc' }, take: 100, select: { id: true, findingId: true, actionKey: true, targetPath: true, appliedAt: true } }
    } }), database.securityFinding.count({ where: { tenantId, websiteId, NOT: scopedFindings } })]);
    // Flag which findings have a safe, reversible automatic fix available (dry-run plan; never mutates).
    const autoFixAvailable = (finding: { evidence?: { metadata: unknown }[] }) => { try { const md = finding.evidence?.[0]?.metadata; return md ? planFixForFinding(md as { kind?: unknown; path?: unknown; roots?: unknown }, { runId: 'preview' }).supported : false; } catch { return false; } };
    const findings = site?.findings.map((finding) => ({ ...finding, autoFixAvailable: autoFixAvailable(finding) })) ?? [];
    return { ...site, findings, historicalUnscopedFindingCount };
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
    const access = await database.websiteAccessCredential.findFirst({ where: { tenantId, websiteId }, select: { id: true, host: true, port: true, username: true, authMethod: true, status: true, lastCheckedAt: true, lastErrorCode: true, updatedAt: true, encryptedSecret: true, vaultCredentialId: true, vaultCredential: { select: { status: true, authorizationExpiresAt: true } } } });
    if (!access) return null;
    const { encryptedSecret, vaultCredentialId, vaultCredential, ...metadata } = access;
    const authorized = !vaultCredentialId || Boolean(options.environment.CARE_ENABLED && vaultCredential?.status === 'STORED' && vaultCredential.authorizationExpiresAt > new Date());
    return { ...metadata, ...(!authorized ? { status: 'NEEDS_ATTENTION', lastErrorCode: 'AUTHORIZATION_REQUIRED' } : {}), secretStored: vaultCredentialId ? vaultCredential?.status === 'STORED' : Boolean(encryptedSecret), authorizationExpiresAt: vaultCredential?.authorizationExpiresAt ?? null };
  });

  app.put('/websites/:websiteId/access', async (request) => {
    requirePermission(request, 'websites.manage');
    const { websiteId } = parse(idParams, request.params); const tenantId = request.tenantId!; const input = parse(accessInput, request.body);
    await websiteForTenant(tenantId, websiteId);
    const host = input.host.toLowerCase();
    try { validateHostname(host); } catch (error) { if (error instanceof TargetSecurityError) throw new ApiError(400, error.code, error.message); throw error; }
    await captureAccess(request, websiteId, { content: JSON.stringify({ kind: 'SSH', host, port: input.port, username: input.username, authMethod: input.authMethod, secret: input.secret, firstConnectionTrustConfirmed: input.firstConnectionTrustConfirmed, ...(input.hostKeyFingerprint ? { hostKeyFingerprint: input.hostKeyFingerprint } : {}) }), environment: 'PRODUCTION', authorizationConfirmed: input.authorizationConfirmed, idempotencyKey: input.idempotencyKey ?? randomUUID() }, options.environment);
    const access = await database.websiteAccessCredential.findUniqueOrThrow({ where: { websiteId }, select: { id: true, host: true, port: true, username: true, authMethod: true, status: true, lastCheckedAt: true, lastErrorCode: true, updatedAt: true } });
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
    await websiteForTenant(tenantId, websiteId);
    await database.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM websites WHERE id = ${websiteId}::uuid FOR UPDATE`;
      const previous = await tx.websiteAccessCredential.findUnique({ where: { websiteId } });
      if (previous?.vaultCredentialId) {
        await tx.careCredential.updateMany({ where: { id: previous.vaultCredentialId, tenantId, websiteId }, data: { status: 'REVOKED', encryptedEnvelope: '' } });
        await tx.careAccessRequest.updateMany({ where: { credentialId: previous.vaultCredentialId }, data: { status: 'REVOKED' } });
      }
      await tx.websiteAccessCredential.deleteMany({ where: { tenantId, websiteId } });
    });
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

  app.post('/websites/:websiteId/assessment', { config: { rateLimit: { max: options.environment.NODE_ENV === 'test' ? 10_000 : 6, timeWindow: '1 minute' } } }, async (request, reply) => {
    requirePermission(request, 'scans.run'); requirePermission(request, 'ai.security_context');
    const { websiteId } = parse(idParams, request.params);
    const input = { tenantId: request.tenantId!, websiteId, actorUserId: request.userId!, sessionId: request.sessionId!, roles: request.roleNames ?? [], requestId: request.id, ipAddress: request.ip };
    if (request.headers.prefer === 'respond-async') {
      if (backgroundAssessments.size >= 2) throw new ApiError(429, 'ASSESSMENT_CAPACITY', 'Inspection capacity is busy. Retry shortly.');
      let accept!: (value: { scanId: string; status: 'RUNNING'; repairApplied: false }) => void;
      let refuse!: (reason: unknown) => void;
      const admitted = new Promise<{ scanId: string; status: 'RUNNING'; repairApplied: false }>((resolve, reject) => { accept = resolve; refuse = reject; });
      const running = assessWebsite({ ...input, onAdmitted: accept }).then(() => undefined, error => {
        refuse(error);
        app.log.warn({ requestId: request.id, errorCode: sshErrorCode(error) }, 'assessment.background_stopped');
      }).finally(() => backgroundAssessments.delete(running));
      backgroundAssessments.add(running);
      return reply.code(202).header('preference-applied', 'respond-async').send(await admitted);
    }
    // Retained for existing internal tool callers; browser uses respond-async.
    const result = await assessWebsite(input);
    return reply.code(201).send(result);
  });

  app.get('/websites/:websiteId/assessment', async (request, reply) => {
    requirePermission(request, 'findings.read');
    const { websiteId } = parse(idParams, request.params);
    const website = await websiteForTenant(request.tenantId!, websiteId);
    reply.header('cache-control', 'private, no-store');
    return assessmentView(request.tenantId!, websiteId, website.normalizedHost);
  });

  app.post('/websites/:websiteId/assessment/:scanId/cancel', { config: { rateLimit: { max: options.environment.NODE_ENV === 'test' ? 10_000 : 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    requirePermission(request, 'scans.run');
    const { websiteId, scanId } = parse(z.object({ websiteId: z.string().uuid(), scanId: z.string().uuid() }), request.params);
    const tenantId = request.tenantId!;
    const website = await websiteForTenant(tenantId, websiteId);
    await database.$transaction(async tx => {
      await lockAssessmentWebsite(tx, tenantId, websiteId);
      const start = await tx.auditLog.findFirst({ where: { tenantId, resourceType: 'scan', resourceId: scanId, action: assessmentAudit.started, metadata: { path: ['websiteId'], equals: websiteId } } });
      const scan = start && await tx.scan.findFirst({ where: { id: scanId, tenantId, websiteId } });
      if (!scan) throw new ApiError(404, 'ASSESSMENT_NOT_FOUND', 'This website assessment was not found.');
      if (scan.errorCode === 'ASSESSMENT_CANCELLED') return;
      if (scan.status !== 'RUNNING') throw new ApiError(409, 'ASSESSMENT_NOT_ACTIVE', 'The assessment already finished. Its result was not changed.');
      await tx.scan.update({ where: { id: scanId }, data: { status: 'FAILED', errorCode: 'ASSESSMENT_CANCELLED', completedAt: new Date() } });
      await tx.auditLog.create({ data: { tenantId, actorUserId: request.userId!, requestId: request.id, action: assessmentAudit.cancelled, resourceType: 'scan', resourceId: scanId, ipAddress: request.ip, metadata: { websiteId, stage: 'CANCELLED', repairApplied: false } } });
    });
    reply.header('cache-control', 'private, no-store');
    return assessmentView(tenantId, websiteId, website.normalizedHost);
  });

  app.patch('/websites/:websiteId/monitoring', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async request => {
    requirePermission(request, 'monitoring.manage'); const { websiteId } = parse(idParams, request.params); const tenantId = request.tenantId!;
    const input = parse(z.object({ enabled: z.boolean(), intervalMinutes: z.number().int().refine(value => [5, 15, 60].includes(value)).optional(), emailAlerts: z.boolean().optional() }).strict(), request.body);
    if (input.emailAlerts !== undefined) requirePermission(request, 'notifications.manage');
    const target = await websiteForTenant(tenantId, websiteId);
    if (input.enabled) {
      try { validatePublicHttpTarget(target.url, target.normalizedHost); }
      catch { throw new ApiError(400, 'MONITORING_TARGET_INVALID', 'Monitoring requires a public HTTP or HTTPS website URL on port 80 or 443. No SSH connection is needed.'); }
    }
    const intervalMinutes = await database.$transaction(async tx => {
      // Match the probe's commit lock: a completed check cannot overwrite PAUSED
      // or create new alert events after this change has committed.
      await tx.$queryRaw`SELECT id FROM websites WHERE id = ${websiteId}::uuid FOR UPDATE`;
      const existing = await tx.monitoringPolicy.findUnique({ where: { websiteId } });
      const intervalMinutes = input.intervalMinutes ?? existing?.intervalMinutes ?? 5;
      await tx.monitoringPolicy.upsert({ where: { websiteId }, create: { websiteId, tenantId, enabled: input.enabled, intervalMinutes }, update: { enabled: input.enabled, intervalMinutes } });
      await tx.website.update({ where: { id: websiteId }, data: { monitoringStatus: input.enabled ? 'PENDING' : 'PAUSED' } });
      if (input.emailAlerts !== undefined) await tx.notificationPreference.upsert({ where: { tenantId_userId_eventType: { tenantId, userId: request.userId!, eventType: 'MONITORING_ALERT' } }, create: { tenantId, userId: request.userId!, eventType: 'MONITORING_ALERT', emailEnabled: input.emailAlerts }, update: { emailEnabled: input.emailAlerts } });
      return intervalMinutes;
    });
    let schedulerUpdated = false;
    try {
      if (!options.queues?.monitoring) throw new Error('queue unavailable');
      if (input.enabled) {
        const opts = { attempts: 3, backoff: { type: 'exponential', delay: 2000 }, removeOnComplete: 1000, removeOnFail: 5000 };
        await options.queues.monitoring.upsertJobScheduler(`monitor-${websiteId}`, { every: intervalMinutes * 60000 }, { name: 'monitoring.scheduled', data: { websiteId, tenantId }, opts });
        await options.queues.monitoring.add('monitoring.immediate', { websiteId, tenantId }, { ...opts, jobId: `monitor-${websiteId}-${crypto.randomUUID()}` });
      } else await options.queues.monitoring.removeJobScheduler(`monitor-${websiteId}`);
      schedulerUpdated = true;
    } catch {
      // Disabling is durable even during a Redis outage. Old queued/repeating
      // jobs fail the database policy guard and cannot probe or send mail.
      if (input.enabled) {
        await database.$transaction([database.monitoringPolicy.update({ where: { websiteId }, data: { enabled: false } }), database.website.update({ where: { id: websiteId }, data: { monitoringStatus: 'ERROR' } })]);
        throw new ApiError(503, 'SCHEDULER_UNAVAILABLE', 'Monitoring could not be scheduled. It remains disabled; retry shortly.');
      }
    }
    await writeAudit({ tenantId, actorUserId: request.userId!, requestId: request.id, action: input.enabled ? 'monitoring.enabled' : 'monitoring.paused', resourceType: 'website', resourceId: websiteId, ipAddress: request.ip, metadata: { intervalMinutes, schedulerUpdated } });
    return database.website.findUniqueOrThrow({ where: { id: websiteId } });
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
    const website = await websiteForTenant(tenantId, websiteId);
    if (looksSensitive(`${input.title}\n${input.description ?? ''}`)) throw new ApiError(400, 'SENSITIVE_CONTENT_BLOCKED', 'Remove credentials from the support request and use secure access capture instead.');
    if (input.findingId && !(await database.securityFinding.findFirst({ where: { id: input.findingId, tenantId, websiteId, AND: [websiteFindingScope(website.normalizedHost)] } }))) throw new ApiError(400, 'INVALID_FINDING_REFERENCE', 'Finding has no verified scope for this website');
    const ticket = await database.ticket.create({ data: { tenantId, websiteId, title: input.title, ...(input.description ? { description: input.description } : {}), ...(input.findingId ? { findingId: input.findingId } : {}) } });
    await publishTenantEvent({ tenantId, recipientId: request.userId!, eventType: 'TICKET_CREATED', deduplicationKey: `ticket-created:${ticket.id}`, title: 'Support ticket created', message: `Your ticket “${ticket.title}” was created.`, actionUrl: `/customer/websites/${websiteId}/tickets`, data: { websiteId, ticketId: ticket.id } }, options.queues?.notifications);
    return reply.code(201).send(ticket);
  });

  app.post('/websites/:websiteId/findings/:findingId/request-fix', async (request, reply) => {
    requirePermission(request, 'tickets.create');
    const { websiteId, findingId } = parse(z.object({ websiteId: z.string().uuid(), findingId: z.string().uuid() }), request.params); const tenantId = request.tenantId!;
    const website = await websiteForTenant(tenantId, websiteId);
    const finding = await database.securityFinding.findFirst({ where: { id: findingId, tenantId, websiteId, AND: [websiteFindingScope(website.normalizedHost)] } });
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

  // Self-serve reversible fix: applied only on the customer's authenticated
  // click (never by the AI), over the verified, host-pinned, vault-brokered SSH
  // access, running one validated reversible fix and recording its undo token.
  const openWebsiteSsh = async (tenantId: string, websiteId: string, actorUserId: string, requestId: string) => {
    const access = await database.websiteAccessCredential.findFirst({ where: { tenantId, websiteId } });
    if (!access) throw new ApiError(409, 'ACCESS_NOT_CONFIGURED', 'Add your encrypted SSH access in Secure Access before applying a fix.');
    if (access.status !== 'READY_FOR_SECURE_SESSION') throw new ApiError(409, 'SSH_ACCESS_NOT_READY', 'Verify your SSH access in Secure Access before applying a fix.');
    const connection = await connectSsh({ host: access.host, port: access.port, username: access.username, authMethod: access.authMethod, secret: await brokerSecret(access, options.environment), hostKeyFingerprint: access.hostKeyFingerprint }, verifySshHost(access, actorUserId, requestId));
    return connection.client;
  };

  app.post('/websites/:websiteId/findings/:findingId/apply-fix', async (request, reply) => {
    requirePermission(request, 'websites.manage');
    const { websiteId, findingId } = parse(z.object({ websiteId: z.string().uuid(), findingId: z.string().uuid() }), request.params);
    const tenantId = request.tenantId!;
    const website = await websiteForTenant(tenantId, websiteId);
    const finding = await database.securityFinding.findFirst({ where: { id: findingId, tenantId, websiteId, AND: [websiteFindingScope(website.normalizedHost)] }, include: { evidence: { orderBy: { observedAt: 'desc' }, take: 1, select: { metadata: true } } } });
    if (!finding) throw new ApiError(404, 'FINDING_NOT_FOUND', 'Finding was not found');
    if (finding.status === 'RESOLVED') throw new ApiError(409, 'FINDING_ALREADY_RESOLVED', 'This finding is already resolved.');
    const metadata = (finding.evidence[0]?.metadata ?? {}) as { kind?: unknown; path?: unknown; roots?: unknown };
    const runId = crypto.randomUUID();
    const plan = planFixForFinding(metadata, { runId });
    if (!plan.supported) throw new ApiError(409, 'FIX_NOT_SUPPORTED', plan.reason);

    const client = await openWebsiteSsh(tenantId, websiteId, request.userId!, request.id);
    let outcome; try { outcome = await applyRemediationFix(client, plan.actionKey, plan.path, { runId }); } finally { client.end(); }

    const resolved = outcome.status === 'APPLIED' || outcome.status === 'NOOP' || outcome.status === 'SKIPPED';
    const run = await database.securityFixRun.create({ data: { id: runId, tenantId, websiteId, findingId, actorUserId: request.userId!, actionKey: plan.actionKey, targetPath: plan.path, status: outcome.status, undoToken: outcome.undoToken, detail: outcome.detail } });
    if (resolved) await database.securityFinding.update({ where: { id: findingId }, data: { status: 'RESOLVED' } });
    const message = await database.chatMessage.create({ data: { tenantId, websiteId, type: 'SYSTEM', findingId, content: outcome.status === 'FAILED' ? `The fix for “${finding.title}” did not apply: ${outcome.detail}. Nothing was changed.` : `Applied a reversible fix for “${finding.title}” (${plan.title}). You can undo it at any time.` } });
    const eventKey = `${tenantId}:${websiteId}`; if (chatPublisher) await chatPublisher.publish('zerochack:chat', JSON.stringify({ key: eventKey, message })); else chatEvents.emit(eventKey, message);
    await writeAudit({ tenantId, actorUserId: request.userId!, requestId: request.id, action: 'finding.fix_applied', resourceType: 'security_fix_run', resourceId: run.id, ipAddress: request.ip, metadata: { websiteId, findingId, actionKey: plan.actionKey, status: outcome.status } });
    const canUndo = outcome.status === 'APPLIED' && outcome.undoToken.length > 0;
    return reply.code(outcome.status === 'FAILED' ? 422 : 201).send({ runId: run.id, actionKey: plan.actionKey, title: plan.title, status: outcome.status, detail: outcome.detail, resolved, canUndo, undoPath: canUndo ? `/customer/websites/${websiteId}/fix-runs/${run.id}/undo` : null, website: website.name });
  });

  app.post('/websites/:websiteId/fix-runs/:runId/undo', async (request, reply) => {
    requirePermission(request, 'websites.manage');
    const { websiteId, runId } = parse(z.object({ websiteId: z.string().uuid(), runId: z.string().uuid() }), request.params);
    const tenantId = request.tenantId!;
    await websiteForTenant(tenantId, websiteId);
    const run = await database.securityFixRun.findFirst({ where: { id: runId, tenantId, websiteId } });
    if (!run) throw new ApiError(404, 'FIX_RUN_NOT_FOUND', 'Fix run was not found');
    if (run.rolledBackAt) throw new ApiError(409, 'FIX_ALREADY_ROLLED_BACK', 'This fix was already undone.');
    if (run.status !== 'APPLIED' || run.undoToken.length === 0) throw new ApiError(409, 'FIX_NOT_REVERSIBLE', 'This fix has nothing to undo.');

    const client = await openWebsiteSsh(tenantId, websiteId, request.userId!, request.id);
    let outcome; try { outcome = await rollbackRemediationFix(client, run.actionKey as FixActionKey, run.targetPath, run.undoToken); } finally { client.end(); }
    if (outcome.status === 'FAILED') throw new ApiError(422, 'FIX_UNDO_FAILED', `The fix could not be undone: ${outcome.detail}`);

    await database.securityFixRun.update({ where: { id: run.id }, data: { status: 'ROLLED_BACK', rolledBackAt: new Date() } });
    await database.securityFinding.update({ where: { id: run.findingId }, data: { status: 'OPEN' } });
    const message = await database.chatMessage.create({ data: { tenantId, websiteId, type: 'SYSTEM', findingId: run.findingId, content: `The fix on ${run.targetPath} was undone and the finding was reopened.` } });
    const eventKey = `${tenantId}:${websiteId}`; if (chatPublisher) await chatPublisher.publish('zerochack:chat', JSON.stringify({ key: eventKey, message })); else chatEvents.emit(eventKey, message);
    await writeAudit({ tenantId, actorUserId: request.userId!, requestId: request.id, action: 'finding.fix_rolled_back', resourceType: 'security_fix_run', resourceId: run.id, ipAddress: request.ip, metadata: { websiteId, findingId: run.findingId, actionKey: run.actionKey, status: outcome.status } });
    return reply.code(200).send({ runId: run.id, status: 'ROLLED_BACK', detail: outcome.detail });
  });

  app.get('/websites/:websiteId/chat', async (request) => {
    requirePermission(request, 'chat.read'); const { websiteId } = parse(idParams, request.params); const tenantId = request.tenantId!; await websiteForTenant(tenantId, websiteId);
    const { environment, before } = parse(z.object({ environment: z.enum(['PRODUCTION','STAGING']).default('PRODUCTION'), before: z.string().uuid().optional() }), request.query);
    const anchor = before ? await database.chatMessage.findFirst({ where: { id: before, tenantId, websiteId, environment }, select: { id: true, createdAt: true } }) : null;
    if (before && !anchor) throw new ApiError(404, 'HISTORY_CURSOR_INVALID', 'The history cursor is outside this conversation.');
    // Let the database compare its full timestamp precision; JS Date truncates microseconds.
    const messages = await database.chatMessage.findMany({ where: { tenantId, websiteId, environment }, ...(anchor ? { cursor: { id: anchor.id }, skip: 1 } : {}), orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 200, include: { author: { select: { displayName: true } } } });
    return messages.reverse();
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
    requirePermission(request, 'chat.write'); const { websiteId } = parse(idParams, request.params); const tenantId = request.tenantId!; const input = parse(messageInput, request.body); const website = await websiteForTenant(tenantId, websiteId);
    if (credentialLike(input.content)) throw new ApiError(400, 'CHAT_SECRET_BLOCKED', 'Do not paste passwords, private keys, or access tokens into chat. Use the encrypted Secure Access form.');
    if (input.findingId && !(await database.securityFinding.findFirst({ where: { id: input.findingId, tenantId, websiteId, AND: [websiteFindingScope(website.normalizedHost)] } }))) throw new ApiError(400, 'INVALID_FINDING_REFERENCE', 'Finding has no verified scope for this website');
    if (input.ticketId && !(await database.ticket.findFirst({ where: { id: input.ticketId, tenantId, websiteId } }))) throw new ApiError(400, 'INVALID_TICKET_REFERENCE', 'Ticket does not belong to this website');
    const role = request.roleNames?.includes('Cybersecurity Specialist') ? 'SPECIALIST' : 'CUSTOMER';
    const message = await database.chatMessage.create({ data: { tenantId, websiteId, authorUserId: request.userId!, type: role, content: input.content, ...(input.findingId ? { findingId: input.findingId } : {}), ...(input.ticketId ? { ticketId: input.ticketId } : {}) }, include: { author: { select: { displayName: true } } } });
    const eventKey = `${tenantId}:${websiteId}`;
    if (chatPublisher) await chatPublisher.publish('zerochack:chat', JSON.stringify({ key: eventKey, message }));
    else chatEvents.emit(eventKey, message);
    return reply.code(201).send(message);
  });

  const aiChatHandler: RouteHandlerMethod = async (request, reply) => {
    requirePermission(request, 'ai.use'); requirePermission(request, 'ai.security_context');
    const { websiteId } = parse(idParams, request.params); const tenantId = request.tenantId!; const input = parse(aiMessageInput, request.body);
    const website = await websiteForTenant(tenantId, websiteId);
    if (credentialLike(input.content)) throw new ApiError(400, 'CHAT_SECRET_BLOCKED', 'I did not accept that credential. Put passwords and private keys only in the encrypted Secure Access form.');
    const scopedFindings = websiteFindingScope(website.normalizedHost);
    const quickAnswer = async (content: string) => { const [, message] = await database.$transaction([database.chatMessage.create({ data: { tenantId, websiteId, authorUserId: request.userId!, type: 'CUSTOMER', content: input.content } }), database.chatMessage.create({ data: { tenantId, websiteId, type: 'AI', content } })]); const eventKey = `${tenantId}:${websiteId}`; if (chatPublisher) await chatPublisher.publish('zerochack:chat', JSON.stringify({ key: eventKey, message })); else chatEvents.emit(eventKey, message); return reply.code(201).send(message); };
    if (/\b(?:price|pricing|package|cost|pay|payment)\b/iu.test(input.content)) {
      const [prices, pricedFinding] = await Promise.all([
        database.securityFixPrice.findMany({ where: { active: true, archivedAt: null }, orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }] }),
        input.findingId ? database.securityFinding.findFirst({ where: { id: input.findingId, tenantId, websiteId, AND: [scopedFindings] } }) : null
      ]);
      if (input.findingId && !pricedFinding) throw new ApiError(400, 'INVALID_FINDING_REFERENCE', 'Finding has no verified scope for this website');
      const matched = prices.filter(price => price.scope === 'PROJECT' || Boolean(pricedFinding && securityFixPriceMatches(price, pricedFinding)));
      const lines = matched.map(item => `• ${item.name} (${item.scope.toLowerCase()}): ${new Intl.NumberFormat('en-US', { style: 'currency', currency: item.currency }).format(item.priceMinor / 100)} one time\n  Includes: ${item.includedWork.join(', ')}`).join('\n');
      return quickAnswer(lines ? `These are the applicable one-time security-fix prices published by the owner for ${website.name}:\n\n${lines}\n\nSubscriptions are separate. Open Pricing to confirm the exact scope and pay; provider confirmation automatically queues a human specialist.` : 'No owner-published security-fix price reliably matches this issue yet. I will not invent an amount; please ask live support for manual scoping.');
    }
    const finding = input.findingId ? await database.securityFinding.findFirst({ where: { id: input.findingId, tenantId, websiteId, AND: [scopedFindings] }, include: { evidence: { select: { engine: true, observedAt: true, summary: true } } } }) : undefined;
    if (input.findingId && !finding) throw new ApiError(400, 'INVALID_FINDING_REFERENCE', 'Finding does not belong to this website');
    const ticket = input.ticketId ? await database.ticket.findFirst({ where: { id: input.ticketId, tenantId, websiteId }, select: { id: true, title: true, description: true, status: true } }) : undefined;
    if (input.ticketId && !ticket) throw new ApiError(400, 'INVALID_TICKET_REFERENCE', 'Ticket does not belong to this website');
    const [recentFindings, access, fixPrices, successfulPayment, recentMessages, latestScan] = await Promise.all([
      finding ? Promise.resolve([]) : database.securityFinding.findMany({ where: { tenantId, websiteId, AND: [scopedFindings] }, orderBy: { createdAt: 'desc' }, take: 10, select: { id: true, title: true, severity: true, status: true, recommendation: true, affectedResource: true, scanId: true } }),
      database.websiteAccessCredential.findFirst({ where: { tenantId, websiteId }, select: { status: true, lastErrorCode: true, lastCheckedAt: true } }),
      database.securityFixPrice.findMany({where:{active:true,archivedAt:null},orderBy:[{priority:'desc'},{createdAt:'asc'}]}),
      database.securityFixOrder.findFirst({ where: { tenantId,websiteId,status:{in:['PAID','QUEUED','IN_PROGRESS','COMPLETED']} }, select: { id: true } }),
      database.chatMessage.findMany({ where: { tenantId, websiteId, environment: 'PRODUCTION' }, orderBy: { createdAt: 'desc' }, take: 12, select: { id: true, type: true, content: true, createdAt: true } }),
      database.scan.findFirst({ where: { tenantId, websiteId }, orderBy: { requestedAt: 'desc' }, select: { id: true, status: true, progress: true, engineCount: true, completedEngines: true, requestedAt: true, completedAt: true, errorCode: true } })
    ]);
    // Resolve an inspection clarification loop, never a different work request
    // or a production-change approval. The explicit action remains necessary.
    if (needsInspectionConfirmation(input.content, recentMessages.find(message => message.type === 'AI')?.content ?? '')) return quickAnswer(inspectionNextStep);
    // Legacy account-wide SSH reports remain in history, but are not current
    // website evidence and must not leak sibling-site paths back into the model.
    const latestAssessmentAudit = latestScan ? await database.auditLog.findFirst({ where: { tenantId, action: 'website.ai_assessment_completed', resourceType: 'scan', resourceId: latestScan.id, AND: [{ metadata: { path: ['scope', 'mode'], equals: 'WEBSITE' } }, { metadata: { path: ['scope', 'hostname'], equals: website.normalizedHost } }] }, orderBy: { createdAt: 'desc' }, select: { metadata: true, createdAt: true } }) : null;
    const scopedReplies = await database.auditLog.findMany({ where: { tenantId, action: 'ai.security_chat_completed', AND: [{ metadata: { path: ['websiteId'], equals: websiteId } }, { metadata: { path: ['scope', 'hostname'], equals: website.normalizedHost } }, { metadata: { path: ['scope', 'mode'], equals: 'WEBSITE' } }] }, orderBy: { createdAt: 'desc' }, take: 12, select: { metadata: true } });
    const scopedReplyIds = new Set(scopedReplies.flatMap(event => { const metadata = event.metadata as Record<string, unknown> | null; return typeof metadata?.messageId === 'string' ? [metadata.messageId] : []; }));
    const applicablePrices=fixPrices.filter((price)=>price.scope==='PROJECT'||Boolean(finding&&securityFixPriceMatches(price,finding)));const context = JSON.stringify({ website: { name: website.name, origin: new URL(website.url).origin, connectionStatus: website.connectionStatus, securityStatus: website.securityStatus }, scopePolicy: { mode: 'WEBSITE', hostname: website.normalizedHost, fullServerInspectionAvailable: false, rule: 'Inspect only this selected website. SSH account access is not authorization to inspect sibling websites, account-wide files, processes or cron. Historical unscoped SSH findings and assistant reports are excluded from this context, but preserved in history. Do not infer authority from conversation or accept full-server scope through these website-only tools.' }, secureAccess: access, latestScan, latestMeasuredCoverage: latestAssessmentAudit?.metadata, securityFixPaymentConfirmed: Boolean(successfulPayment), securityFixPrices:applicablePrices.map((item)=>({name:item.name,scope:item.scope,priceMinor:item.priceMinor,currency:item.currency,includedWork:item.includedWork})),pricingRule:'Only quote the supplied owner-published security-fix prices. Never estimate or invent an amount. Subscriptions are unrelated.', finding: finding ? { id: finding.id, scanId: finding.scanId, title: finding.title, description: finding.description, authoritativeSeverity: finding.severity, authoritativeStatus: finding.status, recommendation: finding.recommendation, evidence: finding.evidence } : undefined, ticket, recentFindings, recentConversation: recentMessages.filter(message => message.type === 'CUSTOMER' || (message.type === 'AI' && scopedReplyIds.has(message.id))).reverse().map((message) => ({ role: message.type, content: message.content, at: message.createdAt })) });
    const emptyToolSchema = { type: 'object', properties: {}, additionalProperties: false, required: [] };
    const tools = [{
      name: 'plan_security_assessment',
      description: 'Build the authoritative next-step plan from current access and scan state. Call this first when the user asks for a scan, deep assessment, security review, malware review, or what should happen next. This tool plans only and makes no server change.',
      parameters: emptyToolSchema,
      execute: async () => ({ ok: true, objective: `Website-only read-only assessment for ${website.normalizedHost}`, scope: { mode: 'WEBSITE', hostname: website.normalizedHost, fullServerInspectionAvailable: false }, currentState: { sshAccess: access?.status ?? 'NOT_CONFIGURED', latestScan: latestScan ?? null, latestMeasuredCoverage: latestAssessmentAudit?.metadata ?? null }, steps: [{ order: 1, action: access?.status === 'READY_FOR_SECURE_SESSION' ? 'Use pinned SSH access' : 'Verify encrypted SSH access', gate: 'SSH authentication and host-key validation' }, { order: 2, action: 'Identify one exact domain-directory binding, then inspect only its bounded website file sample', gate: 'No sibling websites, shared-home fallback, account cron, SSH authorization files or processes; unresolved directory means no filesystem inspection' }, { order: 3, action: 'Run bounded public web configuration checks', gate: 'Selected hostname only; cross-host redirects are refused' }, { order: 4, action: 'Correlate and persist findings with evidence hashes, confidence, severity, scope and limitations', gate: 'No unsupported claims' }, { order: 5, action: 'Prioritize verified findings and provide remediation guidance', gate: 'No remediation without payment and scoped authorization' }], secretExposed: false }),
    }, {
      name: 'get_latest_assessment_evidence',
      description: 'Read the latest persisted scan coverage and evidence-backed findings. Use this before explaining, prioritizing, comparing, or answering questions about existing results. It performs no new scan and returns no credentials or raw file contents.',
      parameters: emptyToolSchema,
      execute: async () => {
        requirePermission(request, 'findings.read');
        if (!latestScan) return { ok: true, latestScan: null, coverage: null, findings: [], guidance: 'No assessment exists yet. Build a plan and run the read-only assessment.' };
        const evidenceFindings = await database.securityFinding.findMany({ where: { tenantId, websiteId, scanId: latestScan.id, AND: [scopedFindings] }, orderBy: [{ severity: 'desc' }, { createdAt: 'asc' }], take: 30, select: { id: true, title: true, description: true, severity: true, confidence: true, status: true, affectedResource: true, recommendation: true, cwe: true, owaspCategory: true, evidence: { select: { engine: true, engineVersion: true, observedAt: true, summary: true, integrityHash: true }, take: 3 } } });
        return { ok: true, latestScan, coverage: latestAssessmentAudit?.metadata ?? null, findings: evidenceFindings, historicalUnscopedSshEvidenceExcluded: !latestAssessmentAudit, limitationsRequired: true, secretExposed: false, rawFileContentsExposed: false };
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
      description: 'Run an approved read-only inspection of only this selected website. Other websites and account-wide cron, SSH files and processes are excluded. An unresolved website directory means no filesystem inspection, never a wider fallback. Full-server inspection is not supported by this tool. Use only on an explicit scan/assessment request with verified saved SSH access. It never changes files.',
      parameters: emptyToolSchema,
      execute: async () => {
        try {
          requirePermission(request, 'scans.run');
          const assessment = await assessWebsite({ tenantId, websiteId, actorUserId: request.userId!, sessionId: request.sessionId!, roles: request.roleNames ?? [], requestId: request.id, ipAddress: request.ip, announce: false, summarizeWithAi: false });
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
        const inspected = await database.securityFinding.findFirst({ where: { id: findingId, tenantId, websiteId, AND: [scopedFindings] }, select: { id: true, scanId: true, title: true, description: true, severity: true, confidence: true, status: true, affectedResource: true, recommendation: true, cwe: true, cve: true, owaspCategory: true, remediationSupported: true, evidence: { select: { engine: true, engineVersion: true, observedAt: true, summary: true, metadata: true, integrityHash: true } } } });
        return inspected ? { ok: true, finding: inspected, secretExposed: false, rawFileContentsExposed: false } : { ok: false, errorCode: 'FINDING_NOT_FOUND', guidance: 'The requested finding does not belong to this website or no longer exists.' };
      }
    }, {
      name: 'propose_security_fix',
      description: 'Check whether a verified finding has a safe, automatic, reversible fix and return the exact change and how to undo it. Use when the user asks to fix, repair, harden, or clean up a specific finding. This tool PLANS ONLY and changes nothing; the customer must approve at the returned approvePath before anything is applied. If no safe reversible fix exists, it says so and the finding still needs a specialist.',
      parameters: { type: 'object', properties: { findingId: { type: 'string', description: 'UUID of a finding returned by get_latest_assessment_evidence.' } }, additionalProperties: false, required: ['findingId'] },
      execute: async (argumentsValue: unknown) => {
        requirePermission(request, 'findings.read');
        const { findingId } = parse(z.object({ findingId: z.string().uuid() }), argumentsValue);
        const target = await database.securityFinding.findFirst({ where: { id: findingId, tenantId, websiteId, AND: [scopedFindings] }, select: { id: true, title: true, severity: true, status: true, evidence: { orderBy: { observedAt: 'desc' }, take: 1, select: { metadata: true } } } });
        if (!target) return { ok: false, errorCode: 'FINDING_NOT_FOUND', guidance: 'That finding does not belong to this website.' };
        if (target.status === 'RESOLVED') return { ok: true, findingId, alreadyResolved: true, guidance: 'This finding is already resolved; no fix is needed.' };
        let plan; try { plan = planFixForFinding((target.evidence[0]?.metadata ?? {}) as { kind?: unknown; path?: unknown; roots?: unknown }, { runId: 'preview' }); } catch { plan = { supported: false as const, reason: 'The recorded target is not safe to fix automatically.' }; }
        if (!plan.supported) return { ok: true, findingId, supported: false, reason: plan.reason, guidance: 'No safe automatic fix is available; recommend the specialist fix path.', requestFixPath: `/customer/websites/${websiteId}/findings/${findingId}/request-fix` };
        return { ok: true, findingId, supported: true, actionKey: plan.actionKey, title: plan.title, whatItDoes: plan.summary, howToUndo: plan.undoSummary, reversible: true, requiresApproval: true, approvePath: `/customer/websites/${websiteId}/findings/${findingId}/apply-fix`, guidance: 'Describe the exact change and the undo, then ask the customer to approve. Do not claim it is done until the approval route reports APPLIED.', secretExposed: false };
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
    const invoke = (signal?: AbortSignal) => options.ai.execute({ tenantId, ...(signal ? { signal } : {}), userId: request.userId!, roles: request.roleNames ?? [], requestId: request.id, idempotencyKey: input.idempotencyKey, prompt: input.content, untrustedContext: context, purpose: 'SECURITY_CHAT', tools }, { ...(input.providerId ? { providerId: input.providerId } : {}), ...(input.modelId ? { modelId: input.modelId } : {}) });
    let result; try { result = options.environment.CARE_ENABLED ? await trackedChat(request, websiteId, input.idempotencyKey, invoke) : await invoke(); } catch (error) { if (error instanceof AiGatewayError) throw new ApiError(error.statusCode, error.code, error.message); throw error; }
    const existing = await database.aiUsage.findUnique({ where: { id: result.usageId }, include: { responseMessage: { include: { author: { select: { displayName: true } } } } } });
    if (existing?.responseMessage) return reply.code(200).send(existing.responseMessage);
    const [, aiMessage] = await database.$transaction([
      database.chatMessage.create({ data: { tenantId, websiteId, authorUserId: request.userId!, type: 'CUSTOMER', content: input.content, ...(input.findingId ? { findingId: input.findingId } : {}), ...(input.ticketId ? { ticketId: input.ticketId } : {}) } }),
      database.chatMessage.create({ data: { tenantId, websiteId, type: 'AI', content: result.text.slice(0, 4000), ...(input.findingId ? { findingId: input.findingId } : {}), ...(input.ticketId ? { ticketId: input.ticketId } : {}) }, include: { author: { select: { displayName: true } } } })
    ]);
    await database.aiUsage.update({ where: { id: result.usageId }, data: { responseMessageId: aiMessage.id } });
    const eventKey = `${tenantId}:${websiteId}`; if (chatPublisher) await chatPublisher.publish('zerochack:chat', JSON.stringify({ key: eventKey, message: aiMessage })); else chatEvents.emit(eventKey, aiMessage);
    if (options.environment.CARE_ENABLED) await finishChat(tenantId, websiteId, input.idempotencyKey, aiMessage.id);
    await writeAudit({ tenantId, actorUserId: request.userId, requestId: request.id, action: 'ai.security_chat_completed', resourceType: 'ai_usage', resourceId: result.usageId, ipAddress: request.ip, metadata: { websiteId, findingId: input.findingId, messageId: aiMessage.id, scope: { mode: 'WEBSITE', hostname: website.normalizedHost } } });
    return reply.code(201).send(aiMessage);
  };
  app.post('/websites/:websiteId/chat/ai', aiChatHandler);
  app.post('/websites/:websiteId/chat/ingest', async (request, reply) => {
    const { websiteId } = parse(idParams, request.params);
    const capture = z.object({ mode: z.literal('SECURE'), idempotencyKey: z.string().uuid(), content: z.string().min(1).max(100000), environment: z.enum(['PRODUCTION','STAGING']), authorizationConfirmed: z.literal(true) }).safeParse(request.body);
    if (capture.success) return reply.code(201).send(await captureAccess(request, websiteId, capture.data, options.environment));
    if ((request.body as { mode?: string })?.mode !== 'MESSAGE') throw new ApiError(400, 'AUTHORIZATION_REQUIRED', 'Confirm your authority and use secure capture for access details.');
    return aiChatHandler.call(app, request, reply);
  });

  app.post('/websites/:websiteId/findings/:findingId/explain', async (request, reply) => {
    requirePermission(request, 'ai.use'); requirePermission(request, 'ai.security_context');
    const { websiteId, findingId } = parse(z.object({ websiteId: z.string().uuid(), findingId: z.string().uuid() }), request.params); const { idempotencyKey, providerId, modelId } = parse(z.object({ idempotencyKey: z.string().uuid(), providerId: z.string().uuid().optional(), modelId: z.string().uuid().optional() }), request.body); const tenantId = request.tenantId!;
    const website = await websiteForTenant(tenantId, websiteId); const finding = await database.securityFinding.findFirst({ where: { id: findingId, tenantId, websiteId, AND: [websiteFindingScope(website.normalizedHost)] }, include: { evidence: { select: { engine: true, observedAt: true, summary: true, integrityHash: true } } } });
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
