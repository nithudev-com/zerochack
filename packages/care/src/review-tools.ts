import { z } from 'zod';
import { CareError, looksSensitive } from './vault.js';
import type { ReviewSnapshot } from './source-review.js';
import { checkCss, checkHtml, checkSyntax, checkYaml } from './source-checks.js';

import { implementedReviewTools } from './tool-ids.js';
export { implementedReviewTools } from './tool-ids.js';
export type RecoveryReadiness = { state: 'NOT_OBSERVED' | 'RECORDED_EVIDENCE'; observedAt: string; checks: Array<{ name: string; state: string; detail: string }>; limitation: string };
export type ReviewToolContext = {
  tenantId: string; websiteId: string; jobId: string; environment: string;
  authorized: boolean; approvalExpiresAt: Date; sourceDigest: string;
  summary: string; expectedBehavior: string; snapshot: ReviewSnapshot;
  state: string; completedRoles: string[];
  recovery?: RecoveryReadiness;
};
const empty = z.object({}).strict();
const schemas = {
  T01: empty, T02: empty, T04: empty, T09: empty,
  T10: z.object({ path: z.string().max(180), startLine: z.number().int().min(1).default(1), endLine: z.number().int().min(1).max(100_000).optional() }).strict(),
  T11: z.object({ text: z.string().min(2).max(120), path: z.string().max(180).optional() }).strict(),
  T19: empty, T21: empty, T31: empty, T32: empty, T53: empty, T59: empty, T65: empty, T66: empty, T67: empty
};
/** Pure, offline handlers. The server binds scope; callers cannot supply a tenant or destination. */
export function executeReviewTool(id: typeof implementedReviewTools[number], args: unknown, context: ReviewToolContext, now = new Date()): unknown {
  if (!context.authorized || context.approvalExpiresAt <= now) throw new CareError('TOOL_DENIED', 'A current source-review approval is required.');
  const checked = schemas[id]?.safeParse(args);
  if (!checked?.success) throw new CareError('TOOL_INPUT_INVALID', 'The source-review tool input is invalid.');
  const output = reviewToolOutput(id, args, context);
  if (Buffer.byteLength(JSON.stringify(output)) > (id === 'T10' ? 250000 : 65536)) throw new CareError('TOOL_OUTPUT_LIMIT', 'This tool result exceeds its bounded output allowance. Use a smaller source snapshot.');
  return output;
}
function reviewToolOutput(id: typeof implementedReviewTools[number], args: unknown, context: ReviewToolContext): unknown {
  const snapshot = context.snapshot;
  switch (id) {
    case 'T01': return { summary: context.summary, expectedBehavior: context.expectedBehavior, mode: 'SOURCE_REVIEW' };
    case 'T02': return { environment: context.environment, sourceDigest: context.sourceDigest, fileCount: snapshot.files.length, policy: snapshot.policy, liveAccess: false, sourceExecution: false };
    case 'T04': return { jobId: context.jobId, expiresAt: context.approvalExpiresAt.toISOString(), sourceDigest: context.sourceDigest, capability: 'SOURCE_REVIEW', permitsRelease: false };
    case 'T09': return snapshot.files.map(({ path, digest, lines }) => ({ path, digest, lines }));
    case 'T10': {
      const input = schemas.T10.parse(args); const file = snapshot.files.find((item) => item.path === input.path);
      if (!file) throw new CareError('SOURCE_PATH_DENIED', 'This path is outside the approved snapshot.');
      const end = input.endLine ?? file.lines;
      if (end < input.startLine || end > file.lines) throw new CareError('TOOL_INPUT_INVALID', 'The source range is outside the approved file.');
      return { path: file.path, digest: file.digest, startLine: input.startLine, endLine: end, content: file.content.split('\n').slice(input.startLine - 1, end).join('\n') };
    }
    case 'T11': {
      const input = schemas.T11.parse(args);
      if (input.path && !snapshot.files.some((file) => file.path === input.path)) throw new CareError('SOURCE_PATH_DENIED', 'This path is outside the approved snapshot.');
      return snapshot.files.filter((file) => !input.path || file.path === input.path).flatMap((file) => file.content.split('\n').flatMap((line, index) => line.includes(input.text) ? [{ path: file.path, line: index + 1, excerpt: line.slice(0, 300) }] : [])).slice(0, 50);
    }
    case 'T19': return snapshot.files.filter((file) => /(^|\/)package\.json$/.test(file.path)).map((file) => {
      try {
        const value: unknown = JSON.parse(file.content);
        const manifest = z.object({ dependencies: z.record(z.string().max(200), z.string().max(200)).optional(), devDependencies: z.record(z.string().max(200), z.string().max(200)).optional() }).passthrough().parse(value);
        const dependencies = Object.entries({ ...manifest.devDependencies, ...manifest.dependencies });
        return { path: file.path, dependencies: dependencies.slice(0, 300).map(([name, declaredVersion]) => ({ name, declaredVersion })), truncated: dependencies.length > 300, evidence: 'DECLARED_ONLY', advisoryCheck: 'NOT_RUN' };
      } catch { return { path: file.path, error: 'INVALID_MANIFEST', advisoryCheck: 'NOT_RUN' }; }
    });
    case 'T21': return { screenedFiles: snapshot.files.length, suspectedPaths: snapshot.files.filter((file) => looksSensitive(file.content)).map((file) => file.path), limitation: 'Pattern screening cannot identify every secret. Customer privacy review remains required.' };
    case 'T59': return { state: context.state, completedRoles: context.completedRoles, sourceDigest: context.sourceDigest };
    case 'T53': return context.recovery ?? { state: 'NOT_OBSERVED', checks: [], limitation: 'The server has not supplied scoped recovery evidence. No recovery readiness is claimed.' };
    case 'T31': return checkHtml(snapshot, 'accessibility');
    case 'T32': return checkHtml(snapshot, 'links');
    case 'T65': return checkSyntax(snapshot);
    case 'T66': return checkCss(snapshot);
    case 'T67': return checkYaml(snapshot);
  }
}
