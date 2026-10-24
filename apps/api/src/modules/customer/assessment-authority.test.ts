import type { Prisma } from '@prisma/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../errors.js';
import { assessmentAccessDigest, assertActiveAssessment, lockAssessmentAuthority, retryAssessmentAuthority, type AssessmentBinding } from './assessment-authority.js';

afterEach(() => vi.useRealTimers());

const now = new Date('2026-10-18T12:00:00Z');
const access = { id: 'access', tenantId: 'tenant', websiteId: 'website', updatedAt: now, host: 'ssh.example.test', port: 22, username: 'fixture', authMethod: 'PASSWORD', hostKeyFingerprint: 'SHA256:fixture-pin', vaultCredentialId: null as string | null, encryptedSecret: 'synthetic-encrypted-value', status: 'READY_FOR_SECURE_SESSION' };
function fixture(vault = false) {
  const snapshot = { ...access, vaultCredentialId: vault ? 'vault' : null };
  const credential = vault ? { tenantId: 'tenant', websiteId: 'website', environment: 'PRODUCTION', kind: 'SSH', status: 'STORED', version: 2, authorizationExpiresAt: new Date(now.getTime() + 60000), host: snapshot.host, port: snapshot.port, username: snapshot.username, authMethod: snapshot.authMethod } : null;
  const mock = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    scan: { findFirst: vi.fn().mockResolvedValue({ status: 'RUNNING' }) },
    website: { findFirst: vi.fn().mockResolvedValue({ lifecycle: 'ACTIVE', url: 'https://example.test/', normalizedHost: 'example.test' }) },
    websiteAccessCredential: { findFirst: vi.fn().mockResolvedValue({ ...snapshot, vaultCredential: credential }) },
    user: { findUnique: vi.fn().mockResolvedValue({ status: 'APPROVED' }) },
    tenantMembership: { findUnique: vi.fn().mockResolvedValue({ status: 'ACTIVE' }) },
    session: { findFirst: vi.fn().mockResolvedValue({ revokedAt: null, expiresAt: new Date(now.getTime() + 60000) }) },
    userRole: { findMany: vi.fn().mockResolvedValue([{ role: { permissions: [{ permission: { key: 'scans.run' } }, { permission: { key: 'ai.security_context' } }] } }]) }
  };
  const binding: AssessmentBinding = { tenantId: 'tenant', websiteId: 'website', scanId: 'scan', userId: 'user', sessionId: 'session', url: 'https://example.test/', normalizedHost: 'example.test', accessDigest: assessmentAccessDigest(snapshot), vaultVersion: vault ? 2 : null };
  return { mock, tx: mock as unknown as Prisma.TransactionClient, binding, snapshot, credential };
}

