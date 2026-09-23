import { z } from 'zod';

export const uuidSchema = z.uuid();
export const paginationSchema = z.object({
  cursor: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25)
});
export type Pagination = z.infer<typeof paginationSchema>;

const password = z.string().min(12).max(128).regex(/[a-z]/).regex(/[A-Z]/).regex(/\d/).regex(/[^A-Za-z0-9]/);
export const publicRegistrationRoleSchema = z.enum(['Customer', 'Agency', 'Affiliate']);
export const registrationSchema = z.object({
  email: z.email().max(320), password, displayName: z.string().trim().min(2).max(120),
  organizationName: z.string().trim().min(2).max(160), role: publicRegistrationRoleSchema
});
export const loginSchema = z.object({ email: z.email().max(320), password: z.string().min(1).max(128) });
export const tokenSchema = z.object({ token: z.string().min(32).max(256) });
export const resetPasswordSchema = tokenSchema.extend({ password });
export const forgotPasswordSchema = z.object({ email: z.email().max(320) });
export const mfaCodeSchema = z.object({ challengeToken: z.string().min(32).max(256), code: z.string().min(6).max(32) });
export const approvalSchema = z.object({ status: z.enum(['APPROVED', 'REJECTED', 'SUSPENDED', 'DEACTIVATED']), reason: z.string().trim().min(3).max(500).optional() });
