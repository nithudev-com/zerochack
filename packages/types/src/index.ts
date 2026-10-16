export type EntityId = string;
export type TenantId = EntityId;
export type UserId = EntityId;

export interface RequestContext {
  requestId: string;
  userId?: UserId;
  tenantId?: TenantId;
}

export interface ApiErrorResponse {
  error: { code: string; message: string; requestId: string; details?: unknown };
}

/** Public navigation labels only. Choices never grant execution authority. */
export const websiteNavigationLabels = {
  TOOLS: { seo: 'SEO', security: 'Security', automation: 'Automation', marketing: 'Marketing', chat: 'Chat Agent' },
  WORKPLACE: { security: 'Fix hacks & security', development: 'Full-stack web development', redesign: 'Website redesign', issue: 'Fix an issue', server: 'Server-side work', seo: 'SEO work', automation: 'Automation' }
} as const;
export type WebsiteNavigationClick = {
  [Section in keyof typeof websiteNavigationLabels]: { section: Section; option: keyof (typeof websiteNavigationLabels)[Section] }
}[keyof typeof websiteNavigationLabels];
export type WebsiteNavigationActivity = WebsiteNavigationClick & { id: string; createdAt: string };
export function websiteNavigationLabel(click: WebsiteNavigationClick) {
  return click.section === 'TOOLS' ? websiteNavigationLabels.TOOLS[click.option] : websiteNavigationLabels.WORKPLACE[click.option];
}

export type UptimeState = 'UP' | 'DOWN' | 'UNKNOWN';
export type UptimeCheck = { id: string; observedAt: string; state: UptimeState; httpStatus: number | null; responseTimeMs: number | null; errorCode: string | null };
export type UptimeSummary = {
  observedAt: string; enabled: boolean; eligible: boolean; intervalMinutes: number; emailAlerts: boolean;
  state: UptimeState | 'PAUSED' | 'PENDING' | 'STALE'; lastCheck: UptimeCheck | null;
  windowDays: number; windowHours?: number; sampleCount: number; knownCount: number; upCount: number; downCount: number; unknownCount: number;
  passedPercent: number | null; averageResponseMs: number | null; truncated: boolean;
  days: Array<{ day: string; up: number; down: number; unknown: number }>;
  incidents: Array<{ id: string; title: string; firstObservedAt: string; lastObservedAt: string; recoveredAt: string | null }>;
  emailHistory: Array<{ id: string; status: string; createdAt: string; deliveredAt: string | null; attempts: number; lastErrorCode: string | null }>;
  emailTemplateEnabled: boolean;
};
export type UptimeHistory = { checks: UptimeCheck[]; nextCursor: string | null };