describe('assessment authority and exact target fences', () => {
  it.each([false,true])('accepts only the current authorized %s-vault binding', async vault => {
    const { tx, binding, mock } = fixture(vault);
    await expect(assertActiveAssessment(tx, binding, now)).resolves.toBeUndefined();
    expect(mock.scan.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'scan', tenantId: 'tenant', websiteId: 'website' } }));
    expect(mock.session.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'session', tenantId: 'tenant', userId: 'user' } }));
    expect(mock.websiteAccessCredential.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { tenantId: 'tenant', websiteId: 'website' } }));
  });
  it.each([null, { status: 'CANCELLED' }, { status: 'SUCCEEDED' }, { status: 'FAILED' }, { status: 'QUEUED' }])('refuses non-active or out-of-scope scan %j', async scan => {
    const { tx, binding, mock } = fixture(); mock.scan.findFirst.mockResolvedValue(scan);
    await expect(assertActiveAssessment(tx, binding, now)).rejects.toMatchObject({ statusCode: 409, code: 'ASSESSMENT_CANCELLED' });
  });
  it.each([null, { lifecycle: 'ARCHIVED', url: 'https://example.test/', normalizedHost: 'example.test' }, { lifecycle: 'ACTIVE', url: 'https://changed.test/', normalizedHost: 'example.test' }, { lifecycle: 'ACTIVE', url: 'https://example.test/', normalizedHost: 'changed.test' }])('rejects lifecycle, tenant absence or target drift', async website => {
    const { tx, binding, mock } = fixture(); mock.website.findFirst.mockResolvedValue(website);
    await expect(assertActiveAssessment(tx, binding, now)).rejects.toMatchObject({ code: 'ASSESSMENT_BINDING_CHANGED' });
  });
  it.each(['id','host','port','username','authMethod','hostKeyFingerprint','encryptedSecret','updatedAt','vaultCredentialId'])('binds every saved-access field: %s', field => {
    const snapshot = { ...access, [field]: field === 'port' ? 2222 : field === 'updatedAt' ? new Date(now.getTime() + 1) : 'changed-fixture' };
    expect(assessmentAccessDigest(snapshot)).not.toBe(assessmentAccessDigest(access));
    expect(assessmentAccessDigest(snapshot)).toMatch(/^[a-f0-9]{64}$/u);
  });
  it.each([null, { ...access, status: 'CONFIGURED' }, { ...access, encryptedSecret: 'rotated-fixture-secret' }])('rejects missing, unverified or rotated bridge access', async current => {
    const { tx, binding, mock } = fixture(); mock.websiteAccessCredential.findFirst.mockResolvedValue(current);
    await expect(assertActiveAssessment(tx, binding, now)).rejects.toMatchObject({ code: 'ASSESSMENT_BINDING_CHANGED' });
  });
  it.each(['user','membership','session','permission'])('requires current actor authorization: %s', async denied => {
    const { tx, binding, mock } = fixture();
    if (denied === 'user') mock.user.findUnique.mockResolvedValue({ status: 'SUSPENDED' });
    if (denied === 'membership') mock.tenantMembership.findUnique.mockResolvedValue({ status: 'SUSPENDED' });
    if (denied === 'session') mock.session.findFirst.mockResolvedValue(null);
    if (denied === 'permission') mock.userRole.findMany.mockResolvedValue([{ role: { permissions: [{ permission: { key: 'scans.run' } }] } }]);
    await expect(assertActiveAssessment(tx, binding, now)).rejects.toMatchObject({ statusCode: 403, code: 'AUTHORIZATION_REQUIRED' });
  });
  it.each([{ revokedAt: now, expiresAt: new Date(now.getTime() + 60000) }, { revokedAt: null, expiresAt: now }])('rejects a revoked or exactly expired session', async session => {
    const { tx, binding, mock } = fixture(); mock.session.findFirst.mockResolvedValue(session);
    await expect(assertActiveAssessment(tx, binding, now)).rejects.toMatchObject({ code: 'AUTHORIZATION_REQUIRED' });
  });
  it.each(['version','tenantId','websiteId','environment','kind','host','port','username','authMethod'])('rejects independent vault drift without bridge rotation: %s', async field => {
    const { tx, binding, mock, snapshot, credential } = fixture(true);
    const changed = { ...credential, [field]: field === 'port' ? 2222 : field === 'version' ? 3 : 'changed-fixture' };
    mock.websiteAccessCredential.findFirst.mockResolvedValue({ ...snapshot, vaultCredential: changed });
    await expect(assertActiveAssessment(tx, binding, now)).rejects.toMatchObject({ code: 'ASSESSMENT_BINDING_CHANGED' });
  });
  it.each(['REVOKED','EXPIRED'])('rejects vault authority %s independently of bridge state', async status => {
    const { tx, binding, mock, snapshot, credential } = fixture(true);
    mock.websiteAccessCredential.findFirst.mockResolvedValue({ ...snapshot, vaultCredential: { ...credential, status } });
    await expect(assertActiveAssessment(tx, binding, now)).rejects.toMatchObject({ code: 'AUTHORIZATION_REQUIRED' });
  });
  it('rejects expired or absent vault records and unexpected legacy versions', async () => {
    const { tx, binding, mock, snapshot, credential } = fixture(true);
    mock.websiteAccessCredential.findFirst.mockResolvedValue({ ...snapshot, vaultCredential: { ...credential, authorizationExpiresAt: now } });
    await expect(assertActiveAssessment(tx, binding, now)).rejects.toMatchObject({ code: 'AUTHORIZATION_REQUIRED' });
    mock.websiteAccessCredential.findFirst.mockResolvedValue({ ...snapshot, vaultCredential: null });
    await expect(assertActiveAssessment(tx, binding, now)).rejects.toMatchObject({ code: 'ASSESSMENT_BINDING_CHANGED' });
    const legacy = fixture();
    await expect(assertActiveAssessment(legacy.tx, { ...legacy.binding, vaultVersion: 2 }, now)).rejects.toMatchObject({ code: 'ASSESSMENT_BINDING_CHANGED' });
  });
  it('never reflects secret-bearing state in a rejected binding error', async () => {
    const { tx, binding, mock } = fixture(); mock.websiteAccessCredential.findFirst.mockResolvedValue({ ...access, encryptedSecret: 'synthetic-private-value' });
    const error = await assertActiveAssessment(tx, binding, now).catch(error => error);
    expect(String(error)).not.toContain('synthetic-private-value'); expect(String(error)).not.toContain(access.encryptedSecret);
  });
  it('locks actual authority rows before checking current state inside the result transaction', async () => {
    const { tx, binding, mock } = fixture();
    // Give the checked session an actual future expiry: the lock wrapper deliberately
    // uses the real clock, rather than extending a historic request's authority.
    mock.session.findFirst.mockResolvedValue({ revokedAt: null, expiresAt: new Date(Date.now() + 60000) });
    mock.scan.findFirst.mockImplementation(() => { expect(mock.$queryRaw).toHaveBeenCalledTimes(7); return Promise.resolve({ status: 'RUNNING' }); });
    await expect(lockAssessmentAuthority(tx, binding)).resolves.toBeUndefined();
    const statements = mock.$queryRaw.mock.calls.map(call => Array.from(call[0] as TemplateStringsArray).join('?'));
    for (const table of ['scans','users','tenant_memberships','sessions','care_credentials','website_access_credentials','user_roles','roles','role_permissions','permissions']) expect(statements.join(' ')).toContain(table);
    expect(statements.every(statement => statement.includes('FOR SHARE') && statement.includes('NOWAIT'))).toBe(true);
    expect(statements[6]).toContain('FOR SHARE OF ur, r, rp, p');
  });
  it.each([{ code: '55P03' }, { code: 'P2010', meta: { code: '55P03' } }])('fails closed on authority contention without a read-only fallback', async error => {
    const { tx, binding, mock } = fixture(); mock.$queryRaw.mockRejectedValue(error);
    await expect(lockAssessmentAuthority(tx, binding)).rejects.toMatchObject({ statusCode: 409, code: 'ASSESSMENT_AUTHORITY_BUSY' });
    expect(mock.scan.findFirst).not.toHaveBeenCalled();
  });
  it('redacts unexpected lock failures and still rejects a revocation observed after locking', async () => {
    const { tx, binding, mock } = fixture(); mock.$queryRaw.mockRejectedValue(new Error('synthetic-private-lock-diagnostic'));
    const error = await lockAssessmentAuthority(tx, binding).catch(error => error);
    expect(error).toMatchObject({ statusCode: 503, code: 'ASSESSMENT_AUTHORITY_UNAVAILABLE' }); expect(String(error)).not.toContain('synthetic-private');
    mock.$queryRaw.mockResolvedValue([]); mock.session.findFirst.mockResolvedValue(null);
    await expect(lockAssessmentAuthority(tx, binding)).rejects.toMatchObject({ code: 'AUTHORIZATION_REQUIRED' });
  });
});

