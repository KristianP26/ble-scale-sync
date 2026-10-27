import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppConfig } from '../../src/config/schema.js';

/**
 * Config corpus goldens (architecture audit 2026-10-21, wave 0 item 0.4,
 * C step 0).
 *
 * Each case is a config.yaml (with the .env next to it and the process
 * environment), or a legacy .env, run through the real loader. Pinned in
 * tests/golden/config/<id>.json: the loaded AppConfig, resolveRuntimeConfig,
 * the buildAdapterRuntimeConfig argument every adapter's configure() gets
 * (its field mapping has its own table test in resolve.test.ts), the exporter
 * slots per user (D029) and the log lines. reload-diff.json pins
 * diffRestartRequired for a set of edits on one loaded config.
 *
 * RULE: a refactor commit never changes a golden file. A golden change goes in
 * its own commit that says why the behaviour changed. Regenerate with
 * `npx vitest run tests/config/config-golden.test.ts -u` and review the diff.
 */

const lines: string[] = [];
const capture = (...args: unknown[]): void => {
  lines.push(
    args
      .map(String)
      .join(' ')
      .replace(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3} /, ''),
  );
};

// The legacy .env mode reads the .env at defaultEnvPath(): point it at the case.
let caseDir = '';
vi.mock(import('../../src/config/paths.js'), async (importOriginal) => ({
  ...(await importOriginal()),
  defaultEnvPath: () => join(caseDir, '.env'),
}));

const { loadYamlConfig } = await import('../../src/config/yaml-load.js');
const { loadEnvConfig } = await import('../../src/config/env-load.js');
const { loadEnvFile } = await import('../../src/config/env-refs.js');
const { resolveRuntimeConfig, buildAdapterRuntimeConfig, resolveExporterSlotsForUser } =
  await import('../../src/config/resolve.js');
const { diffRestartRequired } = await import('../../src/config/reload-diff.js');

// --- Corpus ------------------------------------------------------------------

interface Case {
  id: string;
  /** config.yaml text; absent = legacy .env mode. */
  yaml?: string;
  /** The .env next to config.yaml (or the legacy .env). */
  envFile?: string;
  /** The real process environment (docker -e, compose `environment:`). */
  env?: Record<string, string>;
}

const USER = `
  - name: Dad
    slug: dad
    height: 183
    birth_date: '1990-06-15'
    gender: male
    is_athlete: false
    weight_range: { min: 75, max: 95 }`;

const LEGACY_USER =
  'USER_HEIGHT=183\nUSER_BIRTH_DATE=1990-06-15\nUSER_GENDER=male\nUSER_IS_ATHLETE=false\n';

