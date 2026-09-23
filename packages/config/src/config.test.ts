import { describe, expect, it } from 'vitest';
import { loadEnvironment } from './index.js';

const valid = {
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/db', REDIS_URL: 'redis://localhost:6379',
  SESSION_SECRET: 'a-secure-test-secret-with-32-characters', CORS_ORIGINS: 'http://localhost:3000'
};

describe('environment configuration', () => {
  it('parses mandatory values', () => expect(loadEnvironment(valid).API_PORT).toBe(4000));
  it('requires the care flag for source reviews and bounds the review allowance', () => {
    expect(() => loadEnvironment({ ...valid, CARE_REVIEW_ENABLED: 'true' })).toThrow(/CARE_ENABLED/);
    expect(() => loadEnvironment({ ...valid, CARE_ENABLED: 'true', CARE_REVIEW_ENABLED: 'true', CARE_REVIEW_BUDGET_MICROS: '100000001' })).toThrow();
    expect(loadEnvironment({ ...valid, CARE_ENABLED: 'true', CARE_REVIEW_ENABLED: 'true' }).CARE_REVIEW_ENABLED).toBe(true);
  });
  it('rejects short secrets', () => expect(() => loadEnvironment({ ...valid, SESSION_SECRET: 'short' })).toThrow());
  it('rejects development MFA and SMTP defaults in production', () => expect(() => loadEnvironment({ ...valid, NODE_ENV: 'production' })).toThrow());
  it('requires encrypted production transports and non-placeholder secrets', () => {
    const production = { ...valid, CARE_ENABLED: 'true', CARE_VAULT_KEY: Buffer.alloc(32, 5).toString('base64'), NODE_ENV: 'production', DATABASE_URL: 'postgresql://user:pass@db.example.com/app?sslmode=require', REDIS_URL: 'rediss://redis.example.com:6380', SESSION_SECRET: 'production-session-secret-with-high-entropy-value', MFA_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'), AI_CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 2).toString('base64'), PAYMENT_CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString('base64'), INTEGRATION_CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 4).toString('base64'), REPORT_SIGNING_KEY: 'production-report-signing-key-with-entropy', METRICS_TOKEN: 'production-metrics-token-with-high-entropy', APP_URL: 'https://app.zerochack.example', NEXT_PUBLIC_API_URL: 'https://api.zerochack.example/v1', CORS_ORIGINS: 'https://app.zerochack.example', SMTP_HOST: 'smtp.zerochack.example', SMTP_FROM: 'security@zerochack.example' };
    expect(() => loadEnvironment({ ...production, CARE_VAULT_KEY: production.INTEGRATION_CREDENTIAL_ENCRYPTION_KEY })).toThrow(/CARE_VAULT/);
    expect(loadEnvironment(production).corsOrigins).toEqual(['https://app.zerochack.example']);
    expect(() => loadEnvironment({ ...production, CARE_REVIEW_ENABLED: 'true' })).toThrow(/CARE_ARTIFACT_KEY/);
    expect(() => loadEnvironment({ ...production, CARE_REVIEW_ENABLED: 'true', CARE_ARTIFACT_KEY: production.MFA_ENCRYPTION_KEY })).toThrow(/CARE_ARTIFACT_KEY/);
    expect(() => loadEnvironment({ ...production, REDIS_URL: 'redis://redis.example.com:6379' })).toThrow(/Redis|TLS/iu);
    expect(() => loadEnvironment({ ...production, DATABASE_URL: 'postgresql://user:pass@db.example.com/app?sslmode=disable' })).toThrow(/TLS/iu);
    expect(() => loadEnvironment({ ...production, METRICS_TOKEN: 'replace-with-a-production-metrics-token' })).toThrow(/METRICS/iu);
    expect(() => loadEnvironment({ ...production, CORS_ORIGINS: '*' })).toThrow(/CORS/iu);
  });
});
