import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadYamlConfig } from '../../src/config/yaml-load.js';
import { loadEnvFile } from '../../src/config/env-refs.js';

// G-03: the .env next to config.yaml is loaded into process.env so ${VAR}
// references resolve, and applyEnvOverrides() reads the same process.env. A
// legacy override left in that .env (SCALE_MAC, DRY_RUN, ...) therefore beat
// config.yaml without a word in the log. An override only counts when it
// comes from the real environment (docker -e, compose `environment:`).

// Real override names, so they are saved and restored around every test. On
// Windows process.env is case-insensitive, so lowercase spellings in a .env
// would land on these same keys: the tests only use uppercase.
const KEYS = [
  'SCALE_MAC',
  'DRY_RUN',
  'CONTINUOUS_MODE',
  'SCAN_COOLDOWN',
  'NOBLE_DRIVER',
  'BLE_ADAPTER',
  'BLE_HANDLER',
  'DEBUG',
  'BLE_WATCHDOG_MAX_FAILURES',
] as const;
const saved: Record<string, string | undefined> = {};
const dirs: string[] = [];

const CONFIG_MAC = 'AA:BB:CC:DD:EE:02';
const ENV_FILE_MAC = 'AA:BB:CC:DD:EE:01';

function setup(envFile: string, ble = `  scale_mac: "${CONFIG_MAC}"`): string {
  const dir = mkdtempSync(join(tmpdir(), 'bss-env-file-overrides-'));
  dirs.push(dir);
  const configPath = join(dir, 'config.yaml');
  writeFileSync(
    configPath,
    [
      'version: 1',
      'ble:',
      ble,
      '  mqtt_proxy:',
      '    broker_url: "mqtt://broker.local:1883"',
      'users:',
      '  - name: Dad',
      '    slug: dad',
      '    height: 183',
      "    birth_date: '1990-06-15'",
      '    gender: male',
      '    is_athlete: false',
      '    weight_range: { min: 60, max: 110 }',
      'runtime:',
      '  continuous_mode: false',
      '  scan_cooldown: 30',
      '  dry_run: false',
      '  debug: false',
      '  watchdog_max_consecutive_failures: 10',
      '',
    ].join('\n'),
  );
  writeFileSync(join(dir, '.env'), envFile);
  return configPath;
}

function logged(spy: ReturnType<typeof vi.spyOn>): string {
  return spy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
}

let warn: ReturnType<typeof vi.spyOn>;
let info: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  info = vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  // Drop what the loader put into process.env from each .env, so a key it owned
  // in one test is not mistaken for a .env value in the next.
  for (const dir of dirs.splice(0)) {
    rmSync(join(dir, '.env'), { force: true });
    loadEnvFile(join(dir, '.env'));
    rmSync(dir, { recursive: true, force: true });
  }
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.restoreAllMocks();
});

