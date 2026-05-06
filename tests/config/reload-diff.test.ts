import { describe, it, expect } from 'vitest';
import { diffRestartRequired } from '../../src/config/reload-diff.js';
import type { AppConfig } from '../../src/config/schema.js';

function baseConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    version: 1,
    scale: { weight_unit: 'kg', height_unit: 'cm' },
    unknown_user: 'nearest',
    update_check: true,
    users: [
      {
        name: 'Alice',
        slug: 'alice',
        height: 170,
        birth_date: '1990-01-01',
        gender: 'female',
        is_athlete: false,
        weight_range: { min: 50, max: 70 },
        last_known_weight: null,
      },
    ],
    ...overrides,
  } as AppConfig;
}

describe('diffRestartRequired', () => {
  it('returns empty array when nothing relevant changed', () => {
    const a = baseConfig();
    const b = baseConfig();
    expect(diffRestartRequired(a, b)).toEqual([]);
  });

  it('flags ble.handler change', () => {
    const a = baseConfig({ ble: { handler: 'auto' } });
    const b = baseConfig({ ble: { handler: 'mqtt-proxy' } });
    const diff = diffRestartRequired(a, b);
    expect(diff).toEqual([{ key: 'ble.handler', oldValue: 'auto', newValue: 'mqtt-proxy' }]);
  });

  it('flags ble.adapter change', () => {
    const a = baseConfig({ ble: { handler: 'auto', adapter: 'hci0' } });
    const b = baseConfig({ ble: { handler: 'auto', adapter: 'hci1' } });
    const diff = diffRestartRequired(a, b);
    expect(diff.find((f) => f.key === 'ble.adapter')).toEqual({
      key: 'ble.adapter',
      oldValue: 'hci0',
      newValue: 'hci1',
    });
  });

  it('flags mqtt_proxy.broker_url change', () => {
    const a = baseConfig({
      ble: {
        handler: 'mqtt-proxy',
        mqtt_proxy: {
          broker_url: 'mqtt://a:1883',
          device_id: 'esp',
          username: null,
          password: null,
          topic_prefix: 'ble',
          embedded_broker_port: 1883,
          embedded_broker_bind: '127.0.0.1',
        },
      },
    });
    const b = baseConfig({
      ble: {
        handler: 'mqtt-proxy',
        mqtt_proxy: {
          broker_url: 'mqtt://b:1883',
          device_id: 'esp',
          username: null,
          password: null,
          topic_prefix: 'ble',
          embedded_broker_port: 1883,
          embedded_broker_bind: '127.0.0.1',
        },
      },
    });
    const diff = diffRestartRequired(a, b);
    expect(diff.find((f) => f.key === 'ble.mqtt_proxy.broker_url')).toBeDefined();
  });

  it('flags switch from single to multi user (and back)', () => {
    const single = baseConfig();
    const multi = baseConfig({
      users: [
        ...single.users,
        {
          name: 'Bob',
          slug: 'bob',
          height: 180,
          birth_date: '1985-05-15',
          gender: 'male',
          is_athlete: true,
          weight_range: { min: 75, max: 95 },
          last_known_weight: null,
        },
      ],
    });
    const diff = diffRestartRequired(single, multi);
    expect(diff.find((f) => f.key === 'users.length')).toEqual({
      key: 'users.length',
      oldValue: '1 (single)',
      newValue: '2 (multi)',
    });
  });

  it('does NOT flag user profile edits within the same multi/single bucket', () => {
    const a = baseConfig();
    const b = baseConfig({
      users: [{ ...baseConfig().users[0], height: 175, last_known_weight: 65.5 }],
    });
    expect(diffRestartRequired(a, b)).toEqual([]);
  });

  it('does NOT flag scale.weight_unit / unknown_user / runtime.dry_run / scale_mac', () => {
    const a = baseConfig({
      ble: { handler: 'auto', scale_mac: 'AA:BB:CC:DD:EE:FF' },
      runtime: { dry_run: false } as AppConfig['runtime'],
    });
    const b = baseConfig({
      ble: { handler: 'auto', scale_mac: 'FF:EE:DD:CC:BB:AA' },
      scale: { weight_unit: 'lbs', height_unit: 'in' },
      unknown_user: 'log',
      runtime: { dry_run: true } as AppConfig['runtime'],
    });
    expect(diffRestartRequired(a, b)).toEqual([]);
  });

  it('flags runtime.continuous_mode change', () => {
    const a = baseConfig({ runtime: { continuous_mode: false } as AppConfig['runtime'] });
    const b = baseConfig({ runtime: { continuous_mode: true } as AppConfig['runtime'] });
    const diff = diffRestartRequired(a, b);
    expect(diff.find((f) => f.key === 'runtime.continuous_mode')).toEqual({
      key: 'runtime.continuous_mode',
      oldValue: 'false',
      newValue: 'true',
    });
  });
});
