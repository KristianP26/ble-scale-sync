#!/usr/bin/env tsx

import { parseArgs } from 'node:util';
import { writeFileSync } from 'node:fs';
import { setDisplayUsers } from './ble/handler-mqtt-proxy/index.js';
import { bootstrapMqttProxy } from './ble/mqtt-proxy-bootstrap.js';
import { notifyReady, startHeartbeat, stopHeartbeat } from './runtime/systemd-watchdog.js';
import { adapters } from './scales/index.js';
import { createLogger, setLogLevel, LogLevel } from './logger.js';
import { errMsg } from './utils/error.js';
import { runHealthchecks } from './orchestrator.js';
import { loadAppConfig } from './config/load.js';
import { resolveRuntimeConfig } from './config/resolve.js';
import { startConfigWatcher, type ConfigWatcherHandle } from './config/watch.js';
import type { Exporter } from './interfaces/exporter.js';
import { createAppContext } from './runtime/context.js';
import { processReading } from './runtime/processor.js';
import { PollReadingSource } from './runtime/poll-source.js';
import { runContinuousLoop } from './runtime/loop.js';
import { reloadAppConfig, userDisplaySnapshot } from './runtime/reload.js';
import { buildReadingSource } from './runtime/sources.js';
import {
  buildSingleUserExporters,
  getExportersForUser,
  buildAllUniqueExporters,
} from './runtime/exporters.js';

// ─── CLI flags ──────────────────────────────────────────────────────────────

const { values: cliFlags } = parseArgs({
  options: {
    config: { type: 'string', short: 'c' },
    help: { type: 'boolean', short: 'h' },
  },
  strict: false,
});

if (cliFlags.help) {
  console.log('Usage: npm start [-- --config <path>] [-- --help]');
  console.log('');
  console.log('Options:');
  console.log('  -c, --config <path>  Path to config.yaml (default: ./config.yaml)');
  console.log('  -h, --help           Show this help message');
  console.log('');
  console.log('Environment overrides (always applied, even with config.yaml):');
  console.log('  CONTINUOUS_MODE  true/false  override runtime.continuous_mode');
  console.log('  DRY_RUN          true/false  override runtime.dry_run');
  console.log('  DEBUG            true/false  override runtime.debug');
  console.log('  SCAN_COOLDOWN    5-3600      override runtime.scan_cooldown');
  console.log(
    '  BLE_WATCHDOG_MAX_FAILURES 0-1000  override runtime.watchdog_max_consecutive_failures (0 = disabled)',
  );
  console.log('  SCALE_MAC        MAC/UUID    override ble.scale_mac');
  console.log('  NOBLE_DRIVER     abandonware/stoprocent  override ble.noble_driver');
  console.log('  BLE_ADAPTER      hci0/hci1/...  override ble.adapter (Linux only)');
  process.exit(0);
}

// ─── Config + context ───────────────────────────────────────────────────────

const log = createLogger('Sync');

const loaded = loadAppConfig(cliFlags.config as string | undefined);
const initialConfig = loaded.config;
const initialResolved = resolveRuntimeConfig(initialConfig);

if (initialConfig.runtime?.debug) setLogLevel(LogLevel.DEBUG);

// ─── Abort / signal handling ────────────────────────────────────────────────

const ac = new AbortController();
const ctx = createAppContext({
  config: initialConfig,
  resolved: initialResolved,
  configSource: loaded.source,
  configPath: loaded.configPath,
  signal: ac.signal,
});

let configWatcher: ConfigWatcherHandle | null = null;
let forceExitOnNext = false;

function onSignal(): void {
  if (forceExitOnNext) {
    log.info('Force exit.');
    stopHeartbeat();
    process.exit(1);
  }
  forceExitOnNext = true;
  log.info('\nShutting down gracefully... (press again to force exit)');
  // Close the config watcher first so a late-fire fs event does not flip
  // needsReload after the loop has already abort()ed.
  configWatcher?.close();
  configWatcher = null;
  // Keep the systemd watchdog heartbeat running through graceful shutdown so
  // a slow exit (>= WatchdogSec/2) does not get SIGKILL'd by the supervisor.
  // The heartbeat is stopped in the main() epilogue once cleanup completes.
  ac.abort();
}

process.on('SIGINT', onSignal);
process.on('SIGTERM', onSignal);

let needsReload = false;

if (process.platform !== 'win32') {
  process.on('SIGHUP', () => {
    log.info('Received SIGHUP, will reload config before next scan cycle');
    needsReload = true;
  });
}

// ─── Heartbeat ──────────────────────────────────────────────────────────────

const HEARTBEAT_PATH = '/tmp/.ble-scale-sync-heartbeat';

