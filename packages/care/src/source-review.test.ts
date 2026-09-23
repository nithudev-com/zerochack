import { describe, expect, it } from 'vitest';
import { agentCatalogue, executeReviewTool, implementedReviewTools, prepareReviewSnapshot, reviewPrompt, reviewSteps, validateReviewResult, type ReviewToolContext } from './index.js';

const files = [{ path: 'src/page.tsx', content: 'export function Page() {\n  return <button>Save</button>;\n}\n' }, { path: 'baseline.css', content: ':root { --color: blue; }' }, { path: 'candidate.css', content: ':root { --color: green; }' }];
const snapshot = prepareReviewSnapshot(files);
const context: ReviewToolContext = { tenantId: 'tenant-one', websiteId: 'site-one', jobId: 'job-one', environment: 'STAGING', authorized: true, approvalExpiresAt: new Date(Date.now() + 60000), sourceDigest: 'a'.repeat(64), summary: 'Review the page button', expectedBehavior: 'Check the source and state limitations', snapshot, state: 'RUNNING', completedRoles: [] };
const result = { roleId: 'A09', status: 'REVIEWED', summary: 'A Save button is present in the supplied page source.', findings: [{ title: 'Check interaction behavior', priority: 'LOW', explanation: 'The source includes a Save button; its runtime behavior needs testing.', recommendation: 'Test the expected button behavior with a keyboard and assistive technology.', evidence: [{ path: 'src/page.tsx', startLine: 2, endLine: 2, quote: '<button>Save</button>' }] }], limitations: ['No browser or assistive-technology test was performed.'], nextSteps: ['Run the registered interaction tests in an isolated environment.'] };
describe('source-review scope and evidence controls', () => {
  it('creates a deterministic graph across all 24 roles with reviewers following source specialists', () => {
    const steps = reviewSteps(agentCatalogue.map((role) => role.id).reverse());
    expect(steps).toHaveLength(24); expect(steps[0]?.roleId).toBe('A01'); expect(steps.at(-1)?.roleId).toBe('A18');
    expect(steps.findIndex((step) => step.roleId === 'A14')).toBeGreaterThan(steps.findIndex((step) => step.roleId === 'A07'));
    for (const step of steps) { expect(step.dependsOn).toEqual(step.stepIndex ? [steps[step.stepIndex - 1]!.roleId] : []); expect(reviewPrompt(step.roleId, 'ta')).toContain('Tamil'); }
    expect(() => reviewSteps(['A09','A09'])).toThrow(); expect(() => reviewSteps(['A99'])).toThrow();
  });
  it.each(['../page.ts', '/page.ts', 'src/../../page.ts', '.env', 'src/.env.production', 'credentials.json', 'src/page.exe', 'src\\page.ts', 'src//page.ts'])('rejects out-of-scope or secret-bearing path %s', (path) => {
    expect(() => prepareReviewSnapshot([{ path, content: 'example source' }])).toThrow();
  });
  it('rejects duplicate paths, oversized source, and sensitive content before storage/model use', () => {
    expect(() => prepareReviewSnapshot([...files, { ...files[0]!, path: 'SRC/PAGE.TSX' }])).toThrow();
    expect(() => prepareReviewSnapshot([{ path: 'a.txt', content: 'z'.repeat(200000) }])).toThrow();
    expect(() => prepareReviewSnapshot([{ path: 'a.txt', content: 'password: synthetic-private-credential' }])).toThrow();
    expect(() => prepareReviewSnapshot([{ path: 'a.txt', content: 'binary\u0000data' }])).toThrow();
  });
  it('validates quoted evidence but does not promote observations to runtime proof', () => {
    expect(validateReviewResult(JSON.stringify(result), 'A09', snapshot)).toEqual(result);
    expect(() => validateReviewResult(JSON.stringify({ ...result, testsPassed: true }), 'A09', snapshot)).toThrow();
    expect(() => validateReviewResult(JSON.stringify(result), 'A05', snapshot)).toThrow();
    for (const evidence of [{ path: 'secret.txt', startLine: 2, endLine: 2, quote: '<button>Save</button>' }, { path: 'src/page.tsx', startLine: 1, endLine: 1, quote: '<button>Save</button>' }, { path: 'src/page.tsx', startLine: 2, endLine: 99, quote: '<button>Save</button>' }, { path: 'src/page.tsx', startLine: 2, endLine: 2, quote: 'invented source code' }]) expect(() => validateReviewResult(JSON.stringify({ ...result, findings: [{ ...result.findings[0], evidence: [evidence] }] }), 'A09', snapshot)).toThrow();
  });
  it('requires explicit missing-input states without unsupported findings', () => {
    expect(validateReviewResult(JSON.stringify({ ...result, status: 'NOT_APPLICABLE', findings: [] }), 'A09', snapshot).status).toBe('NOT_APPLICABLE');
    expect(() => validateReviewResult(JSON.stringify({ ...result, status: 'NEEDS_INPUT' }), 'A09', snapshot)).toThrow();
  });
  it('keeps all offline tool handlers inside the approved snapshot and current authorization', () => {
    expect(executeReviewTool('T10', { path: 'src/page.tsx', startLine: 2, endLine: 2 }, context)).toMatchObject({ content: '  return <button>Save</button>;' });
    expect(executeReviewTool('T11', { text: 'Save' }, context)).toEqual([{ path: 'src/page.tsx', line: 2, excerpt: '  return <button>Save</button>;' }]);
    expect(() => executeReviewTool('T10', { path: '../other.ts' }, context)).toThrow();
    expect(() => executeReviewTool('T10', { path: 'src/page.tsx', tenantId: 'other' }, context)).toThrow();
    for (const tool of implementedReviewTools) {
      const args = tool === 'T10' ? { path: 'src/page.tsx' } : tool === 'T11' ? { text: 'Save' } : tool === 'T06' ? { query: 'source' } : tool === 'T07' ? { id: 'source-evidence', version: 'care-policy-notes-v1' } : tool === 'T30' ? { baselinePath: 'baseline.css', candidatePath: 'candidate.css' } : {};
      expect(executeReviewTool(tool, args, context)).toBeDefined();
      expect(() => executeReviewTool(tool, args, { ...context, authorized: false })).toThrow();
      expect(() => executeReviewTool(tool, args, { ...context, approvalExpiresAt: new Date(0) })).toThrow();
    }
  });
  it('labels dependency inventory as declared-only without inventing advisory evidence', () => {
    const dependencies = executeReviewTool('T19', {}, { ...context, snapshot: prepareReviewSnapshot([{ path: 'package.json', content: JSON.stringify({ dependencies: { example: '^1.0.0' } }) }]) });
    expect(dependencies).toEqual([{ path: 'package.json', dependencies: [{ name: 'example', declaredVersion: '^1.0.0' }], truncated: false, evidence: 'DECLARED_ONLY', advisoryCheck: 'NOT_RUN' }]);
  });
});
