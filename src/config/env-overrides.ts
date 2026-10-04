import { createLogger } from '../logger.js';
import type { AppConfig, BleConfig, ExporterEntry } from './schema.js';
import { KNOWN_EXPORTER_NAMES } from '../exporters/registry.js';
import { isValidScaleId, SCALE_ID_HINT } from '../ble/scale-id.js';
import { BOOL_WORDS_HINT, isFromEnvFile, parseBoolWord } from './env-refs.js';

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

/**
 * The raw value of an override variable, or undefined when there is none to
 * apply.
 *
 * Only the real environment overrides config.yaml (G-03). The .env next to
 * config.yaml is loaded into process.env so `${VAR}` references can resolve,
 * which let every override name a leftover legacy .env still carried
 * (SCALE_MAC, DRY_RUN, ...) beat config.yaml without a word in the log: a
 * scale_mac changed in config.yaml then had no effect at all. Such a value is
 * now ignored and named, never echoed, since a .env holds secrets. An empty
 * one is how a template leaves a line blank, so it is ignored quietly.
 */
function readOverride(name: string, field: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  if (!isFromEnvFile(name)) return raw;
  if (raw.trim() !== '') {
    log.warn(
      `${name} is set in the .env file next to config.yaml and is ignored: with config.yaml, ` +
        'overrides come only from the real environment (docker -e, compose environment:). ' +
        `Remove ${name} from .env, or set ${field} in config.yaml.`,
    );
  }
  return undefined;
}

/**
 * Say that an environment variable replaced a configured value, so a config
 * edit that "does nothing" can be traced to it. The value is not logged.
 */
