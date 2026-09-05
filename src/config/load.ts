import { createLogger } from '../logger.js';
import type { AppConfig } from './schema.js';
import { DEFAULT_CONFIG_PATH } from './paths.js';
import { detectConfigSource } from './source-detect.js';
import type { ConfigSource } from './source-detect.js';
import { loadYamlConfig } from './yaml-load.js';
import { loadEnvConfig } from './env-load.js';

// Re-export the focused-module public API so existing callers and tests can
// keep importing from './config/load.js'. This file is now a thin
// orchestration entrypoint; each concern lives in its own module:
//   - env-refs.ts        ${VAR} reference resolution
//   - source-detect.ts   config source detection
//   - env-overrides.ts   environment-variable override resolution
//   - yaml-load.ts       YAML read + parse + validate
//   - env-load.ts        .env fallback → AppConfig
//   - ble-load.ts        lightweight BLE-only loader (scan.ts)
export { resolveEnvReferences } from './env-refs.js';
export { detectConfigSource } from './source-detect.js';
export type { ConfigSource } from './source-detect.js';
export { loadYamlConfig } from './yaml-load.js';
export { loadEnvConfig } from './env-load.js';
export { loadBleConfig } from './ble-load.js';
export type { BleLoadedConfig } from './ble-load.js';

const log = createLogger('Config');

export interface LoadedConfig {
  source: ConfigSource;
  config: AppConfig;
  configPath?: string;
}

/**
 * Load application config from the best available source.
 * Priority: config.yaml → .env → none (error).
 */
export function loadAppConfig(configPath?: string): LoadedConfig {
  const source = detectConfigSource(configPath);

  switch (source) {
    case 'yaml': {
      const yamlPath = configPath ?? DEFAULT_CONFIG_PATH;
      log.info(`Loading config from ${configPath ?? 'config.yaml'}`);
      return { source: 'yaml', config: loadYamlConfig(configPath), configPath: yamlPath };
    }

    case 'env':
      log.info('Loading config from .env (no config.yaml found)');
      return { source: 'env', config: loadEnvConfig() };

    case 'none':
      log.error('No configuration found.');
      log.error('');
      log.error('Create one of:');
      log.error('  config.yaml  — recommended (run: npm run setup)');
      log.error('  .env         — legacy single-user format (see .env.example)');
      process.exit(1);
  }
}
