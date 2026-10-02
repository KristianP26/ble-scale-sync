import { createLogger } from '../logger.js';
import type { AppConfig, ExporterEntry } from './schema.js';
import { KNOWN_EXPORTER_NAMES } from '../exporters/registry.js';
import { isValidScaleId, SCALE_ID_HINT } from '../ble/scale-id.js';

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

const TRUE_WORDS = new Set(['true', 'yes', 'on', '1']);
const FALSE_WORDS = new Set(['false', 'no', 'off', '0']);

/**
 * Read a boolean override, keeping the configured value when the input is not
 * a boolean at all.
 *
 * The old form was `['true','yes','1'].includes(raw.toLowerCase())`, which has
 * no notion of an invalid value: everything that is not a recognised TRUE word
 * is FALSE. `DRY_RUN=treu` therefore did not fail, and did not leave
 * `dry_run: true` from config.yaml alone either - it turned dry-run OFF and
 * exported for real, which is precisely the promise that flag exists to make.
 *
 * Unknown input warns and keeps the configured value, matching what every
 * other override in this file already does (SCAN_COOLDOWN, NOBLE_DRIVER,
 * BLE_HANDLER): a bad env var must never be more powerful than a good one. An
 * empty value is how a compose file neutralises a variable, so it is exempt.
 */
function boolEnv(name: string, current: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return current;
  const word = raw.trim().toLowerCase();
  if (word === '') return current;
  if (TRUE_WORDS.has(word)) return true;
  if (FALSE_WORDS.has(word)) return false;
  log.warn(
    `${name}='${raw}' is not a boolean (true/false, yes/no, on/off, 1/0); ` +
      `keeping ${name.toLowerCase()}=${current} from the configuration.`,
  );
  return current;
}

export function applyEnvOverrides(config: AppConfig): AppConfig {
  const runtime = {
    continuous_mode: config.runtime?.continuous_mode ?? false,
    scan_cooldown: config.runtime?.scan_cooldown ?? 30,
    dry_run: config.runtime?.dry_run ?? false,
    debug: config.runtime?.debug ?? false,
    watchdog_max_consecutive_failures: config.runtime?.watchdog_max_consecutive_failures ?? 10,
    watch_config: config.runtime?.watch_config ?? true,
    idle_rescan_delay: config.runtime?.idle_rescan_delay ?? 5,
    retry_failed_exports: config.runtime?.retry_failed_exports ?? true,
  };
  const ble = { handler: 'auto' as const, ...config.ble };

  // Runtime overrides
  runtime.continuous_mode = boolEnv('CONTINUOUS_MODE', runtime.continuous_mode);
  runtime.dry_run = boolEnv('DRY_RUN', runtime.dry_run);
  runtime.debug = boolEnv('DEBUG', runtime.debug);
  if (process.env.SCAN_COOLDOWN !== undefined) {
    const num = Number(process.env.SCAN_COOLDOWN);
    // Integer, to match the schema. The schema has always required one; this
    // path accepted any finite number in range, so 12.5 reached the runtime
    // through the env var and not through config.yaml.
    if (Number.isInteger(num) && num >= 5 && num <= 3600) {
      runtime.scan_cooldown = num;
    } else {
      log.warn(
        `SCAN_COOLDOWN='${process.env.SCAN_COOLDOWN}' is not a whole number of ` +
          `seconds between 5 and 3600; keeping scan_cooldown=${runtime.scan_cooldown}.`,
      );
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
    // The schema refines this with isValidScaleId; the env path assigned it
    // raw, so a typo that config.yaml would have rejected at startup instead
    // became a scale id that can never match and a scan that never finds
    // anything.
    const raw = process.env.SCALE_MAC.trim();
    if (raw === '') {
      ble.scale_mac = undefined;
    } else if (isValidScaleId(raw)) {
      ble.scale_mac = raw;
    } else {
      log.warn(
        `SCALE_MAC='${process.env.SCALE_MAC}' is not valid (${SCALE_ID_HINT}); ignoring it.`,
      );
    }
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
    } else if (handler === 'ha-bluetooth') {
      if (ble.ha_bluetooth) {
        ble.handler = handler;
      } else {
        log.warn('BLE_HANDLER=ha-bluetooth ignored: ble.ha_bluetooth not configured');
      }
    } else if (handler === 'esphome-proxy') {
      // Was missing entirely: the value is in the schema's own enum, so it
      // validates in config.yaml but fell through every branch here and was
      // dropped in silence (#407).
      if (ble.esphome_proxy) {
        ble.handler = handler;
      } else {
        log.warn('BLE_HANDLER=esphome-proxy ignored: ble.esphome_proxy not configured');
      }
    } else if (handler !== '') {
      // Anything else used to be ignored without a word, which reads exactly
      // like a handler switch that worked. An EMPTY value is exempt: setting a
      // variable to nothing is how a compose file neutralises it, and warning
      // about that on every start would be noise.
      log.warn(
        `BLE_HANDLER='${process.env.BLE_HANDLER}' is not a known handler ` +
          `(auto, mqtt-proxy, esphome-proxy, ha-bluetooth); ignoring it.`,
      );
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