function noteOverride(name: string, field: string): void {
  log.info(`${name} is set in the environment and overrides ${field} from config.yaml.`);
}

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
function boolEnv(name: string, field: string, current: boolean): boolean {
  const raw = readOverride(name, field);
  if (raw === undefined) return current;
  if (raw.trim() === '') return current;
  const value = parseBoolWord(raw);
  if (value !== undefined) {
    noteOverride(name, field);
    return value;
  }
  log.warn(
    `${name}='${raw}' is not a boolean (${BOOL_WORDS_HINT}); ` +
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

  // Runtime overrides
  runtime.continuous_mode = boolEnv(
    'CONTINUOUS_MODE',
    'runtime.continuous_mode',
    runtime.continuous_mode,
  );
  runtime.dry_run = boolEnv('DRY_RUN', 'runtime.dry_run', runtime.dry_run);
  runtime.debug = boolEnv('DEBUG', 'runtime.debug', runtime.debug);
  const cooldown = readOverride('SCAN_COOLDOWN', 'runtime.scan_cooldown');
  if (cooldown !== undefined) {
    const num = Number(cooldown);
    // Integer, to match the schema. The schema has always required one; this
    // path accepted any finite number in range, so 12.5 reached the runtime
    // through the env var and not through config.yaml.
    if (Number.isInteger(num) && num >= 5 && num <= 3600) {
      runtime.scan_cooldown = num;
      noteOverride('SCAN_COOLDOWN', 'runtime.scan_cooldown');
    } else {
      log.warn(
        `SCAN_COOLDOWN='${cooldown}' is not a whole number of ` +
          `seconds between 5 and 3600; keeping scan_cooldown=${runtime.scan_cooldown}.`,
      );
    }
  }
  const watchdogField = 'runtime.watchdog_max_consecutive_failures';
  const watchdog = readOverride('BLE_WATCHDOG_MAX_FAILURES', watchdogField);
  if (watchdog !== undefined) {
    const num = Number(watchdog);
    // An empty value neutralises the variable (compose); anything else that is
    // not a valid count is named rather than dropped without a word (G-22).
    if (watchdog.trim() !== '' && Number.isInteger(num) && num >= 0 && num <= 1000) {
      runtime.watchdog_max_consecutive_failures = num;
      noteOverride('BLE_WATCHDOG_MAX_FAILURES', watchdogField);
    } else if (watchdog.trim() !== '') {
      log.warn(
        `BLE_WATCHDOG_MAX_FAILURES='${watchdog}' is not a whole number between 0 and 1000; ` +
          `keeping watchdog_max_consecutive_failures=${runtime.watchdog_max_consecutive_failures}.`,
      );
    }
  }

  return { ...config, runtime, ble: applyBleEnvOverrides(config.ble) };
}

/**
 * The `ble` section with the BLE environment overrides applied. Shared by the
 * app ({@link applyEnvOverrides}) and by `scan` and `diagnose`, which load only
 * this section (G-05).
 */
export function applyBleEnvOverrides(configured: BleConfig | undefined): BleConfig {
  const ble: BleConfig = { handler: 'auto', ...configured };

  const mac = readOverride('SCALE_MAC', 'ble.scale_mac');
  if (mac !== undefined) {
    // The schema refines this with isValidScaleId; the env path assigned it
    // raw, so a typo that config.yaml would have rejected at startup instead
    // became a scale id that can never match and a scan that never finds
    // anything.
    const raw = mac.trim();
    if (raw === '') {
      if (ble.scale_mac) noteOverride('SCALE_MAC', 'ble.scale_mac');
      ble.scale_mac = undefined;
    } else if (isValidScaleId(raw)) {
      ble.scale_mac = raw;
      noteOverride('SCALE_MAC', 'ble.scale_mac');
    } else {
      log.warn(`SCALE_MAC='${mac}' is not valid (${SCALE_ID_HINT}); ignoring it.`);
    }
  }
  if (readOverride('BLE_ADAPTER', 'ble.adapter') !== undefined) {
    const adapterResult = parseBleAdapterEnv();
    if (adapterResult === null) {
      // Empty string clears adapter override (useful in Docker/Compose)
      if (ble.adapter) noteOverride('BLE_ADAPTER', 'ble.adapter');
      ble.adapter = undefined;
    } else if (adapterResult !== undefined) {
      ble.adapter = adapterResult;
      noteOverride('BLE_ADAPTER', 'ble.adapter');
    }
  }
  const nobleDriver = readOverride('NOBLE_DRIVER', 'ble.noble_driver');
  if (nobleDriver !== undefined) {
    const driver = nobleDriver.trim().toLowerCase();
    if (driver === 'abandonware' || driver === 'stoprocent') {
      ble.noble_driver = driver;
      noteOverride('NOBLE_DRIVER', 'ble.noble_driver');
    } else if (driver !== '') {
      log.warn(`NOBLE_DRIVER='${nobleDriver}' is not abandonware or stoprocent; ignoring it.`);
    }
  }
  const handlerRaw = readOverride('BLE_HANDLER', 'ble.handler');
  if (handlerRaw !== undefined) {
    const handler = handlerRaw.toLowerCase();
    if (handler === 'auto') {
      ble.handler = handler;
      noteOverride('BLE_HANDLER', 'ble.handler');
    } else if (handler === 'mqtt-proxy') {
      if (ble.mqtt_proxy) {
        ble.handler = handler;
        noteOverride('BLE_HANDLER', 'ble.handler');
      } else {
        log.warn('BLE_HANDLER=mqtt-proxy ignored: ble.mqtt_proxy not configured');
      }
    } else if (handler === 'ha-bluetooth') {
      if (ble.ha_bluetooth) {
        ble.handler = handler;
        noteOverride('BLE_HANDLER', 'ble.handler');
      } else {
        log.warn('BLE_HANDLER=ha-bluetooth ignored: ble.ha_bluetooth not configured');
      }
    } else if (handler === 'esphome-proxy') {
      // Was missing entirely: the value is in the schema's own enum, so it
      // validates in config.yaml but fell through every branch here and was
      // dropped in silence (#407).
      if (ble.esphome_proxy) {
        ble.handler = handler;
        noteOverride('BLE_HANDLER', 'ble.handler');
      } else {
        log.warn('BLE_HANDLER=esphome-proxy ignored: ble.esphome_proxy not configured');
      }
    } else if (handler !== '') {
      // Anything else used to be ignored without a word, which reads exactly
      // like a handler switch that worked. An EMPTY value is exempt: setting a
      // variable to nothing is how a compose file neutralises it, and warning
      // about that on every start would be noise.
      log.warn(
        `BLE_HANDLER='${handlerRaw}' is not a known handler ` +
          `(auto, mqtt-proxy, esphome-proxy, ha-bluetooth); ignoring it.`,
      );
    }
  }

  return ble;
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
