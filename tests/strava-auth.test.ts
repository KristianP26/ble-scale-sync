import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  exchangeStravaCode,
  stravaAuthorizeUrl,
  StravaTokenExchangeError,
} from '../src/exporters/strava-auth.js';

describe('strava-auth', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('builds the authorize URL with an encoded client id', () => {
    expect(stravaAuthorizeUrl('1 2')).toBe(
      'https://www.strava.com/oauth/authorize?client_id=1%202&redirect_uri=http://localhost&response_type=code&scope=profile:write',
    );
  });

  it('throws with a bounded body on a refused exchange and writes nothing', async () => {
    dir = mkdtempSync(join(tmpdir(), 'bss-strava-x-'));
    const tokenDir = join(dir, 'tokens');
    const refuse = (async () => new Response('x'.repeat(500), { status: 401 })) as typeof fetch;

    const err = await exchangeStravaCode(
      { clientId: '1', clientSecret: 's', code: 'c', tokenDir },
      refuse,
    ).catch((e: Error) => e);

    // setup-strava reports this class itself and lets any other error through.
    expect(err).toBeInstanceOf(StravaTokenExchangeError);
    expect((err as Error).message).toBe(`Token exchange failed: HTTP 401\n${'x'.repeat(200)}`);
    expect(existsSync(tokenDir)).toBe(false);
  });

  it('lets a network error through as it is, not as a refused exchange', async () => {
    const offline = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;

    const err = await exchangeStravaCode(
      { clientId: '1', clientSecret: 's', code: 'c', tokenDir: join(tmpdir(), 'unused') },
      offline,
    ).catch((e: Error) => e);

    expect(err).toBeInstanceOf(TypeError);
    expect(err).not.toBeInstanceOf(StravaTokenExchangeError);
  });
});
