import { existsSync } from 'node:fs';
import { defaultConfigPath, defaultEnvPath } from './paths.js';

// --- Config source detection ---

export type ConfigSource = 'yaml' | 'env' | 'none';

/**
 * Detect which config source is available.
 * Priority: config.yaml → .env → none.
 *
 * An explicit path is that file or nothing. Falling back to a legacy .env when
 * it was missing turned a typo in --config into a run in single-user .env mode,
 * with another profile and other exporters, announced by one info line.
 */
export function detectConfigSource(configPath?: string): ConfigSource {
  if (configPath !== undefined) return existsSync(configPath) ? 'yaml' : 'none';

  if (existsSync(defaultConfigPath())) return 'yaml';

  if (existsSync(defaultEnvPath())) return 'env';

  return 'none';
}
