import { existsSync, readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { config as dotenvConfig } from 'dotenv';
import type { BleConfig, MqttProxyConfig, EsphomeProxyConfig } from './schema.js';
import type { BleHandlerName } from '../ble/types.js';
import { DEFAULT_CONFIG_PATH, DEFAULT_ENV_PATH } from './paths.js';
import { parseBleAdapterEnv } from './env-overrides.js';

export interface BleLoadedConfig {
  scaleMac?: string;
  nobleDriver?: string;
  bleHandler?: BleHandlerName;
  bleAdapter?: string;
  mqttProxy?: MqttProxyConfig;
  esphomeProxy?: EsphomeProxyConfig;
}

/**
 * Load only BLE-related config (scale_mac, noble_driver, handler, mqtt_proxy).
 * Lightweight — doesn't validate full config, doesn't require user profile.
 */
export function loadBleConfig(configPath?: string): BleLoadedConfig {
  const yamlPath = configPath ?? DEFAULT_CONFIG_PATH;

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
      };
    } catch {
      // Fall through to env vars
    }
  }

  // Load .env if it exists
  if (existsSync(DEFAULT_ENV_PATH)) {
    dotenvConfig({ path: DEFAULT_ENV_PATH });
  }

  return {
    scaleMac: process.env.SCALE_MAC || undefined,
    nobleDriver: process.env.NOBLE_DRIVER || undefined,
    bleAdapter: parseBleAdapterEnv() ?? undefined,
  };
}
