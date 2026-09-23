import { hash, verify } from '@node-rs/argon2';
import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { RequestContext } from '@zerochack/types';

export interface AuthenticatedPrincipal extends RequestContext { userId: string; tenantId: string; sessionId: string; }

export const passwordPolicy = { minLength: 12, maxLength: 128 } as const;
export const hashPassword = (password: string): Promise<string> => hash(password, { memoryCost: 19_456, timeCost: 2, parallelism: 1 });
export const verifyPassword = (hashValue: string, password: string): Promise<boolean> => verify(hashValue, password);

export const roleNames = ['Customer', 'Agency', 'Affiliate', 'Cybersecurity Specialist', 'Owner'] as const;
export type RoleName = (typeof roleNames)[number];
export const publicRoleNames = roleNames.filter((role) => !['Owner', 'Cybersecurity Specialist'].includes(role));

export function validatePassword(password: string): boolean {
  return password.length >= passwordPolicy.minLength && password.length <= passwordPolicy.maxLength && /[a-z]/.test(password) && /[A-Z]/.test(password) && /\d/.test(password) && /[^A-Za-z0-9]/.test(password);
}

export const normalizeEmail = (email: string): string => email.trim().toLowerCase();
export const generateOpaqueToken = (): string => randomBytes(32).toString('base64url');
export const hashOpaqueToken = (token: string, pepper: string): string => createHmac('sha256', pepper).update(token).digest('hex');

const base32Alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function encodeBase32(input: Uint8Array): string {
  let bits = 0; let value = 0; let output = '';
  for (const byte of input) { value = (value << 8) | byte; bits += 8; while (bits >= 5) { output += base32Alphabet[(value >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) output += base32Alphabet[(value << (5 - bits)) & 31];
  return output;
}

function decodeBase32(input: string): Buffer {
  let bits = 0; let value = 0; const output: number[] = [];
  for (const character of input.replace(/=+$/u, '').toUpperCase()) { const index = base32Alphabet.indexOf(character); if (index < 0) throw new Error('Invalid base32'); value = (value << 5) | index; bits += 5; if (bits >= 8) { output.push((value >>> (bits - 8)) & 255); bits -= 8; } }
  return Buffer.from(output);
}

export const generateTotpSecret = (): string => encodeBase32(randomBytes(20));
export function totp(secret: string, time = Date.now(), stepSeconds = 30): string {
  const counter = Math.floor(time / 1000 / stepSeconds); const buffer = Buffer.alloc(8); buffer.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', decodeBase32(secret)).update(buffer).digest(); const offset = digest[digest.length - 1]! & 15;
  const binary = ((digest[offset]! & 127) << 24) | ((digest[offset + 1]! & 255) << 16) | ((digest[offset + 2]! & 255) << 8) | (digest[offset + 3]! & 255);
  return String(binary % 1_000_000).padStart(6, '0');
}

export function verifyTotp(secret: string, code: string, time = Date.now()): boolean {
  if (!/^\d{6}$/u.test(code)) return false;
  return [-1, 0, 1].some((window) => { const expected = Buffer.from(totp(secret, time + window * 30_000)); const supplied = Buffer.from(code); return expected.length === supplied.length && timingSafeEqual(expected, supplied); });
}

export function encryptSecret(secret: string, base64Key: string): string {
  const key = Buffer.from(base64Key, 'base64'); const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return [iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), encrypted.toString('base64url')].join('.');
}

export function decryptSecret(value: string, base64Key: string): string {
  const [ivValue, tagValue, encryptedValue] = value.split('.'); if (!ivValue || !tagValue || !encryptedValue) throw new Error('Invalid encrypted secret');
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(base64Key, 'base64'), Buffer.from(ivValue, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagValue, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(encryptedValue, 'base64url')), decipher.final()]).toString('utf8');
}

export function generateRecoveryCodes(count = 10): string[] { return Array.from({ length: count }, () => `${randomBytes(4).toString('hex')}-${randomBytes(4).toString('hex')}`); }
