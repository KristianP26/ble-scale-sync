#!/usr/bin/env tsx

import { parseArgs } from 'node:util';
import { createRequire } from 'node:module';
import { setDisplayUsers, createMqttProxyDisplayNotifier } from './ble/handler-mqtt-proxy/index.js';
import { bootstrapMqttProxy } from './ble/mqtt-proxy-bootstrap.js';
import { notifyReady, startHeartbeat, stopHeartbeat } from './runtime/systemd-watchdog.js';
import { touchHeartbeat, startFileHeartbeat, stopFileHeartbeat } from './runtime/file-heartbeat.js';
import { armHardExit } from './runtime/hard-exit.js';
import { adapters as fullRegistry } from './scales/index.js';
import { applyForcedAdapter, UnknownAdapterError } from './scales/force.js';
import { assertRegistryIntegrity } from './scales/registry-check.js';
import { createLogger, setLogLevel, LogLevel } from './logger.js';
import { errMsg } from './utils/error.js';
import { runHealthchecks } from './orchestrator.js';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };
import { loadAppConfig } from './config/load.js';
import { resolveRuntimeConfig } from './config/resolve.js';
import { startConfigWatcher, type ConfigWatcherHandle } from './config/watch.js';
import type { Exporter } from './interfaces/exporter.js';
import type { ScaleAdapter } from './interfaces/scale-adapter.js';
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
  console.log(
    '  BLE_HARD_EXIT_GRACE_MS 1000-60000  force-exit floor for hung shutdown (default 5000)',
  );
  console.log('  SCALE_MAC        MAC/UUID    override ble.scale_mac');
  console.log('  NOBLE_DRIVER     abandonware/stoprocent  override ble.noble_driver');
  console.log('  BLE_ADAPTER      hci0/hci1/...  override ble.adapter (Linux only)');
  process.exit(0);
}

// ─── Config + context ───────────────────────────────────────────────────────

const log = createLogger('Sync');

/**
 * One line naming exactly which build is running.
 *
 * #318 was diagnosed only after separating "this option does nothing" from
 * "this container predates the option", and nothing in the log distinguished
 * them. APP_BUILD_* are set by the image build; on a bare checkout they are
 * absent and only the package version is printed.
 *
 * Emitted here rather than inside main() on purpose: loadAppConfig below can
 * throw, and the failures that most need this line never reach main().
 */
const buildChannel = process.env.APP_BUILD_CHANNEL;
const buildRef = process.env.APP_BUILD_REF;
log.info(
  `Version ${pkg.version}` +
    (buildChannel ? ` (image ${buildChannel}${buildRef ? ` @ ${buildRef.slice(0, 7)}` : ''})` : ''),
);

const loaded = loadAppConfig(cliFlags.config as string | undefined);
const initialConfig = loaded.config;
const initialResolved = resolveRuntimeConfig(initialConfig);

if (initialConfig.runtime?.debug) setLogLevel(LogLevel.DEBUG);

// ─── Abort / signal handling ────────────────────────────────────────────────

// Force-exit floor: if abort-driven cleanup cannot drain the event loop
// within this window (e.g. a wedged D-Bus/BlueZ handle pins it open), the
// process is force-exited so Docker `restart: unless-stopped` / systemd can
// recover. Default 5s — below Docker's 10s SIGKILL grace and well below a
// typical systemd WatchdogSec. Override via BLE_HARD_EXIT_GRACE_MS (ms).
const HARD_EXIT_GRACE_MS = ((): number => {
  const raw = process.env.BLE_HARD_EXIT_GRACE_MS;
  if (raw === undefined) return 5_000;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1_000 && n <= 60_000 ? n : 5_000;
})();

const ac = new AbortController();