describe('override variables left in the .env next to config.yaml (G-03)', () => {
  it('SCALE_MAC in .env does not replace ble.scale_mac, and is named in a warning', () => {
    const config = loadYamlConfig(setup(`SCALE_MAC=${ENV_FILE_MAC}\n`));
    expect(config.ble?.scale_mac).toBe(CONFIG_MAC);

    const text = logged(warn);
    expect(text).toContain('SCALE_MAC');
    expect(text).toContain('.env');
    expect(text).toContain('ble.scale_mac');
    // The value may be a secret in general; it is never echoed.
    expect(text).not.toContain(ENV_FILE_MAC);
  });

  it.each([
    ['DRY_RUN', 'true', (c: ReturnType<typeof loadYamlConfig>) => c.runtime?.dry_run, false],
    [
      'CONTINUOUS_MODE',
      'true',
      (c: ReturnType<typeof loadYamlConfig>) => c.runtime?.continuous_mode,
      false,
    ],
    ['DEBUG', 'true', (c: ReturnType<typeof loadYamlConfig>) => c.runtime?.debug, false],
    [
      'SCAN_COOLDOWN',
      '600',
      (c: ReturnType<typeof loadYamlConfig>) => c.runtime?.scan_cooldown,
      30,
    ],
    [
      'BLE_WATCHDOG_MAX_FAILURES',
      '3',
      (c: ReturnType<typeof loadYamlConfig>) => c.runtime?.watchdog_max_consecutive_failures,
      10,
    ],
    ['BLE_ADAPTER', 'hci1', (c: ReturnType<typeof loadYamlConfig>) => c.ble?.adapter, undefined],
    ['BLE_HANDLER', 'mqtt-proxy', (c: ReturnType<typeof loadYamlConfig>) => c.ble?.handler, 'auto'],
  ])('%s in .env keeps the config.yaml value', (name, value, read, expected) => {
    const config = loadYamlConfig(setup(`${name}=${value}\n`));
    expect(read(config)).toBe(expected);
    expect(logged(warn)).toContain(name);
  });

  it('NOBLE_DRIVER in .env is neither applied nor left for the BLE handler to pick up', () => {
    const config = loadYamlConfig(setup('NOBLE_DRIVER=stoprocent\n', '  handler: auto'));
    expect(config.ble?.noble_driver).toBeUndefined();
    // src/ble/index.ts selects the driver from process.env, so an ignored value
    // that stayed there would still decide the driver.
    expect(process.env.NOBLE_DRIVER).toBeUndefined();
    expect(logged(warn)).toContain('NOBLE_DRIVER');
  });

  it('keeps ignoring the .env value on a reload', () => {
    const configPath = setup(`SCALE_MAC=${ENV_FILE_MAC}\nDRY_RUN=true\n`);
    loadYamlConfig(configPath);
    const reloaded = loadYamlConfig(configPath);
    expect(reloaded.ble?.scale_mac).toBe(CONFIG_MAC);
    expect(reloaded.runtime?.dry_run).toBe(false);
  });

  it('an empty value in .env is not worth a warning', () => {
    loadYamlConfig(setup('SCALE_MAC=\nDRY_RUN=\n'));
    expect(logged(warn)).not.toContain('SCALE_MAC');
    expect(logged(warn)).not.toContain('DRY_RUN');
  });

  it('still resolves ${VAR} references from the same .env', () => {
    const configPath = setup(
      `BSS_TEST_G03_MAC=${ENV_FILE_MAC}\n`,
      '  scale_mac: "${BSS_TEST_G03_MAC}"',
    );
    try {
      expect(loadYamlConfig(configPath).ble?.scale_mac).toBe(ENV_FILE_MAC);
    } finally {
      delete process.env.BSS_TEST_G03_MAC;
    }
  });
});

describe('override variables from the real environment', () => {
  it('SCALE_MAC from the environment overrides ble.scale_mac and says so', () => {
    process.env.SCALE_MAC = 'AA:BB:CC:DD:EE:03';
    const config = loadYamlConfig(setup(''));
    expect(config.ble?.scale_mac).toBe('AA:BB:CC:DD:EE:03');

    const text = logged(info);
    expect(text).toMatch(/SCALE_MAC.*ble\.scale_mac/);
    expect(text).not.toContain('AA:BB:CC:DD:EE:03');
  });

  it('DRY_RUN from the environment overrides runtime.dry_run and says so', () => {
    process.env.DRY_RUN = 'true';
    expect(loadYamlConfig(setup('')).runtime?.dry_run).toBe(true);
    expect(logged(info)).toMatch(/DRY_RUN.*runtime\.dry_run/);
  });

  it('the environment wins over the same key in .env, as before', () => {
    process.env.SCALE_MAC = 'AA:BB:CC:DD:EE:03';
    const config = loadYamlConfig(setup(`SCALE_MAC=${ENV_FILE_MAC}\n`));
    expect(config.ble?.scale_mac).toBe('AA:BB:CC:DD:EE:03');
    expect(logged(warn)).not.toContain('SCALE_MAC');
  });
});
