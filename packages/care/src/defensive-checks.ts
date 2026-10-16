import ts from 'typescript';
import postcss from 'postcss';
import { CareError } from './vault.js';
import type { ReviewSnapshot } from './source-review.js';
import { sourceCheckReport } from './source-checks.js';

/** Versioned, deterministic observations on supplied text. Nothing is evaluated or fetched. */
export const DEFENSIVE_RULESET = 'care-defensive-v1';
export function checkSecuritySource(snapshot: ReviewSnapshot) {
  const check = sourceCheckReport('security-source', `${DEFENSIVE_RULESET}: JS/TS syntax patterns only; no data-flow analysis, exploit tests or security certification. Matches require human review.`);
  for (const file of snapshot.files.filter((f) => /\.[cm]?[jt]sx?$/i.test(f.path))) {
    check.result.checkedFiles.push(file.path);
    const source = ts.createSourceFile(file.path, file.content, ts.ScriptTarget.Latest, true);
    const pending: ts.Node[] = [source];
    while (pending.length) {
      const node = pending.pop()!;
      const add = (code: string, message: string) => check.add(file.path, source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, code, message);
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'eval') add('DYNAMIC_EVAL', 'Review dynamic evaluation; prefer a fixed parser or explicit operation allowlist.');
      if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'Function') add('DYNAMIC_FUNCTION', 'Review dynamic function construction and remove untrusted code evaluation.');
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(node.left) && ['innerHTML','outerHTML'].includes(node.left.name.text)) add('HTML_ASSIGNMENT', 'Review this HTML assignment; use text content or a maintained sanitizer for untrusted input.');
      if (ts.isJsxAttribute(node) && node.name.getText(source) === 'dangerouslySetInnerHTML') add('RAW_HTML_PROP', 'Review the origin and sanitization of HTML supplied to this component.');
      ts.forEachChild(node, (child) => { pending.push(child); });
    }
  }
  return check.finish();
}

