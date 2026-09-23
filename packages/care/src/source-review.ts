import { z } from 'zod';
import { agentCatalogue } from './catalogue.js';
import { CareError, looksSensitive } from './vault.js';
import { digestBytes } from './static-html.js';

export const REVIEW_POLICY_VERSION = 'source-review-v1';
export const REVIEW_MAX_BYTES = 200_000;
export const REVIEW_CONTEXT_BYTES = 400_000;
export const reviewRoleIds = agentCatalogue.map((role) => role.id);
export type ReviewRoleId = typeof agentCatalogue[number]['id'];
export const reviewFilesSchema = z.array(z.object({ path: z.string().min(1).max(180), content: z.string().min(1).max(REVIEW_MAX_BYTES) }).strict()).min(1).max(30);
export type ReviewFile = z.infer<typeof reviewFilesSchema>[number];
export type ReviewSnapshot = { policy: typeof REVIEW_POLICY_VERSION; files: Array<ReviewFile & { digest: string; lines: number }> };

export function prepareReviewSnapshot(value: unknown): ReviewSnapshot {
  const parsed = reviewFilesSchema.safeParse(value);
  if (!parsed.success) throw new CareError('SOURCE_INVALID', 'Provide 1–30 UTF-8 text files with relative paths.');
  if (Buffer.byteLength(JSON.stringify(parsed.data)) > REVIEW_MAX_BYTES) throw new CareError('SOURCE_LIMIT', 'The reviewed source snapshot must fit within 200 KB.');
  const seen = new Set<string>();
  const files = parsed.data.map(({ path, content }) => {
    const parts = path.split('/');
    if (!/^[A-Za-z0-9_@./-]+$/.test(path) || parts.some((part) => !part || part === '.' || part === '..' || /^\.?(?:env(?:\.|$)|git$|ssh$|npmrc$|netrc$|credentials?(?:\.|$))/i.test(part)) || !/\.(?:html?|css|scss|[cm]?[jt]sx?|json|ya?ml|md|txt|sql|prisma|php|py|rb|go|rs|java|vue|svelte|toml|xml)$|(?:^|\/)Dockerfile$/i.test(path) || seen.has(path.toLowerCase())) throw new CareError('SOURCE_PATH_DENIED', 'Use unique relative text-source paths; credential files and path traversal are not accepted.');
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(content) || looksSensitive(content)) throw new CareError('SENSITIVE_CONTENT_BLOCKED', 'Remove credentials, private data and binary content before uploading source.');
    seen.add(path.toLowerCase());
    const normalized = content.replace(/\r\n?/g, '\n');
    return { path, content: normalized, digest: digestBytes(Buffer.from(normalized)), lines: normalized.split('\n').length };
  }).sort((a, b) => a.path.localeCompare(b.path));
  if (Buffer.byteLength(JSON.stringify(files)) > REVIEW_MAX_BYTES) throw new CareError('SOURCE_LIMIT', 'The reviewed source snapshot must fit within 200 KB.');
  return { policy: REVIEW_POLICY_VERSION, files };
}

export function reviewSteps(selected: readonly string[]) {
  if (!selected.length || selected.length > 24 || new Set(selected).size !== selected.length || selected.some((id) => !reviewRoleIds.includes(id as ReviewRoleId))) throw new CareError('ROLE_INVALID', 'Choose distinct supported review roles.');
  // A persisted, deterministic dependency order. Models cannot assign themselves privileges.
  const order: ReviewRoleId[] = ['A01','A03','A02','A04','A05','A06','A07','A08','A09','A10','A11','A12','A13','A15','A19','A20','A21','A22','A23','A24','A14','A16','A17','A18'];
  return order.filter((id) => selected.includes(id)).map((roleId, index, all) => ({ roleId, stepIndex: index, dependsOn: index ? [all[index - 1]!] : [] }));
}

const evidenceSchema = z.object({ path: z.string().max(180), startLine: z.number().int().min(1), endLine: z.number().int().min(1), quote: z.string().min(3).max(1200) }).strict();
export const reviewResultSchema = z.object({
  roleId: z.string(),
  status: z.enum(['REVIEWED','NEEDS_INPUT','NOT_APPLICABLE']),
  summary: z.string().min(10).max(700),
  findings: z.array(z.object({ title: z.string().min(3).max(140), priority: z.enum(['LOW','MEDIUM','HIGH']), explanation: z.string().min(10).max(1400), recommendation: z.string().min(10).max(1400), evidence: z.array(evidenceSchema).min(1).max(3) }).strict()).max(8),
  limitations: z.array(z.string().min(5).max(400)).min(1).max(10),
  nextSteps: z.array(z.string().min(5).max(400)).max(8)
}).strict();
export type ReviewResult = z.infer<typeof reviewResultSchema>;
export function validateReviewResult(text: string, roleId: string, snapshot: ReviewSnapshot): ReviewResult {
  if (Buffer.byteLength(text) > 50_000 || looksSensitive(text)) throw new CareError('REVIEW_OUTPUT_INVALID', 'The review response exceeded its limit or contained sensitive content.');
  let decoded: unknown;
  try { decoded = JSON.parse(text); } catch { throw new CareError('REVIEW_OUTPUT_INVALID', 'The model did not return a structured review.'); }
  const parsed = reviewResultSchema.safeParse(decoded);
  if (!parsed.success || parsed.data.roleId !== roleId) throw new CareError('REVIEW_OUTPUT_INVALID', 'The review response did not match its assigned role or schema.');
  const result = parsed.data;
  if (result.status !== 'REVIEWED' && result.findings.length) throw new CareError('REVIEW_OUTPUT_INVALID', 'An incomplete or inapplicable review cannot carry findings.');
  for (const finding of result.findings) for (const reference of finding.evidence) {
    const file = snapshot.files.find((item) => item.path === reference.path);
    if (!file || reference.endLine < reference.startLine || reference.endLine > file.lines || reference.endLine - reference.startLine > 30 || !file.content.split('\n').slice(reference.startLine - 1, reference.endLine).join('\n').includes(reference.quote)) throw new CareError('REVIEW_EVIDENCE_INVALID', 'A finding cited missing source or a quote outside its stated line range.');
  }
  return result;
}

