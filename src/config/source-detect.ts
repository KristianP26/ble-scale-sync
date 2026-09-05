import { existsSync } from 'node:fs';
import { defaultConfigPath, defaultEnvPath } from './paths.js';

// --- Config source detection ---

export type ConfigSource = 'yaml' | 'env' | 'none';

/**
 * Detect which config source is available.
 * Priority: config.yaml → .env → none.
 */
export function detectConfigSource(configPath?: string): ConfigSource {
  const yamlPath = configPath ?? defaultConfigPath();
  if (existsSync(yamlPath)) return 'yaml';

  if (existsSync(defaultEnvPath())) return 'env';

  return 'none';
}
