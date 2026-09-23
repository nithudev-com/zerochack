import { describe, expect, it } from 'vitest';
import { reportIntegrity, signReport, verifyReport, type ReportDocument } from './index.js';

describe('report integrity', () => {
  const report: ReportDocument = { schemaVersion: 1, reportId: 'r', type: 'SECURITY_SCAN', tenantId: 't', website: { id: 'w', name: 'Site', origin: 'https://example.test' }, generatedAt: '2026-09-03T00:00:00.000Z', data: { findings: 2 } };
  it('detects content and signature tampering', () => { const hash = reportIntegrity(report); const signature = signReport(report, 'a sufficiently long signing secret'); expect(verifyReport(report, hash, signature, 'a sufficiently long signing secret')).toBe(true); expect(verifyReport({ ...report, data: { findings: 3 } }, hash, signature, 'a sufficiently long signing secret')).toBe(false); });
  it('is stable across JSON object key reordering',()=>{const reordered={...report,data:{b:2,a:1}};const roundTrip={...report,data:{a:1,b:2}};expect(reportIntegrity(reordered)).toBe(reportIntegrity(roundTrip));expect(signReport(reordered,'secret')).toBe(signReport(roundTrip,'secret'));});
});
