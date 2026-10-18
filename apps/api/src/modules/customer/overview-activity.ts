import { z } from 'zod';

export const navigationClickInput = z.discriminatedUnion('section', [
  z.object({ section: z.literal('TOOLS'), option: z.enum(['seo', 'security', 'automation', 'marketing', 'chat']) }).strict(),
  z.object({ section: z.literal('WORKPLACE'), option: z.enum(['security', 'development', 'redesign', 'issue', 'server', 'seo', 'automation']) }).strict()
]);
export const navigationClickAction = 'website.navigation_clicked';

// Never expose arbitrary audit metadata, IP addresses, actors, or work details.
export function navigationActivity(row: { id: string; createdAt: Date; metadata: unknown }) {
  const click = navigationClickInput.safeParse(row.metadata);
  return click.success ? { id: row.id, createdAt: row.createdAt, ...click.data } : null;
}
