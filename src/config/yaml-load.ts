import { existsSync, readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { config as dotenvConfig } from 'dotenv';
import { createLogger } from '../logger.js';
import { AppConfigSchema, formatConfigError } from './schema.js';
import type { AppConfig } from './schema.js';
import { defaultConfigPath, defaultEnvPath } from './paths.js';
import { resolveEnvReferences } from './env-refs.js';
import { applyEnvOverrides, filterValidExporters } from './env-overrides.js';
import { collectUnknownKeys } from './unknown-keys.js';

const log = createLogger('Config');

/**
 * Load and validate config from a YAML file.
 */
export function loadYamlConfig(configPath?: string): AppConfig {
  // Load .env so ${VAR} references in config.yaml can resolve secrets from .env
  const envPath = defaultEnvPath();
  if (existsSync(envPath)) {
    dotenvConfig({ path: envPath });
  }

  const yamlPath = configPath ?? defaultConfigPath();
  const raw = readFileSync(yamlPath, 'utf8');
  const parsed: unknown = parseYaml(raw);
  const resolved = resolveEnvReferences(parsed);

  // Before validation on purpose: an unknown key is worth naming even when the
  // config fails to parse for an unrelated reason (#318).
  for (const key of collectUnknownKeys(resolved)) {
    log.warn(
      `Unknown config key '${key}' in ${yamlPath}. It is ignored. If you copied it from ` +
        'the documentation, this build is older than that key: update the app.',
    );
  }

  const result = AppConfigSchema.safeParse(resolved);
  if (!result.success) {
    const msg = formatConfigError(result.error);
    log.error(msg);
    throw new Error(msg);
  }

  let config = result.data;

  // Lenient exporter validation — warn + skip unknown types
  config = {
    ...config,
    global_exporters: filterValidExporters(config.global_exporters),
    users: config.users.map((u) => ({
      ...u,
      exporters: filterValidExporters(u.exporters),
    })),
  };

  // Set NOBLE_DRIVER env var if configured (needed before BLE handler import)
  if (config.ble?.noble_driver) {
    process.env.NOBLE_DRIVER = config.ble.noble_driver;
  }

  // Set BLE_HANDLER env var if configured (needed before BLE handler import)
  if (config.ble?.handler && config.ble.handler !== 'auto') {
    process.env.BLE_HANDLER = config.ble.handler;
  }

  // Set DEBUG env var if configured (needed for logger level)
  if (config.runtime?.debug) {
    process.env.DEBUG = 'true';
  }

  // Apply env overrides
  config = applyEnvOverrides(config);

  return config;
}
