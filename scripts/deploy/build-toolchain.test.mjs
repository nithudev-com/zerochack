import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';
import './preview-policy.test.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));

test('the lockfile removes unpatched braces and retains reviewed parser patches when used', async () => {
  const lock = JSON.parse(await readFile(new URL('../../package-lock.json', import.meta.url), 'utf8'));
  assert.ok(!Object.keys(lock.packages).some((name) => name.endsWith('/braces')), 'braces has no patched release');
  const parsers = Object.entries(lock.packages).filter(([name]) => name.endsWith('/postcss-selector-parser'));
  for (const [name, entry] of parsers) assert.equal(entry.version, '7.1.6', name);
});

test('nested selectors retain parent, sibling, attribute and pseudo-class behavior', async () => {
  const result = await postcss([tailwind({ base: root, optimize: { minify: false } })]).process(
    '@import "tailwindcss" source(none); .card { & > .title:hover { color: blue } & + .card[data-active="true"] { margin: 1rem } }',
    { from: root + 'apps/web/app/globals.css' },
  );
  assert.match(result.css, /\.card > \.title:hover/);
  assert.match(result.css, /\.card \+ \.card\[data-active="true"\]/);
  const cardRules = [];
  result.root.walkRules((rule) => { if (rule.selector.startsWith('.card')) cardRules.push(rule); });
  assert.equal(cardRules.length, 2);
});

test('Tailwind generates responsive, important and arbitrary-selector utilities through PostCSS', async () => {
  const result = await postcss([tailwind({ base: root, optimize: { minify: false } })]).process(
    '@import "tailwindcss" source(none); @source inline("flex hover:bg-blue-600 md:grid font-bold! [&>a]:underline");',
    { from: root + 'apps/web/app/globals.css' },
  );
  assert.match(result.css, /display: flex/);
  assert.match(result.css, /font-weight: (?:700|var\(--font-weight-bold\)) !important/);
  assert.match(result.css, /:hover/);
  assert.match(result.css, /@media \(min-width: 48rem\)/);
  assert.match(result.css, /text-decoration-line: underline/);
});

test('the actual portal stylesheet compiles with explicit app and shared UI sources', async () => {
  const css = await readFile(new URL('../../apps/web/app/globals.css', import.meta.url), 'utf8');
  const result = await postcss([tailwind({ base: root, optimize: { minify: false } })]).process(css, { from: root + 'apps/web/app/globals.css' });
  assert.doesNotMatch(result.css, /@(?:tailwind|config|source)\b/);
  assert.match(result.css, /\.customer-layout/);
  assert.match(result.css, /\.mfa-challenge-card/);
  assert.match(result.css, /prefers-reduced-motion/);
  assert.match(result.css, /color: #9ca3af/);
  assert.match(result.css, /border-color: #e5e7eb/);
});
