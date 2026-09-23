import 'fastify';

declare module 'fastify' {
  interface FastifyRequest {
    userId?: string;
    tenantId?: string;
    sessionId?: string;
    roleNames?: string[];
    permissions?: string[];
    mfaVerifiedAt?: Date;
    startedAt: bigint;
  }
}
