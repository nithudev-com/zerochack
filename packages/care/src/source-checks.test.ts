import { describe, expect, it, vi } from 'vitest';
import ts from 'typescript';
import { Document } from 'yaml';
import { checkCss, checkHtml, checkSyntax, checkYaml, prepareReviewSnapshot } from './index.js';
describe('bounded deterministic source checks', () => {
  it('checks every YAML document and reports duplicate keys at the source line', () => {
    const source = prepareReviewSnapshot([{ path: 'deploy.yaml', content: 'kind: Service\n---\nreplicas: 2\nreplicas: 3\n' }]);
    expect(checkYaml(source)).toMatchObject({ state: 'OBSERVATIONS', checkedFiles: ['deploy.yaml'], diagnostics: [{ path: 'deploy.yaml', line: 4, code: 'YAML_DUPLICATE_KEY', message: expect.any(String) }] });
    expect(checkYaml(prepareReviewSnapshot([{ path: 'broken.yml', content: 'services: [web' }])).state).toBe('OBSERVATIONS');
    expect(checkYaml(prepareReviewSnapshot([{ path: 'pipeline.yaml', content: 'name: Build\non: [push]\njobs:\n  build:\n    runs-on: ubuntu-latest\n' }])).state).toBe('NO_ISSUES_DETECTED');
    expect(checkYaml(prepareReviewSnapshot([{ path: 'infra/main.tf', content: 'terraform {}' }])).state).toBe('NOT_APPLICABLE');
  });
  it('does not expand YAML aliases or resolve custom tags and bounds diagnostics without source echo', () => {
    const conversion = vi.spyOn(Document.prototype, 'toJS').mockImplementation(() => { throw new Error('Must not convert YAML to JS'); });
    try {
      expect(checkYaml(prepareReviewSnapshot([{ path: 'compose.yaml', content: 'base: &base {image: example}\nservice: *base\n' }])).state).toBe('NO_ISSUES_DETECTED');
      const tags = checkYaml(prepareReviewSnapshot([{ path: 'template.yaml', content: 'value: !Ref customer-text-marker\n' }]));
      expect(tags.state).toBe('OBSERVATIONS'); expect(JSON.stringify(tags)).not.toContain('customer-text-marker');
      expect(conversion).not.toHaveBeenCalled();
      const noisy = checkYaml(prepareReviewSnapshot([{ path: 'noisy.yaml', content: 'same: value\n'.repeat(100) }]));
      expect(noisy.diagnostics).toHaveLength(30); expect(noisy.truncated).toBe(true);
    } finally { conversion.mockRestore(); }
  });
  it('reports exact HTML attribute locations and missing fragment references', () => {
    const source = prepareReviewSnapshot([{ path: 'index.html', content: '<!doctype html>\n<html><body>\n<img src="https://example.test/image.png">\n<div id="title"></div><p id="title"></p>\n<label for="missing">Name</label>\n<a href="#absent">Open</a><a href="#title">Title</a>\n</body></html>' }]);
    const a11y = checkHtml(source, 'accessibility');
    expect(a11y.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'LANG_MISSING', line: 2 }), expect.objectContaining({ code: 'ALT_MISSING', line: 3 }), expect.objectContaining({ code: 'DUPLICATE_ID', line: 4 }), expect.objectContaining({ code: 'LABEL_TARGET_MISSING', line: 5 })]));
    expect(checkHtml(source, 'links').diagnostics).toEqual([{ path: 'index.html', line: 6, code: 'FRAGMENT_MISSING', message: 'The local link target ID is absent from this HTML file.' }]);
    expect(a11y.limitation).toContain('No accessible-name computation');
  });
  it('parses source without reading imported files, configs, emitting code or running a payload', () => {
    const reads = vi.spyOn(ts.sys, 'readFile').mockImplementation(() => { throw new Error('Unexpected filesystem access'); });
    try {
      const valid = checkSyntax(prepareReviewSnapshot([{ path: 'page.tsx', content: 'import x from "../../outside"; globalThis.sourceCheckMarker = "must-not-run"; const View = () => <button>Save</button>;' }]));
      expect(valid.state).toBe('NO_ISSUES_DETECTED'); expect(reads).not.toHaveBeenCalled(); expect('sourceCheckMarker' in globalThis).toBe(false);
      const invalid = checkSyntax(prepareReviewSnapshot([{ path: 'broken.ts', content: 'const value = ;' }, { path: 'broken.json', content: '{"test": }' }]));
      expect(invalid.diagnostics.map((item) => item.path)).toEqual(['broken.json','broken.ts']);
    } finally { reads.mockRestore(); }
  });
  it('parses CSS without fetching imports and separates unsupported inputs from successful checks', () => {
    expect(checkCss(prepareReviewSnapshot([{ path: 'theme.css', content: '@import "https://example.test/styles.css"; .card { color: red; }' }])).state).toBe('NO_ISSUES_DETECTED');
    expect(checkCss(prepareReviewSnapshot([{ path: 'theme.css', content: '.card { color: red;' }])).diagnostics[0]).toMatchObject({ code: 'CSS_PARSE_ERROR', line: 1 });
    expect(checkCss(prepareReviewSnapshot([{ path: 'theme.scss', content: '$test: red;' }])).state).toBe('NOT_APPLICABLE');
    expect(checkHtml(prepareReviewSnapshot([{ path: 'page.tsx', content: '<img />' }]), 'accessibility').state).toBe('NOT_APPLICABLE');
  });
  it('bounds noisy findings and handles encoded and malformed fragments without throwing', () => {
    const source = prepareReviewSnapshot([{ path: 'page.html', content: '<html lang="en"><body><div id="hello world"></div><a href="#hello%20world">Good</a><a href="#%zz">Bad</a>' + '<img>'.repeat(100) + '</body></html>' }]);
    expect(checkHtml(source, 'accessibility')).toMatchObject({ truncated: true, diagnostics: expect.any(Array) });
    expect(checkHtml(source, 'accessibility').diagnostics).toHaveLength(30);
    expect(checkHtml(source, 'links').diagnostics.map((item) => item.code)).toEqual(['FRAGMENT_ENCODING']);
  });
});
