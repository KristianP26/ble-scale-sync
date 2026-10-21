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

// Secret fields nested inside a compared value, e.g. each additional_proxies
// entry carries its own encryption_key and password.
const SENSITIVE_FIELD_NAMES = new Set(['password', 'encryption_key', 'token']);

function redactSecret(val: unknown): string {
  if (val === undefined || val === null || val === '') return '<unset>';
  return '<redacted>';
}

/** Hide the password in a URL's userinfo (`mqtt://user:pass@host`); other strings pass through. */
function redactUrl(s: string): string {
  if (!s.includes('@')) return s;
  try {
    const u = new URL(s);
    if (!u.password) return s;
    u.password = '<redacted>';
    return u.toString();
  } catch {
    return s;
  }
}

function redactDeep(val: unknown): unknown {
  if (typeof val === 'string') return redactUrl(val);
  if (Array.isArray(val)) return val.map(redactDeep);
  if (val !== null && typeof val === 'object') {
    return Object.fromEntries(
      Object.entries(val).map(([k, v]) => [
        k,
        SENSITIVE_FIELD_NAMES.has(k) ? redactSecret(v) : redactDeep(v),
      ]),
    );
  }
  return val;
}

function maskSensitive(key: string, val: unknown): string {
  if (SENSITIVE_KEYS.has(key)) return redactSecret(val);
  return fmt(redactDeep(val));
}

/**
 * The keys a reload cannot apply, in the order they are reported.
 *
 * Notably hot-swappable (NOT in this list): scale_mac, weight_unit, height_unit, display_unit,
 * runtime.dry_run, runtime.debug, runtime.scan_cooldown, runtime.idle_rescan_delay,
 * runtime.no_reading_rescan_delay (a wait already running is not shortened),
 * ble.session_timeout_sec, ble.auto_clear_stale_bond, ble.pairing_retry_max_min,
 * ble.preemptive_adapter_reset,
 * ble.bind_key, every ble.qn_*,
 * ble.proxy_liveness_timeout_min, exporters,
 * unknown_user, out_of_range, user profile fields, last_known_weight, update_check.
 *
 * No row for switching between one user and several: processReading picks the
 * single- or multi-user path from the live config on every reading, and the
 * reload rebuilds the single-user exporters, so the switch takes effect at once
 * (E-18). Only the startup banner and the startup healthchecks keep the old
 * count, and neither changes what is exported.
 */
export const RESTART_REQUIRED_KEYS = [
  'ble.handler',
  'ble.adapter',
  'ble.noble_driver',
  // Read once into the context. Turning it off live would also leave the
  // adapter's privacy on, so a restart is the honest answer either way (#417).
  'ble.adapter_privacy',
  // The adapter list is built once, before the loop starts (run.ts), so a
  // hot-edited value changes nothing until a restart. Without this row the user
  // gets neither the effect nor the warning, which is neither half of the
  // documented reload contract (#407).
  'ble.force_scale_adapter',
  'ble.mqtt_proxy.broker_url',
  'ble.mqtt_proxy.device_id',
  'ble.mqtt_proxy.topic_prefix',
  'ble.mqtt_proxy.username',
  'ble.mqtt_proxy.password',
  // The embedded broker is bootstrapped once at startup, so these two are as
  // restart-required as the connection fields above (#407).
  'ble.mqtt_proxy.embedded_broker_port',
  'ble.mqtt_proxy.embedded_broker_bind',
  // The watcher keeps the value it was built with until a restart.
  'ble.mqtt_proxy.auto_connect',
  'ble.esphome_proxy.host',
  'ble.esphome_proxy.port',
  'ble.esphome_proxy.encryption_key',
  'ble.esphome_proxy.password',
  // The proxy pool is built when the watcher starts and is not rebuilt on
  // reload, so these three change nothing until a restart either.
  'ble.esphome_proxy.client_info',
  'ble.esphome_proxy.additional_proxies',
  'ble.esphome_proxy.advertisement_timeout',
  'ble.ha_bluetooth.url',
  'ble.ha_bluetooth.token',
  'ble.ha_bluetooth.source',
  'runtime.continuous_mode',
  // The queue path is resolved once in createAppContext, so flipping this key
  // does nothing until a restart. Without this row the user would get neither
  // the effect nor the warning, which is the gap ble.force_scale_adapter had.
  'runtime.retry_failed_exports',
  'runtime.watchdog_max_consecutive_failures',
  // The watcher is started once, before the loop, and a reload neither starts
  // nor stops it.
  'runtime.watch_config',
];

function valueAt(config: AppConfig, key: string): unknown {
  return key
    .split('.')
    .reduce<unknown>((at, k) => (at as Record<string, unknown> | null | undefined)?.[k], config);
}

/** Compare old vs new config and return restart-required field changes. */
export function diffRestartRequired(
  oldConfig: AppConfig,
  newConfig: AppConfig,
): RestartRequiredField[] {
  const out: RestartRequiredField[] = [];
  for (const key of RESTART_REQUIRED_KEYS) {
    const oldVal = valueAt(oldConfig, key);
    const newVal = valueAt(newConfig, key);
    if (fmt(oldVal) === fmt(newVal)) continue;
    out.push({ key, oldValue: maskSensitive(key, oldVal), newValue: maskSensitive(key, newVal) });
  }
  return out;
}
