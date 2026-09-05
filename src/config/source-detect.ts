import { existsSync } from 'node:fs';
import { DEFAULT_CONFIG_PATH, DEFAULT_ENV_PATH } from './paths.js';

// --- Config source detection ---

export type ConfigSource = 'yaml' | 'env' | 'none';

/**
 * Detect which config source is available.
 * Priority: config.yaml → .env → none.
 */
export function detectConfigSource(configPath?: string): ConfigSource {
  const yamlPath = configPath ?? DEFAULT_CONFIG_PATH;
  if (existsSync(yamlPath)) return 'yaml';

  if (existsSync(DEFAULT_ENV_PATH)) return 'env';

  return 'none';
}
