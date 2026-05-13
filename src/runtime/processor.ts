import type { RawReading } from '../ble/shared.js';
import type { Exporter, ExportContext } from '../interfaces/exporter.js';
import type { BodyComposition } from '../interfaces/scale-adapter.js';
import type { WeightUnit } from '../config/schema.js';
import type { AppContext } from './context.js';
import {
  publishBeep,
  publishDisplayReading,
  publishDisplayResult,
} from '../ble/handler-mqtt-proxy/index.js';
import { resolveUserProfile } from '../config/resolve.js';
import { matchUserByWeight, detectWeightDrift } from '../config/user-matching.js';
import { updateLastKnownWeight } from '../config/write.js';
import { dispatchExports } from '../orchestrator.js';
import { createLogger } from '../logger.js';
import { checkAndLogUpdate } from '../update-check.js';
import { fmtWeight } from './format.js';

const log = createLogger('Sync');

// Fixed log order for body-composition metrics, independent of the order in
// which the adapter populates the payload. Matches the BodyComposition shape
// minus `weight` and `impedance` (logged separately above).
const BODY_COMP_LOG_KEYS: ReadonlyArray<keyof BodyComposition> = [
  'bmi',
  'bodyFatPercent',
  'waterPercent',
  'boneMass',
  'muscleMass',
  'visceralFat',
  'physiqueRating',
  'bmr',
  'metabolicAge',
];
const KG_METRICS = new Set<keyof BodyComposition>(['boneMass', 'muscleMass']);

function notifyReading(
  ctx: AppContext,
  slug: string,
  name: string,
  weight: number,
  impedance: number | undefined,
  exporterNames: string[],
): void {
  if (ctx.bleHandler !== 'mqtt-proxy' || !ctx.mqttProxy) return;
  publishDisplayReading(ctx.mqttProxy, slug, name, weight, impedance, exporterNames).catch(
    () => {},
  );
}

function notifyResult(
  ctx: AppContext,
  slug: string,
  name: string,
  weight: number,
  details: Array<{ name: string; ok: boolean }>,
): void {
  if (ctx.bleHandler !== 'mqtt-proxy' || !ctx.mqttProxy) return;
  publishDisplayResult(ctx.mqttProxy, slug, name, weight, details).catch(() => {});
}

function notifyBeep(ctx: AppContext, freq: number, duration: number, repeat: number): void {
  if (ctx.bleHandler !== 'mqtt-proxy' || !ctx.mqttProxy) return;
  publishBeep(ctx.mqttProxy, freq, duration, repeat).catch(() => {});
}

function logBodyComp(payload: BodyComposition, weightUnit: WeightUnit, prefix = ''): void {
  const p = prefix ? `${prefix} ` : '';
  log.info(`${p}Body composition:`);
  for (const k of BODY_COMP_LOG_KEYS) {
    const v = payload[k];
    const display = KG_METRICS.has(k) ? fmtWeight(v, weightUnit) : String(v);
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
  const user = ctx.config.users[0];
  const profile = resolveUserProfile(user, ctx.config.scale);
  const payload = raw.adapter.computeMetrics(raw.reading, profile);

  log.info(
    `\nMeasurement received: ${fmtWeight(payload.weight, ctx.weightUnit)} / ${payload.impedance} Ohm`,
  );
  logBodyComp(payload, ctx.weightUnit);

  checkAndLogUpdate(ctx.config.update_check);

  if (!exporters) {
    log.info('\nDry run. Skipping export.');
    return true;
  }

  notifyReading(
    ctx,
    user.slug,
    user.name,
    payload.weight,
    payload.impedance,
    exporters.map((e) => e.name),
  );

  const context: ExportContext = {
    userName: user.name,
    userSlug: user.slug,
    userConfig: user,
  };

  const { success, details } = await dispatchExports(exporters, payload, context);

  notifyResult(ctx, user.slug, user.name, payload.weight, details);

  return success;
}

async function processMultiUser(
  ctx: AppContext,
  raw: RawReading,
  getExportersForUser: ((slug: string) => Exporter[]) | undefined,
): Promise<boolean> {
  const weight = raw.reading.weight;
  log.info(`\nRaw reading: ${fmtWeight(weight, ctx.weightUnit)} / ${raw.reading.impedance} Ohm`);

  const match = matchUserByWeight(ctx.config.users, weight, ctx.config.unknown_user);

  if (!match.user) {
    if (match.warning) log.warn(match.warning);
    notifyBeep(ctx, 600, 150, 3);
    return true;
  }

  const user = match.user;
  const prefix = `[${user.name}]`;
  log.info(`${prefix} Matched (tier: ${match.tier})`);

  notifyBeep(ctx, 1200, 200, 2);

  const exporters = getExportersForUser ? getExportersForUser(user.slug) : [];

  notifyReading(
    ctx,
    user.slug,
    user.name,
    weight,
    raw.reading.impedance,
    exporters.map((e) => e.name),
  );

  const drift = detectWeightDrift(user, weight);
  if (drift) log.warn(`${prefix} ${drift}`);

  const profile = resolveUserProfile(user, ctx.config.scale);
  const payload = raw.adapter.computeMetrics(raw.reading, profile);

  log.info(
    `${prefix} Measurement: ${fmtWeight(payload.weight, ctx.weightUnit)} / ${payload.impedance} Ohm`,
  );
  logBodyComp(payload, ctx.weightUnit, prefix);

  checkAndLogUpdate(ctx.config.update_check);

  if (ctx.dryRun) {
    log.info(`${prefix} Dry run. Skipping export.`);
    return true;
  }

  const context: ExportContext = {
    userName: user.name,
    userSlug: user.slug,
    userConfig: user,
    ...(drift ? { driftWarning: drift } : {}),
  };

  const { success, details } = await dispatchExports(exporters, payload, context);

  notifyResult(ctx, user.slug, user.name, payload.weight, details);

  if (ctx.configSource === 'yaml' && ctx.configPath) {
    updateLastKnownWeight(ctx.configPath, user.slug, weight, user.last_known_weight);
  }

  return success;
}
