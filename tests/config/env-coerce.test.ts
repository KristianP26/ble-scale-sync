import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadYamlConfig } from '../../src/config/load.js';

/**
 * G-21: a `${VAR}` reference resolves to a string before the schema sees it,
 * so `port: ${ESPHOME_PORT}` failed with "expected number, received string".
 * A field whose whole value is one reference is now converted when the schema
 * wants a number or a boolean.
 */
describe('${VAR} in numeric and boolean config fields (G-21)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bss-env-coerce-'));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  function load(yaml: string) {
    const path = join(dir, 'config.yaml');
    writeFileSync(path, yaml);
    return loadYamlConfig(path);
  }

  /** Load, failing on an assertion (not a throw) when the config is refused. */
  function loadValid(yaml: string) {
    let error: string | undefined;
    let config: ReturnType<typeof loadYamlConfig> | undefined;
    try {
      config = load(yaml);
    } catch (err) {
      error = (err as Error).message;
    }
    expect(error).toBeUndefined();
    return config!;
  }

  const yaml = (fields: {
    port?: string;
    athlete?: string;
    height?: string;
    debug?: string;
    sessionTimeout?: string;
  }) => `
version: 1
ble:
  handler: esphome-proxy
  session_timeout_sec: ${fields.sessionTimeout ?? '60'}
  esphome_proxy:
    host: proxy.local
    port: ${fields.port ?? '6053'}
users:
  - name: Test
    slug: test
    height: ${fields.height ?? '183'}
    birth_date: "1990-06-15"
    gender: male
    is_athlete: ${fields.athlete ?? 'false'}
    weight_range: { min: 70, max: 100 }
runtime:
  debug: ${fields.debug ?? 'false'}
`;

  it('converts a whole ${VAR} reference in number fields', () => {
    vi.stubEnv('BSS_T_PORT', '6054');
    vi.stubEnv('BSS_T_HEIGHT', '181.5');
    vi.stubEnv('BSS_T_TIMEOUT', ' 45 ');
    const config = loadValid(
      yaml({
        port: '${BSS_T_PORT}',
        height: '"${BSS_T_HEIGHT}"',
        sessionTimeout: '${BSS_T_TIMEOUT}',
      }),
    );
    expect(config.ble?.esphome_proxy?.port).toBe(6054);
    expect(config.users[0].height).toBe(181.5);
    expect(config.ble?.session_timeout_sec).toBe(45);
  });

  it('converts boolean words the env overrides accept', () => {
    const cases: Array<[string, boolean]> = [
      ['true', true],
      ['YES', true],
      ['on', true],
      ['1', true],
      ['false', false],
      ['No', false],
      ['off', false],
      ['0', false],
    ];
    for (const [word, expected] of cases) {
      vi.stubEnv('BSS_T_ATHLETE', word);
      vi.stubEnv('BSS_T_DEBUG', word);
      const config = loadValid(yaml({ athlete: '${BSS_T_ATHLETE}', debug: '${BSS_T_DEBUG}' }));
      expect(config.users[0].is_athlete, word).toBe(expected);
      expect(config.runtime?.debug, word).toBe(expected);
    }
  });

  it('names the field and the variable, never the value, when it does not convert', () => {
    vi.stubEnv('BSS_T_PORT', 'hunter2-secret');
    vi.stubEnv('BSS_T_ATHLETE', 'maybe-secret');
    let message = '';
    try {
      load(yaml({ port: '${BSS_T_PORT}', athlete: '${BSS_T_ATHLETE}' }));
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('ble.esphome_proxy.port');
    expect(message).toContain("'BSS_T_PORT'");
    expect(message).toContain('not a number');
    expect(message).toContain('users.0.is_athlete');
    expect(message).toContain("'BSS_T_ATHLETE'");
    expect(message).toMatch(/true\/false, yes\/no, on\/off, 1\/0/);
    expect(message).not.toContain('hunter2-secret');
    expect(message).not.toContain('maybe-secret');
  });

  it('does not convert a reference embedded in a longer string', () => {
    vi.stubEnv('BSS_T_PORT', '6054');
    expect(() => load(yaml({ port: '"60${BSS_T_PORT}"' }))).toThrow(/expected number/);
  });

  it('does not convert a literal quoted string that is not a reference', () => {
    expect(() => load(yaml({ port: '"6053"' }))).toThrow(/expected number/);
  });

  it('leaves a reference in a string field a string', () => {
    vi.stubEnv('BSS_T_NAME', '1');
    const config = loadValid(yaml({}).replace('name: Test', 'name: ${BSS_T_NAME}'));
    expect(config.users[0].name).toBe('1');
  });
});
