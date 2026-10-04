import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import {
  resolveEnvReferences,
  detectConfigSource,
  loadYamlConfig,
  loadAppConfig,
  loadBleConfig,
} from '../../src/config/load.js';
import { createExporterFromEntry, KNOWN_EXPORTER_NAMES } from '../../src/exporters/registry.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual };
});

// --- resolveEnvReferences ---

describe('resolveEnvReferences', () => {
  beforeEach(() => {
    vi.stubEnv('TEST_VAR', 'hello');
    vi.stubEnv('ANOTHER_VAR', 'world');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('replaces ${VAR} in strings', () => {
    expect(resolveEnvReferences('prefix-${TEST_VAR}-suffix')).toBe('prefix-hello-suffix');
  });

  it('replaces multiple vars in one string', () => {
    expect(resolveEnvReferences('${TEST_VAR} ${ANOTHER_VAR}')).toBe('hello world');
  });

  it('passes through strings without references', () => {
    expect(resolveEnvReferences('plain text')).toBe('plain text');
  });

  it('passes through non-string primitives', () => {
    expect(resolveEnvReferences(42)).toBe(42);
    expect(resolveEnvReferences(true)).toBe(true);
    expect(resolveEnvReferences(null)).toBeNull();
  });

  it('deep-walks objects', () => {
    const input = { a: '${TEST_VAR}', b: { c: '${ANOTHER_VAR}' } };
    expect(resolveEnvReferences(input)).toEqual({ a: 'hello', b: { c: 'world' } });
  });

  it('deep-walks arrays', () => {
    const input = ['${TEST_VAR}', '${ANOTHER_VAR}'];
    expect(resolveEnvReferences(input)).toEqual(['hello', 'world']);
  });

  it('throws on undefined env var', () => {
    expect(() => resolveEnvReferences('${MISSING_VAR}')).toThrow(
      "Environment variable 'MISSING_VAR' referenced in config.yaml is not defined",
    );
  });

  // G-24: there was no way to write a literal `${` at all.
  it('reads $${...} as a literal ${...}', () => {
    expect(resolveEnvReferences('pa$${MISSING_VAR}ss')).toBe('pa${MISSING_VAR}ss');
    expect(resolveEnvReferences('$${TEST_VAR}-${TEST_VAR}')).toBe('${TEST_VAR}-hello');
  });

  it('handles nested objects with arrays', () => {
    const input = {
      exporters: [{ type: 'mqtt', password: '${TEST_VAR}' }],
    };
    expect(resolveEnvReferences(input)).toEqual({
      exporters: [{ type: 'mqtt', password: 'hello' }],
    });
  });
});

// --- detectConfigSource ---

describe('detectConfigSource', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns yaml when config path exists', () => {
    vi.spyOn(fs, 'existsSync').mockImplementation((p) => String(p).endsWith('config.yaml'));
    expect(detectConfigSource()).toBe('yaml');
  });

  it('returns env when only .env exists', () => {
    vi.spyOn(fs, 'existsSync').mockImplementation((p) => String(p).endsWith('.env'));
    expect(detectConfigSource()).toBe('env');
  });

  it('returns none when neither exists', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    expect(detectConfigSource()).toBe('none');
  });

  it('uses custom config path for yaml detection', () => {
    vi.spyOn(fs, 'existsSync').mockImplementation((p) => String(p) === '/custom/config.yaml');
    expect(detectConfigSource('/custom/config.yaml')).toBe('yaml');
  });
});

// --- loadYamlConfig ---

