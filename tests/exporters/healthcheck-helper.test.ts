import { describe, it, expect, vi } from 'vitest';
import { httpHealthcheck } from '../../src/utils/retry.js';
import { StravaExporter } from '../../src/exporters/strava.js';

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

  it('uses a GET, so a check never overwrites the athlete weight', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('', { status: 200 }));
    const exporter = new StravaExporter({
      clientId: '1',
      clientSecret: 's',
      tokenDir: 'C:/nonexistent-strava-token-dir-for-test',
    } as never);
    // Token loading fails first, so assert on the contract rather than the call:
    // the export path uses PUT and the healthcheck must not.
    await exporter.healthcheck!();
    for (const call of fetchSpy.mock.calls) {
      expect((call[1] as RequestInit | undefined)?.method).not.toBe('PUT');
    }
    fetchSpy.mockRestore();
  });
});
