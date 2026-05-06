#!/usr/bin/env tsx

import { parseArgs } from 'node:util';
import { writeFileSync } from 'node:fs';
import { scanAndReadRaw, ReadingWatcher } from './ble/index.js';
import type { RawReading } from './ble/index.js';
import {
  publishBeep,
  publishDisplayReading,
  publishDisplayResult,
  setDisplayUsers,
} from './ble/handler-mqtt-proxy/index.js';
import { bootstrapMqttProxy } from './ble/mqtt-proxy-bootstrap.js';
import type { EmbeddedBrokerHandle } from './ble/embedded-broker.js';
import { abortableSleep, POST_DISCONNECT_GRACE_MS } from './ble/types.js';
import { ConsecutiveFailureWatchdog } from './ble/watchdog.js';
import { notifyReady, startHeartbeat, stopHeartbeat } from './runtime/systemd-watchdog.js';
import { adapters } from './scales/index.js';
import { createLogger, setLogLevel, LogLevel } from './logger.js';
import { errMsg } from './utils/error.js';
import { createExporterFromEntry } from './exporters/registry.js';
import { runHealthchecks, dispatchExports } from './orchestrator.js';
import { loadAppConfig, loadYamlConfig } from './config/load.js';
import {
  resolveForSingleUser,
  resolveExportersForUser,
  resolveUserProfile,
  resolveRuntimeConfig,
} from './config/resolve.js';
import { matchUserByWeight, detectWeightDrift } from './config/user-matching.js';
import { updateLastKnownWeight, withWriteLock } from './config/write.js';
import type { Exporter, ExportContext } from './interfaces/exporter.js';
import type { BodyComposition } from './interfaces/scale-adapter.js';
import type { WeightUnit } from './config/schema.js';
import { checkAndLogUpdate } from './update-check.js';

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

// ─── Config loading ─────────────────────────────────────────────────────────

const log = createLogger('Sync');

const loaded = loadAppConfig(cliFlags.config as string | undefined);
let appConfig = loaded.config;
const configSource = loaded.source;
const configPath = loaded.configPath;

if (appConfig.runtime?.debug) setLogLevel(LogLevel.DEBUG);

const {
  scaleMac: SCALE_MAC,
  weightUnit,
  dryRun,
  continuousMode,
  scanCooldownSec,
  watchdogMaxFailures,
  bleHandler,
  bleAdapter,
  mqttProxy: initialMqttProxy,
  esphomeProxy,
} = resolveRuntimeConfig(appConfig);

let mqttProxy = initialMqttProxy;
let embeddedBroker: EmbeddedBrokerHandle | null = null;

const KG_TO_LBS = 2.20462;

function fmtWeight(kg: number, unit: WeightUnit): string {
  if (unit === 'lbs') return `${(kg * KG_TO_LBS).toFixed(2)} lbs`;
  return `${kg.toFixed(2)} kg`;
}

function logBodyComp(payload: BodyComposition, prefix = ''): void {
  const p = prefix ? `${prefix} ` : '';
  log.info(`${p}Body composition:`);
  const kgMetrics = new Set(['boneMass', 'muscleMass']);
  const { weight: _w, impedance: _i, ...metrics } = payload;
  for (const [k, v] of Object.entries(metrics)) {
    const display = kgMetrics.has(k) ? fmtWeight(v, weightUnit) : String(v);
    log.info(`${p}  ${k}: ${display}`);
  }
}

// ─── Abort / signal handling ────────────────────────────────────────────────

const ac = new AbortController();
const { signal } = ac;
let forceExitOnNext = false;

function onSignal(): void {
  if (forceExitOnNext) {
    log.info('Force exit.');
    stopHeartbeat();
    process.exit(1);
  }
  forceExitOnNext = true;
  log.info('\nShutting down gracefully... (press again to force exit)');
  // Keep the systemd watchdog heartbeat running through graceful shutdown so
  // a slow exit (>= WatchdogSec/2) does not get SIGKILL'd by the supervisor.
  // The heartbeat is stopped in the main() epilogue once cleanup completes.
  ac.abort();
}

process.on('SIGINT', onSignal);
process.on('SIGTERM', onSignal);

