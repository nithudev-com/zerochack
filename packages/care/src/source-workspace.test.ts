import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { applyWorkspacePatch } from './source-workspace.js';
import { prepareReviewSnapshot } from './source-review.js';
import { runSourceQuality } from './source-quality.js';
import { compareStoredScreenshots } from './screenshot-compare.js';

describe('bounded text workspaces and static profiles', () => {
  it('preserves original bytes and rejects missing, overlapping, outside-path and unchanged edits', () => {
    const original = prepareReviewSnapshot([{ path: 'src/a.ts', content: 'const count = 1; // aaa' }]);
    const patched = applyWorkspacePatch(original, [{ path: 'src/a.ts', before: 'count = 1', after: 'count = 2' }]);
    expect(patched.files[0]!.content).toContain('count = 2');
    expect(original.files[0]!.content).toContain('count = 1');
    for (const patch of [{ path: 'src/a.ts', before: 'aa', after: 'b' }, { path: 'src/a.ts', before: 'missing', after: 'b' }, { path: '../src/a.ts', before: '1', after: '2' }, { path: 'src/a.ts', before: '1', after: '1' }]) expect(() => applyWorkspacePatch(original, [patch])).toThrow();
    expect(() => applyWorkspacePatch(original, [{ path: 'src/a.ts', before: '1', after: '\u0000' }])).toThrow();
    expect(() => applyWorkspacePatch(original, [{ path: 'src/a.ts', before: '1', after: 'x'.repeat(50000) }])).toThrow();
  });
  it('runs fixed lint rules without evaluating uploaded code or configuration', async () => {
    const snapshot = prepareReviewSnapshot([{ path: 'src/a.ts', content: 'var count = 1;\nif (count == 2) { debugger; }\nthrow new Error("NEVER_EXECUTE");' }, { path: 'eslint.config.js', content: 'throw new Error("NEVER_LOAD_PLUGIN");' }]);
    const result = await runSourceQuality('T33', snapshot);
    expect(result.diagnostics.map((d) => d.code)).toEqual(['NO_VAR','STRICT_EQUALITY','NO_DEBUGGER']);
    expect(result.profile).toBe('care-typescript-5.9.3-v1');
  });
  it('detects semantic mismatches across supplied relative modules with trusted standard library types', async () => {
    const result = await runSourceQuality('T34', prepareReviewSnapshot([{ path: 'src/value.ts', content: 'export const count: number = 2;' }, { path: 'src/main.ts', content: 'import { count } from "./value.js";\nconst label: string = count;\nconst values: number[] = [1, 2]; values.map(n => n * 2);' }]));
    expect(result.state).toBe('OBSERVATIONS');
    expect(result.diagnostics).toEqual([expect.objectContaining({ path: 'src/main.ts', line: 2, code: 'TS2322' })]);
  }, 15000);
  it('does not resolve external packages, host files or supplied tsconfig, and returns no false passing status', async () => {
    const result = await runSourceQuality('T34', prepareReviewSnapshot([{ path: 'main.ts', content: '/// <reference path="../../etc/passwd" />\nimport { readFile } from "node:fs";\nimport outside from "../../outside";\nconst value: number = "wrong";' }, { path: 'tsconfig.json', content: '{"compilerOptions":{"strict":false,"noCheck":true}}' }]));
    expect(result.state).toBe('OBSERVATIONS');
    expect(result.diagnostics.map((d) => d.code)).toContain('TS2322');
    expect(result.diagnostics.filter((d) => d.code === 'TS2792' || d.code === 'TS2307').length).toBeGreaterThanOrEqual(2);
    expect(result.diagnostics.every((d) => d.path === 'main.ts')).toBe(true);
  }, 15000);
  it('checks valid standard library code and reports non-code snapshots as inapplicable', async () => {
    expect((await runSourceQuality('T34', prepareReviewSnapshot([{ path: 'good.ts', content: 'export const values: number[] = [1, 2]; values.map(value => value * 2);' }]))).state).toBe('NO_ISSUES_DETECTED');
    expect((await runSourceQuality('T33', prepareReviewSnapshot([{ path: 'a.css', content: ':root { color: red; }' }]))).state).toBe('NOT_APPLICABLE');
  }, 15000);
});

describe('stored screenshot comparison', () => {
  const image = (width: number, color: string) => sharp({ create: { width, height: 2, channels: 3, background: color } }).png().toBuffer();
  it('compares actual pixels and reports exact changed area', async () => {
    const before = await image(2, '#ffffff'); const after = await image(2, '#000000');
    expect(await compareStoredScreenshots(before, before)).toMatchObject({ changedPixels: 0, changedRatio: 0, bounds: null });
    expect(await compareStoredScreenshots(before, after)).toMatchObject({ changedPixels: 4, changedRatio: 1, bounds: { x: 0, y: 0, width: 2, height: 2 } });
    expect(await compareStoredScreenshots(before, await image(3, '#ffffff'))).toMatchObject({ state: 'INCOMPARABLE' });
  });
  it('rejects invalid images and oversized decoded dimensions', async () => {
    await expect(compareStoredScreenshots(Buffer.from('not png'), await image(2, '#ffffff'))).rejects.toThrow();
    const huge = await sharp({ create: { width: 3000, height: 3000, channels: 3, background: '#ffffff' } }).png().toBuffer();
    await expect(compareStoredScreenshots(huge, await image(2, '#ffffff'))).rejects.toThrow();
  });
});
