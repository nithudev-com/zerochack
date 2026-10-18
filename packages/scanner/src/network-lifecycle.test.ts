import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const transport = vi.hoisted(() => ({ fetch: vi.fn(), agents: [] as Array<{ options: unknown; destroy: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }> }));
vi.mock('undici', () => ({
  Agent: class {
    destroy = vi.fn().mockResolvedValue(undefined); close = vi.fn().mockResolvedValue(undefined);
    constructor(public options: unknown) { transport.agents.push(this); }
  },
  fetch: transport.fetch
}));
import { resolvePublicTarget, safeHttpRequest } from './network.js';
import { runSecurityScan } from './orchestrator.js';
const publicAnswer = [{ address: '93.184.216.34', family: 4 as const }];
beforeEach(() => { transport.fetch.mockReset(); transport.agents.length = 0; });
afterEach(() => vi.useRealTimers());

describe('whole-operation scanner deadlines and cancellation', () => {
  it('rejects pre-cancelled work before DNS, fetch or dispatcher creation', async () => {
    const controller = new AbortController(); controller.abort(new Error('synthetic-private-reason')); const resolver = vi.fn().mockResolvedValue(publicAnswer);
    await expect(safeHttpRequest('https://example.org/', { resolver, signal: controller.signal })).rejects.toMatchObject({ code: 'REQUEST_ABORTED' });
    expect(resolver).not.toHaveBeenCalled(); expect(transport.fetch).not.toHaveBeenCalled(); expect(transport.agents).toHaveLength(0);
  });
  it('bounds a stalled DNS lookup and does not dispatch after its late answer', async () => {
    vi.useFakeTimers(); let answer!: (value: typeof publicAnswer) => void;
    const resolver = vi.fn((_host: string, signal?: AbortSignal) => { expect(signal).toBeInstanceOf(AbortSignal); return new Promise<typeof publicAnswer>(resolve => { answer = resolve; }); });
    const checked = expect(safeHttpRequest('https://example.org/', { resolver, timeoutMs: 100 })).rejects.toMatchObject({ code: 'CONNECTION_TIMEOUT' });
    await vi.advanceTimersByTimeAsync(100); await checked; answer(publicAnswer); await Promise.resolve();
    expect(transport.fetch).not.toHaveBeenCalled(); expect(transport.agents).toHaveLength(0); expect(vi.getTimerCount()).toBe(0);
  });
  it('cancels a pending resolver promptly without accepting a later safe answer', async () => {
    const controller = new AbortController(); const resolver = vi.fn(() => new Promise<typeof publicAnswer>(() => undefined));
    const checked = expect(resolvePublicTarget(new URL('https://example.org/'), resolver, controller.signal)).rejects.toMatchObject({ code: 'REQUEST_ABORTED' });
    controller.abort(); await checked; expect(transport.fetch).not.toHaveBeenCalled();
  });
  it('aborts stalled fetch work and destroys its dedicated dispatcher', async () => {
    const controller = new AbortController(); transport.fetch.mockImplementation(() => new Promise(() => undefined));
    const checked = expect(safeHttpRequest('https://example.org/', { resolver: async () => publicAnswer, signal: controller.signal })).rejects.toMatchObject({ code: 'REQUEST_ABORTED' });
    await vi.waitFor(() => expect(transport.fetch).toHaveBeenCalledOnce()); controller.abort(); await checked;
    expect(transport.agents[0]!.destroy).toHaveBeenCalledOnce(); expect(transport.agents[0]!.close).not.toHaveBeenCalled();
    expect(transport.fetch.mock.calls[0]![1].signal.aborted).toBe(true);
  });
  it('cancels redirect bodies before resolving or sending the next hop', async () => {
    const order: string[] = []; const cancel = vi.fn(async () => { order.push('cancel-body'); });
    transport.fetch.mockResolvedValueOnce({ status: 302, headers: new Headers({ location: '/next' }), body: { cancel } }).mockResolvedValueOnce(new Response('done', { status: 200 }));
    const resolver = vi.fn(async () => { order.push('dns'); return publicAnswer; });
    const result = await safeHttpRequest('https://example.org/', { resolver });
    expect(result.url).toBe('https://example.org/next'); expect(cancel).toHaveBeenCalledOnce(); expect(order.slice(0, 3)).toEqual(['dns','cancel-body','dns']);
    expect(transport.agents.every(agent => agent.destroy.mock.calls.length === 1 && agent.close.mock.calls.length === 0)).toBe(true);
  });
  it('does not reset the deadline on redirects', async () => {
    vi.useFakeTimers(); const resolver = async () => publicAnswer;
    transport.fetch.mockImplementationOnce(() => new Promise(resolve => setTimeout(() => resolve(new Response(null, { status: 302, headers: { location: '/next' } })), 60))).mockImplementationOnce(() => new Promise(resolve => setTimeout(() => resolve(new Response('late')), 60)));
    const checked = expect(safeHttpRequest('https://example.org/', { resolver, timeoutMs: 100 })).rejects.toMatchObject({ code: 'CONNECTION_TIMEOUT' });
    await vi.advanceTimersByTimeAsync(100); await checked;
    expect(transport.fetch).toHaveBeenCalledTimes(2); expect(transport.agents.every(agent => agent.destroy.mock.calls.length === 1)).toBe(true);
    // Drain the synthetic ignored transport's own timer; real fetch receives abort.
    await vi.advanceTimersByTimeAsync(20); expect(vi.getTimerCount()).toBe(0);
  });
  it('does not send another redirect after cancellation while its body closes', async () => {
    const controller = new AbortController(); const cancel = vi.fn(async () => { controller.abort(); });
    transport.fetch.mockResolvedValue({ status: 302, headers: new Headers({ location: '/next' }), body: { cancel } });
    await expect(safeHttpRequest('https://example.org/', { resolver: async () => publicAnswer, signal: controller.signal })).rejects.toMatchObject({ code: 'REQUEST_ABORTED' });
    expect(transport.fetch).toHaveBeenCalledOnce();
  });
  it('bounds a streaming body and a stuck dispatcher cleanup', async () => {
    vi.useFakeTimers();
    transport.fetch.mockImplementation(async () => {
      transport.agents[0]!.destroy.mockImplementation(() => new Promise(() => undefined));
      return { status: 200, headers: new Headers(), body: { getReader: () => ({ read: () => new Promise(() => undefined) }) } };
    });
    const checked = expect(safeHttpRequest('https://example.org/', { resolver: async () => publicAnswer, timeoutMs: 100 })).rejects.toMatchObject({ code: 'CONNECTION_TIMEOUT' });
    await vi.advanceTimersByTimeAsync(100); await checked; expect(vi.getTimerCount()).toBe(0); expect(transport.agents[0]!.destroy).toHaveBeenCalledOnce();
  });
  it('does not report success when cleanup itself exceeds the whole deadline', async () => {
    vi.useFakeTimers(); transport.fetch.mockImplementation(async () => { transport.agents[0]!.destroy.mockImplementation(() => new Promise(() => undefined)); return new Response('done'); });
    const checked = expect(safeHttpRequest('https://example.org/', { resolver: async () => publicAnswer, timeoutMs: 100 })).rejects.toMatchObject({ code: 'CONNECTION_TIMEOUT' });
    await vi.advanceTimersByTimeAsync(100); await checked; expect(vi.getTimerCount()).toBe(0);
  });
  it('preserves DNS, redirect-scope, response-size and TLS failure gates', async () => {
    await expect(safeHttpRequest('https://example.org/', { resolver: async () => [...publicAnswer, { address: '127.0.0.1', family: 4 }] })).rejects.toMatchObject({ code: 'DNS_UNSAFE' });
    expect(transport.fetch).not.toHaveBeenCalled();
    transport.fetch.mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'https://different.org/' } }));
    await expect(safeHttpRequest('https://example.org/', { resolver: async () => publicAnswer })).rejects.toMatchObject({ code: 'REDIRECT_SCOPE_BLOCKED' });
    transport.fetch.mockResolvedValueOnce(new Response('large', { headers: { 'content-length': '999' } }));
    await expect(safeHttpRequest('https://example.org/', { resolver: async () => publicAnswer, maxBytes: 10 })).rejects.toMatchObject({ code: 'RESPONSE_TOO_LARGE' });
    transport.fetch.mockRejectedValueOnce(new Error('synthetic-CERT_HAS_EXPIRED-private-diagnostic'));
    const error = await safeHttpRequest('https://example.org/', { resolver: async () => publicAnswer }).catch(error => error);
    expect(error).toMatchObject({ code: 'CONNECTION_FAILED' }); expect(String(error)).not.toContain('private-diagnostic');
    for (const agent of transport.agents) { expect(agent.options).not.toHaveProperty('connect.rejectUnauthorized'); expect(agent.options).not.toHaveProperty('connect.checkServerIdentity'); }
  });
  it('stops subsequent engines when the caller cancels after a completed engine', async () => {
    const controller = new AbortController(); const first = vi.fn(async () => []); const second = vi.fn(async () => []);
    transport.fetch.mockResolvedValue(new Response('fixture'));
    await expect(runSecurityScan('https://example.org/', { resolver: async () => publicAnswer, signal: controller.signal, engines: [{ name: 'first', version: '1', scan: first }, { name: 'second', version: '1', scan: second }], onEngineComplete: async () => { controller.abort(); } })).rejects.toMatchObject({ code: 'REQUEST_ABORTED' });
    expect(first).toHaveBeenCalledOnce(); expect(second).not.toHaveBeenCalled();
  });
});
