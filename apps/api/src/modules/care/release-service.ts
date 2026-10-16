import { database } from '@zerochack/database';
import type { CareRelease, Prisma } from '@prisma/client';
import type { Environment } from '@zerochack/config';
import { CareError, digestBytes, inspectStaticHtml, openSecret } from '@zerochack/care';
import { safeHttpRequest } from '@zerochack/scanner';
import { careEvent, vaultKey } from './runtime.js';
import { assertRepairActor, readArtifact, writeArtifact } from './repair-service.js';
import { openStaticTarget, type StaticTarget } from './static-target.js';

type ReleaseDependencies = { open: typeof openStaticTarget; health: (url: string, digest: string) => Promise<boolean> };
const defaults: ReleaseDependencies = {
  open: openStaticTarget,
  async health(url, digest) { const response = await safeHttpRequest(url, { allowedHostname: new URL(url).hostname, maxBytes: 200000, maxRedirects: 0, timeoutMs: 10000 }); return response.status === 200 && /text\/html/i.test(response.headers['content-type'] ?? '') && digestBytes(response.body) === digest; }
};
async function authorize(tx: Prisma.TransactionClient, release: CareRelease, env: Environment) {
  const job = await tx.careJob.findUniqueOrThrow({ where: { id: release.jobId } });
  const revision = await tx.careRevision.findUniqueOrThrow({ where: { id: release.revisionId } });
  const website = await tx.website.findUniqueOrThrow({ where: { id: release.websiteId } });
  const credential = await tx.careCredential.findUniqueOrThrow({ where: { id: release.credentialId } });
  const bridge = await tx.websiteAccessCredential.findFirst({ where: { websiteId: website.id, vaultCredentialId: credential.id } });
  const binding = release.evidence as { url?: string; hostKeyFingerprint?: string } | null;
  if (!release.approvedBy || !release.approvalExpiresAt || release.approvalExpiresAt <= new Date() || job.state === 'CANCELLED' || revision.version !== job.planVersion || revision.state !== 'VERIFIED' || revision.sourceDigest !== release.sourceDigest || revision.candidateDigest !== release.candidateDigest || !revision.candidateId || website.connectionStatus !== 'VERIFIED' || binding?.url !== website.url || !binding.hostKeyFingerprint || binding.hostKeyFingerprint !== bridge?.hostKeyFingerprint || credential.status !== 'STORED' || credential.kind !== 'SSH' || credential.environment !== 'PRODUCTION' || credential.version !== release.credentialVersion || credential.authorizationExpiresAt <= new Date()) throw new CareError('APPROVAL_STALE', 'The release authority, source, candidate, website, or account changed.');
  await assertRepairActor(tx, { ...job, userId: release.approvedBy });
  const user = await tx.user.findUniqueOrThrow({ where: { id: release.approvedBy } });
  if (!user.mfaEnabledAt) throw new CareError('MFA_REQUIRED', 'The release approver no longer has MFA enabled.');
  const candidate = readArtifact(await tx.careArtifact.findUniqueOrThrow({ where: { id: revision.candidateId } }), env);
  const source = readArtifact(await tx.careArtifact.findUniqueOrThrow({ where: { id: revision.sourceId } }), env);
  if (digestBytes(candidate) !== release.candidateDigest || digestBytes(source) !== release.sourceDigest) throw new CareError('ARTIFACT_INTEGRITY', 'The approved artifacts failed integrity validation.');
  inspectStaticHtml(candidate.toString('utf8'));
  return { job, candidate, source, url: website.url, access: { host: credential.host, port: credential.port, username: credential.username, authMethod: credential.authMethod, secret: openSecret(credential.encryptedEnvelope, credential, { v1: vaultKey(env) }), hostKeyFingerprint: binding.hostKeyFingerprint } };
}
/** Reconciliation observes known outcomes. It never replays replacement or rollback. */
export async function reconcileRelease(id: string, env: Environment, dependencies: ReleaseDependencies = defaults) {
  if (!env.CARE_RELEASE_ENABLED) throw new CareError('RELEASE_DISABLED', 'Release is disabled.');
  const release = await database.careRelease.findUniqueOrThrow({ where: { id } });
  if (release.state !== 'OUTCOME_UNKNOWN' || release.heartbeatAt.getTime() > Date.now() - 120000) throw new CareError('RECONCILIATION_NOT_READY', 'Wait two minutes after the last worker activity before reconciling an unknown outcome.');
  // Fresh user authentication authorizes observation; all original source/account bindings still apply.
  const context = await database.$transaction((tx) => authorize(tx, { ...release, approvalExpiresAt: new Date(Date.now() + 60000) }, env));
  const target = await dependencies.open(context.access, release.remotePath, release.id);
  try {
    const observed = digestBytes(await target.read());
    if (![release.sourceDigest, release.candidateDigest].includes(observed) || !await dependencies.health(context.url, observed)) throw new CareError('OUTCOME_UNRESOLVED', 'Remote or public evidence is inconclusive. A human operator must investigate; no file was changed.');
    // Removing our release lock is allowed only after the exact file and HTTP result match.
    await target.unlock();
    const state = observed === release.candidateDigest ? 'COMPLETED' : 'BASELINE_CONFIRMED';
    await database.$transaction(async (tx) => {
      const changed = await tx.careRelease.updateMany({ where: { id, state: 'OUTCOME_UNKNOWN' }, data: { state, errorCode: null, evidence: { ...(release.evidence as Prisma.JsonObject), reconciledAt: new Date().toISOString(), remoteDigest: observed, httpDigestMatched: true } } });
      if (!changed.count) throw new CareError('RECONCILIATION_CONFLICT', 'Another observer already reconciled this release.');
      await tx.careJob.update({ where: { id: release.jobId }, data: { state: state === 'COMPLETED' ? 'COMPLETED' : 'WAITING_FOR_INPUT' } });
      await careEvent(tx, { ...context.job, environment: 'PRODUCTION' }, 'release.reconciled', state, 'Remote and public content agree. The outcome was reconciled without replaying a write.', { jobId: release.jobId });
    });
    return { state };
  } finally { target.close(); }
}
export async function runOneRelease(env: Environment, dependencies: ReleaseDependencies = defaults): Promise<boolean> {
  if (!env.CARE_ENABLED || !env.CARE_REPAIR_ENABLED || !env.CARE_RELEASE_ENABLED) return false;
  const release = await database.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM care_releases WHERE state = 'QUEUED' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED`;
    if (!rows[0]) return null;
    return tx.careRelease.update({ where: { id: rows[0].id }, data: { state: 'RUNNING', heartbeatAt: new Date() } });
  });
  if (!release) return false;
  let target: StaticTarget | undefined; let mutationStarted = false; let resolved = false; let heartbeatBusy = false; let fenced = false;
  const timer = setInterval(() => { if (heartbeatBusy) return; heartbeatBusy = true; void database.careRelease.updateMany({ where: { id: release.id, state: { in: ['RUNNING','VERIFYING'] } }, data: { heartbeatAt: new Date() } }).then(({ count }) => { if (!count) { fenced = true; target?.close(); } }).catch(() => { fenced = true; target?.close(); }).finally(() => { heartbeatBusy = false; }); }, 10000);
  try {
    const context = await database.$transaction((tx) => authorize(tx, release, env));
    target = await dependencies.open(context.access, release.remotePath, release.id); await target.lock();
    const original = await target.read();
    if (digestBytes(original) !== release.sourceDigest) throw new CareError('SOURCE_DRIFT', 'The live file differs from the approved source.');
    if (!await dependencies.health(context.url, release.sourceDigest)) throw new CareError('BASELINE_HEALTH_FAILED', 'The website does not serve the exact approved standalone source.');
    await database.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM websites WHERE id = ${release.websiteId}::uuid FOR UPDATE`;
      await authorize(tx, release, env);
      const current = await tx.careRelease.findUniqueOrThrow({ where: { id: release.id } });
      if (current.state !== 'RUNNING') throw new CareError('RELEASE_LEASE_LOST', 'The release state changed.');
      const backup = await writeArtifact(tx, { tenantId: release.tenantId, websiteId: release.websiteId, jobId: release.jobId, environment: 'PRODUCTION', createdBy: release.approvedBy! }, original, 'BACKUP', 'index.html', 'text/html', env);
      if (digestBytes(readArtifact(backup, env)) !== release.sourceDigest) throw new CareError('BACKUP_INVALID', 'The recovery copy failed validation.');
      await tx.careRelease.update({ where: { id: release.id }, data: { backupId: backup.id, state: 'VERIFYING' } });
      await careEvent(tx, context.job, 'release.started', 'VERIFYING', 'The exact source and recovery copy were verified; the approved single-file release is starting.', { jobId: release.jobId });
    });
    if (fenced) throw new CareError('RELEASE_LEASE_LOST', 'The release heartbeat was lost.');
    mutationStarted = true;
    const authorizeCommit = async (recovery: boolean) => {
      if (fenced) throw new CareError('RELEASE_LEASE_LOST', 'The release heartbeat was lost.');
      await database.$transaction(async (tx) => {
        const current = await tx.careRelease.findUniqueOrThrow({ where: { id: release.id } });
        if (current.state !== 'VERIFYING') throw new CareError('RELEASE_LEASE_LOST', 'The release state changed before replacement.');
        // Approved compensation can finish after the start-approval expiry; current actor/account authority still applies.
        await authorize(tx, recovery ? { ...current, approvalExpiresAt: new Date(Date.now() + 60000) } : current, env);
      });
    };
    await target.replace(context.candidate, release.sourceDigest, () => authorizeCommit(false));
    const candidatePresent = digestBytes(await target.read()) === release.candidateDigest;
    if (!candidatePresent) throw new CareError('RELEASE_OUTCOME_UNKNOWN', 'The remote file does not match the candidate after replacement.');
    let healthy = false; try { healthy = await dependencies.health(context.url, release.candidateDigest); } catch { /* A failed check requires the pre-authorized conditional rollback. */ }
    let state = 'COMPLETED';
    if (!healthy) {
      if (fenced) throw new CareError('RELEASE_LEASE_LOST', 'Recovery requires reconciliation after heartbeat loss.');
      await target.replace(original, release.candidateDigest, () => authorizeCommit(true));
      if (digestBytes(await target.read()) !== release.sourceDigest || !await dependencies.health(context.url, release.sourceDigest)) throw new CareError('ROLLBACK_UNVERIFIED', 'Recovery needs manual reconciliation.');
      state = 'ROLLED_BACK';
    }
    await target.unlock();
    await database.$transaction(async (tx) => {
      const changed = await tx.careRelease.updateMany({ where: { id: release.id, state: 'VERIFYING' }, data: { state, errorCode: healthy ? null : 'CANDIDATE_HEALTH_FAILED', evidence: { ...(release.evidence as Prisma.JsonObject), sourceDigest: release.sourceDigest, candidateDigest: release.candidateDigest, verifiedAt: new Date().toISOString(), remoteDigest: healthy ? release.candidateDigest : release.sourceDigest, httpDigestMatched: true } } });
      if (!changed.count) throw new CareError('RELEASE_LEASE_LOST', 'The release outcome needs reconciliation.');
      await tx.careJob.update({ where: { id: release.jobId }, data: { state: healthy ? 'COMPLETED' : 'WAITING_FOR_INPUT', errorCode: healthy ? null : 'CANDIDATE_HEALTH_FAILED' } });
      await careEvent(tx, { ...context.job, environment: 'PRODUCTION' }, 'release.completed', state, healthy ? 'The approved candidate is live. Remote and public response hashes match.' : 'Candidate health verification failed. The original page was restored and verified.', { jobId: release.jobId });
    });
    resolved = true;
  } catch (error) {
    const code = error instanceof CareError ? error.code : 'RELEASE_FAILED';
    const state = mutationStarted ? 'OUTCOME_UNKNOWN' : 'FAILED';
    await database.$transaction(async (tx) => {
      await tx.careRelease.update({ where: { id: release.id }, data: { state, errorCode: code } });
      await careEvent(tx, { tenantId: release.tenantId, websiteId: release.websiteId, environment: 'PRODUCTION' }, 'release.stopped', state, mutationStarted ? 'Release outcome requires reconciliation. No automatic replay will occur.' : 'Release stopped before replacement. Review the blocking check before approving a new release.', { jobId: release.jobId });
    });
  } finally {
    clearInterval(timer);
    if (!mutationStarted && !resolved && target) await target.unlock().catch(() => undefined);
    target?.close();
  }
  return true;
}
