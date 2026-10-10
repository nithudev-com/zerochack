import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadEnvironment } from '@zerochack/config';
import { encryptSecret } from '@zerochack/auth';
import { PlatformSmtp, smtpInput } from './smtp-settings.js';

const mocks = vi.hoisted(() => ({ find: vi.fn(), upsert: vi.fn(), audit: vi.fn(), transaction: vi.fn(), verify: vi.fn(), send: vi.fn(), transport: vi.fn(), resolve: vi.fn() }));
vi.mock('@zerochack/database', () => ({ database: { systemSetting: { findUnique: mocks.find }, $transaction: mocks.transaction } }));
vi.mock('@zerochack/scanner', () => ({ resolvePublicTarget: mocks.resolve }));
vi.mock('nodemailer', () => ({ default: { createTransport: mocks.transport } }));
const environment = loadEnvironment({ NODE_ENV: 'test', DATABASE_URL: 'postgresql://fixture:fixture@localhost/smtp_test', REDIS_URL: 'redis://localhost:6379', SESSION_SECRET: 'synthetic-session-secret-at-least-32', CORS_ORIGINS: 'http://localhost:3000', SMTP_HOST: 'smtp.mail-provider.com', SMTP_PORT: '465', SMTP_SECURE: 'true', SMTP_USER: 'owner@example.com', SMTP_PASSWORD: 'Synthetic-mail-password9!', SMTP_FROM: 'owner@example.com', INTEGRATION_CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64') });
const settings = { host: 'smtp.mail-provider.com', port: 465 as const, user: 'owner@example.com', from: 'owner@example.com', fromName: 'CodeBandage', password: 'Synthetic-mail-password9!' };
const actor = { userId: 'owner', tenantId: 'platform', requestId: 'fixture', ipAddress: '127.0.0.1' };
const record = (value = settings, date = '2026-01-01T00:00:00.000Z') => ({ updatedAt: new Date(date), value: { encryptedCredentials: encryptSecret(JSON.stringify(value), environment.INTEGRATION_CREDENTIAL_ENCRYPTION_KEY) } });

beforeEach(() => {
  vi.resetAllMocks(); mocks.find.mockResolvedValue(null); mocks.verify.mockResolvedValue(true); mocks.send.mockResolvedValue({ messageId: 'fixture-message' });
  mocks.transport.mockReturnValue({ verify: mocks.verify, sendMail: mocks.send }); mocks.resolve.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
  mocks.transaction.mockImplementation(async fn => fn({ systemSetting: { findUnique: mocks.find, upsert: mocks.upsert }, auditLog: { create: mocks.audit } }));
});
describe('platform SMTP', () => {
  it('keeps server defaults working without returning the password', async () => {
    const service = new PlatformSmtp(environment); const status = await service.status();
    expect(status).toMatchObject({ source: 'server', passwordSet: true, revision: 'environment' }); expect(JSON.stringify(status)).not.toContain(settings.password);
    await service.send({ to: 'recipient@example.test', subject: 'Fixture', text: 'Fixture' }); expect(mocks.transport).toHaveBeenCalledWith(expect.objectContaining({ secure: true, tls: expect.objectContaining({ rejectUnauthorized: true }) }));
  });
  it('verifies pinned public DNS with the original TLS hostname and stores only ciphertext', async () => {
    const service = new PlatformSmtp(environment); await service.save({ ...settings, revision: 'environment' }, actor);
    expect(mocks.transport).toHaveBeenCalledWith(expect.objectContaining({ host: '93.184.216.34', secure: true, tls: expect.objectContaining({ servername: settings.host, rejectUnauthorized: true }) }));
    expect(mocks.verify).toHaveBeenCalledOnce(); expect(JSON.stringify(mocks.upsert.mock.calls)).not.toContain(settings.password); expect(JSON.stringify(mocks.audit.mock.calls)).not.toContain(settings.password);
    expect(mocks.transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: 'Serializable' });
  });
  it('requires STARTTLS for port 587 and retains blank passwords on the same account', async () => {
    const { password: _password, ...publicFields } = settings; void _password;
    await new PlatformSmtp(environment).save({ ...publicFields, port: 587, revision: 'environment' }, actor);
    expect(mocks.transport).toHaveBeenCalledWith(expect.objectContaining({ secure: false, requireTLS: true, auth: { user: settings.user, pass: settings.password } }));
  });
  it('rejects credentials being reused with a different host or username', async () => {
    const { password: _password, ...fields } = settings; void _password;
    await expect(new PlatformSmtp(environment).save({ ...fields, host: 'another.provider.com', revision: 'environment' }, actor)).rejects.toMatchObject({ code: 'SMTP_PASSWORD_REQUIRED' }); expect(mocks.transport).not.toHaveBeenCalled();
  });
  it('does not replace working settings on authentication/TLS/DNS failure', async () => {
    mocks.verify.mockRejectedValue(new Error('provider response with secret '+settings.password));
    await expect(new PlatformSmtp(environment).save({ ...settings, revision: 'environment' }, actor)).rejects.toMatchObject({ code: 'SMTP_VERIFY_FAILED' }); expect(mocks.upsert).not.toHaveBeenCalled();
    mocks.resolve.mockRejectedValue(new Error('DNS_UNSAFE')); await expect(new PlatformSmtp(environment).save({ ...settings, revision: 'environment' }, actor)).rejects.toMatchObject({ code: 'SMTP_VERIFY_FAILED' });
  });
  it('rejects stale forms before contacting a provider and concurrent changes before saving', async () => {
    const service = new PlatformSmtp(environment);
    await expect(service.save({ ...settings, revision: 'old' }, actor)).rejects.toMatchObject({ code: 'SMTP_CHANGED' }); expect(mocks.verify).not.toHaveBeenCalled();
    mocks.find.mockResolvedValueOnce(null).mockResolvedValueOnce(record());
    await expect(service.save({ ...settings, revision: 'environment' }, actor)).rejects.toMatchObject({ code: 'SMTP_CHANGED' }); expect(mocks.upsert).not.toHaveBeenCalled();
  });
  it('API and worker instances pick up the latest settings for every send', async () => {
    const api = new PlatformSmtp(environment), worker = new PlatformSmtp(environment);
    mocks.find.mockResolvedValue(record()); await api.send({ to: 'one@example.test', subject: 'one', text: 'one' });
    mocks.find.mockResolvedValue(record({ ...settings, password: 'Rotated-synthetic-password9!' })); await worker.send({ to: 'two@example.test', subject: 'two', text: 'two' }); await api.send({ to: 'three@example.test', subject: 'three', text: 'three' });
    expect(mocks.transport.mock.calls.map(call => call[0].auth.pass)).toEqual([settings.password, 'Rotated-synthetic-password9!', 'Rotated-synthetic-password9!']);
  });
  it('fails closed on corrupted settings and sanitizes delivery failures', async () => {
    mocks.find.mockResolvedValue({ updatedAt: new Date(), value: { encryptedCredentials: 'corrupted' } });
    await expect(new PlatformSmtp(environment).send({ to: 'one@example.test', subject: 'one', text: 'one' })).rejects.toThrow('SMTP_DELIVERY_FAILED'); expect(mocks.transport).not.toHaveBeenCalled();
    mocks.find.mockResolvedValue(null); mocks.send.mockRejectedValue(new Error(settings.password));
    await expect(new PlatformSmtp(environment).send({ to: 'one@example.test', subject: 'one', text: 'one' })).rejects.toThrow(/^SMTP_DELIVERY_FAILED$/u);
  });
  it('rejects unsafe ports, malformed hosts, header injection and unknown TLS bypass options', () => {
    for (const value of [{ port: 25 }, { host: '127.0.0.1' }, { host: 'https://smtp.example.com' }, { fromName: 'Name\r\nBcc: other@example.com' }, { rejectUnauthorized: false }]) expect(smtpInput.safeParse({ ...settings, revision: 'environment', ...value }).success).toBe(false);
  });
});