export const reviewFocus: Record<ReviewRoleId, string> = {
  A01: 'Identify the supplied scope, dependencies, missing evidence and a bounded work plan. Do not imply that planned steps executed.',
  A02: 'Explain the issue and source observations in the requested language. Ask precise customer questions and explain remaining approvals.',
  A03: 'Inventory technologies supported by actual filenames and source. Distinguish declared versions from installed or deployed versions.',
  A04: 'Assess supplied incident symptoms and evidence preservation needs. Recommend human escalation when needed; no live investigation or cleanup.',
  A05: 'Review provided authentication, authorization, validation and data-handling code defensively. Give remediation guidance, never exploits or attack instructions.',
  A06: 'Review declared dependencies and provenance. No current advisory feed is present: do not invent CVEs, latest versions or vulnerability-free claims.',
  A07: 'Review provided API/backend logic and propose scoped changes. No code is applied and no API or database is contacted.',
  A08: 'Review layout and frontend source, preserving the requested design. This review does not run the separate static HTML repair workflow.',
  A09: 'Review labels, semantics and keyboard intent in source. Mark contrast, assistive technology and browser interaction checks as not tested.',
  A10: 'Identify source-level performance hypotheses and a measurement plan. Do not invent timings, measurements or benchmark improvements.',
  A11: 'Review supplied schema/migration text for compatibility and data preservation. No database queries or migration tests execute.',
  A12: 'Review supplied deployment manifests and least-privilege settings. Live infrastructure state is unknown.',
  A13: 'Propose acceptance criteria and test cases from supplied requirements and source. No tests have been written or executed by this review.',
  A14: 'Independently recheck earlier source claims against the snapshot. Cite original source for your findings. Test execution and coverage are not verified.',
  A15: 'Review source-level layout risks. No screenshots are rendered or compared; require actual browser evidence for visual assertions.',
  A16: 'Independently review earlier recommendations against source and scope. You cannot approve a patch, tests or release.',
  A17: 'Review release prerequisites and recovery questions using supplied source only. Backups, deployment and restore drills remain unverified.',
  A18: 'Summarize evidence-backed source findings, missing inputs and remaining customer decisions. A completed review is not a completed repair.',
  A19: 'Review supplied CMS/commerce source or manifests. No plugins are installed, orders placed, payments refunded or CMS systems contacted.',
  A20: 'Review supplied integration contracts and error handling. External providers and sandbox transactions are not contacted.',
  A21: 'Review supplied metadata, headings and content consistency. No crawling, public publication or search ranking claims.',
  A22: 'Review sanitized telemetry text and logging configuration supplied in the snapshot. There is no live monitoring evidence.',
  A23: 'Evaluate supplied technical documentation for clarity, version assumptions and reusable lessons for this case only. Do not learn across customers.',
  A24: 'Review supplied Tamil/English UI strings, date handling, input and usability assumptions. No browser or human usability test executes.'
};

export function reviewPrompt(roleId: ReviewRoleId, language: 'en' | 'ta') {
  const role = agentCatalogue.find((item) => item.id === roleId)!;
  return `Assigned role: ${roleId} ${role.name}. Policy: ${REVIEW_POLICY_VERSION}. ${reviewFocus[roleId]}\nWrite user-facing text in ${language === 'ta' ? 'Tamil; preserve technical identifiers' : 'English'}. Return only JSON: {"roleId":"${roleId}","status":"REVIEWED|NEEDS_INPUT|NOT_APPLICABLE","summary":"...","findings":[{"title":"...","priority":"LOW|MEDIUM|HIGH","explanation":"...","recommendation":"...","evidence":[{"path":"exact supplied path","startLine":1,"endLine":1,"quote":"exact source substring"}]}],"limitations":["..."],"nextSteps":["..."]}. At most 8 findings; cite a 3–1200 character quote inside a range of at most 31 lines for every finding. Never use prior agent prose as proof. Missing evidence means NEEDS_INPUT or NOT_APPLICABLE with empty findings. Summary 10–700 characters; finding title 3–140; explanation/recommendation 10–1400; limitations and next steps 5–400 each. Include at least one limitation. No markdown fences.`;
}
