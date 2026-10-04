import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, normalize } from 'node:path';
import { loadYamlConfig } from '../../src/config/load.js';

/**
 * F-11: a relative token_dir is taken from the directory config.yaml is in,
 * never from the working directory. The config here lives in a temp
 * directory, so it is never the working directory of the test run.
 */
describe('relative token_dir resolves from the config directory (F-11)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bss-token-dirs-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function load(exporters: string) {
    const path = join(dir, 'config.yaml');
    writeFileSync(
      path,
      `
version: 1
users:
  - name: Alice
    slug: alice
    height: 168
    birth_date: "1990-06-15"
    gender: female
    is_athlete: false
    weight_range: { min: 50, max: 70 }
    exporters:
${exporters}
`,
    );
    return loadYamlConfig(path);
  }

  function errorOf(fn: () => unknown): string {
    try {
      fn();
    } catch (err) {
      return (err as Error).message;
    }
    return '';
  }

  it('makes Garmin and Strava token_dir absolute against the config directory', () => {
    const config = load(`
      - type: garmin
        email: a@example.com
        password: p
        token_dir: ./garmin-tokens/alice
      - type: strava
        client_id: "1"
        client_secret: s
        token_dir: strava-tokens/alice
`);
    const [garmin, strava] = config.users[0].exporters!;
    expect(garmin.token_dir).toBe(join(dir, 'garmin-tokens', 'alice'));
    expect(strava.token_dir).toBe(join(dir, 'strava-tokens', 'alice'));
  });

  it('gives a Strava entry without token_dir its default next to the config', () => {
    const config = load(`
      - type: strava
        client_id: "1"
        client_secret: s
`);
    expect(config.users[0].exporters![0].token_dir).toBe(join(dir, 'strava-tokens'));
  });

  it('leaves absolute and ~ paths pointing where they did, and Garmin without one unset', () => {
    const abs = join(dir, 'elsewhere');
    const config = load(`
      - type: garmin
        email: a@example.com
        password: p
        token_dir: ${JSON.stringify(abs)}
      - type: strava
        client_id: "1"
        client_secret: s
        token_dir: ~/strava-alice
      - type: garmin
        email: b@example.com
        password: p
`);
    const [garmin, strava, garminDefault] = config.users[0].exporters!;
    expect(garmin.token_dir).toBe(abs);
    expect(normalize(String(strava.token_dir))).toBe(join(homedir(), 'strava-alice'));
    expect(garminDefault.token_dir).toBeUndefined();
  });

  // The collision check compared paths resolved from the working directory,
  // so an absolute path and a relative one naming the same directory next to
  // config.yaml were two directories to it, and two accounts shared a token.
  it('sees an absolute and a relative token_dir naming the same directory as a collision', () => {
    const message = errorOf(() =>
      load(`
      - type: garmin
        email: a@example.com
        password: p
        token_dir: ${JSON.stringify(join(dir, 'garmin-tokens'))}
      - type: garmin
        email: b@example.com
        password: p
        token_dir: ./garmin-tokens
`),
    );
    expect(message).toContain('use the same token directory');
  });

  it('does not report two different directories as a collision', () => {
    const message = errorOf(() =>
      load(`
      - type: garmin
        email: a@example.com
        password: p
        token_dir: ${JSON.stringify(join(process.cwd(), 'garmin-tokens'))}
      - type: garmin
        email: b@example.com
        password: p
        token_dir: ./garmin-tokens
`),
    );
    expect(message).toBe('');
  });
});
