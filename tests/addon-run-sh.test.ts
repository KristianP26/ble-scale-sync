import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
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

/**
 * Parts of run.sh run here under dash when it is installed (the add-on's
 * /bin/sh), else under sh.
 */
const SHELL = ['dash', 'sh'].find(
  (bin) => spawnSync(bin, ['-c', 'exit 0'], { encoding: 'utf8' }).status === 0,
);

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
      /curl -s -w '\\n%\{http_code\}'(?:[^\n]*\\\n)*[^\n]*http:\/\/supervisor\/services\/mqtt/,
    );
    expect(RUN_SH).toMatch(/^\s*403\)/m);
  });
});

/**
 * Shell commands in run.sh, comments dropped and backslash continuations
 * joined, so a command split over several lines is one string.
 */
function shellCommands(): string[] {
  return RUN_SH.replace(/\\\n/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
}

describe('run.sh external calls are bounded', () => {
  // Everything here runs before `exec node`, so before the app writes its
  // health heartbeat: a call that never returns holds the add-on forever.
  it('runs every btmgmt call under timeout', () => {
    const calls = shellCommands()
      .flatMap((cmd) => [...cmd.matchAll(/(\S+\s+\S+\s+)?btmgmt --index/g)])
      .map((m) => m[0]);
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call, call).toMatch(/^timeout \d+ btmgmt/);
  });

  it('gives every curl call a time limit', () => {
    const calls = shellCommands().filter((cmd) => /\bcurl\s/.test(cmd));
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call, call).toMatch(/--max-time \d+/);
  });
});

const TRANSLATIONS = parse(
  lf(readFileSync('ble-scale-sync-addon/translations/en.yaml', 'utf8')),
) as { configuration: Record<string, unknown> };

const JQ = spawnSync('jq', ['--version'], { encoding: 'utf8' }).status === 0;

describe('add-on options that default to true', () => {
  const defaultTrue = Object.entries(MANIFEST.options)
    .filter(([, value]) => value === true)
    .map(([key]) => key);

  it('are read with opt_bool_default_true, never as opt_bool or opt', () => {
    // opt_bool reads a missing key as false, so for these options a missing
    // key turned a default of true into false.
    expect(defaultTrue.length).toBeGreaterThan(0);
    for (const key of defaultTrue) {
      expect(RUN_SH, key).toMatch(new RegExp(`opt_bool_default_true ${key}\\)`));
      expect(RUN_SH, key).not.toMatch(new RegExp(`\\$\\((opt|opt_bool) ${key}\\)`));
    }
  });

  describe.skipIf(!SHELL || !JQ)('opt_bool_default_true', () => {
    function read(options: unknown, key: string): string {
      return withTempDir((dir) => {
        const file = join(dir, 'options.json').replace(/\\/g, '/');
        writeFileSync(file, JSON.stringify(options));
        const m = /# >>> option readers\n([\s\S]*?)# <<< option readers/.exec(RUN_SH);
        expect(m, 'option readers block not found in run.sh').not.toBeNull();
        const res = spawnSync(
          SHELL!,
          ['-c', `OPTIONS='${file}'\n${m![1]}\nopt_bool_default_true ${key}`],
          { encoding: 'utf8' },
        );
        expect(res.stderr).toBe('');
        return res.stdout.trim();
      });
    }

    it('keeps the default for a missing or null key', () => {
      expect(read({}, 'mqtt_enabled')).toBe('true');
      expect(read({ mqtt_enabled: null }, 'mqtt_enabled')).toBe('true');
    });

    it('switches off only on an explicit false', () => {
      expect(read({ mqtt_enabled: false }, 'mqtt_enabled')).toBe('false');
      expect(read({ mqtt_enabled: true }, 'mqtt_enabled')).toBe('true');
    });

    it('answers exactly true or false, since the value is written unquoted', () => {
      expect(read({ mqtt_ha_discovery: 'no: [' }, 'mqtt_ha_discovery')).toBe('true');
    });
  });
});

describe('add-on option update_check', () => {
  it('is an add-on option, on by default', () => {
    expect(MANIFEST.options).toHaveProperty('update_check', true);
    expect(TRANSLATIONS.configuration).toHaveProperty('update_check');
  });

  it('is written from the option rather than hardcoded', () => {
    expect(RUN_SH).toMatch(/^update_check: \$UPDATE_CHECK$/m);
    expect(RUN_SH).not.toMatch(/^update_check: true$/m);
  });

  it('is named as ignored in custom config mode when it is turned off', () => {
    expect(customConfigBranch()).toMatch(/opt_bool_default_true update_check/);
  });
});