const CORPUS: Case[] = [
  { id: 'yaml-minimal-defaults', yaml: `version: 1\nusers:${USER}\n` },
  {
    id: 'yaml-full',
    yaml: `version: 1
ble:
  scale_mac: "AA:BB:CC:DD:EE:01"
  bind_key: "00112233445566778899aabbccddeeff"
  handler: mqtt-proxy
  adapter: hci1
  adapter_privacy: true
  force_scale_adapter: QN Scale
  session_timeout_sec: 90
  qn_protocol_byte: 255
  qn_report_byte: 2
  qn_weight_ack: true
  qn_user_key: 1234
  qn_user_slot: 2
  qn_a4_prelude: true
  qn_time_sync_long: false
  qn_config_long: true
  qn_result_ack: false
  rmsc04_profile_byte: "9e"
  mqtt_proxy:
    broker_url: "mqtt://broker.local:1883"
    username: proxy
    password: "placeholder"
scale: { weight_unit: lbs, height_unit: in, display_unit: st }
unknown_user: log
out_of_range: skip
users:
  - name: Dad
    slug: dad
    height: 72
    birth_date: '1990-06-15'
    gender: male
    is_athlete: true
    weight_range: { min: 75, max: 95 }
    last_known_weight: 84.2
    beurer_user_index: 1
    exporters:
      - type: webhook
        url: "https://hooks.example/dad"
  - name: Mom
    slug: mom
    height: 65
    birth_date: '1992-03-20'
    gender: female
    is_athlete: false
    weight_range: { min: 50, max: 70 }
    estimate_body_composition: false
global_exporters:
  - type: webhook
    url: "https://hooks.example/one"
  - type: webhook
    url: "https://hooks.example/two"
  - type: mqtt
    broker_url: "mqtt://broker.local:1883"
  - type: strava
    client_id: "12345"
    client_secret: "placeholder"
    token_dir: ./strava-tokens
runtime:
  continuous_mode: true
  scan_cooldown: 60
  dry_run: false
  debug: true
  watchdog_max_consecutive_failures: 3
  watch_config: false
  idle_rescan_delay: 10
  no_reading_rescan_delay: 20
  retry_failed_exports: false
update_check: false
`,
  },
  {
    id: 'yaml-env-references',
    yaml: `version: 1
users:${USER}
global_exporters:
  - type: mqtt
    broker_url: "\${BROKER}"
    password: "\${MQTT_PASS}"
    topic: "scale/$\${LITERAL}"
runtime:
  scan_cooldown: \${COOLDOWN}
  dry_run: \${DRY}
`,
    envFile: 'BROKER=mqtt://from-env-file:1883\nMQTT_PASS=placeholder\nCOOLDOWN=45\nDRY=yes\n',
  },
  {
    id: 'yaml-env-overrides',
    yaml: `version: 1
ble:
  scale_mac: "AA:BB:CC:DD:EE:02"
users:${USER}
runtime:
  scan_cooldown: 30
`,
    env: {
      SCALE_MAC: 'AA:BB:CC:DD:EE:09',
      DRY_RUN: 'yes',
      CONTINUOUS_MODE: 'on',
      DEBUG: '1',
      SCAN_COOLDOWN: '12.5',
      BLE_WATCHDOG_MAX_FAILURES: '7',
      BLE_ADAPTER: 'hci2',
      NOBLE_DRIVER: 'stoprocent',
    },
  },
  {
    id: 'yaml-env-overrides-invalid',
    yaml: `version: 1\nusers:${USER}\n`,
    env: { DRY_RUN: 'maybe', BLE_WATCHDOG_MAX_FAILURES: 'lots', SCAN_COOLDOWN: '2' },
  },
  {
    id: 'yaml-override-in-env-file-ignored',
    yaml: `version: 1\nble:\n  scale_mac: "AA:BB:CC:DD:EE:02"\nusers:${USER}\n`,
    envFile: 'SCALE_MAC=AA:BB:CC:DD:EE:01\nDRY_RUN=true\n',
  },
  {
    id: 'yaml-unknown-keys-and-exporters',
    yaml: `version: 1
ble:
  qn_future_knob: 1
users:${USER}
    favourite_colour: blue
global_exporters:
  - type: carrier-pigeon
  - type: webhook
    url: "https://hooks.example/one"
mystery: true
`,
  },
  {
    id: 'yaml-invalid',
    yaml: `version: 1
users:
  - name: Dad
    slug: Dad
    height: -1
    birth_date: '1990-02-30'
    gender: other
    is_athlete: false
    weight_range: { min: 90, max: 80 }
`,
  },
  { id: 'env-legacy-minimal', envFile: LEGACY_USER },
  {
    id: 'env-legacy-full',
    envFile:
      'USER_HEIGHT=72\nUSER_BIRTH_DATE=1992-03-20\nUSER_GENDER=female\nUSER_IS_ATHLETE=true\n' +
      'WEIGHT_UNIT=lbs\nHEIGHT_UNIT=in\nSCALE_MAC=AA:BB:CC:DD:EE:03\n' +
      'DRY_RUN=true\nCONTINUOUS_MODE=true\nSCAN_COOLDOWN=45\nNOBLE_DRIVER=abandonware\n' +
      'BLE_ADAPTER=hci1\nDEBUG=1\nEXPORTERS=garmin,mqtt,webhook\nGARMIN_EMAIL=a@example.com\n' +
      'GARMIN_PASSWORD=placeholder\nGARMIN_WEIGHT_ONLY=true\n' +
      'MQTT_BROKER_URL=mqtt://broker.local:1883\nWEBHOOK_URL=https://hooks.example/one\n',
  },
];

/** Edits on the loaded `yaml-full` config, each diffed against the original. */
const RELOAD_EDITS: Record<string, Record<string, unknown>> = {
  'nothing-changed': {},
  'hot-reloadable-only': {
    'runtime.dry_run': true,
    'runtime.scan_cooldown': 90,
    out_of_range: 'warn',
    'users.0.last_known_weight': 90,
    'ble.qn_weight_ack': false,
    'ble.qn_user_slot': 3,
    'ble.rmsc04_profile_byte': '5c',
  },
  'handler-and-adapter': {
    'ble.handler': 'auto',
    'ble.adapter': 'hci0',
    'ble.noble_driver': 'stoprocent',
  },
  'mqtt-proxy-credentials': {
    'ble.mqtt_proxy.password': 'other-placeholder',
    'ble.mqtt_proxy.broker_url': 'mqtt://user:secret@broker.local:1884',
  },
  'esphome-proxy-added': {
    'ble.esphome_proxy': {
      host: 'esp.local',
      port: 6053,
      encryption_key: 'placeholder',
      client_info: 'ble-scale-sync',
      additional_proxies: [{ host: 'esp2.local', port: 6053, password: 'placeholder' }],
      advertisement_timeout: 0,
    },
  },
  'restart-required-runtime-and-ble': {
    'runtime.continuous_mode': false,
    'runtime.retry_failed_exports': true,
    'runtime.watchdog_max_consecutive_failures': 10,
    'ble.adapter_privacy': false,
    'ble.force_scale_adapter': null,
  },
  'users-changed': { users: [] },
};

