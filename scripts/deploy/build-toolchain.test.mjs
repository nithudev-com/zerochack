import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import postcss from 'postcss';
import nested from 'postcss-nested';
import tailwind from 'tailwindcss';

const root = fileURLToPath(new URL('../../', import.meta.url));

test('the lockfile retains the reviewed selector-parser security patch', async () => {
  const lock = JSON.parse(await readFile(new URL('../../package-lock.json', import.meta.url), 'utf8'));
  const parsers = Object.entries(lock.packages).filter(([name]) => name.endsWith('/postcss-selector-parser'));
  assert.ok(parsers.length > 0);
  for (const [name, entry] of parsers) assert.equal(entry.version, '7.1.6', name);
});

test('nested selectors retain parent, sibling, attribute and pseudo-class behavior', async () => {
  const result = await postcss([nested()]).process(
    '.card { & > .title:hover { color: blue } & + .card[data-active="true"] { margin: 1rem } }',
    { from: undefined },
  );
  assert.match(result.css, /\.card > \.title:hover/);
  assert.match(result.css, /\.card \+ \.card\[data-active="true"\]/);
  assert.equal(result.root.nodes.length, 2);
});

test('Tailwind 3 utility generation remains compatible with the patched parser', async () => {
  const result = await postcss([tailwind({
    content: [{ raw: '<div class="flex hover:bg-blue-600 md:grid !font-bold [&>a]:underline"></div>', extension: 'html' }],
    theme: { extend: {} }, plugins: [],
  })]).process('@tailwind utilities;', { from: undefined });
  assert.match(result.css, /display: flex/);
  assert.match(result.css, /font-weight: 700 !important/);
  assert.match(result.css, /:hover/);
  assert.match(result.css, /@media \(min-width: 768px\)/);
  assert.match(result.css, /text-decoration-line: underline/);
});

test('the actual portal stylesheet compiles with its existing Tailwind 3 configuration', async () => {
  const css = await readFile(new URL('../../apps/web/app/globals.css', import.meta.url), 'utf8');
  const result = await postcss([tailwind({
    content: [root + 'apps/web/app/**/*.{ts,tsx}', root + 'apps/web/components/**/*.{ts,tsx}', root + 'packages/ui/src/**/*.{ts,tsx}'],
    theme: { extend: {} }, plugins: [],
  })]).process(css, { from: root + 'apps/web/app/globals.css' });
  assert.doesNotMatch(result.css, /@tailwind/);
  assert.match(result.css, /\.customer-layout/);
  assert.match(result.css, /\.mfa-challenge-card/);
  assert.match(result.css, /prefers-reduced-motion/);
});
