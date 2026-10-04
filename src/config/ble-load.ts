import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { config as dotenvConfig } from 'dotenv';
import { BleSchema, formatConfigError } from './schema.js';
import type {
  BleConfig,
  MqttProxyConfig,
  EsphomeProxyConfig,
  HaBluetoothConfig,
} from './schema.js';
import type { BleHandlerName } from '../ble/types.js';
import { defaultConfigPath, defaultEnvPath, envPathFor } from './paths.js';
import { detectConfigSource } from './source-detect.js';
import { isFromEnvFile, loadEnvFile, resolveEnvReferencesTracked } from './env-refs.js';
import { safeParseResolved } from './env-coerce.js';
import { applyBleEnvOverrides, parseBleAdapterEnv } from './env-overrides.js';
import { parseConfigYaml } from './yaml-parse.js';

export interface BleLoadedConfig {
  scaleMac?: string;
  nobleDriver?: string;
  bleHandler?: BleHandlerName;
  bleAdapter?: string;
  mqttProxy?: MqttProxyConfig;
  esphomeProxy?: EsphomeProxyConfig;
  haBluetooth?: HaBluetoothConfig;
}

/** Only the `ble` section is validated; users and exporters are not this loader's concern. */
const BleSectionSchema = z.object({ ble: BleSchema.optional() });

/**
 * Load only the BLE part of the config, for `scan` and `diagnose`.
 *
 * With a config.yaml this goes through the same steps as the app for the `ble`
 * section (G-05): the .env next to the file, `${VAR}` references, the schema
 * with its defaults and checks, and the environment overrides. It used to
 * return the section straight from the YAML parser, so a mqtt-proxy config that
 * relied on the defaults listened on `undefined/undefined/...` and a
 * `token: ${HA_TOKEN}` reached Home Assistant literally. A user profile is
 * still not required, and a `${VAR}` outside `ble` is not resolved.
 *
 * Throws on an invalid `ble` section and on an explicit path that does not
 * exist, as the app does, instead of scanning with settings nobody configured.
 */
export function loadBleConfig(configPath?: string): BleLoadedConfig {
  const source = detectConfigSource(configPath);

  if (source === 'yaml') {
    const ble = loadYamlBleSection(configPath ?? defaultConfigPath());
    return {
      scaleMac: ble.scale_mac ?? undefined,
      nobleDriver: ble.noble_driver ?? undefined,
      bleHandler: ble.handler,
      bleAdapter: ble.adapter ?? undefined,
      mqttProxy: ble.mqtt_proxy ?? undefined,
      esphomeProxy: ble.esphome_proxy ?? undefined,
      haBluetooth: ble.ha_bluetooth ?? undefined,
    };
  }

  if (configPath !== undefined) {
    throw new Error(`Config file not found: ${configPath}`);
  }

  // Legacy single-user .env mode (or nothing configured): unchanged.
  const envPath = defaultEnvPath();
  if (existsSync(envPath)) {
    dotenvConfig({ path: envPath, quiet: true });
  }

  return {
    scaleMac: process.env.SCALE_MAC || undefined,
    nobleDriver: process.env.NOBLE_DRIVER || undefined,
    bleAdapter: parseBleAdapterEnv() ?? undefined,
  };
}

function loadYamlBleSection(yamlPath: string): BleConfig {
  loadEnvFile(envPathFor(yamlPath));

  const parsed = parseConfigYaml(readFileSync(yamlPath, 'utf8'), yamlPath);
  const ble =
    parsed !== null && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>).ble
      : undefined;

  // Wrapped in `ble` so a ${VAR} conversion and an error path read
  // `ble.mqtt_proxy...`, exactly as they do for the whole config.
  const { value, wholeRefs } = resolveEnvReferencesTracked({ ble });
  const result = safeParseResolved(BleSectionSchema, value, wholeRefs);
  if (!result.success) throw new Error(formatConfigError(result.error));

  const effective = applyBleEnvOverrides(result.data.ble);

  // The BLE handler import picks the noble driver from process.env. A
  // NOBLE_DRIVER that only came from .env was not applied above, so it must not
  // decide the driver that way either (G-03).
  if (!effective.noble_driver && isFromEnvFile('NOBLE_DRIVER')) {
    delete process.env.NOBLE_DRIVER;
  }

  return effective;
}
