import type { WebsiteListItem } from '../components/website-card';

export type OverviewWebsite = WebsiteListItem & { createdAt?: string };
export function orderedOverviewWebsites(websites: OverviewWebsite[]) {
  const timestamp = (website: OverviewWebsite) => website.createdAt && Number.isFinite(Date.parse(website.createdAt)) ? Date.parse(website.createdAt) : Number.MAX_SAFE_INTEGER;
  return [...websites].sort((left, right) => timestamp(left) - timestamp(right));
}
export function overviewWebsite(websites: OverviewWebsite[], selectedId?: string | null) {
  const ordered = orderedOverviewWebsites(websites);
  return ordered.find(website => website.id === selectedId) ?? ordered.find(website => {
    const summary = website.connectionSummary;
    return summary && summary.kind !== 'NONE' && summary.lastCheckedAt && Number.isFinite(Date.parse(summary.lastCheckedAt)) && (summary.kind === 'SSH' || summary.providers.length > 0);
  }) ?? ordered[0];
}
