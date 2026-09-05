import { existsSync, readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { config as dotenvConfig } from 'dotenv';
import type {
  BleConfig,
  MqttProxyConfig,
  EsphomeProxyConfig,
  HaBluetoothConfig,
} from './schema.js';
import type { BleHandlerName } from '../ble/types.js';
import { defaultConfigPath, defaultEnvPath } from './paths.js';
import { parseBleAdapterEnv } from './env-overrides.js';

export interface BleLoadedConfig {
  scaleMac?: string;
  nobleDriver?: string;
  bleHandler?: BleHandlerName;
  bleAdapter?: string;
  mqttProxy?: MqttProxyConfig;
  esphomeProxy?: EsphomeProxyConfig;
  haBluetooth?: HaBluetoothConfig;
}

/**
 * Load only BLE-related config (scale_mac, noble_driver, handler, mqtt_proxy).
 * Lightweight — doesn't validate full config, doesn't require user profile.
 */
export function loadBleConfig(configPath?: string): BleLoadedConfig {
  const yamlPath = configPath ?? defaultConfigPath();

  if (existsSync(yamlPath)) {
    try {
      const raw = readFileSync(yamlPath, 'utf8');
      const parsed = parseYaml(raw) as { ble?: BleConfig };
      const ble = parsed?.ble;
      return {
        scaleMac: ble?.scale_mac ?? undefined,
        nobleDriver: ble?.noble_driver ?? undefined,
        bleHandler: (ble?.handler as BleLoadedConfig['bleHandler']) ?? undefined,
        bleAdapter: ble?.adapter ?? undefined,
        mqttProxy: ble?.mqtt_proxy ?? undefined,
        esphomeProxy: ble?.esphome_proxy ?? undefined,
        haBluetooth: ble?.ha_bluetooth ?? undefined,
      };
    } catch {
      // Fall through to env vars
    }
  }

  // Load .env if it exists
  const envPath = defaultEnvPath();
  if (existsSync(envPath)) {
    dotenvConfig({ path: envPath });
  }

  return {
    scaleMac: process.env.SCALE_MAC || undefined,
    nobleDriver: process.env.NOBLE_DRIVER || undefined,
    bleAdapter: parseBleAdapterEnv() ?? undefined,
  };
}
