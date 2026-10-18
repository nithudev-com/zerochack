import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiClientError, parseRetryAfter } from './api';
import { canRetainQueryData, pollingInterval, queryRetry, retryDelayRemaining } from './query-policy';

const clockNow = Date.parse('2026-10-18T12:00:00.000Z');
const queryState = (error: unknown, count = 0, errorUpdateCount?: number) => ({
  state: { error, errorUpdatedAt: Date.now(), fetchFailureCount: count, ...(errorUpdateCount === undefined ? {} : { errorUpdateCount }) }
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(clockNow);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('Retry-After response handling', () => {
  it('parses numeric seconds and rounds fractional seconds upward', () => {
    expect(parseRetryAfter('17', clockNow)).toBe(17);
    expect(parseRetryAfter(' 17.2 ', clockNow)).toBe(18);
    expect(parseRetryAfter('0', clockNow)).toBe(1);
  });

  it('parses HTTP dates and never schedules a past date as an immediate retry', () => {
    expect(parseRetryAfter('Sun, 18 Oct 2026 12:00:17 GMT', clockNow)).toBe(17);
    expect(parseRetryAfter('Sun, 18 Oct 2026 12:00:17 GMT', clockNow + 100)).toBe(17);
    expect(parseRetryAfter('Sun, 18 Oct 2026 11:59:00 GMT', clockNow)).toBe(1);
    expect(parseRetryAfter('not a date', clockNow)).toBeNull();
    expect(parseRetryAfter(null, clockNow)).toBeNull();
  });

  it.each(['17', 'Sun, 18 Oct 2026 12:00:17 GMT'])('preserves the %s header on an actual failed API response', async retryAfter => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: 'RATE_LIMITED', message: 'Please wait.' } }), {
      status: 429, headers: { 'content-type': 'application/json', 'retry-after': retryAfter }
    }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(api('/customer/fixture/chat')).rejects.toMatchObject({
      status: 429, code: 'RATE_LIMITED', retryAfterSeconds: 17, retryAt: clockNow + 17_000
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ credentials: 'include' }));
  });

  it('uses a bounded default wait when a 429 has no usable Retry-After', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('unparseable response', { status: 429 })));
    await expect(api('/customer/fixture/chat')).rejects.toMatchObject({ status: 429, retryAfterSeconds: 60, retryAt: clockNow + 60_000 });
    expect(new ApiClientError('Wait', 'RATE_LIMITED', 429, 0).retryAfterSeconds).toBe(1);
  });
});

describe('query retry and polling budgets', () => {
  it('retries a transient query at most once and never immediately retries a 4xx rejection', () => {
    for (const error of [new Error('network unavailable'), new ApiClientError('Unavailable', 'UNAVAILABLE', 503)]) {
      expect(queryRetry(0, error)).toBe(true);
      expect(queryRetry(1, error)).toBe(false);
      expect(queryRetry(5, error)).toBe(false);
    }
    for (const status of [400, 401, 403, 404, 408, 422, 429]) {
      expect(queryRetry(0, new ApiClientError('Rejected', 'REJECTED', status))).toBe(false);
    }
  });

  it('hides cached private data and stops polling after session, authorization, or deleted-resource errors', () => {
    for (const status of [401, 403, 404]) {
      const error = new ApiClientError('Rejected', 'REJECTED', status);
      expect(canRetainQueryData(error)).toBe(false);
      expect(pollingInterval(queryState(error), 1500)).toBe(false);
    }
    expect(pollingInterval(queryState(new ApiClientError('Invalid', 'INVALID', 422)), 1500)).toBe(false);
    expect(canRetainQueryData(new ApiClientError('Wait', 'RATE_LIMITED', 429))).toBe(true);
    expect(canRetainQueryData(new ApiClientError('Unavailable', 'UNAVAILABLE', 503))).toBe(true);
  });

  it('does not poll before a 429 deadline, even as the remaining wait decreases', () => {
    const error = new ApiClientError('Wait', 'RATE_LIMITED', 429, 17);
    expect(retryDelayRemaining(error)).toBe(17_000);
    expect(pollingInterval(queryState(error), 1000)).toBe(17_100);
    vi.setSystemTime(clockNow + 16_000);
    expect(retryDelayRemaining(error)).toBe(1000);
    expect(pollingInterval(queryState(error), 1000)).toBe(1100);
    expect(pollingInterval(queryState(error), 20_000)).toBe(1100);
    vi.setSystemTime(clockNow + 17_000);
    expect(retryDelayRemaining(error)).toBe(0);
    expect(pollingInterval(queryState(error), 1000)).toBe(5000);
    expect(retryDelayRemaining(error, clockNow + 30_000)).toBe(0);
    expect(retryDelayRemaining(new Error('other failure'))).toBe(0);
  });

  it('backs transient polling off from 5 seconds to a bounded minute without shortening the normal interval', () => {
    const error = new ApiClientError('Unavailable', 'UNAVAILABLE', 503);
    expect(pollingInterval(queryState(null), 1500)).toBe(1500);
    for (const [count, expected] of [[0, 5000], [1, 10_000], [2, 20_000], [3, 40_000], [4, 60_000], [50, 60_000]] as const) {
      expect(pollingInterval(queryState(error, count), 1500)).toBe(expected);
    }
    expect(pollingInterval(queryState(error, 0, 3), 1500)).toBe(40_000);
    expect(pollingInterval(queryState(error), 30_000)).toBe(30_000);
    expect(pollingInterval(queryState(new ApiClientError('Timeout', 'TIMEOUT', 408)), 1500)).toBe(5000);
  });
});
