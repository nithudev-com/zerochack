import type { ReviewSnapshot } from './source-review.js';

export type DependencyCoordinate = { ecosystem: 'npm' | 'Packagist'; name: string; version: string };
export type InventoryEntry = DependencyCoordinate & { evidence: 'DECLARED_EXACT' | 'LOCKFILE'; path: string };
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const exactVersion = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
export function isDependencyCoordinate(value: DependencyCoordinate): boolean {
  const name = value.ecosystem === 'npm' ? /^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/ : /^[a-z0-9][a-z0-9_.-]*\/[a-z0-9][a-z0-9_.-]*$/;
  return name.test(value.name) && value.name.length <= 180 && value.version.length <= 100 && exactVersion.test(value.version);
}
export const coordinateKey = (value: DependencyCoordinate): string => `${value.ecosystem}:${value.name}@${value.version}`;

/** Declarations only: never installs a package, resolves a URL or executes customer code. */
export function inventoryDependencies(snapshot: ReviewSnapshot) {
  const entries: InventoryEntry[] = [];
  const issues: Array<{ path: string; code: string }> = [];
  let skipped = 0;
  let truncated = false;
  const add = (path: string, ecosystem: DependencyCoordinate['ecosystem'], name: unknown, version: unknown, evidence: InventoryEntry['evidence']) => {
    if (typeof name !== 'string' || typeof version !== 'string') { skipped++; return; }
    const normalized = ecosystem === 'Packagist' ? version.replace(/^v/, '') : version;
    const entry = { path, ecosystem, name, version: normalized, evidence };
    if (!isDependencyCoordinate(entry)) { skipped++; return; }
    if (entries.length >= 2000) { truncated = true; return; }
    entries.push(entry);
  };
  for (const file of snapshot.files) {
    if (!/(^|\/)(package\.json|package-lock\.json|npm-shrinkwrap\.json|composer\.lock)$/.test(file.path)) continue;
    let value: unknown;
    try { value = JSON.parse(file.content); } catch { issues.push({ path: file.path, code: 'INVALID_JSON' }); continue; }
    if (!object(value)) { issues.push({ path: file.path, code: 'INVALID_MANIFEST' }); continue; }
    if (file.path.endsWith('composer.lock')) {
      for (const group of ['packages', 'packages-dev']) {
        if (value[group] === undefined) continue;
        if (!Array.isArray(value[group])) { issues.push({ path: file.path, code: 'INVALID_LOCK_ENTRIES' }); continue; }
        for (const entry of value[group]) if (object(entry)) add(file.path, 'Packagist', entry.name, entry.version, 'LOCKFILE'); else skipped++;
      }
    } else if (/(^|\/)package\.json$/.test(file.path)) {
      for (const group of ['dependencies', 'devDependencies', 'optionalDependencies']) {
        if (value[group] === undefined) continue;
        if (!object(value[group])) { issues.push({ path: file.path, code: 'INVALID_DEPENDENCY_GROUP' }); continue; }
        for (const [name, version] of Object.entries(value[group])) add(file.path, 'npm', name, version, 'DECLARED_EXACT');
      }
    } else if ((value.lockfileVersion === 2 || value.lockfileVersion === 3) && object(value.packages)) {
      for (const [path, entry] of Object.entries(value.packages)) {
        if (!path) continue; // Project root is not an installed dependency.
        if (!object(entry) || entry.link === true || !/(^|\/)node_modules\//.test(path)) { skipped++; continue; }
        const inferred = path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
        add(file.path, 'npm', entry.name ?? inferred, entry.version, 'LOCKFILE');
      }
    } else if (value.lockfileVersion === 1 && object(value.dependencies)) {
      const visit = (group: Record<string, unknown>, depth: number) => {
        if (depth > 32) { truncated = true; return; }
        for (const [name, entry] of Object.entries(group)) {
          if (!object(entry)) { skipped++; continue; }
          add(file.path, 'npm', name, entry.version, 'LOCKFILE');
          if (object(entry.dependencies)) visit(entry.dependencies, depth + 1);
        }
      };
      visit(value.dependencies, 0);
    } else issues.push({ path: file.path, code: 'UNSUPPORTED_LOCK_FORMAT' });
  }
  const unique = new Map<string, InventoryEntry>();
  for (const entry of entries) {
    const key = coordinateKey(entry);
    if (!unique.has(key) || entry.evidence === 'LOCKFILE') unique.set(key, entry);
  }
  return {
    entries: [...unique.values()].sort((a, b) => coordinateKey(a).localeCompare(coordinateKey(b))),
    skipped, truncated, issues,
    limitation: 'Exact declarations from npm manifests/lockfiles and Composer lockfiles only; ranges, workspace links and unsupported versions are omitted. These are not installed/deployed facts. No advisory service was contacted.'
  };
}
