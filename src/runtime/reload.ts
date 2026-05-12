import { loadYamlConfig } from '../config/load.js';
import { resolveRuntimeConfig } from '../config/resolve.js';
import { diffRestartRequired } from '../config/reload-diff.js';
import { withWriteLock } from '../config/write.js';
import { setDisplayUsers } from '../ble/handler-mqtt-proxy/index.js';
import { createLogger, setLogLevel, LogLevel } from '../logger.js';
import { errMsg } from '../utils/error.js';
import type { AppConfig } from '../config/schema.js';
import type { AppContext } from './context.js';

const log = createLogger('Sync');

/**
 * Reload config.yaml in place, refresh hot-swap fields on the context, and
 * warn about restart-required edits. No-op for env-config installs.
 *
 * Caller is responsible for rebuilding any cached single-user exporters
 * (returned `usersChanged` lets the caller skip the rebuild when irrelevant).
 */
export async function reloadAppConfig(
  ctx: AppContext,
  userDisplaySnapshotRef: { value: string },
): Promise<void> {
  const configPath = ctx.configPath;
  if (ctx.configSource !== 'yaml' || !configPath) return;
  await withWriteLock(async () => {
    try {
      const oldConfig = ctx.config;
      const newConfig = loadYamlConfig(configPath);
      const resolved = resolveRuntimeConfig(newConfig);
      ctx.setConfig(newConfig, resolved);
      setLogLevel(newConfig.runtime?.debug ? LogLevel.DEBUG : LogLevel.INFO);

      // Re-publish display users for the ESP32 board if the user set changed.
      const newSnapshot = userDisplaySnapshot(newConfig);
      if (
        ctx.bleHandler === 'mqtt-proxy' &&
        ctx.mqttProxy &&
        newSnapshot !== userDisplaySnapshotRef.value
      ) {
        setDisplayUsers(
          newConfig.users.map((u) => ({
            slug: u.slug,
            name: u.name,
            weight_range: u.weight_range,
          })),
        );
        userDisplaySnapshotRef.value = newSnapshot;
      }

      // Warn about edits that need a restart to take effect.
      const restartFields = diffRestartRequired(oldConfig, newConfig);
      for (const f of restartFields) {
        log.warn(
          `Config change detected in ${f.key} (${f.oldValue} -> ${f.newValue}). ` +
            'Restart required for this field to take effect.',
        );
      }

      log.info('Config reloaded successfully');
    } catch (err) {
      log.error(`Config reload failed, keeping current config: ${errMsg(err)}`);
    }
  });
}

export function userDisplaySnapshot(config: AppConfig): string {
  return JSON.stringify(
    config.users.map((u) => ({ slug: u.slug, name: u.name, weight_range: u.weight_range })),
  );
}
