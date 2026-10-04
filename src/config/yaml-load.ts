import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createLogger } from '../logger.js';
import { createAppConfigSchema, formatConfigError } from './schema.js';
import type { AppConfig } from './schema.js';
import { defaultConfigPath, envPathFor } from './paths.js';
import { isFromEnvFile, loadEnvFile, resolveEnvReferencesTracked } from './env-refs.js';
import { safeParseResolved } from './env-coerce.js';
import { applyEnvOverrides, filterValidExporters } from './env-overrides.js';
import { collectUnknownKeys } from './unknown-keys.js';
import { parseConfigYaml } from './yaml-parse.js';
import { resolveConfigTokenDirs } from './token-dirs.js';

const log = createLogger('Config');

/**
 * Load and validate config from a YAML file.
 */
export function loadYamlConfig(configPath?: string): AppConfig {
  // Load .env so ${VAR} references in config.yaml can resolve secrets from .env.
  // It is the .env next to the config file, also when --config names one.
  const yamlPath = configPath ?? defaultConfigPath();
  // Re-read on every load, so a reload sees an edited .env too (G-20).
  loadEnvFile(envPathFor(yamlPath));

  const raw = readFileSync(yamlPath, 'utf8');
  const parsed: unknown = parseConfigYaml(raw, yamlPath);
  const { value: resolved, wholeRefs } = resolveEnvReferencesTracked(parsed);

  // Before validation on purpose: an unknown key is worth naming even when the
  // config fails to parse for an unrelated reason (#318).
  for (const key of collectUnknownKeys(resolved)) {
    log.warn(
      `Unknown config key '${key}' in ${yamlPath}. It is ignored. If you copied it from ` +
        'the documentation, this build is older than that key: update the app.',
    );
  }

  // A field whose whole value is one ${VAR} becomes a number or a boolean where
  // the schema asks for one (G-21).
  // A relative token_dir means "next to this config.yaml" (F-11), for the
  // collision check here and for every consumer after load.
  const configDir = dirname(resolve(yamlPath));
  const result = safeParseResolved(createAppConfigSchema(configDir), resolved, wholeRefs);
  if (!result.success) {
    // Thrown, not also logged: every caller reports the error it catches (the
    // CLI entry, validate, the reload path), so logging here printed each
    // schema error twice.
    throw new Error(formatConfigError(result.error));
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
  config = resolveConfigTokenDirs(config, configDir);

  // Nothing below can throw, so a reload that fails validation above never
  // touches process.env and the running BLE handler keeps its driver.
  reclaimNobleDriver();
  config = applyEnvOverrides(config);
  publishNobleDriver(config.ble?.noble_driver ?? undefined);

  // DEBUG and BLE_HANDLER are deliberately NOT written to process.env. They
  // used to be, before applyEnvOverrides() ran, so the config value overwrote
  // the very environment variable that was meant to override it, and on a
  // reload the value written last time came back as an "override" (debug: true
  // -> false had no effect until a restart). Nothing reads either variable
  // except applyEnvOverrides(): the log level is set from runtime.debug by the
  // caller (setLogLevel) and the handler is taken from ble.handler.

  return config;
}

/**
 * The NOBLE_DRIVER value this module last wrote, and what the variable held
 * before that write. src/ble/index.ts picks the noble driver from the
 * environment, so the final noble_driver has to be published there. Without
 * remembering that the value is ours, the next reload would read it back as
 * an environment override and a config change (or removal) of noble_driver
 * would never be seen.
 */
let publishedNobleDriver: { written: string; before: string | undefined } | null = null;

/** Put NOBLE_DRIVER back to what the environment had before our last write. */
function reclaimNobleDriver(): void {
  // If someone else changed the variable since, their value is the real
  // environment and is left alone.
  if (publishedNobleDriver && process.env.NOBLE_DRIVER === publishedNobleDriver.written) {
    if (publishedNobleDriver.before === undefined) delete process.env.NOBLE_DRIVER;
    else process.env.NOBLE_DRIVER = publishedNobleDriver.before;
  }
  publishedNobleDriver = null;
}

function publishNobleDriver(driver: string | undefined): void {
  // A NOBLE_DRIVER that only came from .env was not applied as an override
  // (G-03), so it must not pick the driver through process.env either. The
  // next load puts it back from .env and removes it here again.
  if (!driver && isFromEnvFile('NOBLE_DRIVER')) {
    delete process.env.NOBLE_DRIVER;
    return;
  }
  // No driver configured: whatever the environment holds stays, exactly as an
  // unset noble_driver always behaved. Same value already there: nothing of
  // ours to remember, so it keeps counting as the user's own override.
  if (!driver || process.env.NOBLE_DRIVER === driver) return;
  publishedNobleDriver = { written: driver, before: process.env.NOBLE_DRIVER };
  process.env.NOBLE_DRIVER = driver;
}
