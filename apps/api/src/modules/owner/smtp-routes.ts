import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { database } from '@zerochack/database';
import type { Environment } from '@zerochack/config';
import { ApiError } from '../../errors.js';
import { authenticate, requireOwnerMfa, requirePermission } from '../auth/security.js';
import { parse } from '../auth/routes.js';
import { writeAudit } from '../auth/service.js';
import { PlatformSmtp, smtpInput } from '../communications/smtp-settings.js';

export const smtpRoutes: FastifyPluginAsync<{ environment: Environment; smtp: PlatformSmtp }> = async (app, { environment, smtp }) => {
  app.addHook('preHandler', async request => {
    await authenticate(request, environment);
    requireOwnerMfa(request);
    requirePermission(request, 'integrations.manage');
  });
  app.addHook('onSend', async (_request, reply) => { void reply.header('cache-control', 'private, no-store'); });
  const limited = { config: { rateLimit: { max: environment.NODE_ENV === 'test' ? 10000 : 3, timeWindow: '1 minute' } } };
  app.get('/owner/smtp', async request => {
    const user = await database.user.findUniqueOrThrow({ where: { id: request.userId! }, select: { email: true } });
    return { ...await smtp.status(), testRecipient: user.email };
  });
  app.put('/owner/smtp', limited, async request => {
    const input = parse(smtpInput, request.body);
    return smtp.save(input, { userId: request.userId!, tenantId: request.tenantId!, requestId: request.id, ipAddress: request.ip });
  });
  app.post('/owner/smtp/verify', limited, async () => { await smtp.verify(); return { verified: true, message: 'TLS connection and authentication verified. No email was sent.' }; });
  app.post('/owner/smtp/test', { config: { rateLimit: { max: environment.NODE_ENV === 'test' ? 10000 : 3, timeWindow: '1 hour' } } }, async request => {
    parse(z.object({ confirm: z.literal(true) }).strict(), request.body);
    const user = await database.user.findUniqueOrThrow({ where: { id: request.userId! }, select: { email: true, emailVerifiedAt: true } });
    if (!user.emailVerifiedAt) throw new ApiError(403, 'EMAIL_NOT_VERIFIED', 'Verify your Owner email before sending a test.');
    try { await smtp.send({ to: user.email, subject: 'CodeBandage SMTP test', text: 'This test was requested from your CodeBandage Owner SMTP Settings. The mail server accepted this message. No account verification or password reset action is required.' }); }
    catch { throw new ApiError(400, 'SMTP_TEST_FAILED', 'The test email could not be sent. Check the SMTP connection and sender authorization.'); }
    await writeAudit({ tenantId: request.tenantId, actorUserId: request.userId, requestId: request.id, action: 'email.smtp_test_sent', resourceType: 'system_setting', resourceId: 'email.smtp.primary', ipAddress: request.ip, metadata: { recipient: 'authenticated_owner' } });
    return { accepted: true, message: 'The SMTP server accepted the test email. Check your inbox and spam folder; acceptance does not guarantee inbox delivery.' };
  });
};
