import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sendWithRetry, probe, fetchNoRedirect } from '../../src/exporters/http.js';
import type { Logger } from '../../src/logger.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const log: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const opts = { log, label: 'test', baseDelayMs: 0 };

function redirect(status: number, location?: string): Response {
  return new Response(null, { status, headers: location ? { location } : {} });
}

describe('sendWithRetry and redirects', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('asks fetch not to follow redirects', async () => {
    mockFetch.mockResolvedValue(new Response('', { status: 200 }));
    await sendWithRetry('https://example.com/hook', { method: 'POST' }, opts);
    expect(mockFetch).toHaveBeenCalledWith(
      'https://example.com/hook',
      expect.objectContaining({ redirect: 'manual' }),
    );
  });

  it('cannot be told to follow by the caller init', async () => {
    mockFetch.mockResolvedValue(new Response('', { status: 200 }));
    await sendWithRetry('https://example.com/hook', { redirect: 'follow' }, opts);
    expect(mockFetch.mock.calls[0][1].redirect).toBe('manual');
  });

  it.each([301, 307, 308])(
    'fails once on a %i to a POST, naming only the target origin',
    async (status) => {
      mockFetch.mockResolvedValue(redirect(status, 'https://other.example/x?token=abc'));
      const onStatus = vi.fn();
      const onOk = vi.fn();
      const result = await sendWithRetry(
        'https://example.com/hook',
        { method: 'POST' },
        { ...opts, onStatus, onOk },
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain(
        `HTTP ${status}: redirected to https://other.example, which is not followed`,
      );
      expect(result.error).not.toContain('token=abc');
      expect(result.error).not.toContain('/x');
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(onStatus).not.toHaveBeenCalled();
      expect(onOk).not.toHaveBeenCalled();
    },
  );

  it.each([302, 303])(
    'counts a %i to a POST as delivered without following or retrying it',
    async (status) => {
      mockFetch.mockResolvedValue(redirect(status, 'https://other.example/x?token=abc'));
      const onStatus = vi.fn();
      const onOk = vi.fn();
      const result = await sendWithRetry(
        'https://example.com/hook?key=secret',
        { method: 'POST' },
        { ...opts, onStatus, onOk },
      );

      expect(result).toEqual({ success: true });
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(onStatus).not.toHaveBeenCalled();
      expect(onOk).not.toHaveBeenCalled();
      const logged = vi.mocked(log.info).mock.calls.map((c) => String(c[0]));
      expect(logged).toEqual([expect.stringContaining(`answered HTTP ${status}`)]);
      expect(logged[0]).toContain('https://example.com');
      expect(logged[0]).not.toContain('secret');
      expect(logged[0]).not.toContain('token=abc');
    },
  );

  it.each([302, 303])('still refuses a %i to a request that is not a POST', async (status) => {
    mockFetch.mockResolvedValue(redirect(status, 'https://other.example/x'));
    for (const init of [{}, { method: 'PUT' }]) {
      mockFetch.mockClear();
      const result = await sendWithRetry('https://example.com/hook', init, opts);
      expect(result.success).toBe(false);
      expect(result.error).toContain(
        `HTTP ${status}: redirected to https://other.example, which is not followed`,
      );
      expect(mockFetch).toHaveBeenCalledTimes(1);
    }
  });

  it('says so when the redirect stays on the same origin', async () => {
    mockFetch.mockResolvedValue(redirect(308, '/hook/'));
    const result = await sendWithRetry('https://example.com/hook', { method: 'POST' }, opts);
    expect(result.error).toContain(
      'HTTP 308: redirected within https://example.com, which is not followed',
    );
  });

  it('says so when there is no usable Location', async () => {
    mockFetch.mockResolvedValueOnce(redirect(301));
    expect((await sendWithRetry('https://example.com/hook', {}, opts)).error).toContain(
      'HTTP 301: redirect without a usable Location',
    );
    mockFetch.mockResolvedValueOnce(redirect(302, 'javascript:alert(1)'));
    expect((await sendWithRetry('https://example.com/hook', {}, opts)).error).toContain(
      'redirect without a usable Location',
    );
  });

  it('still retries a 5xx', async () => {
    mockFetch.mockResolvedValue(new Response('', { status: 503 }));
    const result = await sendWithRetry('https://example.com/hook', {}, opts);
    expect(result.success).toBe(false);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });
});

describe('probe and redirects', () => {
  it('reports a redirect as an unhealthy target', async () => {
    mockFetch.mockResolvedValue(redirect(308, 'https://example.com/health'));
    const result = await probe('http://example.com/health');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(
      /^HTTP 308: redirected to https:\/\/example\.com, which is not followed/,
    );
  });
});

describe('fetchNoRedirect', () => {
  it.each([301, 302, 303, 307, 308])('refuses a %i, even to a POST', async (status) => {
    mockFetch.mockResolvedValue(redirect(status, 'https://other.example/x'));
    await expect(fetchNoRedirect('https://example.com', { method: 'POST' })).rejects.toThrow(
      `HTTP ${status}: redirected to https://other.example, which is not followed`,
    );
  });

  it('returns a non-redirect response untouched', async () => {
    const res = new Response('ok', { status: 200 });
    mockFetch.mockResolvedValue(res);
    await expect(fetchNoRedirect('https://example.com')).resolves.toBe(res);
  });
});
