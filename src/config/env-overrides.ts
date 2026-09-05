import { createLogger } from '../logger.js';
import type { AppConfig, ExporterEntry } from './schema.js';
import { KNOWN_EXPORTER_NAMES } from '../exporters/registry.js';

const log = createLogger('Config');

/**
 * Parse and validate BLE_ADAPTER from environment variable.
 * Returns: valid adapter name (string), null (empty = clear override), or undefined (not set / invalid).
 */
export function parseBleAdapterEnv(): string | null | undefined {
  const raw = process.env.BLE_ADAPTER;
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const adapter = trimmed.toLowerCase();
  if (/^hci\d+$/.test(adapter)) return adapter;
  log.warn(`BLE_ADAPTER='${raw}' is not valid (expected hci0, hci1, ...)`);
  return undefined;
}

export function applyEnvOverrides(config: AppConfig): AppConfig {
  const runtime = {
    continuous_mode: config.runtime?.continuous_mode ?? false,
    scan_cooldown: config.runtime?.scan_cooldown ?? 30,
    dry_run: config.runtime?.dry_run ?? false,
    debug: config.runtime?.debug ?? false,
    watchdog_max_consecutive_failures: config.runtime?.watchdog_max_consecutive_failures ?? 10,
    watch_config: config.runtime?.watch_config ?? true,
  };
  const ble = { handler: 'auto' as const, ...config.ble };

  // Runtime overrides
  if (process.env.CONTINUOUS_MODE !== undefined) {
    runtime.continuous_mode = ['true', 'yes', '1'].includes(
      process.env.CONTINUOUS_MODE.toLowerCase(),
    );
  }
  if (process.env.DRY_RUN !== undefined) {
    runtime.dry_run = ['true', 'yes', '1'].includes(process.env.DRY_RUN.toLowerCase());
  }
  if (process.env.DEBUG !== undefined) {
    runtime.debug = ['true', 'yes', '1'].includes(process.env.DEBUG.toLowerCase());
  }
  if (process.env.SCAN_COOLDOWN !== undefined) {
    const num = Number(process.env.SCAN_COOLDOWN);
    if (Number.isFinite(num) && num >= 5 && num <= 3600) {
      runtime.scan_cooldown = num;
    }
  }
  if (process.env.BLE_WATCHDOG_MAX_FAILURES !== undefined) {
    const num = Number(process.env.BLE_WATCHDOG_MAX_FAILURES);
    if (Number.isInteger(num) && num >= 0 && num <= 1000) {
      runtime.watchdog_max_consecutive_failures = num;
    }
  }

  // BLE overrides
  if (process.env.SCALE_MAC !== undefined) {
    ble.scale_mac = process.env.SCALE_MAC;
  }
  const adapterResult = parseBleAdapterEnv();
  if (adapterResult === null) {
    // Empty string clears adapter override (useful in Docker/Compose)
    ble.adapter = undefined;
  } else if (adapterResult !== undefined) {
    ble.adapter = adapterResult;
  }
  if (process.env.NOBLE_DRIVER !== undefined) {
    const driver = process.env.NOBLE_DRIVER.toLowerCase();
    if (driver === 'abandonware' || driver === 'stoprocent') {
      ble.noble_driver = driver;
    }
  }
  if (process.env.BLE_HANDLER !== undefined) {
    const handler = process.env.BLE_HANDLER.toLowerCase();
    if (handler === 'auto') {
      ble.handler = handler;
    } else if (handler === 'mqtt-proxy') {
      if (ble.mqtt_proxy) {
        ble.handler = handler;
      } else {
        log.warn('BLE_HANDLER=mqtt-proxy ignored: ble.mqtt_proxy not configured');
      }
    }
  }

  return { ...config, runtime, ble };
}

export function filterValidExporters(
  entries: ExporterEntry[] | undefined,
): ExporterEntry[] | undefined {
  if (!entries) return undefined;
  const valid: ExporterEntry[] = [];
  for (const entry of entries) {
    if ((KNOWN_EXPORTER_NAMES as Set<string>).has(entry.type)) {
      valid.push(entry);
    } else {
      log.warn(`Unknown exporter type '${entry.type}' in config.yaml — skipping`);
    }
  }
  return valid.length > 0 ? valid : undefined;
}