describe('bounded retry of rolled-back assessment authority transactions', () => {
  const busy = () => new ApiError(409, 'ASSESSMENT_AUTHORITY_BUSY', 'Synthetic known-rolled-back lock contention');

  it('rechecks authority and succeeds after one known rolled-back BUSY rejection', async () => {
    vi.useFakeTimers();
    const transaction = vi.fn(async () => 'saved').mockRejectedValueOnce(busy());
    const beforeAttempt = vi.fn(async () => undefined);
    const result = retryAssessmentAuthority(transaction, beforeAttempt);
    await vi.advanceTimersByTimeAsync(24);
    expect(transaction).toHaveBeenCalledTimes(1); expect(beforeAttempt).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBe('saved');
    expect(transaction).toHaveBeenCalledTimes(2); expect(beforeAttempt).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0);
  });

  it('stops after exactly four BUSY attempts and bounded 25/50/100 millisecond delays', async () => {
    vi.useFakeTimers(); const contention = busy();
    const transaction = vi.fn(async () => 'saved').mockRejectedValue(contention);
    const beforeAttempt = vi.fn(async () => undefined);
    const result = expect(retryAssessmentAuthority(transaction, beforeAttempt)).rejects.toBe(contention);
    await vi.advanceTimersByTimeAsync(24); expect(transaction).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); expect(transaction).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(49); expect(transaction).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1); expect(transaction).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(99); expect(transaction).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1); await result;
    expect(transaction).toHaveBeenCalledTimes(4); expect(beforeAttempt).toHaveBeenCalledTimes(4); expect(vi.getTimerCount()).toBe(0);
  });

  it('observes revocation after BUSY before opening any additional transaction', async () => {
    vi.useFakeTimers(); const revoked = new ApiError(403, 'AUTHORIZATION_REQUIRED', 'Synthetic revoked binding');
    const transaction = vi.fn(async () => 'saved').mockRejectedValue(busy());
    const beforeAttempt = vi.fn(async () => undefined).mockResolvedValueOnce(undefined).mockRejectedValue(revoked);
    const result = expect(retryAssessmentAuthority(transaction, beforeAttempt)).rejects.toBe(revoked);
    await vi.advanceTimersByTimeAsync(25); await result;
    expect(transaction).toHaveBeenCalledTimes(1); expect(beforeAttempt).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    new ApiError(403, 'AUTHORIZATION_REQUIRED', 'Synthetic revocation'),
    new ApiError(409, 'ASSESSMENT_CANCELLED', 'Synthetic cancellation'),
    new ApiError(409, 'ASSESSMENT_TIMEOUT', 'Synthetic deadline'),
    new ApiError(409, 'ASSESSMENT_BINDING_CHANGED', 'Synthetic target drift'),
    new ApiError(503, 'ASSESSMENT_AUTHORITY_UNAVAILABLE', 'Synthetic unknown authority failure'),
    new Error('Synthetic uncertain commit failure'),
    { code: 'ASSESSMENT_AUTHORITY_BUSY', message: 'Not the recognized rolled-back ApiError' },
    { code: 'P2010', meta: { code: '55P03' } }
  ])('does not retry, sleep or disguise any other/uncertain transaction failure: %j', async failure => {
    vi.useFakeTimers();
    const transaction = vi.fn(async () => 'saved').mockRejectedValue(failure);
    const beforeAttempt = vi.fn(async () => undefined);
    await expect(retryAssessmentAuthority(transaction, beforeAttempt)).rejects.toBe(failure);
    expect(transaction).toHaveBeenCalledTimes(1); expect(beforeAttempt).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  });

  it('does not open a transaction or retry when the fresh pre-attempt guard fails', async () => {
    vi.useFakeTimers(); const failure = busy();
    const beforeAttempt = vi.fn(async () => undefined).mockRejectedValue(failure);
    const transaction = vi.fn(async () => 'saved');
    await expect(retryAssessmentAuthority(transaction, beforeAttempt)).rejects.toBe(failure);
    expect(transaction).not.toHaveBeenCalled(); expect(beforeAttempt).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  });
});
