import { z } from 'zod';
import { decryptSecret, encryptSecret } from '@zerochack/auth';
import { database } from '@zerochack/database';
import type { Environment } from '@zerochack/config';
import { SmtpEmailProvider, type EmailMessage, type EmailProvider } from '@zerochack/email';
import { resolvePublicTarget } from '@zerochack/scanner';
import { ApiError } from '../../errors.js';

export const SMTP_SETTING_KEY = 'email.smtp.primary';
const fields = {
  host: z.string().trim().toLowerCase().min(4).max(253).regex(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/u),
  port: z.union([z.literal(465), z.literal(587)]),
  user: z.string().trim().min(1).max(320).regex(/^[^\r\n\x00]+$/u),
  from: z.email().max(320),
  fromName: z.string().trim().min(1).max(120).regex(/^[^\r\n\x00]+$/u)
};
export const smtpInput = z.object({ ...fields, password: z.string().min(1).max(1024).optional(), revision: z.string().min(1).max(80) }).strict();
const storedConfig = z.object({ ...fields, password: z.string().min(1).max(1024) }).strict();
type Input = z.infer<typeof smtpInput>;
type AuditActor = { userId: string; tenantId: string; requestId: string; ipAddress: string };

// One platform-wide setting, encrypted with the existing backed-up integration key.
// Every send re-reads it: API and worker processes cannot retain stale credentials.
export class PlatformSmtp implements EmailProvider {
  constructor(private readonly environment: Environment) {}

  async active() {
    const row = await database.systemSetting.findUnique({ where: { key: SMTP_SETTING_KEY } });
    if (row) {
      const value = z.object({ encryptedCredentials: z.string() }).parse(row.value);
      const settings = storedConfig.parse(JSON.parse(decryptSecret(value.encryptedCredentials, this.environment.INTEGRATION_CREDENTIAL_ENCRYPTION_KEY)));
      return { settings, revision: row.updatedAt.toISOString(), source: 'owner' as const };
    }
    const env = this.environment;
    return { settings: { host: env.SMTP_HOST, port: env.SMTP_PORT, user: env.SMTP_USER ?? '', password: env.SMTP_PASSWORD ?? '', from: env.SMTP_FROM, fromName: 'CodeBandage' }, revision: 'environment', source: 'server' as const };
  }

  async status() {
    const { settings, ...metadata } = await this.active();
    return { ...metadata, host: settings.host, port: settings.port, user: settings.user, from: settings.from, fromName: settings.fromName, passwordSet: Boolean(settings.password) };
  }

  private async provider(settings: Awaited<ReturnType<PlatformSmtp['active']>>['settings'], source: 'owner' | 'server') {
    // Trusted server defaults retain development SMTP support. Owner inputs always
    // require public DNS, a pinned resolved IP, TLS identity verification, and auth.
    if (source === 'server') return new SmtpEmailProvider({ ...settings, secure: this.environment.SMTP_SECURE, requireTLS: this.environment.NODE_ENV === 'production' && !this.environment.SMTP_SECURE });
    const addresses = await resolvePublicTarget(new URL('https://' + settings.host));
    return new SmtpEmailProvider({ ...settings, host: addresses[0]!.address, servername: settings.host, secure: settings.port === 465, requireTLS: settings.port === 587 });
  }

  async verify(): Promise<void> {
    try { const active = await this.active(); await (await this.provider(active.settings, active.source)).verify(); }
    catch { throw new ApiError(400, 'SMTP_VERIFY_FAILED', 'SMTP connection verification failed. Check the host, TLS port, username and password.'); }
  }

  async send(message: EmailMessage) {
    try { const active = await this.active(); return await (await this.provider(active.settings, active.source)).send(message); }
    catch { throw new Error('SMTP_DELIVERY_FAILED'); } // Never propagate provider responses/credentials to logs.
  }

  async save(input: Input, actor: AuditActor) {
    const current = await this.active();
    if (input.revision !== current.revision) throw new ApiError(409, 'SMTP_CHANGED', 'SMTP settings changed. Reload before saving.');
    if (!input.password && (input.host !== current.settings.host || input.user !== current.settings.user)) {
      throw new ApiError(400, 'SMTP_PASSWORD_REQUIRED', 'Enter a new password when changing the SMTP host or username.');
    }
    if (!input.password && !current.settings.password) throw new ApiError(400, 'SMTP_PASSWORD_REQUIRED', 'Enter the SMTP password.');
    const { revision: _revision, ...values } = input;
    void _revision;
    const settings = storedConfig.parse({ ...values, password: input.password ?? current.settings.password });
    try { await (await this.provider(settings, 'owner')).verify(); }
    catch { throw new ApiError(400, 'SMTP_VERIFY_FAILED', 'SMTP verification failed; the working settings were not changed. Check host, TLS port and credentials.'); }
    const encryptedCredentials = encryptSecret(JSON.stringify(settings), this.environment.INTEGRATION_CREDENTIAL_ENCRYPTION_KEY);
    try {
      await database.$transaction(async tx => {
        const latest = await tx.systemSetting.findUnique({ where: { key: SMTP_SETTING_KEY } });
        if ((latest?.updatedAt.toISOString() ?? 'environment') !== input.revision) throw new ApiError(409, 'SMTP_CHANGED', 'SMTP settings changed. Reload before saving.');
        await tx.systemSetting.upsert({ where: { key: SMTP_SETTING_KEY }, create: { key: SMTP_SETTING_KEY, value: { encryptedCredentials }, description: 'Encrypted platform SMTP. Manage through Owner SMTP Settings.', changedByUserId: actor.userId, securityInvariant: true }, update: { value: { encryptedCredentials }, changedByUserId: actor.userId } });
        await tx.auditLog.create({ data: { tenantId: actor.tenantId, actorUserId: actor.userId, requestId: actor.requestId, ipAddress: actor.ipAddress, action: 'email.smtp_updated', resourceType: 'system_setting', resourceId: SMTP_SETTING_KEY, metadata: { passwordRotated: Boolean(input.password), tlsVerified: true } } });
      }, { isolationLevel: 'Serializable' });
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'P2034') throw new ApiError(409, 'SMTP_CHANGED', 'SMTP settings changed. Reload before saving.');
      throw error;
    }
    return this.status();
  }
}
