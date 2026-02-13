#!/usr/bin/env tsx

import { parseArgs } from 'node:util';
import { scanAndRead } from './ble/index.js';
import { abortableSleep } from './ble/types.js';
import { adapters } from './scales/index.js';
import { createLogger } from './logger.js';
import { errMsg } from './utils/error.js';
import { createExporterFromEntry } from './exporters/registry.js';
import { runHealthchecks, dispatchExports } from './orchestrator.js';
import { loadAppConfig } from './config/load.js';
import { resolveForSingleUser } from './config/resolve.js';
import type { Exporter } from './interfaces/exporter.js';
import type { BodyComposition } from './interfaces/scale-adapter.js';
import type { WeightUnit } from './config/schema.js';

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
  console.log('  CONTINUOUS_MODE  true/false — override runtime.continuous_mode');
  console.log('  DRY_RUN          true/false — override runtime.dry_run');
  console.log('  DEBUG            true/false — override runtime.debug');
  console.log('  SCAN_COOLDOWN    5-3600     — override runtime.scan_cooldown');
  console.log('  SCALE_MAC        MAC/UUID   — override ble.scale_mac');
  console.log('  NOBLE_DRIVER     abandonware/stoprocent — override ble.noble_driver');
  process.exit(0);
}

// ─── Config loading ─────────────────────────────────────────────────────────

const log = createLogger('Sync');

const { config: appConfig } = loadAppConfig(cliFlags.config as string | undefined);

const {
  profile,
  scaleMac: SCALE_MAC,
  weightUnit,
  dryRun,
  continuousMode,
  scanCooldownSec,
} = resolveForSingleUser(appConfig);

const KG_TO_LBS = 2.20462;

function fmtWeight(kg: number, unit: WeightUnit): string {
  if (unit === 'lbs') return `${(kg * KG_TO_LBS).toFixed(2)} lbs`;
  return `${kg.toFixed(2)} kg`;
}

// ─── Abort / signal handling ────────────────────────────────────────────────

const ac = new AbortController();
const { signal } = ac;
let forceExitOnNext = false;

function onSignal(): void {
  if (forceExitOnNext) {
    log.info('Force exit.');
    process.exit(1);
  }
  forceExitOnNext = true;
  log.info('\nShutting down gracefully... (press again to force exit)');
  ac.abort();
}

process.on('SIGINT', onSignal);
process.on('SIGTERM', onSignal);

// ─── Build exporters ────────────────────────────────────────────────────────

function buildExporters(): Exporter[] {
  const resolved = resolveForSingleUser(appConfig);
  return resolved.exporterEntries.map((entry) => createExporterFromEntry(entry));
}

// ─── Single cycle ───────────────────────────────────────────────────────────

async function runCycle(exporters?: Exporter[]): Promise<boolean> {
  const payload: BodyComposition = await scanAndRead({
    targetMac: SCALE_MAC,
    adapters,
    profile,
    weightUnit,
    abortSignal: signal,
    onLiveData(reading) {
      const impStr: string = reading.impedance > 0 ? `${reading.impedance} Ohm` : 'Measuring...';
      process.stdout.write(
        `\r  Weight: ${fmtWeight(reading.weight, weightUnit)} | Impedance: ${impStr}      `,
      );
    },
  });

  log.info(
    `\nMeasurement received: ${fmtWeight(payload.weight, weightUnit)} / ${payload.impedance} Ohm`,
  );
  log.info('Body composition:');
  const kgMetrics = new Set(['boneMass', 'muscleMass']);
  const { weight: _w, impedance: _i, ...metrics } = payload;
  for (const [k, v] of Object.entries(metrics)) {
    const display = kgMetrics.has(k) ? fmtWeight(v, weightUnit) : String(v);
    log.info(`  ${k}: ${display}`);
  }

  if (!exporters) {
    log.info('\nDry run — skipping export.');
    return true;
  }

  return dispatchExports(exporters, payload);
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const modeLabel = continuousMode ? ' (continuous)' : '';
  log.info(`\nBLE Scale Sync${dryRun ? ' (dry run)' : ''}${modeLabel}`);
  if (SCALE_MAC) {
    log.info(`Scanning for scale ${SCALE_MAC}...`);
  } else {
    log.info(`Scanning for any recognized scale...`);
  }
  log.info(`Adapters: ${adapters.map((a) => a.name).join(', ')}\n`);

  let exporters: Exporter[] | undefined;
  if (!dryRun) {
    exporters = buildExporters();
    await runHealthchecks(exporters);
  }

  if (!continuousMode) {
    const success = await runCycle(exporters);
    if (!success) process.exit(1);
    return;
  }

  // Continuous mode loop
  while (!signal.aborted) {
    try {
      await runCycle(exporters);

      // Cooldown only after a successful reading — the discovery timeout
      // (120s) already acts as the waiting period between retry attempts
      if (signal.aborted) break;
      log.info(`\nWaiting ${scanCooldownSec}s before next scan...`);
      await abortableSleep(scanCooldownSec * 1000, signal);
    } catch (err) {
      if (signal.aborted) break;
      log.info(`No scale found, retrying... (${errMsg(err)})`);
    }
  }

  log.info('Stopped.');
}

main().catch((err: Error) => {
  if (signal.aborted) {
    log.info('Stopped.');
    return;
  }
  log.error(err.message);
  process.exit(1);
});