type Rule = { code: string; pattern: RegExp; message: string };
const configRules: Rule[] = [
  { code: 'TLS_VERIFY_DISABLED', pattern: /\b(?:rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED\s*[:=]\s*["']?0)\b/i, message: 'Certificate verification appears disabled. Restore verification and configure a trusted certificate chain.' },
  { code: 'COOKIE_SECURE_DISABLED', pattern: /\bsecure\s*:\s*false\b/i, message: 'A secure option is false. Check whether this is a session cookie or development-only configuration.' },
  { code: 'DEBUG_ENABLED', pattern: /\b(?:DEBUG|APP_DEBUG)\s*[:=]\s*["']?true\b/i, message: 'Debug mode appears enabled. Confirm that production does not expose debug information.' },
  { code: 'CORS_WILDCARD', pattern: /access-control-allow-origin[^\n]{0,40}\*/i, message: 'Review this wildcard origin against the intended cross-origin access policy.' }
];
const infraRules: Rule[] = [
  { code: 'PRIVILEGED_CONTAINER', pattern: /^\s*(?:privileged|hostNetwork|hostPID)\s*:\s*true\b/i, message: 'Review this elevated container capability and restrict it to the minimum required scope.' },
  { code: 'ROOT_CONTAINER_USER', pattern: /^(?:\s*USER\s+(?:root|0)(?:\s|$)|\s*runAsUser\s*:\s*0\b)/i, message: 'This declaration selects the root user. Use a restricted runtime identity where supported.' },
  { code: 'FLOATING_IMAGE', pattern: /^\s*(?:FROM\s+\S+:latest(?:\s|$)|image:\s*[^\s]+:latest\s*$)/i, message: 'The image uses a floating latest tag. Pin and review an immutable image digest.' },
  { code: 'PRIVILEGE_ESCALATION', pattern: /^\s*allowPrivilegeEscalation\s*:\s*true\b/i, message: 'Review and disable container privilege escalation where the workload allows it.' }
];
export function checkDefensiveConfig(snapshot: ReviewSnapshot, mode: 'config' | 'infra') {
  const check = sourceCheckReport(mode === 'infra' ? 'infrastructure-manifest' : 'security-config', `${DEFENSIVE_RULESET}: line-pattern observations only. Comments/templates may match. No platform schema, deployed-state or comprehensive security validation.`);
  const accepted = mode === 'infra' ? /(?:^|\/)(?:Dockerfile|Containerfile)$|\.(?:ya?ml|tf|hcl)$/i : /\.(?:[cm]?[jt]s|json|ya?ml|toml|ini|conf|config|properties)$/i;
  for (const file of snapshot.files.filter((f) => accepted.test(f.path))) {
    check.result.checkedFiles.push(file.path);
    file.content.split('\n').forEach((line, index) => {
      if (/^\s*(?:#|\/\/)/.test(line)) return;
      for (const rule of mode === 'infra' ? infraRules : configRules) if (rule.pattern.test(line)) check.add(file.path, index + 1, rule.code, rule.message);
    });
  }
  return check.finish();
}

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const label = (value: unknown) => typeof value === 'string' ? value.slice(0, 180) : null;
export function inventorySbom(snapshot: ReviewSnapshot) {
  const reports = [];
  for (const file of snapshot.files.filter((f) => /\.json$/i.test(f.path))) {
    let data: unknown; try { data = JSON.parse(file.content); } catch { continue; }
    if (!record(data)) continue;
    const format = data.bomFormat === 'CycloneDX' ? 'CycloneDX' : typeof data.spdxVersion === 'string' && data.spdxVersion.startsWith('SPDX-') ? 'SPDX' : null;
    if (!format) continue;
    const entries = format === 'CycloneDX' ? data.components : data.packages;
    reports.push({ path: file.path, format, packages: Array.isArray(entries) ? entries.slice(0, 100).filter(record).map((item) => ({ name: label(item.name), version: label(format === 'CycloneDX' ? item.version : item.versionInfo), type: label(item.type) })) : [], truncated: Array.isArray(entries) && entries.length > 100 });
  }
  return { state: reports.length ? 'DECLARED_ONLY' : 'NOT_APPLICABLE', reports, limitation: 'Top-level supplied CycloneDX/SPDX JSON declarations only. No image extraction, signature verification, nested component inventory or advisory matching.' };
}

export function checkApiContract(snapshot: ReviewSnapshot) {
  const check = sourceCheckReport('api-contract-structure', `${DEFENSIVE_RULESET}: basic OpenAPI 3 JSON structure and local reference existence only. No full OpenAPI/JSON Schema validation, compatibility certification or API execution.`);
  for (const file of snapshot.files.filter((f) => /\.json$/i.test(f.path))) {
    let data: unknown; try { data = JSON.parse(file.content); } catch { continue; }
    if (!record(data) || typeof data.openapi !== 'string' || !/^3\.[01]\./.test(data.openapi)) continue;
    check.result.checkedFiles.push(file.path);
    const add = (code: string, message: string) => check.add(file.path, 1, code, message);
    if (!record(data.info) || typeof data.info.title !== 'string' || typeof data.info.version !== 'string') add('OPENAPI_INFO', 'Provide an info object with title and version.');
    if (!record(data.paths)) add('OPENAPI_PATHS', 'This profile requires a paths object; webhooks-only descriptions need separate validation.');
    else for (const [path, pathItem] of Object.entries(data.paths)) {
      if (!path.startsWith('/')) add('OPENAPI_PATH_NAME', 'An API path does not start with a slash.');
      if (!record(pathItem)) { add('OPENAPI_PATH_ITEM', 'An API path item must be an object.'); continue; }
      for (const method of ['get','put','post','delete','options','head','patch','trace']) if (Object.hasOwn(pathItem, method)) {
        const operation = pathItem[method];
        if (!record(operation) || !record(operation.responses) || !Object.keys(operation.responses).length) add('OPENAPI_RESPONSES', 'An operation lacks a nonempty responses object.');
      }
    }
    const pending: unknown[] = [data];
    while (pending.length) {
      const node = pending.pop();
      if (Array.isArray(node)) { pending.push(...node); continue; }
      if (!record(node)) continue;
      if (Object.hasOwn(node, '$ref')) {
        const ref = node.$ref;
        if (typeof ref !== 'string') add('OPENAPI_REF_TYPE', 'A reference must be a string.');
        else if (ref !== '#' && !ref.startsWith('#/')) add('OPENAPI_EXTERNAL_REF', 'An external reference is not fetched or validated. Supply an offline, reviewed bundled contract.');
        else {
          let resolved: unknown = data;
          try {
            for (const raw of ref === '#' ? [] : decodeURIComponent(ref.slice(2)).split('/')) {
              if (/~(?![01])/.test(raw)) throw new Error('pointer');
              const key = raw.replaceAll('~1','/').replaceAll('~0','~');
              if (!(record(resolved) || Array.isArray(resolved)) || !Object.hasOwn(resolved, key)) throw new Error('missing');
              resolved = (resolved as Record<string, unknown>)[key];
            }
          } catch { add('OPENAPI_REF_MISSING', 'A local JSON pointer is invalid or its target is missing.'); }
        }
      }
      pending.push(...Object.values(node));
    }
  }
  return check.finish();
}

export function compareCssTokens(snapshot: ReviewSnapshot, baselinePath: string, candidatePath: string) {
  if (baselinePath === candidatePath) throw new CareError('TOOL_INPUT_INVALID', 'Choose two distinct approved CSS files.');
  const values = [baselinePath, candidatePath].map((path) => {
    const file = snapshot.files.find((f) => f.path === path && /\.css$/i.test(f.path));
    if (!file) throw new CareError('SOURCE_PATH_DENIED', 'Choose a CSS path in the approved snapshot.');
    const tokens = new Map<string, string[]>();
    try { postcss.parse(file.content, { from: undefined, map: false }).walkDecls((decl) => {
      if (!decl.prop.startsWith('--')) return;
      const declarations = tokens.get(decl.prop) ?? [];
      declarations.push(decl.value); tokens.set(decl.prop, declarations);
    }); }
    catch { throw new CareError('TOOL_INPUT_INVALID', 'Both CSS inputs must parse before comparing token declarations.'); }
    return tokens;
  });
  const before = values[0]!; const after = values[1]!;
  const names = [...new Set([...before.keys(), ...after.keys()])].sort();
  const changes = names.filter((name) => JSON.stringify(before.get(name)) !== JSON.stringify(after.get(name))).map((name) => ({ token: name.slice(0, 180), change: !before.has(name) ? 'ADDED' : !after.has(name) ? 'REMOVED' : 'DECLARATIONS_CHANGED' }));
  return { baselinePath, candidatePath, changes: changes.slice(0, 100), truncated: changes.length > 100, limitation: 'Compares custom-property declarations in supplied CSS only. Selectors, cascade, computed values, component compliance and rendered appearance are not compared.' };
}

export function inventoryDeclaredSchema(snapshot: ReviewSnapshot) {
  const declarations: Array<{ path: string; line: number; kind: string; name: string }> = [];
  for (const file of snapshot.files.filter((f) => /\.prisma$/i.test(f.path))) file.content.split('\n').forEach((line, index) => {
    const match = /^\s*(model|enum|view|type)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{/.exec(line);
    if (match) declarations.push({ path: file.path, line: index + 1, kind: match[1]!, name: match[2]!.slice(0, 180) });
  });
  return { state: declarations.length ? 'DECLARED_ONLY' : 'NOT_APPLICABLE', declarations: declarations.slice(0, 100), truncated: declarations.length > 100, limitation: 'Prisma declaration inventory only; comments/templates can match. No live schema, field validation, database connection or customer rows.' };
}
