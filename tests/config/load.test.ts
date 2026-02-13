import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import {
  resolveEnvReferences,
  detectConfigSource,
  loadYamlConfig,
  loadAppConfig,
  loadBleConfig,
} from '../../src/config/load.js';

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
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);

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
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);

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
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);

    expect(() => loadYamlConfig('/test/config.yaml')).toThrow();
  });

  it('warns and skips unknown exporter types', () => {
    const yamlWithUnknown = VALID_YAML.replace('type: garmin', 'type: fakexporter');
    vi.spyOn(fs, 'readFileSync').mockReturnValue(yamlWithUnknown);
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);

    const config = loadYamlConfig('/test/config.yaml');
    // Unknown exporter should be filtered out
    expect(config.global_exporters).toBeUndefined();
  });

  it('applies env overrides for runtime', () => {
    vi.spyOn(fs, 'readFileSync').mockReturnValue(VALID_YAML);
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.stubEnv('CONTINUOUS_MODE', 'true');
    vi.stubEnv('DRY_RUN', 'true');

    const config = loadYamlConfig('/test/config.yaml');
    expect(config.runtime?.continuous_mode).toBe(true);
    expect(config.runtime?.dry_run).toBe(true);
  });

  it('applies env overrides for BLE', () => {
    vi.spyOn(fs, 'readFileSync').mockReturnValue(VALID_YAML);
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.stubEnv('SCALE_MAC', 'AA:BB:CC:DD:EE:FF');

    const config = loadYamlConfig('/test/config.yaml');
    expect(config.ble?.scale_mac).toBe('AA:BB:CC:DD:EE:FF');
  });

  it('sets NOBLE_DRIVER env var when configured', () => {
    const yamlWithDriver = VALID_YAML.replace(
      'scale_mac: "FF:03:00:13:A1:04"',
      'scale_mac: "FF:03:00:13:A1:04"\n  noble_driver: stoprocent',
    );
    vi.spyOn(fs, 'readFileSync').mockReturnValue(yamlWithDriver);
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);

    loadYamlConfig('/test/config.yaml');
    expect(process.env.NOBLE_DRIVER).toBe('stoprocent');
  });
});

// --- loadBleConfig ---

describe('loadBleConfig', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('reads from YAML when config exists', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'readFileSync').mockReturnValue(`
ble:
  scale_mac: "AA:BB:CC:DD:EE:FF"
  noble_driver: abandonware
`);

    const config = loadBleConfig('/test/config.yaml');
    expect(config.scaleMac).toBe('AA:BB:CC:DD:EE:FF');
    expect(config.nobleDriver).toBe('abandonware');
  });

  it('falls back to env vars when no YAML', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    vi.stubEnv('SCALE_MAC', '11:22:33:44:55:66');
    vi.stubEnv('NOBLE_DRIVER', 'stoprocent');

    const config = loadBleConfig('/nonexistent/config.yaml');
    expect(config.scaleMac).toBe('11:22:33:44:55:66');
    expect(config.nobleDriver).toBe('stoprocent');
  });

  it('returns undefined for missing values', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    delete process.env.SCALE_MAC;
    delete process.env.NOBLE_DRIVER;

    const config = loadBleConfig('/nonexistent/config.yaml');
    expect(config.scaleMac).toBeUndefined();
    expect(config.nobleDriver).toBeUndefined();
  });

  it('handles YAML without ble section', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'readFileSync').mockReturnValue(`
version: 1
scale:
  weight_unit: kg
`);

    const config = loadBleConfig('/test/config.yaml');
    expect(config.scaleMac).toBeUndefined();
    expect(config.nobleDriver).toBeUndefined();
  });

  it('handles invalid YAML gracefully', () => {
    vi.spyOn(fs, 'existsSync').mockImplementation((p) => {
      if (String(p).endsWith('.env')) return false;
      return true;
    });
    vi.spyOn(fs, 'readFileSync').mockImplementation(() => {
      throw new Error('read error');
    });

    // Should not throw — falls through to env vars
    const config = loadBleConfig('/test/config.yaml');
    expect(config.scaleMac).toBeUndefined();
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

  it('exits when no config source exists', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    loadAppConfig();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
