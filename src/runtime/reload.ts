import { loadYamlConfig } from '../config/load.js';
import { resolveRuntimeConfig, resolveExportersForUser } from '../config/resolve.js';
import { createExporterFromEntry } from '../exporters/registry.js';
import type { Exporter } from '../interfaces/exporter.js';
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
 * The write lock is held only across the file read + ctx.setConfig mutation
 * (the only steps that can race with a concurrent atomicWrite from
 * updateLastKnownWeight). Side effects (setLogLevel, setDisplayUsers, restart
 * diff warnings) run outside the lock so a slow MQTT publish or noisy log loop
 * cannot stall pending atomic writes.
 */
export async function reloadAppConfig(
  ctx: AppContext,
  userDisplaySnapshotRef: { value: string },
): Promise<void> {
  const configPath = ctx.configPath;
  if (ctx.configSource !== 'yaml' || !configPath) return;

  let configs: { oldConfig: AppConfig; newConfig: AppConfig };
  try {
    configs = await withWriteLock(async () => {
      const oldConfig = ctx.config;
      const newConfig = loadYamlConfig(configPath);
      const resolved = resolveRuntimeConfig(newConfig);
      // Built BEFORE the swap. loadYamlConfig passes exporter entries through
      // and filters only an unknown `type`, so a missing required field or a
      // bad value first throws here. Thrown after setConfig, it left the new
      // config installed and every later cycle failing on the same entry, with
      // the reload request never cleared (E-07).
      const exportersByUser = buildExportersByUser(newConfig);
      ctx.setConfig(newConfig, resolved);
      // setConfig cleared the cache; refill it with what was just built.
      for (const [slug, exporters] of exportersByUser) ctx.exporterCache.set(slug, exporters);
      return { oldConfig, newConfig };
    });
  } catch (err) {
    log.error(`Config reload failed, keeping current config: ${errMsg(err)}`);
    return;
  }

  const { oldConfig, newConfig } = configs;

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
}

/**
 * Every user's exporters for a config, the way getExportersForUser builds them.
 * Exporter constructors only store their config, so building them has no side
 * effects; the point is that construction is where an invalid entry throws.
 */
function buildExportersByUser(config: AppConfig): Map<string, Exporter[]> {
  const byUser = new Map<string, Exporter[]>();
  for (const user of config.users) {
    byUser.set(
      user.slug,
      resolveExportersForUser(config, user).map((e) => createExporterFromEntry(e)),
    );
  }
  return byUser;
}

export function userDisplaySnapshot(config: AppConfig): string {
  return JSON.stringify(
    config.users.map((u) => ({ slug: u.slug, name: u.name, weight_range: u.weight_range })),
  );
}
