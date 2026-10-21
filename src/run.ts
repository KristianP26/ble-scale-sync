import { createRequire } from 'node:module';
import { printRunHelp } from './cli-help.js';
import { parseRunArgs } from './cli-run-args.js';
import { bootstrapMqttProxy } from './ble/mqtt-proxy-bootstrap.js';
import { notifyReady, startHeartbeat, stopHeartbeat } from './runtime/systemd-watchdog.js';
import { touchHeartbeat, startFileHeartbeat, stopFileHeartbeat } from './runtime/file-heartbeat.js';
import { armHardExit } from './runtime/hard-exit.js';
import { adapters as fullRegistry } from './scales/index.js';
import { applyForcedAdapter } from './scales/force.js';
import { forcedAdapterProblem } from './config/forced-adapter.js';
import { assertRegistryIntegrity } from './scales/registry-check.js';
import { createLogger, setLogLevel, LogLevel } from './logger.js';
import { errMsg } from './utils/error.js';
import { isMainModule } from './utils/entry.js';
import { runHealthchecks } from './orchestrator.js';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };
import { loadAppConfig } from './config/load.js';
import { buildAdapterRuntimeConfig, resolveRuntimeConfig } from './config/resolve.js';
import { startConfigWatcher, type ConfigWatcherHandle } from './config/watch.js';
import { configureUpdateState } from './update-state.js';
import { flushQueue, logQueueAtStartup } from './runtime/export-queue.js';
import {
  persistDedupMark,
  resolveDedupMarksPath,
  restoreDedupMarks,
} from './runtime/dedup-marks.js';
import type { Exporter } from './interfaces/exporter.js';
import type { ScaleAdapter } from './interfaces/scale-adapter.js';
import { createAppContext } from './runtime/context.js';
import { resolveReplayAnchorsPath } from './runtime/replay-anchors.js';
import { processReading } from './runtime/processor.js';
import { PollReadingSource } from './runtime/poll-source.js';
import { runContinuousLoop, type RuntimeLoopDeps } from './runtime/loop.js';
import { runSingleShot } from './runtime/single-run.js';
import { displayUsers, reloadAppConfig, userDisplaySnapshot } from './runtime/reload.js';
import { buildReadingSource, type ReadingSourceBundle } from './runtime/sources.js';
import { resolveHandlerKey } from './ble/index.js';
import {
  buildSingleUserExporters,
  getExportersForUser,
  resolveQueuedExporter,
  buildAllUniqueExporters,
} from './runtime/exporters.js';

const log = createLogger('Sync');

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

/**
 * The run path (D010): `ble-scale-sync`, `ble-scale-sync start` and the
 * add-on's `node dist/index.js --config ...`. Importing this module starts
 * nothing; src/index.ts calls this with the arguments after the command word.
 */
