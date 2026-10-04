import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  BACKOFF_KEY,
  LAST_KNOWN_KEY,
  VERSION_CACHE_KEY,
  getLatestVersion,
} from '../worker/src/version.js';
import type { FetchLike, VersionStore } from '../worker/src/version.js';
import {
  MAX_VERSIONS_PER_DAY,
  addHit,
  aggregate,
  emptyStats,
  parseUserAgent,
} from '../worker/src/stats.js';
import { mayRecordHit } from '../worker/src/rate-limit.js';
import type { StatsLimiter } from '../worker/src/rate-limit.js';

/** In-memory KV with switchable failures; TTLs are recorded, not enforced. */
class FakeKv implements VersionStore {
  data = new Map<string, string>();
  ttl = new Map<string, number | undefined>();
  failPut = false;
  failGet = false;

  async get(key: string): Promise<string | null> {
    if (this.failGet) throw new Error('KV read limit');
    return this.data.get(key) ?? null;
  }

  async put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
    if (this.failPut) throw new Error('KV write limit');
    this.data.set(key, value);
    this.ttl.set(key, options?.expirationTtl);
  }
}

function github(tag: string): FetchLike {
  return vi.fn(async () => new Response(JSON.stringify({ tag_name: tag }), { status: 200 }));
}

const rateLimited: FetchLike = vi.fn(
  async () => new Response('{"message":"API rate limit exceeded"}', { status: 403 }),
);

