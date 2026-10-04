import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import { UserSchema } from '../src/config/schema.js';
import { isValidScaleId } from '../src/ble/scale-id.js';

/**
 * Guards for the Home Assistant add-on wiring. Nothing executes run.sh as a
 * whole in CI (it needs /data, the Supervisor and a Debian base), so the
 * add-on manifest and the script are read as text, the config helper
 * (addon-config.mjs) is run on its own, and a few self-contained parts of
 * run.sh are run in a shell with their paths pointed at a temp directory.
 *
 * Line endings are normalized: Windows checkouts have core.autocrlf on.
 */
const lf = (s: string): string => s.replace(/\r\n/g, '\n');

const ADDON_CONFIG = resolve('ble-scale-sync-addon/addon-config.mjs');
const ADDON_DOCKERFILE = lf(readFileSync('ble-scale-sync-addon/Dockerfile', 'utf8'));

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'addon-run-sh-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const RUN_SH = lf(readFileSync('ble-scale-sync-addon/run.sh', 'utf8'));
const MANIFEST = parse(lf(readFileSync('ble-scale-sync-addon/config.yaml', 'utf8'))) as {
  services?: string[];
  options: Record<string, unknown>;
};

/** The Supervisor's own validator for this key (supervisor/apps/validate.py, RE_SERVICE). */
const RE_SERVICE = /^(?<service>mqtt|mysql):(?<rights>provide|want|need)$/;

/** The custom_config branch of run.sh, up to the `else` that starts option generation. */
function customConfigBranch(): string {
  const start = RUN_SH.indexOf('if [ "$CUSTOM_CONFIG" = "true" ]; then');
  const end = RUN_SH.indexOf('\nelse\n', start);
  expect(start, 'custom_config branch not found in run.sh').toBeGreaterThan(-1);
  expect(end, 'end of the custom_config branch not found in run.sh').toBeGreaterThan(start);
  return RUN_SH.slice(start, end);
}

describe('add-on manifest: Supervisor services', () => {
  it('declares every service run.sh reads from the Supervisor API', () => {
    // The Supervisor answers 403 to GET /services/<name> unless the add-on
    // declares <name> under `services:`. The declaration was missing, so MQTT
    // auto-detection failed on every install.
    const used = [...RUN_SH.matchAll(/http:\/\/supervisor\/services\/(\w+)/g)].map((m) => m[1]);
    expect(used).toContain('mqtt');
    const declared = new Map(
      (MANIFEST.services ?? []).map((entry) => {
        const m = RE_SERVICE.exec(entry);
        expect(
          m,
          `services entry '${entry}' does not match the Supervisor's format`,
        ).not.toBeNull();
        return [m!.groups!.service, m!.groups!.rights] as const;
      }),
    );
    for (const service of used) {
      expect(declared.has(service), `config.yaml must declare services: ${service}:want`).toBe(
        true,
      );
    }
  });

  it('asks for MQTT as optional, since a Garmin-only install has no broker', () => {
    expect(MANIFEST.services).toContain('mqtt:want');
  });

  it('tells a Supervisor refusal apart from a missing broker', () => {
    // Without the status code a 403 and "Mosquitto not installed" produced the
    // same log line, which is how the missing declaration went unnoticed.
    expect(RUN_SH).toMatch(
      /curl -s -w '\\n%\{http_code\}'[^\n]*\n\s*http:\/\/supervisor\/services\/mqtt/,
    );
    expect(RUN_SH).toMatch(/^\s*403\)/m);
  });
});

