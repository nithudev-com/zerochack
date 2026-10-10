import { z } from 'zod';
import { prepareReviewSnapshot, type ReviewSnapshot } from './source-review.js';
import { CareError } from './vault.js';

export const WORKSPACE_POLICY = 'source-workspace-v1';
export const workspacePatchSchema = z.array(z.object({ path: z.string().min(1).max(180), before: z.string().min(1).max(50000), after: z.string().max(50000) }).strict()).min(1).max(20);
/** Literal edits in approved text only. Never opens a path or executes source. */
export function applyWorkspacePatch(snapshot: ReviewSnapshot, value: unknown): ReviewSnapshot {
  const parsed = workspacePatchSchema.safeParse(value);
  if (!parsed.success) throw new CareError('PATCH_INVALID', 'Provide 1–20 literal replacements in approved source paths.');
  if (parsed.data.reduce((sum, patch) => sum + Buffer.byteLength(patch.before) + Buffer.byteLength(patch.after), 0) > 50000) throw new CareError('PATCH_LIMIT', 'The combined replacement text must fit within 50 KB.');
  const files = snapshot.files.map(({ path, content }) => ({ path, content }));
  for (const patch of parsed.data) {
    const file = files.find((item) => item.path === patch.path);
    if (!file) throw new CareError('SOURCE_PATH_DENIED', 'The patch path is outside this workspace.');
    const position = file.content.indexOf(patch.before);
    // Overlapping occurrences also make the anchor ambiguous.
    if (position < 0 || file.content.indexOf(patch.before, position + 1) >= 0) throw new CareError('PATCH_CONFLICT', 'Each original-text anchor must occur exactly once in its current file.');
    file.content = file.content.slice(0, position) + patch.after + file.content.slice(position + patch.before.length);
  }
  const result = prepareReviewSnapshot(files);
  if (result.files.every((file, index) => file.digest === snapshot.files[index]?.digest)) throw new CareError('PATCH_UNCHANGED', 'The patch does not change the current source.');
  return result;
}
