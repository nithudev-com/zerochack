import { CareError } from './vault.js';
/** Bundled product policy notes only, not an internet or cross-customer knowledge index. */
export const KNOWLEDGE_VERSION = 'care-policy-notes-v1';
export const reviewKnowledge = [
  { id: 'source-evidence', title: 'Source evidence and uncertainty', text: 'Cite exact supplied paths and line ranges. Static observations do not prove deployed behavior. Missing inputs must be reported explicitly. No exploit reproduction, source execution or live access is part of a source review.' },
  { id: 'candidate-approval', title: 'Candidate and release approvals', text: 'Static HTML candidate preparation needs approval of the exact source, model and allowance. Production release has a separate target-bound approval and fresh MFA. An AI role cannot approve either operation for a customer.' },
  { id: 'recovery-history', title: 'Recovery evidence and retained history', text: 'Submitted source and reports are encrypted and retained subject to explicit deletion and storage availability. A backup record is not a clean restore drill. Pausing stops future steps but cannot erase costs or undo an in-flight external observation.' }
] as const;
export function searchReviewKnowledge(query: string) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return reviewKnowledge.filter((doc) => words.every((word) => `${doc.title} ${doc.text}`.toLowerCase().includes(word))).map((doc) => ({ id: doc.id, title: doc.title, version: KNOWLEDGE_VERSION, provenance: 'BUNDLED_CARE_POLICY', scope: 'CURRENT_JOB_POLICY' }));
}
export function getReviewKnowledge(id: string, version: string) {
  const doc = reviewKnowledge.find((item) => item.id === id);
  if (!doc || version !== KNOWLEDGE_VERSION) throw new CareError('KNOWLEDGE_REVISION_UNAVAILABLE', 'This bundled policy document revision is unavailable.');
  return { ...doc, version, provenance: 'BUNDLED_CARE_POLICY', limitation: 'Product policy notes only. No external vendor documentation, advisory feed or other customer data.' };
}
