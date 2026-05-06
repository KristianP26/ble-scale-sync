import type { AppConfig } from './schema.js';

/**
 * Subset of config keys that cannot be hot-swapped at runtime. Changing any of
 * these values requires a process restart for the new setting to take effect.
 *
 * Out-of-scope for hot-reload because each would need a full BLE handler /
 * MQTT client / loop teardown. Logged as a warning so users know the edit was
 * accepted into in-memory config but ignored for the live process.
 */
export interface RestartRequiredField {
  key: string;
  oldValue: string;
  newValue: string;
}

function fmt(v: unknown): string {
  if (v === undefined) return '<unset>';
  if (v === null) return 'null';
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
}

const SENSITIVE_KEYS = new Set([
  'ble.mqtt_proxy.password',
  'ble.esphome_proxy.password',
  'ble.esphome_proxy.encryption_key',
]);

function maskSensitive(key: string, val: unknown): string {
  if (!SENSITIVE_KEYS.has(key)) return fmt(val);
  if (val === undefined || val === null || val === '') return '<unset>';
  return '<redacted>';
}

function diffField(
  out: RestartRequiredField[],
  key: string,
  oldVal: unknown,
  newVal: unknown,
): void {
  if (fmt(oldVal) === fmt(newVal)) return;
  out.push({ key, oldValue: maskSensitive(key, oldVal), newValue: maskSensitive(key, newVal) });
}

/**
 * Compare old vs new config and return restart-required field changes.
 *
 * Notably hot-swappable (NOT in this list): scale_mac, weight_unit, height_unit,
 * runtime.dry_run, runtime.debug, runtime.scan_cooldown, exporters,
 * unknown_user, user profile fields, last_known_weight, update_check.
 */
export function diffRestartRequired(
  oldConfig: AppConfig,
  newConfig: AppConfig,
): RestartRequiredField[] {
  const out: RestartRequiredField[] = [];

  diffField(out, 'ble.handler', oldConfig.ble?.handler, newConfig.ble?.handler);
  diffField(out, 'ble.adapter', oldConfig.ble?.adapter, newConfig.ble?.adapter);
  diffField(out, 'ble.noble_driver', oldConfig.ble?.noble_driver, newConfig.ble?.noble_driver);

  const oldMqtt = oldConfig.ble?.mqtt_proxy;
  const newMqtt = newConfig.ble?.mqtt_proxy;
  diffField(out, 'ble.mqtt_proxy.broker_url', oldMqtt?.broker_url, newMqtt?.broker_url);
  diffField(out, 'ble.mqtt_proxy.device_id', oldMqtt?.device_id, newMqtt?.device_id);
  diffField(out, 'ble.mqtt_proxy.topic_prefix', oldMqtt?.topic_prefix, newMqtt?.topic_prefix);
  diffField(out, 'ble.mqtt_proxy.username', oldMqtt?.username, newMqtt?.username);
  diffField(out, 'ble.mqtt_proxy.password', oldMqtt?.password, newMqtt?.password);

  const oldEsp = oldConfig.ble?.esphome_proxy;
  const newEsp = newConfig.ble?.esphome_proxy;
  diffField(out, 'ble.esphome_proxy.host', oldEsp?.host, newEsp?.host);
  diffField(out, 'ble.esphome_proxy.port', oldEsp?.port, newEsp?.port);
  diffField(
    out,
    'ble.esphome_proxy.encryption_key',
    oldEsp?.encryption_key,
    newEsp?.encryption_key,
  );
  diffField(out, 'ble.esphome_proxy.password', oldEsp?.password, newEsp?.password);

  diffField(
    out,
    'runtime.continuous_mode',
    oldConfig.runtime?.continuous_mode,
    newConfig.runtime?.continuous_mode,
  );
  diffField(
    out,
    'runtime.watchdog_max_consecutive_failures',
    oldConfig.runtime?.watchdog_max_consecutive_failures,
    newConfig.runtime?.watchdog_max_consecutive_failures,
  );

  // User count switching between single (==1) and multi (>1) changes the
  // execution path. Same-side renames or weight_range edits do not require a
  // restart and are handled by the regular reload + exporterCache.clear().
  const oldIsMulti = oldConfig.users.length > 1;
  const newIsMulti = newConfig.users.length > 1;
  if (oldIsMulti !== newIsMulti) {
    out.push({
      key: 'users.length',
      oldValue: `${oldConfig.users.length} (${oldIsMulti ? 'multi' : 'single'})`,
      newValue: `${newConfig.users.length} (${newIsMulti ? 'multi' : 'single'})`,
    });
  }

  return out;
}