export async function run(argv: readonly string[]): Promise<void> {
  const cliFlags = parseRunArgs(argv);

  if (cliFlags.kind === 'error') {
    // Before anything else runs: a misplaced subcommand or a mistyped flag must
    // not start a scan and an export (G-16). Exit 2, as the bin does for an
    // unknown command.
    console.error(cliFlags.message);
    console.error('');
    printRunHelp();
    process.exit(2);
  }

  if (cliFlags.help) {
    // `start --help`, or --help after another flag: a bare --help is answered
    // by index.js before this module is ever imported.
    printRunHelp();
    process.exit(0);
  }

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
      (buildChannel
        ? ` (image ${buildChannel}${buildRef ? ` @ ${buildRef.slice(0, 7)}` : ''})`
        : ''),
  );

  const loaded = loadAppConfig(cliFlags.config);
  const initialConfig = loaded.config;
  const initialResolved = resolveRuntimeConfig(initialConfig);

  // Persist the update-check cooldown next to the resolved config file, so a
  // restart-looping container or a development run does not re-send the daily
  // check. Without a config.yaml (.env-only) this lands at the repo root.
  configureUpdateState(loaded.configPath);

  if (initialConfig.runtime?.debug) setLogLevel(LogLevel.DEBUG);

  const ac = new AbortController();

  // Was this abort asked for by an operator (SIGINT/SIGTERM), or did something
  // go wrong? Only the exit code of a shutdown that then hangs depends on it: a
  // stop the operator asked for is not a failure and must not be reported as one
  // by a supervisor (#335). Set before `ac.abort()`, which dispatches its
  // listeners synchronously.
  let deliberateStop = false;

  // Register the hard-exit safety net before anything can abort `ac`. Armed
  // once on the first abort (watchdog trip, SIGTERM, or any internal abort);
  // idempotent, unref'd, so a clean drain still exits naturally first (#194).
  //
  // The flag is read at ARM time, and the first abort wins. A watchdog trip
  // followed by a SIGTERM therefore arms with 1, which is right: both watchdog
  // paths set `process.exitCode = 1` first, and that wins over `fallbackCode`
  // regardless.
  ac.signal.addEventListener(
    'abort',
    () =>
      armHardExit({
        timeoutMs: HARD_EXIT_GRACE_MS,
        log,
        fallbackCode: deliberateStop ? 0 : 1,
      }),
    { once: true },
  );
  const ctx = createAppContext({
    config: initialConfig,
    resolved: initialResolved,
    configSource: loaded.source,
    configPath: loaded.configPath,
    // After setLogLevel, so the restored weigh-ins show at debug level (D067).
    replayAnchorsPath: resolveReplayAnchorsPath(loaded.configPath),
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
    deliberateStop = true;
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
    if (ctx.adapterPrivacy && resolveHandlerKey(ctx.bleHandler) !== 'node-ble') {
      // Only node-ble pairs with the host adapter. Said once, here, rather than
      // left to look like an option that did nothing (#417).
      log.warn(
        'ble.adapter_privacy only applies to the built-in Linux BlueZ transport (node-ble); ignored.',
      );
    }
    if (
      (ctx.config.runtime?.no_reading_rescan_delay ?? 0) > 0 &&
      (!initialResolved.continuousMode || resolveHandlerKey(ctx.bleHandler) !== 'node-ble')
    ) {
      // Only the node-ble poll loop tags a session that heard the scale (#475),
      // and a single run has no next session to wait for.
      log.warn(
        'runtime.no_reading_rescan_delay only applies in continuous mode on the built-in Linux ' +
          'BlueZ transport (node-ble); ignored.',
      );
    }

    if (ctx.bleHandler === 'mqtt-proxy' && ctx.mqttProxy) {
      const bootstrapped = await bootstrapMqttProxy(ctx.mqttProxy);
      ctx.mqttProxy = bootstrapped.mqttProxy;
      ctx.embeddedBroker = bootstrapped.embeddedBroker;
      // Loaded on use, so other transports never load the mqtt-proxy handler.
      const { createMqttProxyDisplayNotifier, setDisplayUsers } =
        await import('./ble/handler-mqtt-proxy/index.js');
      // Attach the display capability; the getter reads the hot-swappable
      // ctx.mqttProxy live so config reloads take effect (#183).
      ctx.display = createMqttProxyDisplayNotifier(() => ctx.mqttProxy);
      // User info for display boards (included in config topic).
      setDisplayUsers(displayUsers(ctx.config));
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
    // does NOT require scale_mac alongside it (see the note in schema.ts); the
    // check right below does, so the override stays pointed at one device.
    let adapters: ScaleAdapter[] = [...fullRegistry];
    const forcedName = ctx.config.ble?.force_scale_adapter ?? undefined;
    if (forcedName) {
      // The same check `validate` makes, after env overrides: SCALE_MAC is the
      // documented Docker way to supply the MAC.
      const problem = forcedAdapterProblem(ctx.config, fullRegistry);
      if (problem) {
        log.error(problem);
        process.exit(1);
      }
      adapters = applyForcedAdapter(fullRegistry, forcedName);
      log.warn(
        `Scale adapter forced to "${adapters[0].name}" by config; protocol auto-detection is off. ` +
          'If auto-detection picked the wrong adapter, please report it so the matcher can be fixed.',
      );
    }
    log.info(`Adapters: ${adapters.map((a) => a.name).join(', ')}\n`);

    // Optional + no-op for adapters without configure(). Re-applied on config
    // reload below so a hot-edited key or unit takes effect.
    const applyAdapterConfig = (): void => {
      for (const a of adapters) a.configure?.(buildAdapterRuntimeConfig(ctx.config, ctx.scaleMac));
    };
    applyAdapterConfig();

    // Before the first session: a Salter weigh-in exported just before a restart
    // is still inside the adapter's age bound, and only the persisted mark keeps
    // the fresh process from exporting it again (review D-15).
    const dedupMarksPath = resolveDedupMarksPath(ctx.configPath);
    restoreDedupMarks(dedupMarksPath, adapters);

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

    // systemd Type=notify integration (#144). No-op when NOTIFY_SOCKET is unset.
    notifyReady();
    startHeartbeat();

    const runProcessReading = async (
      raw: Parameters<typeof processReading>[1],
    ): Promise<boolean> => {
      try {
        return await processReading(ctx, raw, {
          singleUserExporters,
          getExportersForUser: (slug) => getExportersForUser(ctx, slug),
        });
      } finally {
        // After the exports, so a process killed mid-export re-reads and delivers
        // the weigh-in instead of having marked it done. Not on a dry run, which
        // promises to leave things for a real run, as the queue flush does.
        if (!ctx.dryRun) persistDedupMark(dedupMarksPath, raw.adapter);
      }
    };

    // Started with the scan of a single run and awaited before it reports, so a
    // total export failure, which exits non-zero below, still lets the flush
    // finish first (#412). In continuous mode the loop starts it at the top of
    // each iteration without waiting for it (E-02).
    const flushQueuedExports = async (): Promise<void> => {
      if (!ctx.exportQueuePath) return;
      // A dry run promises to skip exports, and a queued upload firing under it
      // is exactly what that promise is about. Nothing is delivered and nothing
      // is dropped: the queue is left for a real run.
      if (ctx.dryRun) return;
      try {
        await flushQueue(
          ctx.exportQueuePath,
          (entry) => resolveQueuedExporter(ctx, entry),
          Date.now(),
          ctx.signal,
        );
      } catch (err) {
        // Warn, not debug: the queue holds weigh-ins that are in no other place,
        // and a pass that dies here is the only trace of why one went missing
        // (E-08).
        log.warn(`Retrying queued exports failed: ${errMsg(err)}`);
      }
    };

    // Once, before the first cycle: after a restart nothing else says the queue
    // survived until the first retry pass, which can be most of an hour away
    // (#460).
    if (ctx.exportQueuePath) logQueueAtStartup(ctx.exportQueuePath, ctx.dryRun);

    if (!initialResolved.continuousMode) {
      const success = await runSingleShot({
        source: new PollReadingSource(ctx, adapters, { singleShot: true }),
        signal: ctx.signal,
        processReading: runProcessReading,
        flush: flushQueuedExports,
      });
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
      applyAdapterConfig();
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

    // Every hook the source built goes to the loop as is. Listed one by one, a
    // new hook was dropped by forgetting a line here, which no test runs (#475).
    const { source, ...sourceHooks } = bundle;
    // And every hook the source can build must be one the loop reads: a key
    // only the bundle knows would pass through the spread and be ignored.
    type HookOnlyTheSourceKnows = Exclude<keyof ReadingSourceBundle, keyof RuntimeLoopDeps>;
    const _everyHookReachesLoop: [HookOnlyTheSourceKnows] extends [never] ? true : never = true;
    await runContinuousLoop({
      ...sourceHooks,
      source,
      processReading: runProcessReading,
      signal: ctx.signal,
      touchHeartbeat,
      isReloadRequested: () => needsReload,
      clearReloadRequest: () => {
        needsReload = false;
      },
      onReload,
      onCycleStart: flushQueuedExports,
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

  await main()
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
}

// `node dist/run.js` still runs the app directly (ARCHITECTURE.md).
if (isMainModule(import.meta.url, process.argv[1])) {
  void run(process.argv.slice(2));
}
