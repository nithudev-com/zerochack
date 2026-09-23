import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const reportTypes = ['SECURITY_SCAN','REMEDIATION','MONITORING','BEFORE_AFTER'] as const;
export type ReportType = typeof reportTypes[number];
export type ReportDocument = { schemaVersion: 1; reportId: string; type: ReportType; tenantId: string; website: { id: string; name: string; origin: string }; generatedAt: string; data: Record<string, unknown> };

function canonicalize(value:unknown):unknown{if(value instanceof Date)return value.toISOString();if(Array.isArray(value))return value.map(canonicalize);if(typeof value==='object'&&value!==null)return Object.fromEntries(Object.entries(value as Record<string,unknown>).sort(([left],[right])=>left.localeCompare(right)).map(([key,item])=>[key,canonicalize(item)]));return value;}
export function canonicalReport(document: ReportDocument): string { return JSON.stringify(canonicalize(document)); }
export function reportIntegrity(document: ReportDocument): string { return createHash('sha256').update(canonicalReport(document)).digest('hex'); }
export function signReport(document: ReportDocument, secret: string): string { return createHmac('sha256', secret).update(canonicalReport(document)).digest('hex'); }
export function verifyReport(document: ReportDocument, integrityHash: string, signature: string, secret: string): boolean {
  const expectedHash = reportIntegrity(document); const expectedSignature = signReport(document, secret);
  if (integrityHash.length !== expectedHash.length || signature.length !== expectedSignature.length) return false;
  return timingSafeEqual(Buffer.from(integrityHash), Buffer.from(expectedHash)) && timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature));
}
