import { parse, type DefaultTreeAdapterTypes } from 'parse5';
import postcss from 'postcss';
import ts from 'typescript';
import { LineCounter, parseAllDocuments } from 'yaml';
import type { ReviewSnapshot } from './source-review.js';

type Element = DefaultTreeAdapterTypes.Element;
type Diagnostic = { path: string; line: number; code: string; message: string };
export type SourceCheck = { check: string; state: 'OBSERVATIONS' | 'NO_ISSUES_DETECTED' | 'NOT_APPLICABLE'; checkedFiles: string[]; diagnostics: Diagnostic[]; truncated: boolean; limitation: string };
const attr = (node: Element, name: string) => node.attrs.find((item) => item.name === name)?.value;
function elements(content: string): Element[] {
  const nodes: DefaultTreeAdapterTypes.Node[] = [parse(content, { sourceCodeLocationInfo: true })];
  const result: Element[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]!;
    if ('tagName' in node) result.push(node);
    if ('childNodes' in node) nodes.push(...node.childNodes);
  }
  return result;
}
export function sourceCheckReport(check: string, limitation: string) {
  const result: SourceCheck = { check, state: 'NOT_APPLICABLE', checkedFiles: [], diagnostics: [], truncated: false, limitation };
  return {
    result,
    add(path: string, line: number, code: string, message: string) {
      if (result.diagnostics.length < 30) result.diagnostics.push({ path, line, code, message: message.slice(0, 180) });
      else result.truncated = true;
    },
    finish() { result.state = result.diagnostics.length ? 'OBSERVATIONS' : result.checkedFiles.length ? 'NO_ISSUES_DETECTED' : 'NOT_APPLICABLE'; return result; }
  };
}
const report = sourceCheckReport;

/** Parses customer text only. No DOM execution, resources, plugins, config loading or network. */
export function checkHtml(snapshot: ReviewSnapshot, mode: 'accessibility' | 'links'): SourceCheck {
  const check = report(mode, mode === 'accessibility' ? 'Static HTML attributes only. No accessible-name computation, CSS visibility, contrast, keyboard, assistive-technology or WCAG certification.' : 'Checks local fragment IDs in supplied HTML only. External links and routes are not fetched or verified.');
  for (const file of snapshot.files.filter((item) => /\.html?$/i.test(item.path))) {
    check.result.checkedFiles.push(file.path);
    try {
      const nodes = elements(file.content); const ids = new Set<string>();
      for (const node of nodes) { const id = attr(node, 'id'); if (id) { if (ids.has(id) && mode === 'accessibility') check.add(file.path, node.sourceCodeLocation?.startLine ?? 1, 'DUPLICATE_ID', 'This ID is declared more than once in this HTML file.'); ids.add(id); } }
      for (const node of nodes) {
        const line = node.sourceCodeLocation?.startLine ?? 1;
        if (mode === 'accessibility') {
          if (node.tagName === 'html' && !attr(node, 'lang')?.trim()) check.add(file.path, line, 'LANG_MISSING', 'The HTML document needs its primary language declared.');
          if (node.tagName === 'img' && attr(node, 'alt') === undefined) check.add(file.path, line, 'ALT_MISSING', 'Review and provide image alternative text; decorative images use an empty alt attribute.');
          if (node.tagName === 'iframe' && !attr(node, 'title')?.trim()) check.add(file.path, line, 'FRAME_TITLE_MISSING', 'Provide a descriptive iframe title.');
          if (node.tagName === 'label' && attr(node, 'for') && !ids.has(attr(node, 'for')!)) check.add(file.path, line, 'LABEL_TARGET_MISSING', 'The label target ID is absent from this HTML file.');
          if (['aria-labelledby','aria-describedby'].some((name) => attr(node, name)?.trim().split(/\s+/).some((id) => !ids.has(id)))) check.add(file.path, line, 'ARIA_TARGET_MISSING', 'A referenced ARIA description or label ID is absent from this HTML file.');
        } else if (node.tagName === 'a') {
          const href = attr(node, 'href');
          if (href?.startsWith('#') && href.length > 1) {
            try { if (!ids.has(decodeURIComponent(href.slice(1)))) check.add(file.path, line, 'FRAGMENT_MISSING', 'The local link target ID is absent from this HTML file.'); }
            catch { check.add(file.path, line, 'FRAGMENT_ENCODING', 'The local fragment contains invalid percent encoding.'); }
          }
        }
      }
    } catch { check.add(file.path, 1, 'PARSE_INCOMPLETE', 'HTML parsing could not complete. This file needs manual review.'); }
  }
  return check.finish();
}

