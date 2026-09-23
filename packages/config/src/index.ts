import 'dotenv/config';
import pino, { type Logger } from 'pino';
import { z } from 'zod';

const booleanString = z.enum(['true', 'false']).transform((value) => value === 'true');
const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  CARE_ENABLED: booleanString.default(false),
  CARE_VAULT_KEY: z.string().optional().refine((value) => value === undefined || Buffer.from(value, 'base64').length === 32, 'Must be a base64-encoded 32-byte key'),
  API_HOST: z.string().default('0.0.0.0'),
  API_PORT: z.coerce.number().int().positive().max(65_535).default(4000),
  WEB_PORT: z.coerce.number().int().positive().max(65_535).default(3000),
  NEXT_PUBLIC_API_URL: z.string().url().default('http://localhost:4000/v1'),
  APP_URL: z.string().url().default('http://localhost:3000'),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().url().startsWith('redis'),
  SESSION_SECRET: z.string().min(32),
  MFA_ENCRYPTION_KEY: z.string().default('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=').refine((value) => Buffer.from(value, 'base64').length === 32, 'Must be a base64-encoded 32-byte key'),
  AI_CREDENTIAL_ENCRYPTION_KEY: z.string().default('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=').refine((value) => Buffer.from(value, 'base64').length === 32, 'Must be a base64-encoded 32-byte key'),
  PAYMENT_CREDENTIAL_ENCRYPTION_KEY: z.string().default('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=').refine((value) => Buffer.from(value, 'base64').length === 32, 'Must be a base64-encoded 32-byte key'),
  INTEGRATION_CREDENTIAL_ENCRYPTION_KEY: z.string().default('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=').refine((value) => Buffer.from(value, 'base64').length === 32, 'Must be a base64-encoded 32-byte key'),
  REPORT_SIGNING_KEY: z.string().min(32).default('local-report-signing-key-change-me'),
  METRICS_TOKEN: z.string().min(32).default('local-metrics-token-change-before-prod'),
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(720).default(24),
  EMAIL_TOKEN_TTL_MINUTES: z.coerce.number().int().min(5).max(1440).default(60),
  RESET_TOKEN_TTL_MINUTES: z.coerce.number().int().min(5).max(120).default(30),
  MFA_CHALLENGE_TTL_MINUTES: z.coerce.number().int().min(2).max(15).default(5),
  SMTP_HOST: z.string().default('127.0.0.1'),
  SMTP_PORT: z.coerce.number().int().positive().max(65_535).default(1025),
  SMTP_SECURE: booleanString.default(false),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  SMTP_FROM: z.email().default('security@zerochack.local'),
  CORS_ORIGINS: z.string().min(1),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  TRUST_PROXY: booleanString.default(false),
  SCANNER_TIMEOUT_MS: z.coerce.number().int().min(1000).max(30_000).default(10_000),
  SCANNER_MAX_REDIRECTS: z.coerce.number().int().min(0).max(10).default(5),
  SCANNER_MAX_RESPONSE_BYTES: z.coerce.number().int().min(1024).max(5_242_880).default(1_048_576)
});

export type Environment = z.infer<typeof environmentSchema> & { corsOrigins: string[] };

const defaultEncryptionKey = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const placeholderSecret = (value: string) => /(?:replace[-_ ]?with|change[-_ ]?me|test[-_ ]?only|local[-_ ])/iu.test(value) || /^(.)(?:\1){31,}$/u.test(value);

