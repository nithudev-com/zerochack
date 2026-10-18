import { describe, expect, it } from 'vitest';
import { inventoryDependencies, isDependencyCoordinate } from './dependency-inventory.js';
import { prepareReviewSnapshot } from './source-review.js';
const snapshot = (path: string, value: unknown) => prepareReviewSnapshot([{ path, content: JSON.stringify(value) }]);
describe('bounded dependency inventory, without installing or fetching source', () => {
  it('keeps exact versions and explains skipped ranges rather than inventing resolved versions', () => {
    const result = inventoryDependencies(snapshot('package.json', { dependencies: { exact: '1.2.3', range: '^1.2.0', linked: 'workspace:*' } }));
    expect(result.entries).toEqual([{ ecosystem: 'npm', name: 'exact', version: '1.2.3', evidence: 'DECLARED_EXACT', path: 'package.json' }]);
    expect(result.skipped).toBe(2);
  });
  it('reads npm lockfile v3, nested packages and aliases, excluding the project root and workspace links', () => {
    const result = inventoryDependencies(snapshot('package-lock.json', { lockfileVersion: 3, packages: { '': { name: 'project', version: '1.0.0' }, 'node_modules/a': { version: '2.0.0' }, 'node_modules/a/node_modules/@scope/b': { version: '3.0.0' }, 'node_modules/alias': { name: 'original', version: '4.0.0' }, 'node_modules/local': { link: true } } }));
    expect(result.entries.map((e) => e.name).sort()).toEqual(['@scope/b', 'a', 'original']);
    expect(result.entries.every((e) => e.evidence === 'LOCKFILE')).toBe(true);
  });
  it('reads nested npm v1 lock dependencies', () => {
    const result = inventoryDependencies(snapshot('npm-shrinkwrap.json', { lockfileVersion: 1, dependencies: { a: { version: '1.0.0', dependencies: { b: { version: '2.0.0' } } } } }));
    expect(result.entries).toHaveLength(2);
  });
  it('supports Composer stable lockfile versions without enabling a CMS or database connector', () => {
    const result = inventoryDependencies(snapshot('composer.lock', { packages: [{ name: 'vendor/package', version: 'v2.3.4' }], 'packages-dev': [{ name: 'vendor/test', version: '1.0.0' }] }));
    expect(result.entries[0]).toMatchObject({ ecosystem: 'Packagist', version: '2.3.4' });
  });
  it('records unsupported or invalid manifests and never describes them as clean', () => {
    expect(inventoryDependencies(snapshot('package-lock.json', { lockfileVersion: 99 })).issues[0]?.code).toBe('UNSUPPORTED_LOCK_FORMAT');
    expect(inventoryDependencies(prepareReviewSnapshot([{ path: 'package.json', content: '{broken' }])).issues[0]?.code).toBe('INVALID_JSON');
  });
  it('prefers lockfile evidence for duplicate exact coordinates', () => {
    const result = inventoryDependencies(prepareReviewSnapshot([{ path: 'package.json', content: '{"dependencies":{"a":"1.0.0"}}' }, { path: 'package-lock.json', content: '{"lockfileVersion":3,"packages":{"node_modules/a":{"version":"1.0.0"}}}' }]));
    expect(result.entries).toHaveLength(1); expect(result.entries[0]?.evidence).toBe('LOCKFILE');
  });
  it('does not include download URLs, integrity fields or arbitrary package metadata in the output', () => {
    const result = inventoryDependencies(snapshot('package-lock.json', { lockfileVersion: 3, packages: { 'node_modules/a': { version: '1.0.0', resolved: 'https://private.example.org/a.tgz', integrity: 'private-marker' } } }));
    expect(JSON.stringify(result)).not.toMatch(/private-marker|private.example.org/);
  });
  it('rejects non-coordinate input and accepts exact prereleases', () => {
    expect(isDependencyCoordinate({ ecosystem: 'npm', name: 'a', version: '1.2.3-beta.1' })).toBe(true);
    expect(isDependencyCoordinate({ ecosystem: 'npm', name: '../a', version: '1.2.3' })).toBe(false);
    expect(isDependencyCoordinate({ ecosystem: 'npm', name: 'a', version: 'latest' })).toBe(false);
    expect(isDependencyCoordinate({ ecosystem: 'npm', name: 'a', version: '01.2.3' })).toBe(false);
  });
});
