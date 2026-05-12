import type { RawReading } from '../ble/shared.js';
import type { Exporter, ExportContext } from '../interfaces/exporter.js';
import type { BodyComposition } from '../interfaces/scale-adapter.js';
import type { AppContext } from './context.js';
import {
  publishBeep,
  publishDisplayReading,
  publishDisplayResult,
} from '../ble/handler-mqtt-proxy/index.js';
import { resolveForSingleUser, resolveUserProfile } from '../config/resolve.js';
import { matchUserByWeight, detectWeightDrift } from '../config/user-matching.js';
import { updateLastKnownWeight } from '../config/write.js';
import { dispatchExports } from '../orchestrator.js';
import { createLogger } from '../logger.js';
import { checkAndLogUpdate } from '../update-check.js';
import { fmtWeight } from './format.js';

const log = createLogger('Sync');

function logBodyComp(payload: BodyComposition, weightUnit: 'kg' | 'lbs', prefix = ''): void {
  const p = prefix ? `${prefix} ` : '';
  log.info(`${p}Body composition:`);
  const kgMetrics = new Set(['boneMass', 'muscleMass']);
  const { weight: _w, impedance: _i, ...metrics } = payload;
  for (const [k, v] of Object.entries(metrics)) {
    const display = kgMetrics.has(k) ? fmtWeight(v, weightUnit) : String(v);
    log.info(`${p}  ${k}: ${display}`);
  }
}

export interface ProcessReadingOpts {
  /** Pre-built exporters for single-user mode. Undefined = dry run skip. */
  singleUserExporters?: Exporter[];
  /** Per-user exporter lookup for multi-user mode (cached by AppContext). */
  getExportersForUser?: (slug: string) => Exporter[];
}

/**
 * Unified reading processor. Single-user mode is the degenerate case of
 * multi-user with `users.length === 1`: skips weight-based matching, drift
 * detection, beep cues, and last-known-weight write.
 *
 * Returns true if export succeeded (or was skipped via dry-run / unknown-user
 * strategy), false on dispatch failure.
 */
export async function processReading(
  ctx: AppContext,
  raw: RawReading,
  opts: ProcessReadingOpts = {},
): Promise<boolean> {
  const isMultiUser = ctx.config.users.length > 1;
  if (isMultiUser) {
    return processMultiUser(ctx, raw, opts.getExportersForUser);
  }
  return processSingleUser(ctx, raw, opts.singleUserExporters);
}

async function processSingleUser(
  ctx: AppContext,
  raw: RawReading,
  exporters: Exporter[] | undefined,
): Promise<boolean> {
  const { profile } = resolveForSingleUser(ctx.config);
  const user = ctx.config.users[0];
  const payload = raw.adapter.computeMetrics(raw.reading, profile);

  log.info(
    `\nMeasurement received: ${fmtWeight(payload.weight, ctx.weightUnit)} / ${payload.impedance} Ohm`,
  );
  logBodyComp(payload, ctx.weightUnit);

  // Update check after successful reading (fire-and-forget, max once per 24h)
  checkAndLogUpdate(ctx.config.update_check);

  if (!exporters) {
    log.info('\nDry run. Skipping export.');
    return true;
  }

  if (ctx.bleHandler === 'mqtt-proxy' && ctx.mqttProxy) {
    publishDisplayReading(
      ctx.mqttProxy,
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

  if (ctx.bleHandler === 'mqtt-proxy' && ctx.mqttProxy) {
    publishDisplayResult(ctx.mqttProxy, user.slug, user.name, payload.weight, details).catch(
      () => {},
    );
  }

  return success;
}

async function processMultiUser(
  ctx: AppContext,
  raw: RawReading,
  getExportersForUser: ((slug: string) => Exporter[]) | undefined,
): Promise<boolean> {
  const weight = raw.reading.weight;
  log.info(`\nRaw reading: ${fmtWeight(weight, ctx.weightUnit)} / ${raw.reading.impedance} Ohm`);

  // Match user by weight
  const match = matchUserByWeight(ctx.config.users, weight, ctx.config.unknown_user);

  if (!match.user) {
    if (match.warning) log.warn(match.warning);
    // Beep: unknown / out of range (3x low tone)
    if (ctx.bleHandler === 'mqtt-proxy' && ctx.mqttProxy) {
      publishBeep(ctx.mqttProxy, 600, 150, 3).catch(() => {});
    }
    return true; // Not a failure: strategy decided to skip
  }

  const user = match.user;
  const prefix = `[${user.name}]`;
  log.info(`${prefix} Matched (tier: ${match.tier})`);

  // Beep: user matched (2x high tone)
  if (ctx.bleHandler === 'mqtt-proxy' && ctx.mqttProxy) {
    publishBeep(ctx.mqttProxy, 1200, 200, 2).catch(() => {});
  }

  // Build exporters for this user (cached). Needed for display reading names.
  const exporters = getExportersForUser ? getExportersForUser(user.slug) : [];

  // Notify display: user matched, export in progress
  if (ctx.bleHandler === 'mqtt-proxy' && ctx.mqttProxy) {
    publishDisplayReading(
      ctx.mqttProxy,
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
  const profile = resolveUserProfile(user, ctx.config.scale);
  const payload = raw.adapter.computeMetrics(raw.reading, profile);

  log.info(
    `${prefix} Measurement: ${fmtWeight(payload.weight, ctx.weightUnit)} / ${payload.impedance} Ohm`,
  );
  logBodyComp(payload, ctx.weightUnit, prefix);

  // Update check after successful reading (fire-and-forget, max once per 24h)
  checkAndLogUpdate(ctx.config.update_check);

  if (ctx.dryRun) {
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
  if (ctx.bleHandler === 'mqtt-proxy' && ctx.mqttProxy) {
    publishDisplayResult(ctx.mqttProxy, user.slug, user.name, payload.weight, details).catch(
      () => {},
    );
  }

  // Update last known weight in config.yaml (async, debounced)
  if (ctx.configSource === 'yaml' && ctx.configPath) {
    updateLastKnownWeight(ctx.configPath, user.slug, weight, user.last_known_weight);
  }

  return success;
}