function touchHeartbeat(): void {
  try {
    writeFileSync(HEARTBEAT_PATH, new Date().toISOString());
  } catch {
    // ignore (e.g., /tmp not writable on Windows)
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const isMultiUser = ctx.config.users.length > 1;
  const modeLabel = initialResolved.continuousMode ? ' (continuous)' : '';
  const userLabel = isMultiUser ? ` [${ctx.config.users.length} users]` : '';
  log.info(`\nBLE Scale Sync${ctx.dryRun ? ' (dry run)' : ''}${modeLabel}${userLabel}`);
  if (isMultiUser) {
    log.info(`Users: ${ctx.config.users.map((u) => u.name).join(', ')}`);
  }
  if (
    ctx.bleAdapter &&
    process.platform === 'linux' &&
    ctx.bleHandler !== 'mqtt-proxy' &&
    !process.env.NOBLE_DRIVER
  ) {
    log.info(`BLE adapter: ${ctx.bleAdapter}`);
  }

  if (ctx.bleHandler === 'mqtt-proxy' && ctx.mqttProxy) {
    const bootstrapped = await bootstrapMqttProxy(ctx.mqttProxy);
    ctx.mqttProxy = bootstrapped.mqttProxy;
    ctx.embeddedBroker = bootstrapped.embeddedBroker;
  }
  if (ctx.scaleMac) {
    log.info(`Scanning for scale ${ctx.scaleMac}...`);
  } else {
    log.info(`Scanning for any recognized scale...`);
  }
  log.info(`Adapters: ${adapters.map((a) => a.name).join(', ')}\n`);

  let singleUserExporters: Exporter[] | undefined;
  if (!ctx.dryRun) {
    if (isMultiUser) {
      const allExporters = buildAllUniqueExporters(ctx);
      await runHealthchecks(allExporters);
    } else {
      singleUserExporters = buildSingleUserExporters(ctx);
      await runHealthchecks(singleUserExporters);
    }
  }

  // Publish user info for display boards (included in config topic)
  if (ctx.bleHandler === 'mqtt-proxy' && ctx.mqttProxy) {
    setDisplayUsers(
      ctx.config.users.map((u) => ({
        slug: u.slug,
        name: u.name,
        weight_range: u.weight_range,
      })),
    );
  }

  // systemd Type=notify integration (#144). No-op when NOTIFY_SOCKET is unset
  // (Docker, npm start, non-systemd installs). When the unit declares
  // WatchdogSec=, the heartbeat catches sync D-Bus stalls that freeze the
  // event loop (#140) and lets systemd restart the service cleanly.
  notifyReady();
  startHeartbeat();

  const runProcessReading = (raw: Parameters<typeof processReading>[1]): Promise<boolean> =>
    processReading(ctx, raw, {
      singleUserExporters,
      getExportersForUser: (slug) => getExportersForUser(ctx, slug),
    });

  if (!initialResolved.continuousMode) {
    touchHeartbeat();
    const source = new PollReadingSource(ctx, adapters);
    const raw = await source.nextReading(ctx.signal);
    const success = await runProcessReading(raw);
    if (!success) process.exit(1);
    return;
  }

  // Auto-reload config.yaml on edit. Continuous-mode only (single runs exit
  // before any reload could matter). Opt out via runtime.watch_config: false.
  if (ctx.configSource === 'yaml' && ctx.configPath && initialResolved.watchConfig) {
    configWatcher = startConfigWatcher(ctx.configPath, () => {
      log.info('config.yaml change detected, will reload before next scan cycle');
      needsReload = true;
    });
  }

  // Reload snapshot for the ESP32 display board user-set diff (in reload.ts).
  const displaySnapshotRef = { value: userDisplaySnapshot(ctx.config) };

  const onReload = async (): Promise<void> => {
    await reloadAppConfig(ctx, displaySnapshotRef);
    if (ctx.config.users.length === 1) {
      singleUserExporters = ctx.dryRun ? undefined : buildSingleUserExporters(ctx);
    }
  };

  const bundle = await buildReadingSource(
    ctx,
    adapters,
    initialResolved.watchdogMaxFailures,
    initialResolved.scanCooldownSec,
  );

  await runContinuousLoop({
    source: bundle.source,
    processReading: runProcessReading,
    signal: ctx.signal,
    touchHeartbeat,
    isReloadRequested: () => needsReload,
    clearReloadRequest: () => {
      needsReload = false;
    },
    onReload,
    onSourceReload: bundle.onSourceReload,
    onSuccess: bundle.onSuccess,
    onFailure: bundle.onFailure,
    failureLogPrefix: bundle.failureLogPrefix,
  });

  log.info('Stopped.');
}

async function shutdownEmbeddedBroker(): Promise<void> {
  if (!ctx.embeddedBroker) return;
  try {
    await ctx.embeddedBroker.close();
  } catch (err) {
    log.warn(`Embedded broker shutdown error: ${errMsg(err)}`);
  } finally {
    ctx.embeddedBroker = null;
  }
}

main()
  .catch((err: Error) => {
    if (ctx.signal.aborted) {
      log.info('Stopped.');
      return;
    }
    log.error(err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await shutdownEmbeddedBroker();
    stopHeartbeat();
  });