export function loadEnvironment(source: NodeJS.ProcessEnv = process.env): Environment {
  const result = environmentSchema.safeParse(source);
  if (!result.success) {
    const fields = result.error.issues.map((issue) => issue.path.join('.')).join(', ');
    throw new Error(`Invalid environment configuration. Check: ${fields}`);
  }
  if (result.data.NODE_ENV === 'production' && result.data.MFA_ENCRYPTION_KEY === defaultEncryptionKey) {
    throw new Error('Invalid environment configuration. Check: MFA_ENCRYPTION_KEY');
  }
  if (result.data.NODE_ENV === 'production' && result.data.AI_CREDENTIAL_ENCRYPTION_KEY === defaultEncryptionKey) {
    throw new Error('Invalid environment configuration. Check: AI_CREDENTIAL_ENCRYPTION_KEY');
  }
  if (result.data.NODE_ENV === 'production' && result.data.PAYMENT_CREDENTIAL_ENCRYPTION_KEY === defaultEncryptionKey) {
    throw new Error('Invalid environment configuration. Check: PAYMENT_CREDENTIAL_ENCRYPTION_KEY');
  }
  if (result.data.NODE_ENV === 'production' && result.data.INTEGRATION_CREDENTIAL_ENCRYPTION_KEY === defaultEncryptionKey) {
    throw new Error('Invalid environment configuration. Check: INTEGRATION_CREDENTIAL_ENCRYPTION_KEY');
  }
  if (result.data.NODE_ENV === 'production' && placeholderSecret(result.data.REPORT_SIGNING_KEY)) {
    throw new Error('Invalid environment configuration. Check: REPORT_SIGNING_KEY');
  }
  if (result.data.NODE_ENV === 'production' && placeholderSecret(result.data.METRICS_TOKEN)) {
    throw new Error('Invalid environment configuration. Check: METRICS_TOKEN');
  }
  if (result.data.NODE_ENV === 'production' && result.data.CARE_ENABLED && (!result.data.CARE_VAULT_KEY || result.data.CARE_VAULT_KEY === defaultEncryptionKey || [result.data.AI_CREDENTIAL_ENCRYPTION_KEY, result.data.INTEGRATION_CREDENTIAL_ENCRYPTION_KEY, result.data.MFA_ENCRYPTION_KEY].includes(result.data.CARE_VAULT_KEY))) throw new Error('Invalid environment configuration. Check: distinct CARE_VAULT_KEY');
  const corsOrigins = [...new Set(result.data.CORS_ORIGINS.split(',').map((origin) => origin.trim()).filter(Boolean))];
  if (corsOrigins.length === 0 || corsOrigins.some((origin) => { try { return new URL(origin).origin !== origin; } catch { return true; } })) {
    throw new Error('Invalid environment configuration. Check: CORS_ORIGINS');
  }
  if (result.data.NODE_ENV === 'production') {
    if (placeholderSecret(result.data.SESSION_SECRET) || result.data.SESSION_SECRET === 'ci-only-secret-that-is-at-least-32-characters') throw new Error('Invalid environment configuration. Check: SESSION_SECRET');
    if (new URL(result.data.APP_URL).protocol !== 'https:' || new URL(result.data.NEXT_PUBLIC_API_URL).protocol !== 'https:' || corsOrigins.some((origin) => new URL(origin).protocol !== 'https:' || origin === '*') || result.data.APP_URL.includes('localhost') || result.data.SMTP_HOST === '127.0.0.1' || result.data.SMTP_FROM.endsWith('.local')) {
      throw new Error('Invalid environment configuration. Check: APP_URL, NEXT_PUBLIC_API_URL, CORS_ORIGINS, SMTP_HOST, SMTP_FROM');
    }
    if (!/[?&]sslmode=(?:require|verify-ca|verify-full)(?:&|$)/iu.test(result.data.DATABASE_URL) || new URL(result.data.REDIS_URL).protocol !== 'rediss:') throw new Error('Invalid environment configuration. Check: DATABASE_URL TLS and REDIS_URL TLS');
  }
  return { ...result.data, corsOrigins };
}

const redactPaths = [
  'req.body', 'body', '*.content', '*.encryptedEnvelope',
  'password', '*.password', 'token', '*.token', 'authorization', 'req.headers.authorization',
  'apiKey', '*.apiKey', 'secret', '*.secret', 'privateKey', '*.privateKey',
  'paymentCredentials', '*.paymentCredentials', 'cookie', 'req.headers.cookie'
];

export function createLogger(service: string, level = 'info'): Logger {
  return pino({
    level,
    base: { service },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: redactPaths, censor: '[REDACTED]' },
    messageKey: 'event',
    formatters: { level: (label) => ({ level: label }) }
  });
}
