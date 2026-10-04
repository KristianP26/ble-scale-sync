import { describe, it, expect } from 'vitest';
import { join, resolve } from 'node:path';
import { selectStravaEntry, stravaTokenDir } from '../../src/exporters/strava-select.js';
import type { AppConfig } from '../../src/config/schema.js';

const strava = (dir: string) => ({
  type: 'strava',
  client_id: '1',
  client_secret: 's',
  token_dir: dir,
});

function config(users: { name: string; slug: string; exporters?: unknown[] }[]): AppConfig {
  return { users } as unknown as AppConfig;
}

describe('selectStravaEntry', () => {
  // setup-strava took the first strava entry in the file, so a second user's
  // entry could never be authorized.
  const two = config([
    { name: 'Alice', slug: 'alice', exporters: [strava('./strava-tokens/alice')] },
    { name: 'Bob', slug: 'bob', exporters: [strava('./strava-tokens/bob')] },
  ]);

  it("authorizes the named user's entry, not the first one", () => {
    const r = selectStravaEntry(two, 'bob');
    expect(r.ok && r.entry.token_dir).toBe('./strava-tokens/bob');
  });

  it('matches the display name too, case-insensitively', () => {
    const r = selectStravaEntry(two, 'BOB');
    expect(r.ok && r.owner).toBe('Bob');
  });

  it('refuses to guess between several entries', () => {
    const r = selectStravaEntry(two);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain('--user');
  });

  it('keeps working without --user when there is one entry', () => {
    const r = selectStravaEntry(
      config([{ name: 'Alice', slug: 'alice', exporters: [strava('./t')] }]),
    );
    expect(r.ok && r.entry.token_dir).toBe('./t');
  });

  it('reports an unknown user', () => {
    expect(selectStravaEntry(two, 'carol').ok).toBe(false);
  });
});

describe('stravaTokenDir (F-11)', () => {
  const cfgDir = resolve('/srv', 'scale');
  const entry = (token_dir?: string) => ({
    type: 'strava' as const,
    client_id: '1',
    client_secret: 's',
    token_dir,
  });

  it('resolves a relative token_dir, and the default, from the config directory', () => {
    expect(stravaTokenDir(entry('./st/alice'), cfgDir)).toBe(join(cfgDir, 'st', 'alice'));
    expect(stravaTokenDir(entry(), cfgDir)).toBe(join(cfgDir, 'strava-tokens'));
  });
});