describe('worker /version', () => {
  it('returns the version GitHub reported even when caching it fails', async () => {
    const kv = new FakeKv();
    kv.failPut = true;
    expect(await getLatestVersion(kv, github('v1.30.0'))).toEqual({
      version: '1.30.0',
      fresh: true,
    });
  });

  it('still answers when KV reads fail', async () => {
    const kv = new FakeKv();
    kv.failGet = true;
    expect((await getLatestVersion(kv, github('v1.30.0'))).version).toBe('1.30.0');
  });

  it('caches the answer for an hour and remembers it as the last known version', async () => {
    const kv = new FakeKv();
    await getLatestVersion(kv, github('v1.30.0'));
    expect(kv.data.get(VERSION_CACHE_KEY)).toBe('1.30.0');
    expect(kv.ttl.get(VERSION_CACHE_KEY)).toBe(3600);
    expect(kv.data.get(LAST_KNOWN_KEY)).toBe('1.30.0');
    expect(kv.ttl.get(LAST_KNOWN_KEY)).toBeUndefined();
  });

  it('falls back to the last known version when GitHub refuses, never to 0.0.0', async () => {
    const kv = new FakeKv();
    kv.data.set(LAST_KNOWN_KEY, '1.29.0');
    expect(await getLatestVersion(kv, rateLimited)).toEqual({ version: '1.29.0', fresh: false });
  });

  it('has no answer at all, rather than a wrong one, when nothing was ever confirmed', async () => {
    expect(await getLatestVersion(new FakeKv(), rateLimited)).toEqual({
      version: null,
      fresh: false,
    });
  });

  it('backs off after a failure instead of calling GitHub on every request', async () => {
    const kv = new FakeKv();
    kv.data.set(LAST_KNOWN_KEY, '1.29.0');
    await getLatestVersion(kv, rateLimited);
    expect(kv.ttl.get(BACKOFF_KEY)).toBeGreaterThanOrEqual(60);

    const fetchFn = github('v1.30.0');
    expect((await getLatestVersion(kv, fetchFn)).version).toBe('1.29.0');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('rejects a release tag that is not a version', async () => {
    expect((await getLatestVersion(new FakeKv(), github('nightly'))).version).toBeNull();
  });
});

describe('worker stats', () => {
  it('parses the app User-Agent', () => {
    expect(parseUserAgent('ble-scale-sync/1.30.0 (linux; arm64)')).toEqual({
      version: '1.30.0',
      os: 'linux',
      arch: 'arm64',
    });
    expect(parseUserAgent('curl/8.0')).toBeNull();
  });

  it('counts a version the app cannot report as other', () => {
    for (const v of ['1.2.3.4', '12345.0.0', '1..', '99999999999999999999']) {
      expect(parseUserAgent(`ble-scale-sync/${v} (linux; x64)`)?.version, v).toBe('other');
    }
  });

  it('keeps a bounded number of version rows per day', () => {
    const day = emptyStats();
    for (let i = 0; i < MAX_VERSIONS_PER_DAY + 50; i++) {
      addHit(day, { version: `1.${i}.0`, os: 'linux', arch: 'x64' });
    }
    expect(Object.keys(day.versions).length).toBeLessThanOrEqual(MAX_VERSIONS_PER_DAY + 1);
    expect(day.versions.other).toBe(50);
    expect(day.total).toBe(MAX_VERSIONS_PER_DAY + 50);
  });

  it('still counts a version already seen that day once the cap is reached', () => {
    const day = emptyStats();
    for (let i = 0; i < MAX_VERSIONS_PER_DAY; i++) {
      addHit(day, { version: `1.${i}.0`, os: 'linux', arch: 'x64' });
    }
    addHit(day, { version: '1.0.0', os: 'linux', arch: 'x64' });
    expect(day.versions['1.0.0']).toBe(2);
  });

  it('aggregates the newest N days of one 30-day read', () => {
    const hit = (v: string) => addHit(emptyStats(), { version: v, os: 'linux', arch: 'x64' });
    const daily = [hit('1.30.0'), null, hit('1.29.0'), ...Array(27).fill(null)];
    expect(aggregate(daily, 1)).toMatchObject({ uniqueDays: 1, totalChecks: 1 });
    expect(aggregate(daily, 7)).toMatchObject({
      period: '7d',
      uniqueDays: 2,
      totalChecks: 2,
      versions: { '1.30.0': 1, '1.29.0': 1 },
    });
  });
});

/** Fixed-window limiter per key, like the binding's `simple` mode in one location. */
function fakeLimiter(limit: number): StatsLimiter & { keys: string[] } {
  const counts = new Map<string, number>();
  const keys: string[] = [];
  return {
    keys,
    async limit({ key }) {
      keys.push(key);
      const n = (counts.get(key) ?? 0) + 1;
      counts.set(key, n);
      return { success: n <= limit };
    },
  };
}

describe('worker stats rate limit', () => {
  it('stops counting one address past the limit, and keys on the address', async () => {
    const limiter = fakeLimiter(5);
    const verdicts = [];
    for (let i = 0; i < 8; i++) verdicts.push(await mayRecordHit(limiter, '203.0.113.7'));
    expect(verdicts).toEqual([true, true, true, true, true, false, false, false]);
    // Another address has its own budget.
    expect(await mayRecordHit(limiter, '198.51.100.1')).toBe(true);
    expect(new Set(limiter.keys).size).toBe(2);
  });

  it('skips the write when the limiter itself fails', async () => {
    const broken: StatsLimiter = {
      limit: async () => {
        throw new Error('limiter unavailable');
      },
    };
    expect(await mayRecordHit(broken, '203.0.113.7')).toBe(false);
  });

  it('counts as before when no limiter is bound', async () => {
    expect(await mayRecordHit(undefined, '203.0.113.7')).toBe(true);
  });

  it('is what GET /version records through, with the binding declared in wrangler.toml', () => {
    const lf = (s: string): string => s.replace(/\r\n/g, '\n');
    const index = lf(readFileSync('worker/src/index.ts', 'utf8'));
    const toml = lf(readFileSync('worker/wrangler.toml', 'utf8'));
    expect(index).toMatch(/mayRecordHit\(env\.STATS_LIMITER, clientIp\)/);
    expect(index).toMatch(/request\.headers\.get\('CF-Connecting-IP'\)/);
    // The only recordHit call is the one behind the limiter.
    expect(index.match(/recordHit\(env\.STATS/g)).toHaveLength(1);
    expect(index).toMatch(/allowed \? recordHit\(env\.STATS, client\)/);
    expect(toml).toMatch(/\[\[ratelimits\]\]\nname = "STATS_LIMITER"\nnamespace_id = "\d+"/);
    expect(toml).toMatch(/\[ratelimits\.simple\]\nlimit = \d+\nperiod = (10|60)\n/);
  });
});
