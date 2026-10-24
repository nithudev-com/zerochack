import { posix } from 'node:path';
import { isIP } from 'node:net';
import { Prisma } from '@prisma/client';
import { ApiError } from '../../errors.js';

const websiteObservationKinds = new Set([
  'WORLD_WRITABLE', 'EXCESSIVE_SECRET_PERMISSIONS', 'SENSITIVE_FILE',
  'PUBLIC_VCS_DIRECTORY', 'PHP_IN_UPLOADS', 'HIDDEN_SCRIPT',
  'MALWARE_SIGNATURE'
]);

function violation(): never {
  throw new ApiError(409, 'ASSESSMENT_SCOPE_VIOLATION', 'The inspection did not prove the selected website scope. No result was accepted.');
}

function canonicalHostname(hostname: string): void {
  if (typeof hostname !== 'string' || hostname.length > 253 || isIP(hostname) !== 0 || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(hostname)) violation();
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function canonicalAbsolutePath(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 2048 && value.startsWith('/') && !/[\\\u0000-\u001f\u007f]/u.test(value) && posix.normalize(value) === value && !value.endsWith('/');
}

/** Match the fixed inspector's domain-directory conventions, never generic account roots.
 * A matching directory is an explicit inference, not proof of the live vhost mapping.
 */
function conventionalDomainRoot(root: string, hostname: string): boolean {
  const parts = root.slice(1).split('/');
  if (parts.length >= 4 && parts.at(-3) === 'domains' && parts.at(-2) === hostname && ['public_html', 'httpdocs'].includes(parts.at(-1) ?? '')) return true;
  return [
    `/var/www/${hostname}/public_html`, `/var/www/${hostname}/html`,
    `/srv/www/${hostname}/public_html`, `/var/www/vhosts/${hostname}/httpdocs`
  ].includes(root);
}

/** Revalidate an external runner's result before persisting or exposing any evidence.
 * The hostname must come from the persisted website binding, never model/body input.
 */
export function assertWebsiteInspectionScope(inspection: unknown, persistedHostname: string): void {
  canonicalHostname(persistedHostname);
  const result = record(inspection);
  const scope = record(result?.scope);
  if (!result || !scope || scope.mode !== 'WEBSITE' || scope.hostname !== persistedHostname) violation();
  // The current website-scoped inspector deliberately never executes external
  // antivirus. A remote result cannot upgrade that capability or claim a clean scan.
  if (result.coverageState !== 'INCOMPLETE' || !(
    (result.malwareScanner === 'SIGNATURES_ONLY' && result.malwareScannerStatus === 'NOT_INSTALLED') ||
    (result.malwareScanner === 'CLAMAV' && result.malwareScannerStatus === 'NOT_RUN_SCOPE')
  )) violation();
  const roots = result.roots;
  const observations = result.observations;
  if (!Array.isArray(roots) || !Array.isArray(observations) || typeof result.scannedFiles !== 'number' || !Number.isInteger(result.scannedFiles) || result.scannedFiles < 0 || result.scannedFiles > 2500) violation();
  if (scope.rootBinding === 'UNRESOLVED') {
    if (roots.length !== 0 || observations.length !== 0 || result.scannedFiles !== 0 || result.coverageState !== 'INCOMPLETE' || result.scanLimitReached !== true || !Array.isArray(result.coverageLimitations) || result.coverageLimitations.length === 0) violation();
    return;
  }
  if (scope.rootBinding !== 'DOMAIN_DIRECTORY_CONVENTION' || roots.length !== 1) violation();
  const root: unknown = roots[0];
  if (!canonicalAbsolutePath(root) || !conventionalDomainRoot(root, persistedHostname)) violation();
  for (const observation of observations) {
    const item = record(observation);
    if (!item || typeof item.kind !== 'string' || !websiteObservationKinds.has(item.kind) || !canonicalAbsolutePath(item.path) || !item.path.startsWith(root + '/')) violation();
  }
}

/** Additional evidence restriction only: callers must retain tenant/website predicates.
 * Preserve legacy evidence in storage; do not present account-wide SSH records as
 * current findings for one website. A valid record cannot launder a mixed finding.
 */
export function websiteFindingScope(hostname: string): Prisma.SecurityFindingWhereInput {
  const address = typeof hostname === 'string' && hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  // Generic website/public-HTTP records already support IP URLs. Keep those
  // readable, but never treat an IP as a DNS-to-directory SSH scope binding.
  if (typeof address === 'string' && isIP(address) !== 0) return { evidence: { none: { engine: 'ssh-forensics' } } };
  canonicalHostname(hostname);
  const validSsh: Prisma.FindingEvidenceWhereInput = {
    engine: 'ssh-forensics',
    AND: [
      { metadata: { path: ['scope', 'mode'], equals: 'WEBSITE' } },
      { metadata: { path: ['scope', 'hostname'], equals: hostname } }
    ]
  };
  const invalidSsh: Prisma.FindingEvidenceWhereInput = {
    engine: 'ssh-forensics',
    OR: [
      // Explicit null guards are essential: NOT a JSON-path equality alone can
      // yield SQL UNKNOWN for a missing path instead of matching bad evidence.
      { metadata: { path: ['scope', 'mode'], equals: Prisma.AnyNull } },
      { metadata: { path: ['scope', 'hostname'], equals: Prisma.AnyNull } },
      { NOT: { metadata: { path: ['scope', 'mode'], equals: 'WEBSITE' } } },
      { NOT: { metadata: { path: ['scope', 'hostname'], equals: hostname } } }
    ]
  };
  return {
    OR: [
      { evidence: { none: { engine: 'ssh-forensics' } } },
      { evidence: { some: validSsh, none: invalidSsh } }
    ]
  };
}
