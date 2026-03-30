import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  isNewerVersion,
  buildUserAgent,
  checkForUpdate,
  resetUpdateCheckTimer,
  getCurrentVersion,
} from '../src/update-check.js';

// Suppress log output during tests
vi.spyOn(console, 'log').mockImplementation(() => {});

beforeEach(() => {
  resetUpdateCheckTimer();
  vi.restoreAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  delete process.env.CI;
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── isNewerVersion ─────────────────────────────────────────────────────────

describe('isNewerVersion()', () => {
  it('returns true when latest major is higher', () => {
    expect(isNewerVersion('1.6.4', '2.0.0')).toBe(true);
  });

  it('returns true when latest minor is higher', () => {
    expect(isNewerVersion('1.6.4', '1.7.0')).toBe(true);
  });

  it('returns true when latest patch is higher', () => {
    expect(isNewerVersion('1.6.4', '1.6.5')).toBe(true);
  });

  it('returns false when versions are equal', () => {
    expect(isNewerVersion('1.6.4', '1.6.4')).toBe(false);
  });

  it('returns false when current is newer', () => {
    expect(isNewerVersion('2.0.0', '1.6.4')).toBe(false);
  });

  it('handles v prefix', () => {
    expect(isNewerVersion('v1.6.4', 'v1.7.0')).toBe(true);
    expect(isNewerVersion('v1.7.0', 'v1.6.4')).toBe(false);
  });

  it('handles mixed v prefix', () => {
    expect(isNewerVersion('1.6.4', 'v1.7.0')).toBe(true);
    expect(isNewerVersion('v1.6.4', '1.7.0')).toBe(true);
  });
});

// ─── buildUserAgent ─────────────────────────────────────────────────────────

describe('buildUserAgent()', () => {
  it('includes version, platform, and arch', () => {
    const ua = buildUserAgent();
    expect(ua).toMatch(/^ble-scale-sync\/[\d.]+ \([^;]+; [^)]+\)$/);
    expect(ua).toContain(getCurrentVersion());
    expect(ua).toContain(process.platform);
    expect(ua).toContain(process.arch);
  });
});

// ─── checkForUpdate ─────────────────────────────────────────────────────────

describe('checkForUpdate()', () => {
  it('returns null when update_check is disabled', async () => {
    const result = await checkForUpdate(false);
    expect(result).toBeNull();
  });

  it('returns null when CI=true', async () => {
    process.env.CI = 'true';
    const result = await checkForUpdate(true);
    expect(result).toBeNull();
  });

  it('returns update info when a newer version is available', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ latest: '99.0.0' }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const result = await checkForUpdate(true);
    expect(result).not.toBeNull();
    expect(result!.latest).toBe('99.0.0');
    expect(result!.current).toBe(getCurrentVersion());
    expect(mockFetch).toHaveBeenCalledOnce();

    vi.unstubAllGlobals();
  });

  it('returns null when current version is up to date', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ latest: getCurrentVersion() }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const result = await checkForUpdate(true);
    expect(result).toBeNull();

    vi.unstubAllGlobals();
  });

  it('returns null on HTTP error', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
    });
    vi.stubGlobal('fetch', mockFetch);

    const result = await checkForUpdate(true);
    expect(result).toBeNull();

    vi.unstubAllGlobals();
  });

  it('returns null on network error', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    vi.stubGlobal('fetch', mockFetch);

    const result = await checkForUpdate(true);
    expect(result).toBeNull();

    vi.unstubAllGlobals();
  });

  it('returns null on invalid JSON response', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ unexpected: 'data' }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const result = await checkForUpdate(true);
    expect(result).toBeNull();

    vi.unstubAllGlobals();
  });

  it('respects once-per-day cooldown (skips second call same day)', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ latest: '99.0.0' }),
    });
    vi.stubGlobal('fetch', mockFetch);

    // First call should go through
    const first = await checkForUpdate(true);
    expect(first).not.toBeNull();
    expect(mockFetch).toHaveBeenCalledOnce();

    // Second call within 24h should be skipped
    const second = await checkForUpdate(true);
    expect(second).toBeNull();
    expect(mockFetch).toHaveBeenCalledOnce(); // Still only 1 call

    vi.unstubAllGlobals();
  });

  it('sends correct User-Agent header', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ latest: getCurrentVersion() }),
    });
    vi.stubGlobal('fetch', mockFetch);

    await checkForUpdate(true);

    const [url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.blescalesync.dev/version');
    expect((options.headers as Record<string, string>)['User-Agent']).toMatch(
      /^ble-scale-sync\/[\d.]+ \([^;]+; [^)]+\)$/,
    );

    vi.unstubAllGlobals();
  });

  it('uses AbortSignal for timeout', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ latest: getCurrentVersion() }),
    });
    vi.stubGlobal('fetch', mockFetch);

    await checkForUpdate(true);

    const options = mockFetch.mock.calls[0][1] as RequestInit;
    expect(options.signal).toBeInstanceOf(AbortSignal);

    vi.unstubAllGlobals();
  });
});

// ─── getCurrentVersion ──────────────────────────────────────────────────────

describe('getCurrentVersion()', () => {
  it('returns a semver string', () => {
    expect(getCurrentVersion()).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