describe('add-on option proxy_liveness_timeout_min', () => {
  it('is an add-on option', () => {
    expect(MANIFEST.options).toHaveProperty('proxy_liveness_timeout_min', 30);
  });

  it('is read in custom_config mode, the only mode that can run a proxy transport', () => {
    // The liveness check only runs on the proxy transports, and the generated
    // config never selects one. Read only in the generated branch, the option
    // could not have any effect at all.
    expect(customConfigBranch()).toMatch(/opt_int proxy_liveness_timeout_min 30/);
  });

  it('is applied through addon-config.mjs, not through a YAML 1.1 round trip', () => {
    expect(customConfigBranch()).toMatch(
      /node "\$ADDON_CONFIG" proxy-liveness "\$FRESH" "\$PROXY_LIVENESS_MIN"/,
    );
  });

  describe('addon-config.mjs proxy-liveness', () => {
    function run(fileContent: string, value: string): { status: number | null; out: unknown } {
      return withTempDir((dir) => {
        const file = join(dir, 'config.yaml');
        writeFileSync(file, fileContent);
        const res = spawnSync(process.execPath, [ADDON_CONFIG, 'proxy-liveness', file, value], {
          encoding: 'utf8',
        });
        return { status: res.status, out: parse(readFileSync(file, 'utf8')) };
      });
    }

    it('adds the option when the file does not set it', () => {
      const r = run('version: 1\nble:\n  handler: esphome-proxy\n', '0');
      expect(r.status).toBe(0);
      expect(r.out).toMatchObject({
        ble: { handler: 'esphome-proxy', proxy_liveness_timeout_min: 0 },
      });
    });

    it('creates the ble section when there is none', () => {
      expect(run('version: 1\nble: null\n', '90')).toMatchObject({
        status: 0,
        out: { ble: { proxy_liveness_timeout_min: 90 } },
      });
      expect(run('version: 1\n', '90')).toMatchObject({
        status: 0,
        out: { ble: { proxy_liveness_timeout_min: 90 } },
      });
    });

    it('leaves a value set in the file alone', () => {
      const r = run('version: 1\nble:\n  proxy_liveness_timeout_min: 45\n', '0');
      expect(r.status).toBe(3);
      expect(r.out).toMatchObject({ ble: { proxy_liveness_timeout_min: 45 } });
    });

    it('rejects a value outside the schema range', () => {
      const r = run('version: 1\n', '5000');
      expect(r.status).toBe(4);
      expect(r.out).toEqual({ version: 1 });
    });

    it('does not change the type of any other value in the file', () => {
      const r = run(TYPE_TRAPS, '90');
      expect(r.status).toBe(0);
      expect(r.out).toEqual({
        ...(parse(TYPE_TRAPS) as Record<string, unknown>),
        ble: { scale_mac: '12:34:56:12:34:56', proxy_liveness_timeout_min: 90 },
      });
    });
  });
});

/**
 * Values a YAML 1.1 reader (PyYAML) and the app's YAML 1.2 reader disagree
 * on. A PyYAML load and dump of this file made the app read `scale_mac` as
 * 9783981296, `slug` as false, `beurer_pin` as 83 and `password` as 100000.
 */
const TYPE_TRAPS = [
  'version: 1',
  'ble:',
  '  scale_mac: 12:34:56:12:34:56',
  'users:',
  '  - name: "No"',
  '    slug: no',
  '    beurer_pin: 0123',
  '    last_known_weight: null',
  'global_exporters:',
  '  - type: mqtt',
  '    password: "1e5"',
  '',
].join('\n');

describe('addon-config.mjs merge-weights', () => {
  function merge(fresh: string, persistent: string | null): { status: number | null; out: string } {
    return withTempDir((dir) => {
      const freshPath = join(dir, 'fresh.yaml');
      const persistentPath = join(dir, 'config.yaml');
      writeFileSync(freshPath, fresh);
      if (persistent !== null) writeFileSync(persistentPath, persistent);
      const res = spawnSync(
        process.execPath,
        [ADDON_CONFIG, 'merge-weights', freshPath, persistentPath],
        { encoding: 'utf8' },
      );
      return {
        status: res.status,
        out: existsSync(persistentPath) ? readFileSync(persistentPath, 'utf8') : '',
      };
    });
  }

  it('is what run.sh merges with, and what the add-on image ships', () => {
    expect(RUN_SH).toMatch(/node "\$ADDON_CONFIG" merge-weights "\$FRESH" "\$CONFIG"/);
    expect(RUN_SH).toMatch(/^ADDON_CONFIG="\/app\/addon-config\.mjs"$/m);
    expect(ADDON_DOCKERFILE).toMatch(/^COPY addon-config\.mjs \/app\/addon-config\.mjs$/m);
    // No config edit may go through PyYAML again.
    expect(RUN_SH).not.toMatch(/safe_dump|merge_last_weights\.py/);
  });

  it('carries last_known_weight over without changing the type of any other value', () => {
    const r = merge(TYPE_TRAPS, 'users:\n  - slug: "no"\n    last_known_weight: 81.4\n');
    expect(r.status).toBe(0);
    const expected = parse(TYPE_TRAPS) as { users: Record<string, unknown>[] };
    expected.users[0].last_known_weight = 81.4;
    expect(parse(r.out)).toEqual(expected);
  });

  it('writes the fresh file through byte for byte when there is nothing to merge', () => {
    expect(merge(TYPE_TRAPS, null)).toEqual({ status: 0, out: TYPE_TRAPS });
    expect(merge(TYPE_TRAPS, 'users:\n  - slug: other\n    last_known_weight: 70\n')).toEqual({
      status: 0,
      out: TYPE_TRAPS,
    });
  });

  it('matches a numeric-looking slug whether or not it was quoted', () => {
    // Before slugs were quoted, `slug: 123` was persisted as a number.
    const fresh = 'users:\n  - name: "123"\n    slug: "123"\n    last_known_weight: null\n';
    const r = merge(fresh, 'users:\n  - slug: 123\n    last_known_weight: 64.2\n');
    expect(parse(r.out)).toEqual({
      users: [{ name: '123', slug: '123', last_known_weight: 64.2 }],
    });
  });

  it('fails on a fresh file that is not YAML, so run.sh falls back to a copy', () => {
    expect(merge('users: [unclosed\n', null).status).toBe(1);
  });
});

