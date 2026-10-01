import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import { prepareReviewSnapshot, type ReviewSnapshot } from './source-review.js';
import { CareError } from './vault.js';
import type { SourceCheck } from './source-checks.js';

export const QUALITY_PROFILE = 'care-typescript-5.9.3-v1';
let active = 0;
// Trusted worker program. Uploaded text is passed as data, never interpolated/evaluated.
const workerProgram = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs');
const path = require('node:path');
const ts = require(workerData.compilerPath);
if (ts.version !== '5.9.3') throw new Error('Unsupported compiler');
const lint = workerData.toolId === 'T33';
const result = { check: lint ? 'fixed-typescript-lint' : 'snapshot-typescript-types', profile: 'care-typescript-5.9.3-v1', state: 'NOT_APPLICABLE', checkedFiles: [], diagnostics: [], truncated: false, limitation: lint ? 'Fixed no-var, no-debugger and strict-equality AST rules on supplied JS/TS. No customer configuration, plugins, formatting or full ESLint profile.' : 'Strict ES2022 snapshot type checking with bundled TypeScript standard libraries, relative imports and no emit. External SDK/package types, project tsconfig, generated types and runtime behavior are not provided or verified. Declaration-file semantic checks are skipped. No customer code executes.' };
const files = new Map(workerData.files.filter(f => /\.[cm]?[jt]sx?$/i.test(f.path)).map(f => ['/snapshot/' + f.path, f.content]));
const sources = new Map();
function add(file, position, code, message) {
 if (result.diagnostics.length >= 30) { result.truncated = true; return; }
 result.diagnostics.push({ path: file.fileName.slice('/snapshot/'.length), line: file.getLineAndCharacterOfPosition(position).line + 1, code, message: message.slice(0, 180) });
}
for (const [name, content] of files) {
 const source = ts.createSourceFile(name, content, ts.ScriptTarget.ES2022, true);
 sources.set(name, source); result.checkedFiles.push(name.slice('/snapshot/'.length));
 if (lint) {
  for (const diagnostic of source.parseDiagnostics) add(source, diagnostic.start || 0, 'TS' + diagnostic.code, ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '));
  const nodes = [source];
  for (let i = 0; i < nodes.length; i++) {
   if (nodes.length > 50000) throw new Error('Node limit');
   const node = nodes[i];
   if (ts.isDebuggerStatement(node)) add(source, node.getStart(), 'NO_DEBUGGER', 'Remove this debugger statement.');
   if (ts.isVariableDeclarationList(node) && !(node.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const))) add(source, node.getStart(), 'NO_VAR', 'Review this declaration and prefer let or const.');
   if (ts.isBinaryExpression(node) && [ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken].includes(node.operatorToken.kind)) add(source, node.getStart(), 'STRICT_EQUALITY', 'Review coercion and prefer strict equality.');
   ts.forEachChild(node, child => { nodes.push(child); });
  }
 }
}
if (!lint && files.size) {
 const libDir = path.dirname(workerData.compilerPath);
 const trustedLib = name => name.startsWith('/trusted/') && /^lib\.[a-z0-9.]+\.d\.ts$/.test(name.slice(9));
 function read(name) {
  if (files.has(name)) return files.get(name);
  if (trustedLib(name)) { try { return fs.readFileSync(path.join(libDir, name.slice(9)), 'utf8'); } catch { return undefined; } }
  return undefined;
 }
 const host = {
  getSourceFile(name) { if (sources.has(name)) return sources.get(name); const content = read(name); if (content === undefined) return undefined; const source = ts.createSourceFile(name, content, ts.ScriptTarget.ES2022, true); sources.set(name, source); return source; },
  getDefaultLibFileName: () => '/trusted/lib.es2022.full.d.ts', getDefaultLibLocation: () => '/trusted',
  writeFile() {}, getCurrentDirectory: () => '/snapshot', getDirectories: () => [],
  fileExists: name => files.has(name) || (trustedLib(name) && fs.existsSync(path.join(libDir, name.slice(9)))),
  readFile: read, getCanonicalFileName: name => name, useCaseSensitiveFileNames: () => true, getNewLine: () => '\n',
  resolveModuleNames(names, containing) { return names.map(name => {
   if (!name.startsWith('./') && !name.startsWith('../')) return undefined;
   const base = path.posix.normalize(path.posix.join(path.posix.dirname(containing), name));
   if (!base.startsWith('/snapshot/')) return undefined;
   const stem = base.replace(/\.[cm]?jsx?$/, '');
   const resolved = [base, stem + '.ts', stem + '.tsx', stem + '.mts', stem + '.cts', stem + '.d.ts', stem + '.js', stem + '.jsx', base + '/index.ts', base + '/index.tsx', base + '/index.d.ts'].find(p => files.has(p));
   return resolved ? { resolvedFileName: resolved, isExternalLibraryImport: false } : undefined;
  }); }, resolveTypeReferenceDirectives: names => names.map(() => undefined)
 };
 const options = { strict: true, noEmit: true, allowJs: true, checkJs: true, skipLibCheck: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.Preserve, types: [], noErrorTruncation: false };
 const program = ts.createProgram([...files.keys()], options, host);
 for (const diagnostic of ts.getPreEmitDiagnostics(program)) {
  if (diagnostic.file && files.has(diagnostic.file.fileName)) add(diagnostic.file, diagnostic.start || 0, 'TS' + diagnostic.code, ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '));
  else if (diagnostic.category === ts.DiagnosticCategory.Error) throw new Error('Profile incomplete');
 }
}
result.state = result.diagnostics.length ? 'OBSERVATIONS' : result.checkedFiles.length ? 'NO_ISSUES_DETECTED' : 'NOT_APPLICABLE';
parentPort.postMessage(result);
`;

/** Worker isolates compiler CPU/heap. It is not a sandbox for executing customer programs. */
export async function runSourceQuality(toolId: 'T33' | 'T34', input: ReviewSnapshot): Promise<SourceCheck & { profile: string }> {
  const snapshot = prepareReviewSnapshot(input.files.map(({ path, content }) => ({ path, content })));
  if (active >= 2) throw new CareError('CHECK_BUSY', 'Static checking is busy. Retry shortly.');
  const compilerPath = createRequire(import.meta.url).resolve('typescript');
  active++;
  try {
    return await new Promise((resolve, reject) => {
      const worker = new Worker(workerProgram, { eval: true, env: {}, execArgv: [], workerData: { toolId, compilerPath, files: snapshot.files }, resourceLimits: { maxOldGenerationSizeMb: 192, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 } });
      let settled = false;
      const finish = (result?: SourceCheck & { profile: string }) => {
        if (settled) return; settled = true; clearTimeout(timer);
        void worker.terminate().then(() => result ? resolve(result) : reject(new CareError('CHECK_INCOMPLETE', 'The fixed static check could not finish within its resource limits. No passing result is claimed.')), () => reject(new CareError('CHECK_INCOMPLETE', 'Static worker shutdown failed. No passing result is claimed.')));
      };
      const timer = setTimeout(() => finish(), 10000);
      worker.once('message', (value) => finish(value));
      worker.once('error', () => finish()); worker.once('exit', () => finish());
    });
  } finally { active--; }
}
