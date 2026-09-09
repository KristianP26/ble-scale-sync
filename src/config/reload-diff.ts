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
  'ble.ha_bluetooth.token',
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
 * runtime.dry_run, runtime.debug, runtime.scan_cooldown, runtime.idle_rescan_delay,
 * ble.session_timeout_sec, ble.auto_clear_stale_bond, ble.bind_key, every ble.qn_*,
 * ble.proxy_liveness_timeout_min, exporters,
 * unknown_user, out_of_range, user profile fields, last_known_weight, update_check.
 */
export function diffRestartRequired(
  oldConfig: AppConfig,
  newConfig: AppConfig,
): RestartRequiredField[] {
  const out: RestartRequiredField[] = [];

  diffField(out, 'ble.handler', oldConfig.ble?.handler, newConfig.ble?.handler);
  diffField(out, 'ble.adapter', oldConfig.ble?.adapter, newConfig.ble?.adapter);
  diffField(out, 'ble.noble_driver', oldConfig.ble?.noble_driver, newConfig.ble?.noble_driver);
  // The adapter list is built once, before the loop starts (run.ts), so a
  // hot-edited value changes nothing until a restart. Without this row the user
  // gets neither the effect nor the warning, which is neither half of the
  // documented reload contract (#407).
  diffField(
    out,
    'ble.force_scale_adapter',
    oldConfig.ble?.force_scale_adapter,
    newConfig.ble?.force_scale_adapter,
  );

  const oldMqtt = oldConfig.ble?.mqtt_proxy;
  const newMqtt = newConfig.ble?.mqtt_proxy;
  diffField(out, 'ble.mqtt_proxy.broker_url', oldMqtt?.broker_url, newMqtt?.broker_url);
  diffField(out, 'ble.mqtt_proxy.device_id', oldMqtt?.device_id, newMqtt?.device_id);
  diffField(out, 'ble.mqtt_proxy.topic_prefix', oldMqtt?.topic_prefix, newMqtt?.topic_prefix);
  diffField(out, 'ble.mqtt_proxy.username', oldMqtt?.username, newMqtt?.username);
  diffField(out, 'ble.mqtt_proxy.password', oldMqtt?.password, newMqtt?.password);
  // The embedded broker is bootstrapped once at startup, so these two are as
  // restart-required as the connection fields above (#407).
  diffField(
    out,
    'ble.mqtt_proxy.embedded_broker_port',
    oldMqtt?.embedded_broker_port,
    newMqtt?.embedded_broker_port,
  );
  diffField(
    out,
    'ble.mqtt_proxy.embedded_broker_bind',
    oldMqtt?.embedded_broker_bind,
    newMqtt?.embedded_broker_bind,
  );

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
  // The proxy pool is built when the watcher starts and is not rebuilt on
  // reload, so these three change nothing until a restart either.
  diffField(out, 'ble.esphome_proxy.client_info', oldEsp?.client_info, newEsp?.client_info);
  diffField(
    out,
    'ble.esphome_proxy.additional_proxies',
    oldEsp?.additional_proxies,
    newEsp?.additional_proxies,
  );
  diffField(
    out,
    'ble.esphome_proxy.advertisement_timeout',
    oldEsp?.advertisement_timeout,
    newEsp?.advertisement_timeout,
  );

  const oldHa = oldConfig.ble?.ha_bluetooth;
  const newHa = newConfig.ble?.ha_bluetooth;
  diffField(out, 'ble.ha_bluetooth.url', oldHa?.url, newHa?.url);
  diffField(out, 'ble.ha_bluetooth.token', oldHa?.token, newHa?.token);
  diffField(out, 'ble.ha_bluetooth.source', oldHa?.source, newHa?.source);

  diffField(
    out,
    'runtime.continuous_mode',
    oldConfig.runtime?.continuous_mode,
    newConfig.runtime?.continuous_mode,
  );
  // The queue path is resolved once in createAppContext, so flipping this key
  // does nothing until a restart. Without this row the user would get neither
  // the effect nor the warning, which is the gap ble.force_scale_adapter had.
  diffField(
    out,
    'runtime.retry_failed_exports',
    oldConfig.runtime?.retry_failed_exports,
    newConfig.runtime?.retry_failed_exports,
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