describe('generated config: user slug', () => {
  it('is quoted, so a name like "No" or "2024" stays a string slug', () => {
    expect(RUN_SH).toMatch(/^ {4}slug: "\$USER_SLUG"$/m);
  });
});

/**
 * The option checks in run.sh mirror the app's schema. They run here under
 * dash when it is installed (the add-on's /bin/sh), else under sh, and every
 * verdict is compared with the schema's own.
 */
const SHELL = ['dash', 'sh'].find(
  (bin) => spawnSync(bin, ['-c', 'exit 0'], { encoding: 'utf8' }).status === 0,
);
const GNU_DATE =
  SHELL !== undefined &&
  spawnSync(SHELL, ['-c', 'date -u -d 2024-02-29 +%F'], { encoding: 'utf8' }).stdout.trim() ===
    '2024-02-29';

function optionChecks(): string {
  const m = /# >>> option checks\n([\s\S]*?)# <<< option checks/.exec(RUN_SH);
  expect(m, 'option checks block not found in run.sh').not.toBeNull();
  return m![1];
}

/** Exit status of `<fn> <args...>` with the option checks defined. */
function check(fn: string, ...args: string[]): boolean {
  const quoted = args.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(' ');
  const res = spawnSync(SHELL!, ['-c', `${optionChecks()}\n${fn} ${quoted}`], {
    encoding: 'utf8',
  });
  expect(res.stderr).toBe('');
  return res.status === 0;
}

describe.skipIf(!SHELL)('run.sh option checks agree with the config schema', () => {
  it.skipIf(!GNU_DATE)('birth date', () => {
    const nextYear = `${new Date().getUTCFullYear() + 1}-01-01`;
    for (const value of [
      '1990-06-15',
      '2024-02-29',
      '2023-02-29',
      '2024-02-31',
      '2024-13-01',
      '1990-6-15',
      '0050-01-01',
      '1899-12-31',
      '0099-12-31',
      '0150-01-01',
      '1900-01-01',
      nextYear,
      '',
    ]) {
      const schema = UserSchema.shape.birth_date.safeParse(value).success;
      expect(check('valid_birth_date', value), value).toBe(schema);
    }
  });

  it('weight range', () => {
    for (const [min, max] of [
      ['40', '150'],
      ['80', '80'],
      ['90', '80'],
      ['0', '80'],
      ['10', '500'],
    ]) {
      const schema = UserSchema.shape.weight_range.safeParse({
        min: Number(min),
        max: Number(max),
      }).success;
      expect(check('valid_weight_range', min, max), `${min}..${max}`).toBe(schema);
    }
    expect(check('valid_weight_range', 'x', '80')).toBe(false);
    expect(check('valid_weight_range', '', '80')).toBe(false);
  });

  it('scale_mac', () => {
    for (const value of [
      'AA:BB:CC:DD:EE:FF',
      'aa:bb:cc:dd:ee:ff',
      'AA:BB:CC:DD:EE',
      'AA-BB-CC-DD-EE-FF',
      'AA:BB:CC:DD:EE:FG',
      '360c96baf290475b14ce7c28aa3b8e81',
      '360c96ba-f290-475b-14ce-7c28aa3b8e81',
      'not a mac',
    ]) {
      expect(check('valid_scale_id', value), value).toBe(isValidScaleId(value));
    }
  });

  it('are applied before the config is written', () => {
    const generate = RUN_SH.indexOf('cat > "$FRESH" <<YAML');
    for (const call of [
      'valid_birth_date "$USER_BIRTH_DATE"',
      'valid_weight_range "$USER_WEIGHT_MIN" "$USER_WEIGHT_MAX"',
      'valid_scale_id "$SCALE_MAC"',
    ]) {
      const at = RUN_SH.indexOf(call);
      expect(at, call).toBeGreaterThan(-1);
      expect(at, call).toBeLessThan(generate);
    }
    // force_scale_adapter is dropped when scale_mac is missing; a scale_mac
    // dropped as invalid must reach that check too.
    expect(RUN_SH.indexOf('valid_scale_id "$SCALE_MAC"')).toBeLessThan(
      RUN_SH.indexOf('force_scale_adapter needs scale_mac'),
    );
  });

  it('give an empty user name the default before the slug is derived', () => {
    const fallback = RUN_SH.indexOf('USER_NAME="Default"');
    expect(fallback).toBeGreaterThan(-1);
    expect(fallback).toBeLessThan(RUN_SH.indexOf('USER_SLUG=$('));
  });
});

