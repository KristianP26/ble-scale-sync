import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { collectUnknownKeys } from '../../src/config/unknown-keys.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

const USER = {
  name: 'A',
  slug: 'a',
  height: 180,
  birth_date: '1990-01-01',
  gender: 'male',
  is_athlete: false,
  weight_range: { min: 40, max: 150 },
  last_known_weight: null,
};

const BASE = { version: 1, users: [USER] };

describe('collectUnknownKeys', () => {
  it('returns nothing for the shipped config.yaml.example', () => {
    const parsed: unknown = parseYaml(readFileSync(join(ROOT, 'config.yaml.example'), 'utf-8'));
    expect(collectUnknownKeys(parsed)).toEqual([]);
  });

  it('returns nothing for the config the add-on run.sh generates', () => {
    // Mirrors every key ble-scale-sync-addon/run.sh writes into config.yaml.
    // If this test starts failing, run.sh emits a key no schema declares and
    // every add-on user would see the warning on every start.
    const generated = {
      version: 1,
      ble: {
        scale_mac: '03:B3:EC:91:A2:12',
        adapter: 'hci0',
        force_scale_adapter: 'Hutbit',
        qn_protocol_byte: 255,
        qn_report_byte: 252,
      },
      scale: { weight_unit: 'kg', height_unit: 'cm' },
      unknown_user: 'nearest',
      users: [{ ...USER, exporters: [{ type: 'mqtt', broker_url: 'mqtt://h:1883' }] }],
      global_exporters: [{ type: 'mqtt', broker_url: 'mqtt://h:1883', qos: 0, retain: true }],
      runtime: { continuous_mode: true, scan_cooldown: 30, dry_run: false, debug: false },
      update_check: true,
    };
    expect(collectUnknownKeys(generated)).toEqual([]);
  });

  it('reports a misspelled key under ble', () => {
    const cfg = {
      ...BASE,
      ble: { scale_mac: '03:B3:EC:91:A2:12', force_scale_adaptr: 'Hutbit' },
    };
    expect(collectUnknownKeys(cfg)).toEqual(['ble.force_scale_adaptr']);
  });

  it('reports an unknown top level key', () => {
    expect(collectUnknownKeys({ ...BASE, forse_scale_adapter: 'Hutbit' })).toEqual([
      'forse_scale_adapter',
    ]);
  });

  it('reports an unknown key under runtime', () => {
    const cfg = { ...BASE, runtime: { continuous_mode: true, watch_confg: false } };
    expect(collectUnknownKeys(cfg)).toEqual(['runtime.watch_confg']);
  });

  it('reports an unknown key on a specific user by index', () => {
    const cfg = { ...BASE, users: [USER, { ...USER, slug: 'b', beurer_pinn: 1234 }] };
    expect(collectUnknownKeys(cfg)).toEqual(['users.1.beurer_pinn']);
  });

  it('reports an unknown key under ble.mqtt_proxy', () => {
    const cfg = { ...BASE, ble: { mqtt_proxy: { broker_url: 'mqtt://h:1883', devcie_id: 'x' } } };
    expect(collectUnknownKeys(cfg)).toEqual(['ble.mqtt_proxy.devcie_id']);
  });

  it('reports an unknown key under ble.esphome_proxy', () => {
    const cfg = { ...BASE, ble: { esphome_proxy: { host: '10.0.0.5', encryption_ky: 'x' } } };
    expect(collectUnknownKeys(cfg)).toEqual(['ble.esphome_proxy.encryption_ky']);
  });

  it('reports an unknown key inside additional_proxies by index', () => {
    const cfg = {
      ...BASE,
      ble: {
        esphome_proxy: {
          host: 'h',
          additional_proxies: [{ host: 'h2' }, { host: 'h3', prt: 6053 }],
        },
      },
    };
    expect(collectUnknownKeys(cfg)).toEqual(['ble.esphome_proxy.additional_proxies.1.prt']);
  });

  it('does not report global exporter options, which are passthrough by design', () => {
    const cfg = {
      ...BASE,
      global_exporters: [
        { type: 'influxdb', url: 'http://h:8086', token: 't', org: 'o', bucket: 'b' },
      ],
    };
    expect(collectUnknownKeys(cfg)).toEqual([]);
  });

  it('does not report per-user exporter options', () => {
    const cfg = {
      ...BASE,
      users: [{ ...USER, exporters: [{ type: 'ntfy', topic: 't', server: 'https://ntfy.sh' }] }],
    };
    expect(collectUnknownKeys(cfg)).toEqual([]);
  });

  it('accepts every key BleSchema declares', () => {
    const cfg = {
      ...BASE,
      ble: {
        scale_mac: '03:B3:EC:91:A2:12',
        bind_key: '0'.repeat(32),
        noble_driver: 'abandonware',
        handler: 'auto',
        adapter: 'hci0',
        force_scale_adapter: 'Hutbit',
        mqtt_proxy: { broker_url: 'mqtt://h:1883' },
        esphome_proxy: { host: 'h' },
      },
    };
    expect(collectUnknownKeys(cfg)).toEqual([]);
  });

  it('does not throw on a non object section', () => {
    expect(collectUnknownKeys({ ...BASE, ble: 'nonsense' })).toEqual([]);
  });

  it('does not throw on a null section', () => {
    expect(collectUnknownKeys({ ...BASE, ble: null })).toEqual([]);
  });

  it('does not throw on a non array users value', () => {
    expect(collectUnknownKeys({ ...BASE, users: 'nope' })).toEqual([]);
  });

  it('returns nothing for a non object root', () => {
    expect(collectUnknownKeys(null)).toEqual([]);
    expect(collectUnknownKeys('nope')).toEqual([]);
    expect(collectUnknownKeys([1, 2])).toEqual([]);
  });
});