// ─── SIGHUP config reload ──────────────────────────────────────────────────

let needsReload = false;

if (process.platform !== 'win32') {
  process.on('SIGHUP', () => {
    log.info('Received SIGHUP, will reload config before next scan cycle');
    needsReload = true;
  });
}

const exporterCache = new Map<string, Exporter[]>();

async function reloadConfig(): Promise<void> {
  if (configSource !== 'yaml' || !configPath) return;
  await withWriteLock(async () => {
    try {
      appConfig = loadYamlConfig(configPath);
      exporterCache.clear();
      log.info('Config reloaded successfully');
    } catch (err) {
      log.error(`Config reload failed, keeping current config: ${errMsg(err)}`);
    }
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

// ─── Build exporters ────────────────────────────────────────────────────────

function buildSingleUserExporters(): Exporter[] {
  const { exporterEntries } = resolveForSingleUser(appConfig);
  return exporterEntries.map((e) => createExporterFromEntry(e));
}

function getExportersForUser(slug: string): Exporter[] {
  let exporters = exporterCache.get(slug);
  if (!exporters) {
    const user = appConfig.users.find((u) => u.slug === slug);
    if (!user) return [];
    const entries = resolveExportersForUser(appConfig, user);
    exporters = entries.map((e) => createExporterFromEntry(e));
    exporterCache.set(slug, exporters);
  }
  return exporters;
}

function buildAllUniqueExporters(): Exporter[] {
  const seen = new Set<string>();
  const all: Exporter[] = [];
  for (const user of appConfig.users) {
    const entries = resolveExportersForUser(appConfig, user);
    for (const entry of entries) {
      if (!seen.has(entry.type)) {
        seen.add(entry.type);
        all.push(createExporterFromEntry(entry));
      }
    }
  }
  return all;
}

// ─── Single-user cycle ──────────────────────────────────────────────────────

/** Process a raw reading for single-user mode: compute metrics, export, display feedback. */
async function processSingleReading(raw: RawReading, exporters?: Exporter[]): Promise<boolean> {
  const { profile } = resolveForSingleUser(appConfig);
  const user = appConfig.users[0];
  const payload = raw.adapter.computeMetrics(raw.reading, profile);

  log.info(
    `\nMeasurement received: ${fmtWeight(payload.weight, weightUnit)} / ${payload.impedance} Ohm`,
  );
  logBodyComp(payload);

  // Update check after successful reading (fire-and-forget, max once per 24h)
  checkAndLogUpdate(appConfig.update_check);

  if (!exporters) {
    log.info('\nDry run. Skipping export.');
    return true;
  }

  if (bleHandler === 'mqtt-proxy' && mqttProxy) {
    publishDisplayReading(
      mqttProxy,
      user.slug,
      user.name,
      payload.weight,
      payload.impedance,
      exporters.map((e) => e.name),
    ).catch(() => {});
  }

  const context: ExportContext = {
    userName: user.name,
    userSlug: user.slug,
    userConfig: user,
  };

  const { success, details } = await dispatchExports(exporters, payload, context);

  if (bleHandler === 'mqtt-proxy' && mqttProxy) {
    publishDisplayResult(mqttProxy, user.slug, user.name, payload.weight, details).catch(() => {});
  }

  return success;
}

async function runSingleUserCycle(exporters?: Exporter[]): Promise<boolean> {
  const { profile } = resolveForSingleUser(appConfig);

  const raw = await scanAndReadRaw({
    targetMac: SCALE_MAC,
    adapters,
    profile,
    weightUnit,
    abortSignal: signal,
    bleHandler,
    mqttProxy,
    esphomeProxy,
    bleAdapter,
    onLiveData(reading) {
      const impStr: string = reading.impedance > 0 ? `${reading.impedance} Ohm` : 'Measuring...';
      process.stdout.write(
        `\r  Weight: ${fmtWeight(reading.weight, weightUnit)} | Impedance: ${impStr}      `,
      );
    },
  });

  return processSingleReading(raw, exporters);
}

// ─── Process a raw reading (multi-user) ──────────────────────────────────────

async function processRawReading(raw: RawReading): Promise<boolean> {
  const weight = raw.reading.weight;
  log.info(`\nRaw reading: ${fmtWeight(weight, weightUnit)} / ${raw.reading.impedance} Ohm`);

  // Match user by weight
  const match = matchUserByWeight(appConfig.users, weight, appConfig.unknown_user);

  if (!match.user) {
    if (match.warning) log.warn(match.warning);
    // Beep: unknown / out of range (3× low tone)
    if (bleHandler === 'mqtt-proxy' && mqttProxy) {
      publishBeep(mqttProxy, 600, 150, 3).catch(() => {});
    }
    return true; // Not a failure: strategy decided to skip
  }

  const user = match.user;
  const prefix = `[${user.name}]`;
  log.info(`${prefix} Matched (tier: ${match.tier})`);

  // Beep: user matched (2× high tone)
  if (bleHandler === 'mqtt-proxy' && mqttProxy) {
    publishBeep(mqttProxy, 1200, 200, 2).catch(() => {});
  }

  // Build exporters for this user (cached). Needed for display reading names.
  const exporters = getExportersForUser(user.slug);

  // Notify display: user matched, export in progress
  if (bleHandler === 'mqtt-proxy' && mqttProxy) {
    publishDisplayReading(
      mqttProxy,
      user.slug,
      user.name,
      weight,
      raw.reading.impedance,
      exporters.map((e) => e.name),
    ).catch(() => {});
  }

  // Drift detection
  const drift = detectWeightDrift(user, weight);
  if (drift) log.warn(`${prefix} ${drift}`);

  // Compute metrics with matched user's profile
  const profile = resolveUserProfile(user, appConfig.scale);
  const payload = raw.adapter.computeMetrics(raw.reading, profile);

  log.info(
    `${prefix} Measurement: ${fmtWeight(payload.weight, weightUnit)} / ${payload.impedance} Ohm`,
  );
  logBodyComp(payload, prefix);

  // Update check after successful reading (fire-and-forget, max once per 24h)
  checkAndLogUpdate(appConfig.update_check);

  if (dryRun) {
    log.info(`${prefix} Dry run. Skipping export.`);
    return true;
  }

  // Build export context
  const context: ExportContext = {
    userName: user.name,
    userSlug: user.slug,
    userConfig: user,
    ...(drift ? { driftWarning: drift } : {}),
  };

  const { success, details } = await dispatchExports(exporters, payload, context);

  // Notify display: export results
  if (bleHandler === 'mqtt-proxy' && mqttProxy) {
    publishDisplayResult(mqttProxy, user.slug, user.name, payload.weight, details).catch(() => {});
  }

  // Update last known weight in config.yaml (async, debounced)
  if (configSource === 'yaml' && configPath) {
    updateLastKnownWeight(configPath, user.slug, weight, user.last_known_weight);
  }

  return success;
}

// ─── Multi-user cycle ───────────────────────────────────────────────────────

async function runMultiUserCycle(): Promise<boolean> {
  // Use first user's profile for BLE connection (needed by some adapters for onConnected)
  const defaultProfile = resolveUserProfile(appConfig.users[0], appConfig.scale);

  const raw = await scanAndReadRaw({
    targetMac: SCALE_MAC,
    adapters,
    profile: defaultProfile,
    weightUnit,
    abortSignal: signal,
    bleHandler,
    mqttProxy,
    esphomeProxy,
    bleAdapter,
    onLiveData(reading) {
      const impStr: string = reading.impedance > 0 ? `${reading.impedance} Ohm` : 'Measuring...';
      process.stdout.write(
        `\r  Weight: ${fmtWeight(reading.weight, weightUnit)} | Impedance: ${impStr}      `,
      );
    },
  });

  return processRawReading(raw);
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const isMultiUser = appConfig.users.length > 1;
  const modeLabel = continuousMode ? ' (continuous)' : '';
  const userLabel = isMultiUser ? ` [${appConfig.users.length} users]` : '';
  log.info(`\nBLE Scale Sync${dryRun ? ' (dry run)' : ''}${modeLabel}${userLabel}`);
  if (isMultiUser) {
    log.info(`Users: ${appConfig.users.map((u) => u.name).join(', ')}`);
  }
  if (
    bleAdapter &&
    process.platform === 'linux' &&
    bleHandler !== 'mqtt-proxy' &&
    !process.env.NOBLE_DRIVER
  ) {
    log.info(`BLE adapter: ${bleAdapter}`);
  }

  if (bleHandler === 'mqtt-proxy' && mqttProxy) {
    const bootstrapped = await bootstrapMqttProxy(mqttProxy);
    mqttProxy = bootstrapped.mqttProxy;
    embeddedBroker = bootstrapped.embeddedBroker;
  }
  if (SCALE_MAC) {
    log.info(`Scanning for scale ${SCALE_MAC}...`);
  } else {
    log.info(`Scanning for any recognized scale...`);
  }
  log.info(`Adapters: ${adapters.map((a) => a.name).join(', ')}\n`);

  let exporters: Exporter[] | undefined;
  if (!dryRun) {
    if (isMultiUser) {
      const allExporters = buildAllUniqueExporters();
      await runHealthchecks(allExporters);
    } else {
      exporters = buildSingleUserExporters();
      await runHealthchecks(exporters);
    }
  }

  // Publish user info for display boards (included in config topic)
  if (bleHandler === 'mqtt-proxy' && mqttProxy) {
    setDisplayUsers(
      appConfig.users.map((u) => ({
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

  if (!continuousMode) {
    touchHeartbeat();
    const success = isMultiUser ? await runMultiUserCycle() : await runSingleUserCycle(exporters);
    if (!success) process.exit(1);
    return;
  }

  // Continuous mode loop with exponential backoff on failures
  const BACKOFF_INITIAL_MS = 5_000;
  const BACKOFF_MAX_MS = 60_000;
  let backoffMs = 0; // 0 = no failure yet

  if (bleHandler === 'mqtt-proxy' && mqttProxy) {
    // Event-driven: persistent MQTT connection with always-on message handler
    const defaultProfile = resolveUserProfile(appConfig.users[0], appConfig.scale);
    const watcher = new ReadingWatcher(mqttProxy, adapters, SCALE_MAC, defaultProfile);

    while (!signal.aborted) {
      try {
        touchHeartbeat();

        // Start watcher (no-op if already started)
        await watcher.start();

        if (needsReload) {
          await reloadConfig();
          needsReload = false;
          watcher.updateConfig(adapters, SCALE_MAC);
          if (appConfig.users.length === 1 && !dryRun) {
            exporters = buildSingleUserExporters();
          }
        }

        const raw = await watcher.nextReading(signal);

        if (appConfig.users.length > 1) {
          await processRawReading(raw);
        } else {
          await processSingleReading(raw, exporters);
        }

        backoffMs = 0;
      } catch (err) {
        if (signal.aborted) break;
        backoffMs = backoffMs === 0 ? BACKOFF_INITIAL_MS : Math.min(backoffMs * 2, BACKOFF_MAX_MS);
        log.info(`Error processing reading, retrying in ${backoffMs / 1000}s... (${errMsg(err)})`);
        await abortableSleep(backoffMs, signal).catch(() => {});
      }
    }
    await watcher.stop();
  } else if (bleHandler === 'esphome-proxy' && esphomeProxy) {
    // Event-driven: persistent ESPHome Native API connection with BLE adv subscription
    const { ReadingWatcher: EsphomeReadingWatcher } =
      await import('./ble/handler-esphome-proxy.js');
    const watcher = new EsphomeReadingWatcher(esphomeProxy, adapters, SCALE_MAC);

    while (!signal.aborted) {
      try {
        touchHeartbeat();
        await watcher.start();

        if (needsReload) {
          await reloadConfig();
          needsReload = false;
          watcher.updateConfig(adapters, SCALE_MAC);
          if (appConfig.users.length === 1 && !dryRun) {
            exporters = buildSingleUserExporters();
          }
        }

        const raw = await watcher.nextReading(signal);

        if (appConfig.users.length > 1) {
          await processRawReading(raw);
        } else {
          await processSingleReading(raw, exporters);
        }

        backoffMs = 0;
      } catch (err) {
        if (signal.aborted) break;
        backoffMs = backoffMs === 0 ? BACKOFF_INITIAL_MS : Math.min(backoffMs * 2, BACKOFF_MAX_MS);
        log.info(
          `Error processing ESPHome reading, retrying in ${backoffMs / 1000}s... (${errMsg(err)})`,
        );
        await abortableSleep(backoffMs, signal).catch(() => {});
      }
    }
    await watcher.stop();
  } else {
    // Poll-based loop for auto/noble BLE handlers.
    //
    // The watchdog is BlueZ-specific: on Pi 3/4 Broadcom on-board chips the
    // controller can enter a stuck state after a few GATT cycles where the
    // in-handler recovery tiers (D-Bus stop, btmgmt, rfkill, systemctl) don't
    // unwedge the firmware. After N consecutive failures (post first-success)
    // we exit so Docker's `restart: unless-stopped` can rebuild the container,
    // closing all D-Bus clients and re-running the entrypoint's BT reset.
    const watchdog = new ConsecutiveFailureWatchdog(
      watchdogMaxFailures,
      ({ consecutiveFailures }) => {
        log.warn(
          `Watchdog triggered: ${consecutiveFailures} consecutive scan failures since last ` +
            `success. Exiting so the container can restart cleanly. ` +
            `If this persists on Raspberry Pi 3/4 with the on-board Bluetooth chip, ` +
            `consider an ESP32/ESPHome BLE proxy. See https://blescalesync.dev/troubleshooting`,
        );
        process.exit(1);
      },
    );

    while (!signal.aborted) {
      try {
        touchHeartbeat();

        if (needsReload) {
          await reloadConfig();
          needsReload = false;
          // Rebuild single-user exporters after reload
          if (appConfig.users.length === 1 && !dryRun) {
            exporters = buildSingleUserExporters();
          }
        }

        if (appConfig.users.length > 1) {
          await runMultiUserCycle();
        } else {
          await runSingleUserCycle(exporters);
        }

        backoffMs = 0; // Reset backoff on success
        watchdog.recordSuccess();

        if (signal.aborted) break;
        // After a successful read, the scale typically keeps advertising for
        // 15-25 s while the link layer winds down (display fades). Connecting
        // during that tail-off triggers the dying-peer GATT stall (#143). Apply
        // POST_DISCONNECT_GRACE_MS as a floor on top of the configured cooldown.
        // Failed scans in the catch branch use plain backoff, no grace.
        const cooldown = appConfig.runtime?.scan_cooldown ?? scanCooldownSec;
        const cooldownMs = cooldown * 1000;
        const effectiveMs = Math.max(cooldownMs, POST_DISCONNECT_GRACE_MS);
        if (effectiveMs > cooldownMs) {
          log.info(
            `\nWaiting ${effectiveMs / 1000}s before next scan ` +
              `(cooldown ${cooldown}s, post-disconnect grace floor ${POST_DISCONNECT_GRACE_MS / 1000}s)...`,
          );
        } else {
          log.info(`\nWaiting ${cooldown}s before next scan...`);
        }
        await abortableSleep(effectiveMs, signal);
      } catch (err) {
        if (signal.aborted) break;

        // Watchdog records the failure and may exit the process if armed and
        // tripped. Order matters: trip before sleeping so we don't waste a
        // backoff cycle on a controller we already know is wedged.
        watchdog.recordFailure();

        // Exponential backoff: 5s → 10s → 20s → 40s → 60s (cap)
        backoffMs = backoffMs === 0 ? BACKOFF_INITIAL_MS : Math.min(backoffMs * 2, BACKOFF_MAX_MS);
        log.info(`No scale found, retrying in ${backoffMs / 1000}s... (${errMsg(err)})`);
        await abortableSleep(backoffMs, signal).catch(() => {});
      }
    }
  }

  log.info('Stopped.');
}

async function shutdownEmbeddedBroker(): Promise<void> {
  if (!embeddedBroker) return;
  try {
    await embeddedBroker.close();
  } catch (err) {
    log.warn(`Embedded broker shutdown error: ${errMsg(err)}`);
  } finally {
    embeddedBroker = null;
  }
}

main()
  .catch((err: Error) => {
    if (signal.aborted) {
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