describe('loadYamlConfig', () => {
  const VALID_YAML = `
version: 1
ble:
  scale_mac: "FF:03:00:13:A1:04"
scale:
  weight_unit: kg
  height_unit: cm
unknown_user: nearest
users:
  - name: Test
    slug: test
    height: 183
    birth_date: "1990-06-15"
    gender: male
    is_athlete: true
    weight_range: { min: 70, max: 100 }
    last_known_weight: null
global_exporters:
  - type: garmin
runtime:
  continuous_mode: false
  scan_cooldown: 30
  dry_run: false
  debug: false
`;

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('parses valid YAML config', () => {
    vi.spyOn(fs, 'readFileSync').mockReturnValue(VALID_YAML);
    vi.spyOn(fs, 'existsSync').mockImplementation((p) => !String(p).endsWith('.env'));

    const config = loadYamlConfig('/test/config.yaml');
    expect(config.version).toBe(1);
    expect(config.users[0].name).toBe('Test');
    expect(config.users[0].slug).toBe('test');
    expect(config.ble?.scale_mac).toBe('FF:03:00:13:A1:04');
    expect(config.scale.weight_unit).toBe('kg');
  });

  it('resolves env references in YAML', () => {
    vi.stubEnv('MY_SECRET', 'secret123');
    const yaml = VALID_YAML.replace('type: garmin', 'type: garmin\n    password: "${MY_SECRET}"');
    vi.spyOn(fs, 'readFileSync').mockReturnValue(yaml);
    vi.spyOn(fs, 'existsSync').mockImplementation((p) => !String(p).endsWith('.env'));

    const config = loadYamlConfig('/test/config.yaml');
    const garminEntry = config.global_exporters?.[0];
    expect(garminEntry).toBeDefined();
    expect((garminEntry as Record<string, unknown>).password).toBe('secret123');
  });

  it('throws on invalid YAML (missing users)', () => {
    const invalidYaml = `
version: 1
scale:
  weight_unit: kg
`;
    vi.spyOn(fs, 'readFileSync').mockReturnValue(invalidYaml);
    vi.spyOn(fs, 'existsSync').mockImplementation((p) => !String(p).endsWith('.env'));

    expect(() => loadYamlConfig('/test/config.yaml')).toThrow();
  });

  // The yaml library prints a code frame of the bad line, and a config line
  // very often holds the secret itself. The error must locate the problem
  // without echoing the value.
  it('does not echo the offending line of a YAML syntax error', () => {
    const yaml = VALID_YAML.replace('type: garmin', 'type: garmin\n    password: hunter2: x');
    vi.spyOn(fs, 'readFileSync').mockReturnValue(yaml);
    vi.spyOn(fs, 'existsSync').mockImplementation((p) => !String(p).endsWith('.env'));

    let message = '';
    try {
      loadYamlConfig('/test/config.yaml');
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('/test/config.yaml');
    expect(message).toMatch(/line \d+/);
    expect(message).toContain("key 'password'");
    expect(message).not.toContain('hunter2');
  });

  it('does not echo an unquoted value that YAML reads as an alias', () => {
    const yaml = VALID_YAML.replace('type: garmin', 'type: garmin\n    password: *hunter2');
    vi.spyOn(fs, 'readFileSync').mockReturnValue(yaml);
    vi.spyOn(fs, 'existsSync').mockImplementation((p) => !String(p).endsWith('.env'));

    expect(() => loadYamlConfig('/test/config.yaml')).toThrow(/Invalid YAML/);
    try {
      loadYamlConfig('/test/config.yaml');
    } catch (err) {
      expect((err as Error).message).not.toContain('hunter2');
    }
  });

  it('warns about an unknown key under ble and keeps loading (#318)', () => {
    const yamlWithTypo = VALID_YAML.replace(
      '  scale_mac:',
      '  force_scale_adaptr: "Hutbit"\n  scale_mac:',
    );
    vi.spyOn(fs, 'readFileSync').mockReturnValue(yamlWithTypo);
    vi.spyOn(fs, 'existsSync').mockImplementation((p) => !String(p).endsWith('.env'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const config = loadYamlConfig('/test/config.yaml');

    expect(config).toBeDefined();
    expect(warn.mock.calls.flat().join(' ')).toContain('ble.force_scale_adaptr');
    warn.mockRestore();
  });

  // D029: several exporters of one type are allowed and all of them receive
  // the reading (two webhooks, two files), and the retry queue tells them apart
  // by their position. Loading such a config must neither drop one nor warn.
  it('keeps a second global exporter of the same type without a warning', () => {
    const twoHooks = VALID_YAML.replace(
      '  - type: garmin',
      [
        '  - type: webhook',
        '    url: https://a.example',
        '  - type: webhook',
        '    url: https://b.example',
      ].join('\n'),
    );
    vi.spyOn(fs, 'readFileSync').mockReturnValue(twoHooks);
    vi.spyOn(fs, 'existsSync').mockImplementation((p) => !String(p).endsWith('.env'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const config = loadYamlConfig('/test/config.yaml');

    expect(config.global_exporters).toHaveLength(2);
    expect(warn.mock.calls.flat().join(' ')).not.toContain('more than once');
  });

  it('warns and skips unknown exporter types', () => {
    const yamlWithUnknown = VALID_YAML.replace('type: garmin', 'type: fakexporter');
    vi.spyOn(fs, 'readFileSync').mockReturnValue(yamlWithUnknown);
    vi.spyOn(fs, 'existsSync').mockImplementation((p) => !String(p).endsWith('.env'));

    const config = loadYamlConfig('/test/config.yaml');
    // Unknown exporter should be filtered out
    expect(config.global_exporters).toBeUndefined();
  });

  it('applies env overrides for runtime', () => {
    vi.spyOn(fs, 'readFileSync').mockReturnValue(VALID_YAML);
    vi.spyOn(fs, 'existsSync').mockImplementation((p) => !String(p).endsWith('.env'));
    vi.stubEnv('CONTINUOUS_MODE', 'true');
    vi.stubEnv('DRY_RUN', 'true');

    const config = loadYamlConfig('/test/config.yaml');
    expect(config.runtime?.continuous_mode).toBe(true);
    expect(config.runtime?.dry_run).toBe(true);
  });

  it('applies env overrides for BLE', () => {
    vi.spyOn(fs, 'readFileSync').mockReturnValue(VALID_YAML);
    vi.spyOn(fs, 'existsSync').mockImplementation((p) => !String(p).endsWith('.env'));
    vi.stubEnv('SCALE_MAC', 'AA:BB:CC:DD:EE:FF');

    const config = loadYamlConfig('/test/config.yaml');
    expect(config.ble?.scale_mac).toBe('AA:BB:CC:DD:EE:FF');
  });

  it('applies BLE_ADAPTER env override with trim and lowercase', () => {
    vi.spyOn(fs, 'readFileSync').mockReturnValue(VALID_YAML);
    vi.spyOn(fs, 'existsSync').mockImplementation((p) => !String(p).endsWith('.env'));
    vi.stubEnv('BLE_ADAPTER', '  HCI1  ');

    const config = loadYamlConfig('/test/config.yaml');
    expect(config.ble?.adapter).toBe('hci1');
  });

  it('clears adapter when BLE_ADAPTER is empty string', () => {
    const yamlWithAdapter = VALID_YAML.replace(
      'scale_mac: "FF:03:00:13:A1:04"',
      'scale_mac: "FF:03:00:13:A1:04"\n  adapter: hci1',
    );
    vi.spyOn(fs, 'readFileSync').mockReturnValue(yamlWithAdapter);
    vi.spyOn(fs, 'existsSync').mockImplementation((p) => !String(p).endsWith('.env'));
    vi.stubEnv('BLE_ADAPTER', '');

    const config = loadYamlConfig('/test/config.yaml');
    expect(config.ble?.adapter).toBeUndefined();
  });

  it('warns on invalid BLE_ADAPTER and does not override', () => {
    const yamlWithAdapter = VALID_YAML.replace(
      'scale_mac: "FF:03:00:13:A1:04"',
      'scale_mac: "FF:03:00:13:A1:04"\n  adapter: hci0',
    );
    vi.spyOn(fs, 'readFileSync').mockReturnValue(yamlWithAdapter);
    vi.spyOn(fs, 'existsSync').mockImplementation((p) => !String(p).endsWith('.env'));
    vi.stubEnv('BLE_ADAPTER', 'eth0');

    const config = loadYamlConfig('/test/config.yaml');
    // Invalid value should not override the YAML value
    expect(config.ble?.adapter).toBe('hci0');
  });

  it('sets NOBLE_DRIVER env var when configured', () => {
    const yamlWithDriver = VALID_YAML.replace(
      'scale_mac: "FF:03:00:13:A1:04"',
      'scale_mac: "FF:03:00:13:A1:04"\n  noble_driver: stoprocent',
    );
    vi.spyOn(fs, 'readFileSync').mockReturnValue(yamlWithDriver);
    vi.spyOn(fs, 'existsSync').mockImplementation((p) => !String(p).endsWith('.env'));

    loadYamlConfig('/test/config.yaml');
    expect(process.env.NOBLE_DRIVER).toBe('stoprocent');
  });
});

// --- env overrides vs. values loadYamlConfig publishes to process.env ---

// loadYamlConfig used to write DEBUG, BLE_HANDLER and NOBLE_DRIVER from
// config.yaml into process.env BEFORE applyEnvOverrides() read them, so an
// override from the real environment was overwritten by the value it was
// meant to override, and on a reload the value written last time came back
// as if it were an override.
describe('loadYamlConfig env override precedence', () => {
  const KEYS = ['DEBUG', 'BLE_HANDLER', 'NOBLE_DRIVER'] as const;
  const saved: Record<string, string | undefined> = {};

  const yaml = (ble: string, debug: boolean): string => `
version: 1
ble:
${ble}
users:
  - name: Test
    slug: test
    height: 183
    birth_date: "1990-06-15"
    gender: male
    is_athlete: false
    weight_range: { min: 70, max: 100 }
runtime:
  debug: ${debug}
`;
  const PROXY = `  mqtt_proxy:\n    broker_url: "mqtt://broker.local:1883"`;

  const load = (raw: string) => {
    vi.spyOn(fs, 'readFileSync').mockReturnValue(raw);
    return loadYamlConfig('/test/config.yaml');
  };

  beforeEach(() => {
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    // Keep the developer's real .env out of these tests.
    vi.spyOn(fs, 'existsSync').mockImplementation((p) => !String(p).endsWith('.env'));
  });

  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    vi.restoreAllMocks();
  });

  it('DEBUG=false in the environment turns off debug: true from config.yaml', () => {
    process.env.DEBUG = 'false';
    expect(load(yaml('  handler: auto', true)).runtime?.debug).toBe(false);
  });

  it('a reload from debug: true to debug: false turns debug off', () => {
    expect(load(yaml('  handler: auto', true)).runtime?.debug).toBe(true);
    expect(load(yaml('  handler: auto', false)).runtime?.debug).toBe(false);
  });

  it('BLE_HANDLER=auto in the environment overrides handler: mqtt-proxy', () => {
    process.env.BLE_HANDLER = 'auto';
    expect(load(yaml(`  handler: mqtt-proxy\n${PROXY}`, false)).ble?.handler).toBe('auto');
  });

  it('a reload from handler: mqtt-proxy to handler: auto takes the new handler', () => {
    expect(load(yaml(`  handler: mqtt-proxy\n${PROXY}`, false)).ble?.handler).toBe('mqtt-proxy');
    expect(load(yaml(`  handler: auto\n${PROXY}`, false)).ble?.handler).toBe('auto');
  });

  it('NOBLE_DRIVER in the environment overrides noble_driver and stays published', () => {
    process.env.NOBLE_DRIVER = 'stoprocent';
    expect(load(yaml('  noble_driver: abandonware', false)).ble?.noble_driver).toBe('stoprocent');
    expect(process.env.NOBLE_DRIVER).toBe('stoprocent');
    // And it keeps winning on a reload.
    expect(load(yaml('  noble_driver: abandonware', false)).ble?.noble_driver).toBe('stoprocent');
  });

  it('publishes noble_driver from config.yaml for the BLE handler import', () => {
    load(yaml('  noble_driver: abandonware', false));
    expect(process.env.NOBLE_DRIVER).toBe('abandonware');
  });

  it('a reload that removes noble_driver drops the value config.yaml had published', () => {
    load(yaml('  noble_driver: abandonware', false));
    const config = load(yaml('  handler: auto', false));
    expect(config.ble?.noble_driver).toBeUndefined();
    expect(process.env.NOBLE_DRIVER).toBeUndefined();
  });
});

// --- loadBleConfig ---

describe('loadBleConfig', () => {
  // The YAML path applies the environment overrides now (G-05), so a value an
  // earlier test left in process.env would leak into these.
  const KEYS = ['SCALE_MAC', 'NOBLE_DRIVER', 'BLE_ADAPTER', 'BLE_HANDLER'] as const;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  /** config.yaml exists, no .env anywhere (the mocked read would serve it the YAML). */
  const yamlOnly = (): void => {
    vi.spyOn(fs, 'existsSync').mockImplementation((p) => !String(p).endsWith('.env'));
  };

  it('reads from YAML when config exists', () => {
    yamlOnly();
    vi.spyOn(fs, 'readFileSync').mockReturnValue(`
ble:
  scale_mac: "AA:BB:CC:DD:EE:FF"
  noble_driver: abandonware
`);

    const config = loadBleConfig('/test/config.yaml');
    expect(config.scaleMac).toBe('AA:BB:CC:DD:EE:FF');
    expect(config.nobleDriver).toBe('abandonware');
  });

  // No path given in the legacy cases: an explicit --config that does not exist
  // is an error now, like it is for the app.
  it('falls back to env vars when no YAML', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    vi.stubEnv('SCALE_MAC', '11:22:33:44:55:66');
    vi.stubEnv('NOBLE_DRIVER', 'stoprocent');

    const config = loadBleConfig();
    expect(config.scaleMac).toBe('11:22:33:44:55:66');
    expect(config.nobleDriver).toBe('stoprocent');
  });

  it('returns undefined for missing values', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);

    const config = loadBleConfig();
    expect(config.scaleMac).toBeUndefined();
    expect(config.nobleDriver).toBeUndefined();
  });

  it('handles YAML without ble section', () => {
    yamlOnly();
    vi.spyOn(fs, 'readFileSync').mockReturnValue(`
version: 1
scale:
  weight_unit: kg
`);

    const config = loadBleConfig('/test/config.yaml');
    expect(config.scaleMac).toBeUndefined();
    expect(config.nobleDriver).toBeUndefined();
    expect(config.bleHandler).toBe('auto');
  });

  it('validates BLE_ADAPTER env var in fallback path', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    vi.stubEnv('BLE_ADAPTER', ' HCI1 ');

    const config = loadBleConfig();
    expect(config.bleAdapter).toBe('hci1');
  });

  it('ignores invalid BLE_ADAPTER env var in fallback path', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    vi.stubEnv('BLE_ADAPTER', 'eth0');

    const config = loadBleConfig();
    expect(config.bleAdapter).toBeUndefined();
  });

  it('reports an unreadable config.yaml instead of scanning with defaults', () => {
    yamlOnly();
    vi.spyOn(fs, 'readFileSync').mockImplementation(() => {
      throw new Error('read error');
    });

    // It used to fall through to the env vars, i.e. to the native handler with
    // nothing configured, while config.yaml asked for something else (G-05).
    expect(() => loadBleConfig('/test/config.yaml')).toThrow('read error');
  });
});

