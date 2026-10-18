import { expect, test, type Page } from '@playwright/test';

const websiteId = 'c7429fb1-8e35-4d0e-a735-0d807c47cb91';
const workspace = `/customer/websites/${websiteId}`;
const stamp = '2026-10-18T10:00:00.000Z';
type Events = { burst: (count: number, index?: number) => void; sources: () => Array<{ closed: boolean; url: string; credentials: boolean }> };

async function fixture(page: Page) {
  await page.clock.install();
  await page.addInitScript(() => {
    const instances: FakeSource[] = [];
    class FakeSource extends EventTarget {
      closed = false; onopen: ((event: Event) => void) | null = null; onerror: ((event: Event) => void) | null = null;
      constructor(public url: string, public options?: EventSourceInit) {
        super(); instances.push(this);
        queueMicrotask(() => { if (!this.closed) this.onopen?.(new Event('open')); });
      }
      close() { this.closed = true; }
    }
    Object.defineProperty(window, 'EventSource', { configurable: true, value: FakeSource });
    (window as unknown as { careEvents: Events }).careEvents = {
      burst(count, index = instances.length - 1) { const source = instances[index]; if (!source || source.closed) return; for (let sequence = 0; sequence < count; sequence++) source.dispatchEvent(new MessageEvent('activity', { data: JSON.stringify({ sequence }), lastEventId: String(sequence + 1) })); },
      sources: () => instances.map(source => ({ closed: source.closed, url: source.url, credentials: source.options?.withCredentials === true }))
    };
  });
  const reads = { care: 0, chat: 0, olderCare: 0, olderChat: 0, stagingCare: 0, stagingChat: 0 };
  const state = { throttle: false, tail: 'Saved conversation tail' };
  const head = Array.from({ length: 200 }, (_, index) => ({ id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`, type: 'AI', content: `Saved message ${index}`, createdAt: stamp }));
  await page.route('**/v1/**', async route => {
    const request = route.request(); const url = new URL(request.url()); const path = url.pathname;
    const headers = { 'access-control-allow-origin': new URL(page.url()).origin, 'access-control-allow-credentials': 'true', 'access-control-expose-headers': 'retry-after', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type' };
    const send = (json: unknown) => route.fulfill({ headers, json });
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    if (path.endsWith('/auth/me')) return send({ roles: ['Customer'] });
    if (path === `/v1/websites/${websiteId}`) return send({ id: websiteId, name: 'Request budget fixture', url: 'https://example.test/', connectionStatus: 'PENDING' });
    const older = url.searchParams.has('before'); const staging = url.searchParams.get('environment') === 'STAGING';
    if (path.endsWith('/care')) {
      if (older) reads.olderCare++; else if (staging) reads.stagingCare++; else reads.care++;
      if (state.throttle && !older) return route.fulfill({ headers: { ...headers, 'retry-after': '17' }, status: 429, json: { error: { code: 'RATE_LIMITED', message: 'Rate limit exceeded, retry in 17 seconds' } } });
      return send({ nextCursor: older ? null : 'a7b560ce-2b96-4c76-b7e8-29047ab4fe75', credentials: [], accessRequests: [], jobs: [], capabilities: { sourceReview: false, attachments: false, isolatedRepair: false, deployment: false } });
    }
    if (path.endsWith('/chat')) {
      if (older) reads.olderChat++; else if (staging) reads.stagingChat++; else reads.chat++;
      if (state.throttle && !older) return route.fulfill({ headers: { ...headers, 'retry-after': '17' }, status: 429, json: { error: { code: 'RATE_LIMITED', message: 'Rate limit exceeded, retry in 17 seconds' } } });
      if (older) return send([{ id: 'older-message', type: 'AI', content: 'Earlier conversation is retained', createdAt: stamp }]);
      return send([...head.slice(0, -1), { ...head.at(-1), content: staging ? 'Staging conversation tail' : state.tail }]);
    }
    return send([]);
  });
  await page.goto(workspace);
  await expect(page.getByLabel('Conversation history')).toContainText('Saved conversation tail');
  await expect(page.getByText('Live activity', { exact: true })).toBeVisible();
  return { reads, state, burst: (count = 100) => page.evaluate(count => (window as unknown as { careEvents: Events }).careEvents.burst(count), count) };
}

test('100 replay events refresh only the latest heads once and never refetch manually loaded history', async ({ page }) => {
  const current = await fixture(page);
  await page.getByRole('button', { name: 'Load older messages', exact: true }).click();
  await page.getByRole('button', { name: 'Load older jobs', exact: true }).click();
  await expect.poll(() => current.reads.olderChat).toBe(1); await expect.poll(() => current.reads.olderCare).toBe(1);
  await expect(page.getByLabel('Conversation history')).toContainText('Earlier conversation is retained');
  const before = { ...current.reads }; current.state.tail = 'Newest saved tail after replay';
  await current.burst(); await page.clock.fastForward(5100);
  await expect(page.getByLabel('Conversation history')).toContainText('Newest saved tail after replay');
  expect(current.reads.care - before.care).toBe(1); expect(current.reads.chat - before.chat).toBe(1);
  expect(current.reads.olderCare).toBe(1); expect(current.reads.olderChat).toBe(1);
  expect((await page.evaluate(() => (window as unknown as { careEvents: Events }).careEvents.sources())).filter(source => !source.closed)).toHaveLength(1);
});

test('429 retains the thread and unsent draft, defers replay refreshes, then reconciles the newest tail', async ({ page }) => {
  const current = await fixture(page); const draft = page.getByLabel('Message CodeBandage', { exact: true });
  await draft.fill('Keep this unsent idea while the server asks me to wait.');
  current.state.throttle = true; await current.burst(); await page.clock.fastForward(5100);
  await expect(page.getByRole('button', { name: 'Retry workspace', exact: true })).toBeDisabled();
  await expect(page.getByLabel('Conversation history')).toContainText('Saved conversation tail');
  await expect(draft).toHaveValue('Keep this unsent idea while the server asks me to wait.');
  const paused = { ...current.reads }; await current.burst(); await page.clock.fastForward(16000);
  expect(current.reads.care).toBe(paused.care); expect(current.reads.chat).toBe(paused.chat);
  current.state.throttle = false; current.state.tail = 'Newest saved tail after waiting';
  await page.clock.fastForward(2000);
  await expect(page.getByLabel('Conversation history')).toContainText('Newest saved tail after waiting');
  expect(current.reads.care - paused.care).toBe(1); expect(current.reads.chat - paused.chat).toBe(1);
  await expect(draft).toHaveValue('Keep this unsent idea while the server asks me to wait.');
});

test('scope changes close the old subscription and clear its pending replay timer', async ({ page }) => {
  const current = await fixture(page); const before = { ...current.reads };
  await current.burst(); await page.getByLabel('Environment', { exact: true }).selectOption('STAGING');
  await expect(page.getByLabel('Conversation history')).toContainText('Staging conversation tail');
  await expect(page.getByText('Live activity', { exact: true })).toBeVisible();
  const sources = await page.evaluate(() => (window as unknown as { careEvents: Events }).careEvents.sources());
  expect(sources[0]).toMatchObject({ closed: true, credentials: true });
  expect(sources.at(-1)).toMatchObject({ closed: false, credentials: true });
  await page.clock.fastForward(5100);
  expect(current.reads.care).toBe(before.care); expect(current.reads.chat).toBe(before.chat);
  await current.burst(); await page.clock.fastForward(5100);
  await expect.poll(() => current.reads.stagingCare).toBe(2); await expect.poll(() => current.reads.stagingChat).toBe(2);
});
