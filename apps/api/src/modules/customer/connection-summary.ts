type Check = { status: string; lastCheckedAt: Date | null; lastErrorCode: string | null };
type Access = Check & { vaultCredentialId: string | null; vaultCredential: { status: string; authorizationExpiresAt: Date } | null };
type Connector = Check & { provider: string; websiteUrl: string; authorizationExpiresAt: Date };

/** Recorded authentication evidence only, never a live session or execution permission. */
export function connectionSummary(site: { url: string; connectionStatus: string; accessCredential: Access | null; connectors: Connector[] }, now = new Date()) {
  const none = { kind: 'NONE' as const, providers: [] as string[], lastCheckedAt: null as Date | null };
  if (site.connectionStatus !== 'VERIFIED') return none;
  const access = site.accessCredential;
  const authorized = access && (!access.vaultCredentialId || (access.vaultCredential?.status === 'STORED' && access.vaultCredential.authorizationExpiresAt > now));
  if (authorized && access.status === 'READY_FOR_SECURE_SESSION' && access.lastCheckedAt && !access.lastErrorCode) {
    return { kind: 'SSH' as const, providers: ['ssh'], lastCheckedAt: access.lastCheckedAt };
  }
  const checked = site.connectors.filter(row => row.status === 'AUTHENTICATED_READ' && row.websiteUrl === site.url && row.authorizationExpiresAt > now && row.lastCheckedAt && !row.lastErrorCode);
  if (!checked.length) return none;
  return { kind: 'CONNECTOR' as const, providers: checked.map(row => row.provider), lastCheckedAt: new Date(Math.max(...checked.map(row => row.lastCheckedAt!.getTime()))) };
}