// --- loadAppConfig ---

describe('loadAppConfig', () => {
  const VALID_YAML = `
version: 1
users:
  - name: Test
    slug: test
    height: 183
    birth_date: "1990-06-15"
    gender: male
    is_athlete: true
    weight_range: { min: 70, max: 100 }
global_exporters:
  - type: garmin
`;

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('loads from YAML when config.yaml exists', () => {
    vi.spyOn(fs, 'existsSync').mockImplementation((p) => String(p).endsWith('config.yaml'));
    vi.spyOn(fs, 'readFileSync').mockReturnValue(VALID_YAML);

    const result = loadAppConfig();
    expect(result.source).toBe('yaml');
    expect(result.config.users[0].name).toBe('Test');
  });

  it('falls back to .env when no config.yaml', () => {
    vi.spyOn(fs, 'existsSync').mockImplementation((p) => String(p).endsWith('.env'));
    // Set all required env vars for loadConfig()
    vi.stubEnv('USER_HEIGHT', '183');
    vi.stubEnv('USER_BIRTH_DATE', '1990-06-15');
    vi.stubEnv('USER_GENDER', 'male');
    vi.stubEnv('USER_IS_ATHLETE', 'true');

    const result = loadAppConfig();
    expect(result.source).toBe('env');
    expect(result.config.version).toBe(1);
    expect(result.config.users).toHaveLength(1);
    expect(result.config.users[0].name).toBe('Default');
    expect(result.config.users[0].birth_date).toBe('1990-06-15');
  });

  // The env vars are parsed by loadExporterConfig() but only reach the exporter
  // through the ExporterEntry that loadEnvConfig() builds, so cross that seam.
  it('carries NTFY_REPORT_EXPORTS and TELEGRAM_REPORT_EXPORTS into the .env exporter entries', () => {
    vi.spyOn(fs, 'existsSync').mockImplementation((p) => String(p).endsWith('.env'));
    vi.stubEnv('USER_HEIGHT', '183');
    vi.stubEnv('USER_BIRTH_DATE', '1990-06-15');
    vi.stubEnv('USER_GENDER', 'male');
    vi.stubEnv('USER_IS_ATHLETE', 'true');
    vi.stubEnv('EXPORTERS', 'ntfy,telegram');
    vi.stubEnv('NTFY_TOPIC', 'my-scale');
    vi.stubEnv('NTFY_REPORT_EXPORTS', 'true');
    vi.stubEnv('TELEGRAM_BOT_TOKEN', '123:abc');
    vi.stubEnv('TELEGRAM_CHAT_ID', '42');
    vi.stubEnv('TELEGRAM_REPORT_EXPORTS', 'true');

    const { config } = loadAppConfig();
    const byType = Object.fromEntries(config.global_exporters!.map((e) => [e.type, e]));
    expect(createExporterFromEntry(byType.ntfy).reportsExports).toBe(true);
    expect(createExporterFromEntry(byType.telegram).reportsExports).toBe(true);
  });

  // The logger reads DEBUG with the same TRUE words as the yaml override, so
  // the legacy path must too: DEBUG=1 meant debug logs but runtime.debug false.
  it.each(['1', 'yes', 'on', 'TRUE'])('reads DEBUG=%s as on in the .env path', (value) => {
    vi.spyOn(fs, 'existsSync').mockImplementation((p) => String(p).endsWith('.env'));
    vi.stubEnv('USER_HEIGHT', '183');
    vi.stubEnv('USER_BIRTH_DATE', '1990-06-15');
    vi.stubEnv('USER_GENDER', 'male');
    vi.stubEnv('USER_IS_ATHLETE', 'true');
    vi.stubEnv('DEBUG', value);

    expect(loadAppConfig().config.runtime?.debug).toBe(true);
  });

  // G-22: the .env path cast NOBLE_DRIVER to the union without looking at it.
  it('rejects an unknown NOBLE_DRIVER in the .env path', () => {
    vi.spyOn(fs, 'existsSync').mockImplementation((p) => String(p).endsWith('.env'));
    vi.stubEnv('USER_HEIGHT', '183');
    vi.stubEnv('USER_BIRTH_DATE', '1990-06-15');
    vi.stubEnv('USER_GENDER', 'male');
    vi.stubEnv('USER_IS_ATHLETE', 'true');
    vi.stubEnv('NOBLE_DRIVER', 'bluez');

    expect(() => loadAppConfig()).toThrow(/NOBLE_DRIVER/);
  });

  it('carries GARMIN_WEIGHT_ONLY into the .env Garmin exporter entry', () => {
    vi.spyOn(fs, 'existsSync').mockImplementation((p) => String(p).endsWith('.env'));
    vi.stubEnv('USER_HEIGHT', '183');
    vi.stubEnv('USER_BIRTH_DATE', '1990-06-15');
    vi.stubEnv('USER_GENDER', 'male');
    vi.stubEnv('USER_IS_ATHLETE', 'true');
    vi.stubEnv('EXPORTERS', 'garmin');
    vi.stubEnv('GARMIN_WEIGHT_ONLY', 'true');

    const { config } = loadAppConfig();
    const garmin = config.global_exporters!.find((e) => e.type === 'garmin');
    expect(garmin).toMatchObject({ weight_only: true });
    // The entry has to survive the factory too, not just the loader.
    expect(() => createExporterFromEntry(garmin!)).not.toThrow();
  });

  it('carries the HEALTHLOG_* vars into a buildable .env HealthLog exporter entry', () => {
    vi.spyOn(fs, 'existsSync').mockImplementation((p) => String(p).endsWith('.env'));
    vi.stubEnv('USER_HEIGHT', '183');
    vi.stubEnv('USER_BIRTH_DATE', '1990-06-15');
    vi.stubEnv('USER_GENDER', 'male');
    vi.stubEnv('USER_IS_ATHLETE', 'true');
    vi.stubEnv('EXPORTERS', 'healthlog');
    vi.stubEnv('HEALTHLOG_BASE_URL', 'https://healthlog.example');
    vi.stubEnv('HEALTHLOG_TOKEN', 'tok-1');
    vi.stubEnv('HEALTHLOG_SYNC_MEASUREMENTS', 'false');

    const { config } = loadAppConfig();
    const healthlog = config.global_exporters!.find((e) => e.type === 'healthlog');
    expect(healthlog).toEqual({
      type: 'healthlog',
      base_url: 'https://healthlog.example',
      token: 'tok-1',
      sync_measurements: false,
    });
    // Without the env-load mapping the entry is a bare { type } and the
    // factory throws on the missing base_url.
    expect(createExporterFromEntry(healthlog!).name).toBe('healthlog');
  });

  // `.env.example` lists file and strava under "Available", and
  // loadExporterConfig() parses and validates FILE_* and STRAVA_*, but the
  // values never reached the entry: the factory got a bare { type } and the
  // app refused to start with an error pointing at a config.yaml the user does
  // not have.
  it('carries FILE_PATH and FILE_FORMAT into a buildable .env file exporter entry', () => {
    vi.spyOn(fs, 'existsSync').mockImplementation((p) => String(p).endsWith('.env'));
    vi.stubEnv('USER_HEIGHT', '183');
    vi.stubEnv('USER_BIRTH_DATE', '1990-06-15');
    vi.stubEnv('USER_GENDER', 'male');
    vi.stubEnv('USER_IS_ATHLETE', 'true');
    vi.stubEnv('EXPORTERS', 'file');
    vi.stubEnv('FILE_PATH', './measurements.jsonl');
    vi.stubEnv('FILE_FORMAT', 'jsonl');

    const { config } = loadAppConfig();
    const file = config.global_exporters!.find((e) => e.type === 'file');
    expect(file).toEqual({ type: 'file', file_path: './measurements.jsonl', format: 'jsonl' });
    expect(() => createExporterFromEntry(file!)).not.toThrow();
  });

  it('carries the STRAVA_* vars into a buildable .env Strava exporter entry', () => {
    vi.spyOn(fs, 'existsSync').mockImplementation((p) => String(p).endsWith('.env'));
    vi.stubEnv('USER_HEIGHT', '183');
    vi.stubEnv('USER_BIRTH_DATE', '1990-06-15');
    vi.stubEnv('USER_GENDER', 'male');
    vi.stubEnv('USER_IS_ATHLETE', 'true');
    vi.stubEnv('EXPORTERS', 'strava');
    vi.stubEnv('STRAVA_CLIENT_ID', '12345');
    vi.stubEnv('STRAVA_CLIENT_SECRET', 'shh');
    vi.stubEnv('STRAVA_TOKEN_DIR', './my-strava-tokens');

    const { config } = loadAppConfig();
    const strava = config.global_exporters!.find((e) => e.type === 'strava');
    expect(strava).toEqual({
      type: 'strava',
      client_id: '12345',
      client_secret: 'shh',
      // Relative to the directory the .env is in (F-11), here the working
      // directory, since that is where the stubbed .env "exists".
      token_dir: resolvePath(process.cwd(), 'my-strava-tokens'),
    });
    expect(() => createExporterFromEntry(strava!)).not.toThrow();
  });

  // Parsed and range-checked by loadExporterConfig(), then dropped on the way
  // into the entry, so a slow Garmin stayed on the 180 s default (#399).
  it('carries GARMIN_UPLOAD_TIMEOUT_SEC into the .env Garmin exporter entry', () => {
    vi.spyOn(fs, 'existsSync').mockImplementation((p) => String(p).endsWith('.env'));
    vi.stubEnv('USER_HEIGHT', '183');
    vi.stubEnv('USER_BIRTH_DATE', '1990-06-15');
    vi.stubEnv('USER_GENDER', 'male');
    vi.stubEnv('USER_IS_ATHLETE', 'true');
    vi.stubEnv('EXPORTERS', 'garmin');
    vi.stubEnv('GARMIN_UPLOAD_TIMEOUT_SEC', '300');

    const { config } = loadAppConfig();
    const garmin = config.global_exporters!.find((e) => e.type === 'garmin');
    expect(garmin).toMatchObject({ upload_timeout_sec: 300 });
    expect(() => createExporterFromEntry(garmin!)).not.toThrow();
  });

  // Every exporter `.env.example` offers must come out of the legacy loader as
  // an entry the factory can build. Catches the next exporter whose mapping
  // block is forgotten in env-load.ts.
  it('builds every known exporter from its minimal .env variables', () => {
    vi.spyOn(fs, 'existsSync').mockImplementation((p) => String(p).endsWith('.env'));
    vi.stubEnv('USER_HEIGHT', '183');
    vi.stubEnv('USER_BIRTH_DATE', '1990-06-15');
    vi.stubEnv('USER_GENDER', 'male');
    vi.stubEnv('USER_IS_ATHLETE', 'true');
    const minimalEnv: Record<string, string> = {
      MQTT_BROKER_URL: 'mqtt://localhost:1883',
      WEBHOOK_URL: 'https://hook.example/scale',
      INFLUXDB_URL: 'http://localhost:8086',
      INFLUXDB_TOKEN: 'tok',
      INFLUXDB_ORG: 'org',
      INFLUXDB_BUCKET: 'bucket',
      NTFY_TOPIC: 'scale-topic',
      FILE_PATH: './measurements.csv',
      STRAVA_CLIENT_ID: '12345',
      STRAVA_CLIENT_SECRET: 'shh',
      TELEGRAM_BOT_TOKEN: '123:abc',
      TELEGRAM_CHAT_ID: '42',
      INTERVALS_ATHLETE_ID: 'i42',
      INTERVALS_API_KEY: 'key',
      RUNALYZE_TOKEN: 'tok',
      WGER_BASE_URL: 'https://wger.example',
      WGER_TOKEN: 'tok',
      HEALTHLOG_BASE_URL: 'https://healthlog.example',
      HEALTHLOG_TOKEN: 'tok',
    };
    for (const [key, value] of Object.entries(minimalEnv)) vi.stubEnv(key, value);
    vi.stubEnv('EXPORTERS', [...KNOWN_EXPORTER_NAMES].join(','));

    const { config } = loadAppConfig();
    const unbuildable: string[] = [];
    for (const entry of config.global_exporters!) {
      try {
        createExporterFromEntry(entry);
      } catch (err) {
        unbuildable.push(`${entry.type}: ${(err as Error).message}`);
      }
    }
    expect(config.global_exporters!.map((e) => e.type).sort()).toEqual(
      [...KNOWN_EXPORTER_NAMES].sort(),
    );
    expect(unbuildable).toEqual([]);
  });

  it('defaults the .env Garmin entry to weight_only false', () => {
    vi.spyOn(fs, 'existsSync').mockImplementation((p) => String(p).endsWith('.env'));
    vi.stubEnv('USER_HEIGHT', '183');
    vi.stubEnv('USER_BIRTH_DATE', '1990-06-15');
    vi.stubEnv('USER_GENDER', 'male');
    vi.stubEnv('USER_IS_ATHLETE', 'true');
    vi.stubEnv('EXPORTERS', 'garmin');

    const { config } = loadAppConfig();
    expect(config.global_exporters!.find((e) => e.type === 'garmin')).toMatchObject({
      weight_only: false,
    });
  });

  it('exits when no config source exists', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    loadAppConfig();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
