import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StravaExporter } from '../../src/exporters/strava.js';
import type { StravaConfig } from '../../src/exporters/config.js';
import type { BodyComposition } from '../../src/interfaces/scale-adapter.js';

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  renameSync: vi.fn(),
  unlinkSync: vi.fn(),
  chmodSync: vi.fn(),
}));

import * as fs from 'node:fs';

const samplePayload: BodyComposition = {
  weight: 72.5,
  impedance: 485,
  bmi: 23.1,
  bodyFatPercent: 18.5,
  waterPercent: 55.2,
  boneMass: 3.1,
  muscleMass: 58.4,
  visceralFat: 6,
  physiqueRating: 5,
  bmr: 1650,
  metabolicAge: 25,
};

const defaultConfig: StravaConfig = {
  clientId: '12345',
  clientSecret: 'secret',
  tokenDir: './strava-tokens',
};

const validTokens = {
  access_token: 'valid_access',
  refresh_token: 'valid_refresh',
  expires_at: Math.floor(Date.now() / 1000) + 3600,
};

const expiredTokens = {
  access_token: 'old_access',
  refresh_token: 'old_refresh',
  expires_at: Math.floor(Date.now() / 1000) - 100,
};

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('StravaExporter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(validTokens));
    mockFetch.mockResolvedValue({ ok: true, status: 200 });
  });

  it('has name "strava"', () => {
    const exporter = new StravaExporter(defaultConfig);
    expect(exporter.name).toBe('strava');
  });

  it('sends PUT /athlete with weight', async () => {
    const exporter = new StravaExporter(defaultConfig);
    const result = await exporter.export(samplePayload);

    expect(result.success).toBe(true);
    expect(mockFetch).toHaveBeenCalledWith(
      'https://www.strava.com/api/v3/athlete',
      expect.objectContaining({
        method: 'PUT',
        headers: expect.objectContaining({
          Authorization: 'Bearer valid_access',
          'Content-Type': 'application/json',
        }),
        body: JSON.stringify({ weight: 72.5 }),
      }),
    );
  });

  it('refreshes expired token before upload', async () => {
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(expiredTokens));

    const refreshResponse = {
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          access_token: 'new_access',
          refresh_token: 'new_refresh',
          expires_at: Math.floor(Date.now() / 1000) + 3600,
        }),
    };

    const uploadResponse = { ok: true, status: 200 };

    mockFetch.mockResolvedValueOnce(refreshResponse).mockResolvedValueOnce(uploadResponse);

    const exporter = new StravaExporter(defaultConfig);
    const result = await exporter.export(samplePayload);

    expect(result.success).toBe(true);

    // First call: token refresh
    expect(mockFetch.mock.calls[0][0]).toBe('https://www.strava.com/oauth/token');
    const refreshBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(refreshBody.grant_type).toBe('refresh_token');
    expect(refreshBody.client_id).toBe('12345');
    expect(refreshBody.client_secret).toBe('secret');

    // Second call: athlete update with new token
    expect(mockFetch.mock.calls[1][0]).toBe('https://www.strava.com/api/v3/athlete');
    expect(mockFetch.mock.calls[1][1].headers.Authorization).toBe('Bearer new_access');
  });

  // F-14: a token with seconds left passed the check and expired before the PUT.
  it('refreshes a token that is about to expire', async () => {
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ ...validTokens, expires_at: Math.floor(Date.now() / 1000) + 60 }),
    );
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            access_token: 'new_access',
            refresh_token: 'new_refresh',
            expires_at: Math.floor(Date.now() / 1000) + 21600,
          }),
      })
      .mockResolvedValueOnce({ ok: true, status: 200 });

    const result = await new StravaExporter(defaultConfig).export(samplePayload);

    expect(result.success).toBe(true);
    expect(mockFetch.mock.calls[0][0]).toBe('https://www.strava.com/oauth/token');
    expect(mockFetch.mock.calls[1][1].headers.Authorization).toBe('Bearer new_access');
  });

  it('saves refreshed tokens to disk', async () => {
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(expiredTokens));

    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            access_token: 'new_access',
            refresh_token: 'new_refresh',
            expires_at: 9999999999,
          }),
      })
      .mockResolvedValueOnce({ ok: true, status: 200 });

    const exporter = new StravaExporter(defaultConfig);
    await exporter.export(samplePayload);

    expect(fs.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining('strava_tokens.json'),
      expect.stringContaining('"new_access"'),
      expect.objectContaining({ mode: 0o600 }),
    );
  });

  it('fails when token file does not exist', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);

    const exporter = new StravaExporter(defaultConfig);
    const result = await exporter.export(samplePayload);

    expect(result.success).toBe(false);
    expect(result.error).toContain('setup-strava');
  });

  it('fails with helpful message on malformed token file', async () => {
    vi.mocked(fs.readFileSync).mockReturnValue('not valid json {{{');

    const exporter = new StravaExporter(defaultConfig);
    const result = await exporter.export(samplePayload);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Malformed token file');
    expect(result.error).toContain('setup-strava');
  });

  it('saves tokens with restricted file permissions', async () => {
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(expiredTokens));

    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            access_token: 'new_access',
            refresh_token: 'new_refresh',
            expires_at: 9999999999,
          }),
      })
      .mockResolvedValueOnce({ ok: true, status: 200 });

    const exporter = new StravaExporter(defaultConfig);
    await exporter.export(samplePayload);

    // Not a direct writeFileSync(path, ..., { mode }) on the token file: mode
    // applies only when a file is CREATED, so an existing 0644 file stayed
    // 0644, and an in-place truncate+write that fails loses the rotated
    // refresh token while Strava has already invalidated the old one. The
    // token is written to a fresh 0600 tmp file ('wx') and renamed over.
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      expect.stringMatching(/strava_tokens\.json\.tmp$/),
      expect.any(String),
      expect.objectContaining({ mode: 0o600, flag: 'wx' }),
    );
    expect(fs.renameSync).toHaveBeenCalledWith(
      expect.stringMatching(/strava_tokens\.json\.tmp$/),
      expect.stringMatching(/strava_tokens\.json$/),
    );
    expect(fs.writeFileSync).not.toHaveBeenCalledWith(
      expect.stringMatching(/strava_tokens\.json$/),
      expect.anything(),
      expect.anything(),
    );
  });

  it('creates a missing token directory owner-only', async () => {
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(expiredTokens));
    // The token file is readable, its directory is reported missing.
    vi.mocked(fs.existsSync).mockImplementation((p) => String(p).endsWith('strava_tokens.json'));
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({ access_token: 'a', refresh_token: 'r', expires_at: 9999999999 }),
      })
      .mockResolvedValueOnce({ ok: true, status: 200 });

    await new StravaExporter(defaultConfig).export(samplePayload);

    expect(fs.mkdirSync).toHaveBeenCalledWith(expect.any(String), {
      recursive: true,
      mode: 0o700,
    });
  });

  it('returns failure on non-2xx upload response', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 401 });

    const exporter = new StravaExporter(defaultConfig);
    const result = await exporter.export(samplePayload);

    expect(result.success).toBe(false);
    expect(result.error).toContain('401');
  });

  it('returns failure on token refresh error', async () => {
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(expiredTokens));
    mockFetch.mockResolvedValue({ ok: false, status: 400 });

    const exporter = new StravaExporter(defaultConfig);
    const result = await exporter.export(samplePayload);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Token refresh failed');
  });

  it('retries on failure (3 total attempts)', async () => {
    mockFetch.mockRejectedValue(new Error('network error'));

    const exporter = new StravaExporter(defaultConfig);
    const result = await exporter.export(samplePayload);

    expect(result.success).toBe(false);
    expect(result.error).toBe('network error');
    // 3 attempts, each loads tokens + calls fetch = 3 fetch calls
    // (tokens are valid so no refresh calls)
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('succeeds on retry after initial failure', async () => {
    mockFetch
      .mockRejectedValueOnce(new Error('temporary'))
      .mockResolvedValueOnce({ ok: true, status: 200 });

    const exporter = new StravaExporter(defaultConfig);
    const result = await exporter.export(samplePayload);

    expect(result.success).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});