// --- Runner ------------------------------------------------------------------

const NOW = new Date('2026-10-21T08:00:00.000Z');
const parseEnv = (text = ''): Record<string, string> =>
  Object.fromEntries(
    text
      .split('\n')
      .filter((l) => l.includes('='))
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
  );
// Every variable any case or override can touch, unset around each case.
const ENV_NAMES = new Set([
  ...CORPUS.flatMap((c) => [...Object.keys(c.env ?? {}), ...Object.keys(parseEnv(c.envFile))]),
  ...['BLE_HANDLER', 'USER_IS_ATHLETE', 'EXPORTERS'],
]);

/** Machine-specific paths out, so the golden is the same on Windows and Linux CI. */
function normalize(value: unknown): unknown {
  if (typeof value === 'string') {
    let s = value;
    for (const [from, to] of [
      [caseDir, '<configDir>'],
      [homedir(), '<home>'],
    ]) {
      s = s.split(from).join(to);
    }
    return s.replace(/<(configDir|home)>[^\s'"]*/g, (p) => p.replace(/\\/g, '/'));
  }
  if (Array.isArray(value)) return value.map(normalize);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalize(v)]));
  }
  return value;
}

function load(c: Case): AppConfig {
  if (c.envFile !== undefined) writeFileSync(join(caseDir, '.env'), c.envFile);
  if (c.yaml === undefined) return loadEnvConfig();
  const path = join(caseDir, 'config.yaml');
  writeFileSync(path, c.yaml);
  return loadYamlConfig(path);
}

function outcome(c: Case): unknown {
  let config: AppConfig;
  try {
    config = load(c);
  } catch (err) {
    return { error: (err as Error).message, log: lines };
  }
  const runtime = resolveRuntimeConfig(config);
  return {
    config,
    runtime,
    adapterRuntime: {
      ...buildAdapterRuntimeConfig(config, runtime.scaleMac),
      // The live config.users entries; resolve.test.ts pins that identity.
      userWeights: 'config.users',
    },
    exporterSlots: Object.fromEntries(
      config.users.map((u) => [
        u.slug,
        resolveExporterSlotsForUser(config, u).map((r) => `${r.list}:${r.index}:${r.entry.type}`),
      ]),
    ),
    log: lines,
  };
}

function edited(base: AppConfig, edits: Record<string, unknown>): AppConfig {
  const next = structuredClone(base) as unknown as Record<string, unknown>;
  for (const [path, value] of Object.entries(edits)) {
    const keys = path.split('.');
    let at = next;
    for (const k of keys.slice(0, -1)) at = (at[k] ??= {}) as Record<string, unknown>;
    at[keys[keys.length - 1]] = value;
  }
  return next as unknown as AppConfig;
}

const golden = (data: unknown): string => `${JSON.stringify(normalize(data), null, 2)}\n`;

describe('config corpus goldens (tests/golden/config)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    for (const name of ENV_NAMES) vi.stubEnv(name, undefined);
    // cliCommand() in error hints differs between `npm test` and `npx vitest`.
    vi.stubEnv('npm_command', '');
    vi.stubEnv('npm_lifecycle_event', '');
    caseDir = mkdtempSync(join(tmpdir(), 'bss-config-golden-'));
    lines.length = 0;
    for (const m of ['log', 'warn', 'error'] as const) {
      vi.spyOn(console, m).mockImplementation(capture);
    }
  });
  afterEach(() => {
    // Forget what loadEnvFile took from this case's .env before the next case.
    rmSync(join(caseDir, '.env'), { force: true });
    loadEnvFile(join(caseDir, '.env'));
    rmSync(caseDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it.each(CORPUS.map((c) => [c.id, c] as const))('%s', async (id, c) => {
    for (const [name, value] of Object.entries(c.env ?? {})) vi.stubEnv(name, value);
    await expect(golden(outcome(c))).toMatchFileSnapshot(`../golden/config/${id}.json`);
  });

  it('reload-diff', async () => {
    const base = load(CORPUS.find((c) => c.id === 'yaml-full')!);
    const diffs = Object.fromEntries(
      Object.entries(RELOAD_EDITS).map(([id, e]) => [
        id,
        diffRestartRequired(base, edited(base, e)),
      ]),
    );
    await expect(golden(diffs)).toMatchFileSnapshot('../golden/config/reload-diff.json');
  });
});
