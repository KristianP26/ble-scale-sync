import { describe, it, expect } from 'vitest';
import { diffRestartRequired, RESTART_REQUIRED_KEYS } from '../../src/config/reload-diff.js';
import {
  AppConfigSchema,
  BleSchema,
  DockerSchema,
  EsphomeProxySchema,
  HaBluetoothSchema,
  MqttProxySchema,
  RuntimeSchema,
  ScaleSchema,
  type AppConfig,
} from '../../src/config/schema.js';

/**
 * Every config key has a reload policy (architecture audit 2026-10-21, C-01
 * and C-04).
 *
 * The leaves are derived from the schema; the restart side is the list in
 * reload-diff.ts and the hot side is HOT_RELOADABLE below. A new key is in
 * neither, so this fails until somebody decides which it is.
 * `runtime.watch_config` was in neither for as long as it existed: a live edit
 * did nothing and said nothing.
 */

/** Keys a reload applies, or that nothing reads after start-up anyway. */
const HOT_RELOADABLE = [
  'version',
  'unknown_user',
  'out_of_range',
  'users',
  'global_exporters',
  'update_check',
  'scale.weight_unit',
  'scale.height_unit',
  'scale.display_unit',
  'runtime.scan_cooldown',
  'runtime.dry_run',
  'runtime.debug',
  'runtime.idle_rescan_delay',
  'runtime.no_reading_rescan_delay',
  'docker.mode',
  'ble.scale_mac',
  'ble.bind_key',
  'ble.session_timeout_sec',
  'ble.auto_clear_stale_bond',
  'ble.pairing_retry_max_min',
  'ble.preemptive_adapter_reset',
  'ble.proxy_liveness_timeout_min',
  'ble.qn_protocol_byte',
  'ble.qn_report_byte',
  'ble.qn_weight_ack',
  'ble.qn_user_key',
  'ble.qn_a4_prelude',
  'ble.qn_time_sync_long',
  'ble.qn_config_long',
  'ble.qn_result_ack',
  'ble.rmsc04_profile_byte',
];

const shapeKeys = (schema: unknown): string[] =>
  Object.keys((schema as { shape: Record<string, unknown> }).shape);

const SECTIONS: Record<string, unknown> = {
  ble: BleSchema,
  'ble.mqtt_proxy': MqttProxySchema,
  'ble.esphome_proxy': EsphomeProxySchema,
  'ble.ha_bluetooth': HaBluetoothSchema,
  scale: ScaleSchema,
  runtime: RuntimeSchema,
  docker: DockerSchema,
};

/** Every dotted key path the schema declares, sections expanded. */
function schemaLeaves(prefix = '', schema: unknown = AppConfigSchema): string[] {
  return shapeKeys(schema).flatMap((key) => {
    const path = prefix + key;
    return path in SECTIONS ? schemaLeaves(`${path}.`, SECTIONS[path]) : [path];
  });
}

function withValue(path: string, value: unknown): AppConfig {
  const config: Record<string, unknown> = { version: 1, users: [] };
  const keys = path.split('.');
  let at = config;
  for (const k of keys.slice(0, -1)) at = (at[k] ??= {}) as Record<string, unknown>;
  at[keys[keys.length - 1]] = value;
  return config as unknown as AppConfig;
}

describe('reload policy per config key', () => {
  const leaves = schemaLeaves();

  it('every schema key is either restart-required or hot-reloadable, never both', () => {
    const restart = new Set<string>(RESTART_REQUIRED_KEYS);
    expect(HOT_RELOADABLE.filter((k) => restart.has(k))).toEqual([]);
    const classified = new Set([...restart, ...HOT_RELOADABLE]);
    expect(leaves.filter((k) => !classified.has(k))).toEqual([]);
    expect([...classified].filter((k) => !leaves.includes(k))).toEqual([]);
  });

  it.each(leaves)('%s', (key) => {
    const reported = diffRestartRequired(withValue(key, 'before'), withValue(key, 'after'));
    const expected = HOT_RELOADABLE.includes(key) ? [] : [key];
    expect(reported.map((f) => f.key)).toEqual(expected);
  });
});
