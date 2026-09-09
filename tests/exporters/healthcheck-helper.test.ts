import { describe, it, expect, vi } from 'vitest';
import { httpHealthcheck } from '../../src/utils/retry.js';
import { StravaExporter } from '../../src/exporters/strava.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * #406: six exporters held a byte-identical copy of this, and the two most
 * likely to be holding stale credentials had none at all.
 */
describe('httpHealthcheck', () => {
  it('succeeds on an ok response', async () => {
    const result = await httpHealthcheck(async () => new Response('', { status: 200 }));
    expect(result).toEqual({ success: true });
  });

  it('reports the status on a failure response', async () => {
    const result = await httpHealthcheck(async () => new Response('', { status: 401 }));
    expect(result).toEqual({ success: false, error: 'HTTP 401' });
  });

  it('reports a thrown error rather than letting it escape', async () => {
    const result = await httpHealthcheck(async () => {
      throw new Error('getaddrinfo ENOTFOUND');
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/ENOTFOUND/);
  });
});

describe('StravaExporter.healthcheck (#406)', () => {
  it('reports a missing token file instead of not existing', async () => {
    const exporter = new StravaExporter({
      clientId: '1',
      clientSecret: 's',
      tokenDir: 'C:/nonexistent-strava-token-dir-for-test',
    } as never);

    expect(typeof exporter.healthcheck).toBe('function');
    const result = await exporter.healthcheck!();
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/token file not found/i);
  });

  it('reads with a GET, where the export writes with a PUT', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'strava-healthcheck-'));
    fs.writeFileSync(
      path.join(dir, 'strava_tokens.json'),
      JSON.stringify({
        access_token: 'at',
        refresh_token: 'rt',
        // Far in the future, so the check does not try to refresh.
        expires_at: Math.floor(Date.now() / 1000) + 86_400,
      }),
    );

    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('', { status: 200 }));
    try {
      const exporter = new StravaExporter({
        clientId: '1',
        clientSecret: 's',
        tokenDir: dir,
      } as never);

      const result = await exporter.healthcheck!();
      expect(result).toEqual({ success: true });
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      const [url, init] = fetchSpy.mock.calls[0];
      expect(String(url)).toContain('/api/v3/athlete');
      // The export path uses PUT with a weight body; a check must not.
      expect((init as RequestInit | undefined)?.method).toBeUndefined();
      expect((init as RequestInit | undefined)?.body).toBeUndefined();
    } finally {
      fetchSpy.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
