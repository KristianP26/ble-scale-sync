import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  isNewerVersion,
  buildUserAgent,
  checkForUpdate,
  resetUpdateCheckTimer,
  getCurrentVersion,
} from '../src/update-check.js';
import { UPDATE_STATE_FILENAME, configureUpdateState } from '../src/update-state.js';

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

// ─── persisted cooldown ─────────────────────────────────────────────────────

describe('checkForUpdate() persisted cooldown', () => {
  let tempDir: string;

  const configPath = (): string => join(tempDir, 'config.yaml');
  const statePath = (): string => join(tempDir, UPDATE_STATE_FILENAME);

  const okFetch = (): ReturnType<typeof vi.fn> =>
    vi.fn().mockResolvedValue({ ok: true, json: async () => ({ latest: '99.0.0' }) });

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'update-check-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('writes today into the state file next to config.yaml', async () => {
    const mockFetch = okFetch();
    vi.stubGlobal('fetch', mockFetch);
    configureUpdateState(configPath());

    await checkForUpdate(true);

    const today = new Date().toISOString().slice(0, 10);
    expect(existsSync(statePath())).toBe(true);
    expect(JSON.parse(readFileSync(statePath(), 'utf8'))).toEqual({ lastCheckDate: today });

    vi.unstubAllGlobals();
  });

  it('survives a process restart: the second process does not check again', async () => {
    const first = okFetch();
    vi.stubGlobal('fetch', first);
    configureUpdateState(configPath());
    await checkForUpdate(true);
    expect(first).toHaveBeenCalledOnce();

    // Simulate a restart: fresh module state, same state file on disk.
    resetUpdateCheckTimer();
    const second = okFetch();
    vi.stubGlobal('fetch', second);
    configureUpdateState(configPath());

    expect(await checkForUpdate(true)).toBeNull();
    expect(second).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it('checks again once the persisted day is in the past', async () => {
    writeFileSync(statePath(), '{"lastCheckDate":"2000-01-01"}\n', 'utf8');
    const mockFetch = okFetch();
    vi.stubGlobal('fetch', mockFetch);
    configureUpdateState(configPath());

    expect(await checkForUpdate(true)).not.toBeNull();
    expect(mockFetch).toHaveBeenCalledOnce();

    vi.unstubAllGlobals();
  });

  it('treats a corrupt state file as never checked', async () => {
    writeFileSync(statePath(), 'not json', 'utf8');
    const mockFetch = okFetch();
    vi.stubGlobal('fetch', mockFetch);
    configureUpdateState(configPath());

    expect(await checkForUpdate(true)).not.toBeNull();
    expect(mockFetch).toHaveBeenCalledOnce();

    vi.unstubAllGlobals();
  });

  it('consumes the day even when the request fails', async () => {
    const failing = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    vi.stubGlobal('fetch', failing);
    configureUpdateState(configPath());

    expect(await checkForUpdate(true)).toBeNull();
    expect(failing).toHaveBeenCalledOnce();

    const today = new Date().toISOString().slice(0, 10);
    expect(JSON.parse(readFileSync(statePath(), 'utf8'))).toEqual({ lastCheckDate: today });

    vi.unstubAllGlobals();
  });

  it('does not write a state file when update_check is disabled', async () => {
    configureUpdateState(configPath());

    expect(await checkForUpdate(false)).toBeNull();
    expect(existsSync(statePath())).toBe(false);
  });

  it('does not write a state file when CI=true', async () => {
    process.env.CI = 'true';
    configureUpdateState(configPath());

    expect(await checkForUpdate(true)).toBeNull();
    expect(existsSync(statePath())).toBe(false);
  });
});