describe('add-on translations', () => {
  it('describe every option', () => {
    for (const key of Object.keys(MANIFEST.options)) {
      expect(TRANSLATIONS.configuration, key).toHaveProperty(key);
    }
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

// Each case spawns a shell, a dozen per test. That takes about 3 s on Windows
// alone and went past the default 5 s timeout under a full parallel run.
describe.skipIf(!SHELL)(
  'run.sh option checks agree with the config schema',
  { timeout: 30_000 },
  () => {
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
  },
);

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

  function runBlock(vars: Record<string, string>, shareToken: boolean, dataToken = false) {
    return withTempDir((raw) => {
      const dir = raw.replace(/\\/g, '/');
      if (dataToken) {
        // An older token already in use, so the /share copy is the newer one:
        // the case the old newer-wins rule imported.
        mkdirSync(`${dir}/data`, { recursive: true });
        writeFileSync(`${dir}/data/garmin_tokens.json`, '{"token":"data"}');
        const old = new Date(Date.now() - 86_400_000);
        utimesSync(`${dir}/data/garmin_tokens.json`, old, old);
      }
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

  // Review S-04: anything that can write to /share must not be able to swap
  // the token, and with it the Garmin account the measurements go to.
  const GENERATED = {
    CUSTOM_CONFIG: 'false',
    GARMIN_ENABLED: 'true',
    GARMIN_EMAIL: 'a@example.com',
    GARMIN_PASSWORD: 'x',
    CONFIG: '/nonexistent',
  };

  it('never replaces an existing token with a newer one from /share (generated mode)', () => {
    const r = runBlock(GENERATED, true, true);
    expect(r.status).toBe(0);
    expect(r.token).toBe('{"token":"data"}');
    expect(r.stdout).toMatch(/was NOT imported/);
    expect(r.stdout).not.toMatch(/IMPORTING/);
  });

  it('never replaces an existing token with a newer one from /share (custom config mode)', () => {
    const r = runBlock(CUSTOM, true, true);
    expect(r.status).toBe(0);
    expect(r.token).toBe('{"token":"data"}');
    expect(r.stdout).toMatch(/was NOT imported/);
  });

  it('says loudly when it does import a token', () => {
    for (const vars of [CUSTOM, GENERATED]) {
      const r = runBlock(vars, true);
      expect(r.token).toBe('{"token":"share"}');
      expect(r.stdout).toMatch(/IMPORTING a Garmin token/);
    }
  });
});

/**
 * The Strava token block of run.sh, run on its own with /app and /data pointed
 * at a temp directory. Git Bash's ln copies instead of linking unless told
 * otherwise, hence the MSYS setting; Linux ignores it.
 */
describe.skipIf(!SHELL)('run.sh Strava token directory', () => {
  function run(dir: string): { status: number | null; stdout: string } {
    const m = /# >>> strava token dir\n([\s\S]*?)# <<< strava token dir/.exec(RUN_SH);
    expect(m, 'strava token dir block not found in run.sh').not.toBeNull();
    const block = m![1]
      .replaceAll('/data/strava-tokens', `${dir}/data/strava-tokens`)
      .replaceAll('/app/strava-tokens', `${dir}/app/strava-tokens`);
    const script = [
      'set -e',
      'log() { echo "[ble-scale-sync] $*"; }',
      block,
      `sh -c 'echo "STRAVA_TOKEN_DIR=$STRAVA_TOKEN_DIR"'`,
    ].join('\n');
    const res = spawnSync(SHELL!, ['-c', script], {
      encoding: 'utf8',
      env: { ...process.env, MSYS: 'winsymlinks:nativestrict' },
    });
    return { status: res.status, stdout: res.stdout.replaceAll(dir, '<tmp>') };
  }

  it('makes the default ./strava-tokens of the app a persistent directory in /data', () => {
    withTempDir((raw) => {
      const dir = raw.replace(/\\/g, '/');
      mkdirSync(`${dir}/app`);
      const r = run(dir);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('STRAVA_TOKEN_DIR=<tmp>/data/strava-tokens');
      expect(lstatSync(`${dir}/app/strava-tokens`).isSymbolicLink()).toBe(true);
      // A token the app writes through its default path lands in /data.
      writeFileSync(`${dir}/app/strava-tokens/strava_tokens.json`, '{"t":1}');
      expect(readFileSync(`${dir}/data/strava-tokens/strava_tokens.json`, 'utf8')).toBe('{"t":1}');
      // A second start in the same container keeps the link.
      expect(run(dir).status).toBe(0);
      expect(lstatSync(`${dir}/app/strava-tokens`).isSymbolicLink()).toBe(true);
    });
  });

  it('leaves an existing directory alone and says what to set instead', () => {
    withTempDir((raw) => {
      const dir = raw.replace(/\\/g, '/');
      mkdirSync(`${dir}/app/strava-tokens`, { recursive: true });
      writeFileSync(`${dir}/app/strava-tokens/strava_tokens.json`, '{"t":1}');
      const r = run(dir);
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/token_dir: <tmp>\/data\/strava-tokens/);
      expect(readFileSync(`${dir}/app/strava-tokens/strava_tokens.json`, 'utf8')).toBe('{"t":1}');
    });
  });
});

/**
 * The restart loop at the end of run.sh (ADR D030), run with a stub in place
 * of the app. The stub counts its starts in a file and, on the start the test
 * picks, plays the Supervisor: it sends SIGTERM to the script.
 */
describe.skipIf(!SHELL)('run.sh restarts the app after it exits', () => {
  function supervisorBlock(): string {
    const m = /# >>> app supervisor\n([\s\S]*?)# <<< app supervisor/.exec(RUN_SH);
    expect(m, 'app supervisor block not found in run.sh').not.toBeNull();
    return m![1];
  }

  function run(stub: string, block: string) {
    return withTempDir((raw) => {
      const dir = raw.replace(/\\/g, '/');
      writeFileSync(`${dir}/stub.sh`, stub.replaceAll('$DIR', dir));
      const script = [
        'set -e',
        'log() { echo "[ble-scale-sync] $*"; }',
        `start_app() { exec ${SHELL} '${dir}/stub.sh'; }`,
        block,
      ].join('\n');
      const t0 = Date.now();
      const res = spawnSync(SHELL!, ['-c', script], { encoding: 'utf8', timeout: 30_000 });
      return {
        status: res.status,
        signal: res.signal,
        stdout: res.stdout,
        seconds: (Date.now() - t0) / 1000,
        starts: Number(readFileSync(`${dir}/count`, 'utf8').trim()),
        gotTerm: existsSync(`${dir}/term`),
      };
    });
  }

  const COUNT =
    'n=$(cat "$DIR/count" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "$DIR/count"';

  it('restarts after every exit with a growing, capped delay, and stops on SIGTERM', () => {
    // Delays shortened to 1 s doubling up to a 2 s cap, so the test takes ~5 s.
    const block = supervisorBlock()
      .replace(/^RESTART_DELAY_MIN=\d+$/m, 'RESTART_DELAY_MIN=1')
      .replace(/^RESTART_DELAY_MAX=\d+$/m, 'RESTART_DELAY_MAX=2');
    const stub = [
      COUNT,
      '[ "$n" -ge 4 ] || exit "$n"',
      // Fourth start: stay up until stopped, the way the app does.
      `trap 'echo term > "$DIR/term"; exit 0' TERM`,
      'kill -TERM "$PPID"',
      'while :; do sleep 0.1; done',
    ].join('\n');
    const r = run(stub, block);
    expect(r.signal).toBeNull();
    expect(r.starts).toBe(4);
    expect(r.stdout).toMatch(/exited with code 1 after \d+s; restart #1 in 1s/);
    expect(r.stdout).toMatch(/exited with code 2 after \d+s; restart #2 in 2s/);
    expect(r.stdout).toMatch(/exited with code 3 after \d+s; restart #3 in 2s/);
    // The stop reached the app, which shut down on its own, and nothing
    // started after it.
    expect(r.gotTerm).toBe(true);
    expect(r.stdout).toMatch(/Add-on stopping: BLE Scale Sync exited with code 0, not restarting/);
    expect(r.status).toBe(0);
    expect(r.stdout.match(/Starting BLE Scale Sync/g)).toHaveLength(4);
  }, 30_000);

  it('stops without another start when SIGTERM arrives during the delay', () => {
    // The real 5 s delay: the stop must cut it short.
    const stub = [COUNT, '(sleep 0.5; kill -TERM "$PPID") &', 'exit 1'].join('\n');
    const r = run(stub, supervisorBlock());
    expect(r.starts).toBe(1);
    expect(r.stdout).toMatch(/restart #1 in 5s/);
    expect(r.stdout).toMatch(/Add-on stopping: not restarting/);
    expect(r.status).toBe(0);
    expect(r.seconds).toBeLessThan(4);
  }, 30_000);

  it('is how run.sh starts the app: no exec, which would leave nothing to restart it', () => {
    expect(RUN_SH).not.toMatch(/^exec node/m);
    expect(RUN_SH).toMatch(/^start_app\(\) \{ exec node dist\/index\.js --config "\$CONFIG"; \}$/m);
    expect(RUN_SH.indexOf('start_app() {')).toBeLessThan(RUN_SH.indexOf('# >>> app supervisor'));
  });
});

describe('add-on manifest: rfkill', () => {
  it('maps /dev/rfkill as a plain path (host:container:perms is deprecated)', () => {
    // The last BLE recovery tier runs `rfkill block/unblock`, which needs the
    // device node; without it the tier fails on every add-on install.
    const devices = (MANIFEST as { devices?: string[] }).devices ?? [];
    expect(devices).toContain('/dev/rfkill');
    for (const d of devices) expect(d, d).toMatch(/^\/dev\/[^:]+$/);
  });
});
