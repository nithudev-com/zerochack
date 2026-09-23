import { describe, expect, it } from 'vitest';
import { checkApiContract, checkDefensiveConfig, checkSecuritySource, compareCssTokens, inventoryDeclaredSchema, inventorySbom } from './defensive-checks.js';
import { prepareReviewSnapshot } from './source-review.js';
import { getReviewKnowledge, KNOWLEDGE_VERSION, searchReviewKnowledge } from './review-knowledge.js';
import { toolCatalogue } from './catalogue.js';
import { implementedRecordTools, implementedReviewTools } from './tool-ids.js';
import { unavailableToolRequirements, workflowToolBindings } from './tool-support.js';

const source = (path: string, content: string) => prepareReviewSnapshot([{ path, content }]);
describe('bounded defensive source tools', () => {
  it('uses syntax nodes without running source or treating comments as executable sinks', () => {
    const snapshot = source('page.tsx', '// eval(text)\nconst example = "eval(text)";\neval(text);\nnew Function(text);\nnode.innerHTML = value;\nconst component = <div dangerouslySetInnerHTML={value}/>;');
    const result = checkSecuritySource(snapshot);
    expect(result.diagnostics.map((r) => [r.code, r.line])).toEqual(expect.arrayContaining([['DYNAMIC_EVAL',3],['DYNAMIC_FUNCTION',4],['HTML_ASSIGNMENT',5],['RAW_HTML_PROP',6]]));
    expect(result.diagnostics).toHaveLength(4);
    expect(result.limitation).toContain('no data-flow');
  });
  it('limits static observations and marks truncation', () => {
    const result = checkSecuritySource(source('page.js', 'eval(text);\n'.repeat(50)));
    expect(result.diagnostics).toHaveLength(30); expect(result.truncated).toBe(true);
    expect(checkSecuritySource(source('page.txt', 'eval(text);')).state).toBe('NOT_APPLICABLE');
  });
  it('finds configuration observations with accurate paths and no echo of source values', () => {
    const result = checkDefensiveConfig(source('server.js', '// DEBUG=true\nconst options = { rejectUnauthorized: false };\nconst cookie = { secure: false };'), 'config');
    expect(result.diagnostics.map((r) => r.code)).toEqual(['TLS_VERIFY_DISABLED','COOKIE_SECURE_DISABLED']);
    expect(result.checkedFiles).toEqual(['server.js']);
    expect(result.diagnostics[0]?.line).toBe(2);
  });
  it('checks container declarations without loading a platform or executing Docker instructions', () => {
    const snapshot = prepareReviewSnapshot([{ path: 'Dockerfile', content: 'FROM node:latest\nUSER root\nRUN echo ignored\n' }, { path: 'deploy.yaml', content: 'privileged: true\nallowPrivilegeEscalation: true\nrunAsUser: 0\n' }]);
    expect(checkDefensiveConfig(snapshot, 'infra').diagnostics.map((r) => r.code).sort()).toEqual(['FLOATING_IMAGE','ROOT_CONTAINER_USER','PRIVILEGED_CONTAINER','PRIVILEGE_ESCALATION','ROOT_CONTAINER_USER'].sort());
  });
  it('inventories both supplied SBOM formats without claiming advisory matches', () => {
    const snapshot = prepareReviewSnapshot([{ path: 'bom.json', content: JSON.stringify({ bomFormat: 'CycloneDX', components: [{ name: 'example', version: '1.0.0', type: 'library' }] }) }, { path: 'spdx.json', content: JSON.stringify({ spdxVersion: 'SPDX-2.3', packages: [{ name: 'other', versionInfo: '2' }] }) }]);
    const result = inventorySbom(snapshot);
    expect(result.state).toBe('DECLARED_ONLY'); expect(result.reports.map((r) => r.format)).toEqual(['CycloneDX','SPDX']);
    expect(result.reports[1]?.packages[0]?.version).toBe('2'); expect(result.limitation).toContain('No image extraction');
    expect(inventorySbom(source('bad.json', '{')).state).toBe('NOT_APPLICABLE');
  });
  it('bounds SBOM entries and does not convert untrusted objects to labels', () => {
    const result = inventorySbom(source('bom.json', JSON.stringify({ bomFormat: 'CycloneDX', components: Array.from({ length: 102 }, () => ({ name: { toString: 'not callable' }, version: 'a'.repeat(300) })) })));
    expect(result.reports[0]?.packages).toHaveLength(100); expect(result.reports[0]?.truncated).toBe(true);
    expect(result.reports[0]?.packages[0]?.name).toBeNull(); expect(result.reports[0]?.packages[0]?.version).toHaveLength(180);
  });
  it('checks OpenAPI references without fetching external documents or recursively resolving cycles', () => {
    const result = checkApiContract(source('openapi.json', JSON.stringify({ openapi: '3.1.0', info: { title: 'Fixture', version: '1' }, paths: { '/example': { get: { responses: {} } } }, components: { schemas: { Loop: { $ref: '#/components/schemas/Loop' }, Missing: { $ref: '#/components/schemas/Absent' }, Remote: { $ref: 'https://example.test/private' }, Inherited: { $ref: '#/constructor' } } } })));
    expect(result.diagnostics.map((r) => r.code).sort()).toEqual(['OPENAPI_EXTERNAL_REF','OPENAPI_REF_MISSING','OPENAPI_REF_MISSING','OPENAPI_RESPONSES'].sort());
    expect(JSON.stringify(result)).not.toContain('https://example.test');
  });
  it('supports JSON pointer escaping and valid empty local targets', () => {
    const result = checkApiContract(source('openapi.json', JSON.stringify({ openapi: '3.0.3', info: { title: 'Fixture', version: '1' }, paths: {}, definitions: { 'x/y~z': null }, item: { $ref: '#/definitions/x~1y~0z' } })));
    expect(result.state).toBe('NO_ISSUES_DETECTED');
    expect(checkApiContract(source('manifest.json', '{}')).state).toBe('NOT_APPLICABLE');
  });
  it('compares scoped CSS declarations without fetching imports or claiming cascade equivalence', () => {
    const snapshot = prepareReviewSnapshot([{ path: 'old.css', content: ':root { --a: red; --removed: 1; }' }, { path: 'next.css', content: '@import "https://example.test/style.css"; :root { --a: blue; --new: 2; }' }]);
    expect(compareCssTokens(snapshot, 'old.css', 'next.css').changes).toEqual([{ token: '--a', change: 'DECLARATIONS_CHANGED' }, { token: '--new', change: 'ADDED' }, { token: '--removed', change: 'REMOVED' }]);
    expect(() => compareCssTokens(snapshot, '../external.css', 'next.css')).toThrow();
    expect(() => compareCssTokens(snapshot, 'next.css', 'next.css')).toThrow();
  });
  it('inventories declared Prisma names while making no database connection', () => {
    expect(inventoryDeclaredSchema(source('schema.prisma', 'model Example {\n id String @id\n}\nenum State {\n READY\n}')).declarations).toEqual([{ path: 'schema.prisma', line: 1, kind: 'model', name: 'Example' }, { path: 'schema.prisma', line: 4, kind: 'enum', name: 'State' }]);
  });
  it('matches exact bundled knowledge revisions and refuses arbitrary document identifiers', () => {
    expect(searchReviewKnowledge('source')).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'source-evidence', version: KNOWLEDGE_VERSION })]));
    expect(searchReviewKnowledge('unknown-tenant-private-doc')).toEqual([]);
    expect(getReviewKnowledge('source-evidence', KNOWLEDGE_VERSION).provenance).toBe('BUNDLED_CARE_POLICY');
    expect(() => getReviewKnowledge('source-evidence', 'old')).toThrow();
    expect(() => getReviewKnowledge('https://example.test', KNOWLEDGE_VERSION)).toThrow();
  });
  it('accounts for every contract with a real binding or a specific missing dependency', () => {
    const implemented = [...implementedReviewTools, ...implementedRecordTools, ...Object.keys(workflowToolBindings)];
    expect(new Set(implemented).size).toBe(implemented.length);
    expect([...implemented, ...Object.keys(unavailableToolRequirements)].sort()).toEqual(toolCatalogue.map((t) => t.id).sort());
    expect(toolCatalogue.filter((t) => t.enabled)).toHaveLength(49);
    expect(toolCatalogue.filter((t) => !t.enabled)).toHaveLength(18);
    for (const tool of toolCatalogue) expect(tool.enabled ? tool.entrypoint : tool.unavailableReason).toBeTruthy();
  });
});
