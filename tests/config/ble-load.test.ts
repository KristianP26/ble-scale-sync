import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadBleConfig } from '../../src/config/ble-load.js';
import { loadEnvFile } from '../../src/config/env-refs.js';

// G-05: scan and diagnose read the BLE section raw from parseYaml: no ${VAR}
// expansion, no schema defaults, no validation and no --config. A hand-written
// mqtt-proxy config relying on the defaults made scan listen on
// `undefined/undefined/...`, and `ha_bluetooth.token: ${HA_TOKEN}` (what the
// schema comment and the wizard recommend) went to Home Assistant literally.

const TOKEN_VAR = 'BSS_TEST_G05_HA_TOKEN';
const OVERRIDES = ['SCALE_MAC', 'BLE_HANDLER', 'NOBLE_DRIVER', 'BLE_ADAPTER'] as const;
const saved: Record<string, string | undefined> = {};
const dirs: string[] = [];

/** A config.yaml (and optionally a .env) in a fresh directory, never the cwd. */
function setup(yaml: string, envFile?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'bss-ble-load-'));
  dirs.push(dir);
  const configPath = join(dir, 'config.yaml');
  writeFileSync(configPath, yaml);
  if (envFile !== undefined) writeFileSync(join(dir, '.env'), envFile);
  return configPath;
}

beforeEach(() => {
  for (const k of OVERRIDES) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(join(dir, '.env'), { force: true });
    loadEnvFile(join(dir, '.env'));
    rmSync(dir, { recursive: true, force: true });
  }
  delete process.env[TOKEN_VAR];
  for (const k of OVERRIDES) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.restoreAllMocks();
});

describe('loadBleConfig with a config.yaml (G-05)', () => {
  it('fills the mqtt_proxy schema defaults the transport needs', () => {
    const config = loadBleConfig(
      setup(
        [
          'ble:',
          '  handler: mqtt-proxy',
          '  mqtt_proxy:',
          '    embedded_broker_bind: 127.0.0.1',
          '',
        ].join('\n'),
      ),
    );
    expect(config.bleHandler).toBe('mqtt-proxy');
    expect(config.mqttProxy).toMatchObject({
      device_id: 'esp32-ble-proxy',
      topic_prefix: 'ble-proxy',
      embedded_broker_port: 1883,
      auto_connect: true,
    });
  });

  it('fills the esphome_proxy port default', () => {
    const config = loadBleConfig(
      setup(
        ['ble:', '  handler: esphome-proxy', '  esphome_proxy:', '    host: proxy.local', ''].join(
          '\n',
        ),
      ),
    );
    expect(config.esphomeProxy).toMatchObject({ host: 'proxy.local', port: 6053 });
  });

  it('resolves ${VAR} from the .env next to the given config file', () => {
    const configPath = setup(
      [
        'ble:',
        '  handler: ha-bluetooth',
        '  ha_bluetooth:',
        '    url: http://homeassistant.local:8123',
        `    token: \${${TOKEN_VAR}}`,
        '',
      ].join('\n'),
      `${TOKEN_VAR}=token-from-env-file\n`,
    );
    expect(loadBleConfig(configPath).haBluetooth?.token).toBe('token-from-env-file');
  });

  it('does not need a user profile or the exporters', () => {
    // An unresolvable reference outside `ble` is not this tool's business.
    const config = loadBleConfig(
      setup(
        [
          'ble:',
          '  scale_mac: "AA:BB:CC:DD:EE:FF"',
          'global_exporters:',
          '  - type: webhook',
          '    url: ${BSS_TEST_G05_NEVER_DEFINED}',
          '',
        ].join('\n'),
      ),
    );
    expect(config.scaleMac).toBe('AA:BB:CC:DD:EE:FF');
  });

  it('refuses an invalid ble section the app would refuse', () => {
    const configPath = setup(['ble:', '  handler: mqtt-proxy', ''].join('\n'));
    expect(() => loadBleConfig(configPath)).toThrow(/mqtt_proxy/);
  });

  it('applies an override from the real environment, like the app', () => {
    process.env.SCALE_MAC = 'AA:BB:CC:DD:EE:03';
    const config = loadBleConfig(
      setup(['ble:', '  scale_mac: "AA:BB:CC:DD:EE:02"', ''].join('\n')),
    );
    expect(config.scaleMac).toBe('AA:BB:CC:DD:EE:03');
  });

  it('ignores an override left in .env, like the app', () => {
    const config = loadBleConfig(
      setup(
        ['ble:', '  scale_mac: "AA:BB:CC:DD:EE:02"', ''].join('\n'),
        'SCALE_MAC=AA:BB:CC:DD:EE:01\n',
      ),
    );
    expect(config.scaleMac).toBe('AA:BB:CC:DD:EE:02');
  });

  it('names a --config path that does not exist instead of scanning with defaults', () => {
    const missing = join(tmpdir(), 'bss-ble-load-missing', 'config.yaml');
    expect(() => loadBleConfig(missing)).toThrow(/not found/i);
  });
});