export function checkSyntax(snapshot: ReviewSnapshot): SourceCheck {
  const check = report('source-syntax', 'JSON and JS/TS/JSX/TSX syntax only. No imports, project configuration, type checking, code execution, tests or security certification.');
  for (const file of snapshot.files.filter((item) => /\.(json|[cm]?[jt]sx?)$/i.test(item.path))) {
    check.result.checkedFiles.push(file.path);
    if (/\.json$/i.test(file.path)) {
      try { JSON.parse(file.content); } catch { check.add(file.path, 1, 'INVALID_JSON', 'The supplied file is not valid strict JSON.'); }
      continue;
    }
    try {
      // In-memory compiler host: no filesystem reads, imports, plugins or emit.
      const source = ts.createSourceFile(file.path, file.content, ts.ScriptTarget.Latest, true);
      const program = ts.createProgram([file.path], { noLib: true, noResolve: true, noEmit: true, allowJs: true, jsx: ts.JsxEmit.Preserve }, {
        getSourceFile: (name) => name === file.path ? source : undefined,
        getDefaultLibFileName: () => '', writeFile: () => undefined, getCurrentDirectory: () => '',
        getDirectories: () => [], fileExists: (name) => name === file.path, readFile: () => undefined,
        getCanonicalFileName: (name) => name, useCaseSensitiveFileNames: () => true, getNewLine: () => '\n'
      });
      for (const diagnostic of program.getSyntacticDiagnostics(source)) check.add(file.path, source.getLineAndCharacterOfPosition(diagnostic.start ?? 0).line + 1, `TS${diagnostic.code}`, ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '));
    } catch { check.add(file.path, 1, 'PARSE_INCOMPLETE', 'Syntax parsing could not complete. This file needs manual review.'); }
  }
  return check.finish();
}

export function checkCss(snapshot: ReviewSnapshot): SourceCheck {
  const check = report('css-syntax', 'Parses standalone CSS only, without plugins or source maps. No rendering, cascade, responsive-layout or browser-compatibility verification.');
  for (const file of snapshot.files.filter((item) => /\.css$/i.test(item.path))) {
    check.result.checkedFiles.push(file.path);
    try { postcss.parse(file.content, { from: undefined, map: false }); }
    catch (error) { check.add(file.path, error instanceof postcss.CssSyntaxError ? error.line ?? 1 : 1, 'CSS_PARSE_ERROR', error instanceof postcss.CssSyntaxError ? error.reason : 'CSS parsing could not complete.'); }
  }
  return check.finish();
}

export function checkYaml(snapshot: ReviewSnapshot): SourceCheck {
  const check = report('yaml-syntax', 'YAML syntax and duplicate keys only. No alias expansion, custom tag resolution, template rendering, platform schema validation, external includes or pipeline execution.');
  for (const file of snapshot.files.filter((item) => /\.ya?ml$/i.test(item.path))) {
    check.result.checkedFiles.push(file.path);
    try {
      const lineCounter = new LineCounter();
      // Retain the AST only; never convert to JS or resolve aliases/tags/includes.
      const documents = parseAllDocuments(file.content, { lineCounter, prettyErrors: false, strict: true, uniqueKeys: true, schema: 'core', customTags: [], resolveKnownTags: false, logLevel: 'silent' });
      for (const document of documents) for (const issue of [...document.errors, ...document.warnings]) {
        const message = issue.code === 'DUPLICATE_KEY' ? 'This YAML mapping declares the same key more than once.' : issue.code === 'TAG_RESOLVE_FAILED' ? 'This YAML tag needs platform-specific review; custom tags are not resolved.' : 'Review the YAML syntax at this location; templates and platform-specific extensions need separate validation.';
        check.add(file.path, lineCounter.linePos(issue.pos[0]).line, `YAML_${issue.code}`, message);
      }
    } catch { check.add(file.path, 1, 'PARSE_INCOMPLETE', 'YAML parsing could not complete. This file needs manual review.'); }
  }
  return check.finish();
}