/**
 * The Garmin token block of run.sh, run on its own with the /data and /share
 * paths pointed at a temp directory.
 */
describe.skipIf(!SHELL)('run.sh Garmin token import', () => {
  function block(dir: string): string {
    const start = RUN_SH.indexOf('# ── Garmin token bootstrap');
    const end = RUN_SH.indexOf('# ── Reset Bluetooth adapter');
    expect(start, 'Garmin block not found').toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return RUN_SH.slice(start, end)
      .replaceAll('/data/garmin-tokens', `${dir}/data`)
      .replaceAll('/share/ble-scale-sync/garmin-tokens', `${dir}/share`);
  }

  function runBlock(vars: Record<string, string>, shareToken: boolean) {
    return withTempDir((raw) => {
      const dir = raw.replace(/\\/g, '/');
      if (shareToken) {
        mkdirSync(`${dir}/share`, { recursive: true });
        writeFileSync(`${dir}/share/garmin_tokens.json`, '{"token":"share"}');
      }
      const preamble = [
        'log() { echo "[ble-scale-sync] $*"; }',
        ...Object.entries(vars).map(([k, v]) => `${k}='${v}'`),
      ].join('\n');
      const res = spawnSync(
        SHELL!,
        ['-c', `${preamble}\n${block(dir)}\nsh -c 'echo "TOKEN_DIR=$TOKEN_DIR"'`],
        { encoding: 'utf8' },
      );
      const imported = `${dir}/data/garmin_tokens.json`;
      return {
        status: res.status,
        stdout: res.stdout.replaceAll(dir, '<tmp>'),
        token: existsSync(imported) ? readFileSync(imported, 'utf8') : null,
      };
    });
  }

  const CUSTOM = { CUSTOM_CONFIG: 'true', GARMIN_ENABLED: 'false', CONFIG: '/nonexistent' };

  it('imports a token pre-seeded in /share in custom config mode', () => {
    const r = runBlock(CUSTOM, true);
    expect(r.status).toBe(0);
    expect(r.token).toBe('{"token":"share"}');
  });

  it('points garmin entries without token_dir at the persistent directory', () => {
    // The Python default otherwise is ~/.garmin_tokens, wiped on restart.
    const r = runBlock(CUSTOM, true);
    expect(r.stdout).toContain('TOKEN_DIR=<tmp>/data');
  });

  it('does nothing in custom config mode without a token in /share', () => {
    const r = runBlock(CUSTOM, false);
    expect(r.status).toBe(0);
    expect(r.token).toBeNull();
    expect(r.stdout).not.toMatch(/authenticat/i);
  });

  it('does not import in the generated mode while Garmin is off', () => {
    const r = runBlock({ CUSTOM_CONFIG: 'false', GARMIN_ENABLED: 'false' }, true);
    expect(r.token).toBeNull();
  });
});