// Register the hard-exit safety net before anything can abort `ac`. Armed
// once on the first abort (watchdog trip, SIGTERM, or any internal abort);
// idempotent, unref'd, so a clean drain still exits naturally first (#194).
ac.signal.addEventListener('abort', () => armHardExit({ timeoutMs: HARD_EXIT_GRACE_MS, log }), {
  once: true,
});
const ctx = createAppContext({
  config: initialConfig,
  resolved: initialResolved,
  configSource: loaded.source,
  configPath: loaded.configPath,
  signal: ac.signal,
  abortApp: (reason) => ac.abort(reason),
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

/**
 * Keep a stray promise rejection from killing a long-running service.
 *
 * Node's default for an unhandled rejection is to terminate the process. The
 * BLE stack is full of fire-and-forget writes into BlueZ, and BlueZ answers a
 * badly timed one with `org.bluez.Error.InProgress`. In #138 that ended the
 * whole app mid-session, every session, and only the container restart policy
 * hid it: the scale was never read.
 *
 * Individual call sites still attach their own handlers; this is the net under
 * them, not a licence to drop rejections. In single-run mode the exit code is
 * preserved, because there the crash is the result.
 */
let runFinished = false;
let rejectionCount = 0;
process.on('unhandledRejection', (reason: unknown) => {
  const detail = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
  // A single run that already exported its reading must not be turned into a
  // failure by a fire-and-forget BLE write rejecting on the way out.
  if (!initialResolved.continuousMode && !runFinished) {
    log.error(`Unhandled promise rejection: ${detail}`);
    stopHeartbeat();
    process.exit(1);
  }
  rejectionCount++;
  // Throttled: a permanently rejecting loop must not bury the log it is in.
  if (rejectionCount <= 5 || rejectionCount % 50 === 0) {
    log.warn(`Unhandled promise rejection #${rejectionCount} (continuing): ${detail}`);
  }
});

let needsReload = false;

if (process.platform !== 'win32') {
  process.on('SIGHUP', () => {
    log.info('Received SIGHUP, will reload config before next scan cycle');
    needsReload = true;
  });
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Docker HEALTHCHECK liveness file (#277). First statement in main() on
  // purpose: on a fresh container the file does not exist yet, so the check's
  // `test -f` arm fails until the first touch. Everything below (the mqtt-proxy
  // bootstrap, the exporter healthchecks, BLE source construction) happens
  // inside that window, so starting later would leave a gap where a slow
  // bootstrap trips the very restart loop this fixes. Stopped in the epilogue.
  startFileHeartbeat();

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
    // Attach the display capability; the getter reads the hot-swappable
    // ctx.mqttProxy live so config reloads take effect (#183).
    ctx.display = createMqttProxyDisplayNotifier(() => ctx.mqttProxy);
    if (!initialResolved.continuousMode) {
      // The ESP32 connects to a known scale on its own and publishes the
      // session once. Only the continuous-mode watcher subscribes to that
      // topic, so in a single run the event lands while nothing is listening
      // and the weigh-in is silently lost (#296).
      log.warn(
        'mqtt-proxy without continuous mode: the ESP32 connects to known scales on its own, ' +
          'and a single run only listens during its own scan window. ' +
          'Set runtime.continuous_mode: true (or CONTINUOUS_MODE=true) so autonomous connects are never missed.',
      );
    }
  }
  if (ctx.scaleMac) {
    log.info(`Scanning for scale ${ctx.scaleMac}...`);
  } else {
    log.info(`Scanning for any recognized scale...`);
  }
  for (const w of assertRegistryIntegrity(fullRegistry)) {
    log.warn(`Adapter registry: ${w}`);
  }

  // ble.force_scale_adapter replaces the registry with the single adapter the
  // user named, bypassing protocol detection entirely (#318/#319). The schema
  // already requires scale_mac alongside it, so the override stays pointed at
  // one device.
  let adapters: ScaleAdapter[] = [...fullRegistry];
  const forcedName = ctx.config.ble?.force_scale_adapter ?? undefined;
  if (forcedName) {
    // Checked here rather than in the schema because the effective MAC is only
    // known after env overrides, and SCALE_MAC is the documented Docker way to
    // supply it.
    if (!ctx.scaleMac) {
      log.error(
        'ble.force_scale_adapter requires a scale MAC (ble.scale_mac or the SCALE_MAC ' +
          'environment variable): the forced adapter matches every device it is shown, ' +
          'so the MAC is what keeps it pointed at your scale.',
      );
      process.exit(1);
    }
    try {
      adapters = applyForcedAdapter(fullRegistry, forcedName);
    } catch (err) {
      if (err instanceof UnknownAdapterError) {
        log.error(err.message);
        process.exit(1);
      }
      throw err;
    }
    log.warn(
      `Scale adapter forced to "${adapters[0].name}" by config; protocol auto-detection is off. ` +
        'If auto-detection picked the wrong adapter, please report it so the matcher can be fixed.',
    );
  }
  log.info(`Adapters: ${adapters.map((a) => a.name).join(', ')}\n`);

  // Inject runtime config into adapters that read it: the Xiaomi S800 MiBeacon
  // bind key, and the configured display unit that the QN 0x13 command echoes to
  // the scale (#269). Optional + no-op for adapters without configure().
  // Re-applied on config reload below so a hot-edited key or unit takes effect.
  const applyAdapterConfig = (bindKey: string | undefined): void => {
    const weightUnit = ctx.config.scale.weight_unit;
    const qnProtocolByte = ctx.config.ble?.qn_protocol_byte ?? undefined;
    const qnReportByte = ctx.config.ble?.qn_report_byte ?? undefined;
    for (const a of adapters) a.configure?.({ bindKey, weightUnit, qnProtocolByte, qnReportByte });
  };
  applyAdapterConfig(ctx.config.ble?.bind_key ?? undefined);

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

  // systemd Type=notify integration (#144). No-op when NOTIFY_SOCKET is unset.
  notifyReady();
  startHeartbeat();

  const runProcessReading = (raw: Parameters<typeof processReading>[1]): Promise<boolean> =>
    processReading(ctx, raw, {
      singleUserExporters,
      getExportersForUser: (slug) => getExportersForUser(ctx, slug),
    });

  if (!initialResolved.continuousMode) {
    const source = new PollReadingSource(ctx, adapters);
    const raw = await source.nextReading(ctx.signal);
    const success = await runProcessReading(raw);
    if (!success) process.exit(1);
    runFinished = true;
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
    applyAdapterConfig(ctx.config.ble?.bind_key ?? undefined);
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
    stopFileHeartbeat();
  });
