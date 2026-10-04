import type { RawReading } from '../ble/shared.js';
import type { Exporter, ExportContext } from '../interfaces/exporter.js';
import type {
  BodyComposition,
  ScaleAdapter,
  ScaleReading,
  UserProfile,
} from '../interfaces/scale-adapter.js';
import type { WeightUnit, UserConfig } from '../config/schema.js';
import type { AppContext } from './context.js';
import { resolveUserProfile } from '../config/resolve.js';
import { matchUserByWeight, detectWeightDrift, isOutOfRange } from '../config/user-matching.js';
import { updateLastKnownWeight } from '../config/write.js';
import { dispatchExports, type ExportAttempt } from '../orchestrator.js';
import { createLogger } from '../logger.js';
import { checkAndLogUpdate } from '../update-check.js';
import { fmtWeight } from './format.js';
import { enqueue } from './export-queue.js';
import { exporterSlot } from './exporter-slot.js';
import { isHistoricalReading, measurementTime } from '../interfaces/reading-time.js';
import {
  IMPEDANCE_MAX_OHM,
  IMPEDANCE_MIN_OHM,
  isPlausibleImpedance,
} from '../scales/body-comp-helpers.js';

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

/** Tolerance for treating a historical replay weight as a duplicate of the last exported weight. */
const DEDUP_KG_TOLERANCE = 0.1;

/**
 * One reading of a cycle, classified once when the cycle is received (D027).
 *
 * `historical` and `measuredAt` are decided here and nowhere else, so the
 * export, the queue entry and every retry of it agree on what this reading is
 * and when it happened.
 */
interface Frame {
  reading: ScaleReading;
  /** A record from the scale's memory, older than HISTORY_WINDOW_MS. */
  historical: boolean;
  /** When it was measured: the frame's own time, or the receipt time. */
  measuredAt: Date;
}

function classifyFrames(raw: RawReading, receivedAt: Date): Frame[] {
  const all = raw.history ? [...raw.history, raw.reading] : [raw.reading];
  return all.map((reading) => ({
    reading,
    historical: isHistoricalReading(reading, receivedAt.getTime()),
    measuredAt: measurementTime(reading, receivedAt),
  }));
}

/** Combine the user prefix and `[historic <ISO>]` (stored records only) into the log tag. */
function frameTag(prefix: string, frame: Frame): string {
  const ht = frame.historical ? `[historic ${frame.measuredAt.toISOString()}]` : '';
  if (prefix && ht) return `${prefix} ${ht}`;
  return prefix || ht;
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
 * Body composition for one frame, with the impedance decision made HERE (D028).
 *
 * Adapters used to decide on their own what an impedance of 0, a 0xFFFF
 * sentinel or a mis-scaled field meant, and several decided wrong: one ran its
 * vendor formula on 0 ohm, another exported 6553.5 ohm. The processor now
 * checks the impedance against the same plausible band the shared BIA guard
 * uses and, when it fails, sets it to 0 on the reading itself before the
 * adapter computes anything. 0 is the contract's "no impedance": the adapter
 * then has to produce the BMI estimate.
 *
 * In place on purpose: adapters pin their decoded composition to the reading
 * OBJECT (`ReadingComposition`), so a copy would lose it.
 */
function computeFrameMetrics(
  adapter: ScaleAdapter,
  reading: ScaleReading,
  profile: UserProfile,
  tagPrefix: string,
): BodyComposition {
  if (reading.impedance !== 0 && !isPlausibleImpedance(reading.impedance)) {
    log.info(
      `${tagPrefix}Impedance ${reading.impedance} Ohm is not a usable measurement ` +
        `(${IMPEDANCE_MIN_OHM}-${IMPEDANCE_MAX_OHM} Ohm), so body composition is the BMI estimate.`,
    );
    reading.impedance = 0;
  }
  return adapter.computeMetrics(reading, profile);
}

/**
 * Persist a failed export so a later cycle can deliver it (#412).
 *
 * Only exporters that accept a backdated reading are queued. The others cannot
 * express "this happened on Tuesday" at all, so a late delivery would put a
 * stale number in front of the user as if it were current: a retained MQTT
 * topic contradicting the live one, or a push notification about a weigh-in
 * from yesterday. For those the reading is genuinely gone, and the log says so
 * rather than leaving the user to infer it.
 *
 * Keyed on the attempted INSTANCE and the config slot it was built from (D029):
 * a list may hold two exporters of one type, and the queue has to retry the one
 * that failed, not the first of its type.
 */
function queueFailedExports(
  ctx: AppContext,
  payload: BodyComposition,
  context: ExportContext,
  attempts: ExportAttempt[],
  measuredAt: Date,
): void {
  const failed = attempts.filter((a) => !a.detail.ok);
  if (failed.length === 0) return;

  const unrecoverable: string[] = [];

  for (const { exporter, detail } of failed) {
    if (!exporter.supportsBackdate) {
      unrecoverable.push(detail.name);
      continue;
    }
    if (!ctx.retryFailedExports || !ctx.exportQueuePath) continue;
    const slot = exporterSlot(exporter);
    enqueue(ctx.exportQueuePath, {
      exporter: detail.name,
      ...(slot ? { exporterList: slot.list, exporterIndex: slot.index } : {}),
      payload,
      // The same measurement time the live dispatch carried (D027, F-06), so a
      // target that keys on it sees the retry as the same reading.
      timestamp: measuredAt.toISOString(),
      ...(context.userName ? { userName: context.userName } : {}),
      ...(context.userSlug ? { userSlug: context.userSlug } : {}),
      queuedAt: new Date().toISOString(),
      attempts: 0,
      ...(detail.error ? { lastError: detail.error } : {}),
    });
  }

  if (unrecoverable.length > 0) {
    log.warn(
      `${unrecoverable.join(', ')} cannot record a past reading, so this measurement ` +
        `is not recoverable for ${unrecoverable.length > 1 ? 'those targets' : 'that target'}.`,
    );
  }
}

/**
 * Unified reading processor. Single-user mode is the degenerate case of
 * multi-user with `users.length === 1`: it skips weight-based matching, drift
 * detection and beep cues.
 *
 * Returns the success of the last export it dispatched (true when nothing was
 * dispatched: dry run, a deliberate skip, or every frame deduped).
 */
export async function processReading(
  ctx: AppContext,
  raw: RawReading,
  opts: ProcessReadingOpts = {},
): Promise<boolean> {
  // The one moment "now" is taken for this cycle (D027): what is history and
  // what time a stampless reading gets are both decided against it.
  const frames = classifyFrames(raw, new Date());
  const stored = frames.filter((f) => f.historical);
  const live = frames.filter((f) => !f.historical);
  if (ctx.config.users.length > 1) {
    return processMultiUser(ctx, raw, stored, live, opts.getExportersForUser);
  }
  return processSingleUser(ctx, raw, stored, live, opts.singleUserExporters);
}

/** One frame attributed to one user, ready to export. */
interface Assigned {
  frame: Frame;
  user: UserConfig;
  /** Drift warning for the live frame (multi-user only). */
  drift?: string;
}

/**
 * Compute, log and export one frame for its user.
 *
 * `exported` is true only for a dispatch at least one exporter accepted; a dry
 * run, a dedup skip and a total failure all leave it false, so the caller
 * anchors `last_known_weight` only on a weight that actually went out.
 */
async function exportFrame(
  ctx: AppContext,
  raw: RawReading,
  item: Assigned,
  exporters: Exporter[] | undefined,
  prefix: string,
): Promise<{ dispatched: boolean; success: boolean; exported: boolean }> {
  const { frame, user } = item;
  const { reading } = frame;
  const tag = frameTag(prefix, frame);
  const tagPrefix = tag ? `${tag} ` : '';

  // Replay dedup: skip a stored record whose weight matches the last weight
  // exported for this user (likely a re-export of an already-synced weigh-in).
  // The runtime anchor first, then config: in single-run mode every run is a
  // new process, and the persisted last_known_weight is its only memory (E-09).
  const anchor = ctx.lastExportedWeights.get(user.slug) ?? user.last_known_weight;
  if (
    frame.historical &&
    anchor !== null &&
    Math.abs(reading.weight - anchor) < DEDUP_KG_TOLERANCE
  ) {
    log.info(
      `${tagPrefix}Skipping replay: weight ${fmtWeight(reading.weight, ctx.weightUnit)} ` +
        `matches the last exported weight within +/-${DEDUP_KG_TOLERANCE} kg`,
    );
    return { dispatched: false, success: true, exported: false };
  }

  const profile = resolveUserProfile(user, ctx.config.scale);
  const payload = computeFrameMetrics(raw.adapter, reading, profile, tagPrefix);

  log.info(
    `\n${tagPrefix}Measurement: ${fmtWeight(payload.weight, ctx.weightUnit)} / ${payload.impedance} Ohm`,
  );
  logBodyComp(payload, ctx.weightUnit, tag);

  // Dry-run signal is unified: ctx.dryRun OR (single-user) undefined exporters.
  // An empty exporter array is NOT a skip: it dispatches to nothing and reports
  // success, matching the prior multi-user behaviour.
  if (ctx.dryRun || exporters === undefined) {
    log.info(`${tagPrefix}Dry run. Skipping export.`);
    return { dispatched: false, success: true, exported: false };
  }

  if (!frame.historical) {
    // notifyReading uses raw scale values (pre-computeMetrics) so the display
    // mirrors what the scale measured; notifyResult uses the computed payload.
    ctx.display?.reading(
      user.slug,
      user.name,
      reading.weight,
      reading.impedance,
      exporters.map((e) => e.name),
    );
  }

  const context: ExportContext = {
    userName: user.name,
    userSlug: user.slug,
    userConfig: user,
    weightUnit: ctx.weightUnit,
    ...(item.drift ? { driftWarning: item.drift } : {}),
    // Always set, live or not: every backdate exporter records this one time,
    // and the queue entry below carries the same value (F-04, F-06). Without it
    // each exporter, and each Garmin retry process, took its own `now`.
    timestamp: frame.measuredAt,
    ...(frame.historical ? { historical: true } : {}),
  };

  const label =
    `${fmtWeight(reading.weight, ctx.weightUnit)} for ${user.name} ` +
    `measured at ${frame.measuredAt.toISOString()}`;
  const result = await dispatchExports(exporters, payload, context, {
    signal: ctx.signal,
    label,
  });
  queueFailedExports(ctx, payload, context, result.attempts, frame.measuredAt);

  if (!frame.historical) {
    ctx.display?.result(user.slug, user.name, payload.weight, result.details);
  }
  // dispatchExports returns false only when EVERY exporter failed, so a
  // partial success still counts as exported.
  return { dispatched: true, success: result.success, exported: result.success };
}

/**
 * The value config.yaml held for a user before this process first moved it,
 * per user OBJECT, so a reload (which builds new objects from the file) starts
 * over from what the file says.
 */
const persistedWeights = new WeakMap<UserConfig, number | null>();

/**
 * Remember the weight of a LIVE weigh-in that was exported (E-03, E-09).
 *
 * Three readers depend on it: the replay dedup, the matcher's tie-break and
 * last-known tiers, and the QN weight anchor (`resolveUserProfile`). The value
 * used to be written only to config.yaml, and only in multi-user mode, while
 * all three read the copy in memory, which therefore stayed at whatever the
 * process started with. It is now set in memory in both modes, and written to
 * the file in both modes when there is a config.yaml to write to.
 *
 * Never called for a stored record (D027): a replay from the scale's memory is
 * by definition older than the weigh-in the anchor already reflects.
 *
 * The file is written only after a change of 0.5 kg against what is ON DISK,
 * not against the in-memory value, which now moves on every weigh-in: compared
 * with that, a run of small steps would never reach the threshold and the file
 * would drift away from the person indefinitely.
 */
function recordLiveWeight(ctx: AppContext, user: UserConfig, weight: number): void {
  ctx.lastExportedWeights.set(user.slug, weight);
  if (!persistedWeights.has(user)) persistedWeights.set(user, user.last_known_weight);
  user.last_known_weight = weight;

  if (ctx.configSource !== 'yaml' || !ctx.configPath) return;
  const onDisk = persistedWeights.get(user) ?? null;
  updateLastKnownWeight(ctx.configPath, user.slug, weight, onDisk);
  if (onDisk === null || Math.abs(weight - onDisk) >= 0.5) persistedWeights.set(user, weight);
}

/**
 * Stop a reading nobody's `weight_range` vouches for, when asked to.
 *
 * `weight_range` was only ever a MATCHING input. A weight outside every range
 * still resolves to somebody, through the single-user tier that always matches
 * or through the `last_known_weight` proximity tier, and then exports like any
 * other reading. A reporter stood on the scale holding a suitcase, got
 * 178 kg at 0 ohm, and it reached Garmin and a retained MQTT topic. The lasting
 * damage was `last_known_weight` being rewritten to 178, which then tie-broke
 * the NEXT genuine weigh-in to the wrong user and dropped it (#395).
 *
 * Applied to EVERY frame against the user that frame was attributed to (E-04).
 * It used to gate the whole batch on the live weight, so a stored 178 kg record
 * rode along with an in-range live weigh-in, and an out-of-range live reading
 * took perfectly good stored records down with it. Each stored record is now
 * attributed on its own weight (D027), so it is gated on its own weight too.
 *
 * `warn` still logs. Multi-user gets a warning from the matcher on its way here,
 * but the single-user path never calls the matcher at all, so without this an
 * out-of-range reading would go out with no output whatsoever, which is not what
 * `warn` says on the tin.
 *
 * Returns true when the caller should drop the frame. The error beep is only
 * for the live weigh-in: it is a cue for the person standing on the scale.
 */
function skipOutOfRange(
  ctx: AppContext,
  user: UserConfig,
  weight: number,
  prefix: string,
  beep: boolean,
): boolean {
  if (!isOutOfRange(user, weight)) return false;
  const p = prefix ? `${prefix} ` : '';
  const range = `${user.name}'s range [${user.weight_range.min}-${user.weight_range.max}] kg`;
  if (ctx.config.out_of_range !== 'skip') {
    log.warn(
      `${p}${fmtWeight(weight, ctx.weightUnit)} is outside ${range}. ` +
        'Exporting it anyway (out_of_range: warn). Set out_of_range: skip to drop it instead.',
    );
    return false;
  }
  log.warn(
    `${p}Skipping ${fmtWeight(weight, ctx.weightUnit)}: outside ${range} ` +
      '(out_of_range: skip). Not exported, and last_known_weight is left alone.',
  );
  if (beep) ctx.display?.beep(600, 150, 3);
  return true;
}

/**
 * Export the attributed frames in the order the scale produced them (stored
 * records oldest first, then the live weigh-in), and anchor the live one.
 */
async function exportAssigned(
  ctx: AppContext,
  raw: RawReading,
  items: Assigned[],
  exportersFor: (user: UserConfig) => Exporter[] | undefined,
  prefixFor: (user: UserConfig) => string,
): Promise<boolean> {
  let lastSuccess = true;
  for (const item of items) {
    const outcome = await exportFrame(
      ctx,
      raw,
      item,
      exportersFor(item.user),
      prefixFor(item.user),
    );
    if (outcome.dispatched) lastSuccess = outcome.success;
    // last_known_weight stores the raw scale value of a live weigh-in that was
    // actually exported. Setting it on a total failure poisoned the retry: the
    // scale reconnects, replays the same weigh-in from memory, and the dedup
    // drops it as already synced.
    if (outcome.exported && !item.frame.historical) {
      recordLiveWeight(ctx, item.user, item.frame.reading.weight);
    }
  }
  return lastSuccess;
}

/**
 * Whether a stored record belongs to the single configured user. Only a frame
 * that names a scale user slot, for a user who configured a different slot, is
 * somebody else's: everything else stays, as before.
 */
function storedBelongsTo(user: UserConfig, frame: Frame, tag: string): boolean {
  const idx = frame.reading.userIndex;
  if (idx === undefined || user.beurer_user_index === undefined) return true;
  if (idx === user.beurer_user_index) return true;
  log.info(
    `${tag} Dropping a stored record of scale user ${idx}: ${user.name} is scale user ` +
      `${user.beurer_user_index}, so it is somebody else's weigh-in.`,
  );
  return false;
}

async function processSingleUser(
  ctx: AppContext,
  raw: RawReading,
  stored: Frame[],
  live: Frame[],
  exporters: Exporter[] | undefined,
): Promise<boolean> {
  const user = ctx.config.users[0];
  const items: Assigned[] = [];

  for (const frame of stored) {
    const tag = frameTag('', frame);
    if (!storedBelongsTo(user, frame, tag)) continue;
    if (skipOutOfRange(ctx, user, frame.reading.weight, tag, false)) continue;
    items.push({ frame, user });
  }
  for (const frame of live) {
    // Before the update check and before any export, so a skipped reading
    // leaves nothing behind but the log line and the error beep.
    if (skipOutOfRange(ctx, user, frame.reading.weight, '', true)) continue;
    items.push({ frame, user });
  }
  if (items.length === 0) return true;

  checkAndLogUpdate(ctx.config.update_check);

  return exportAssigned(
    ctx,
    raw,
    items,
    () => exporters,
    () => '',
  );
}

/**
 * The user a stored record belongs to in multi-user mode (D027, E-04), or null
 * to drop it.
 *
 * A record from the scale's memory is a weigh-in nobody watched land, so it is
 * attributed on its OWN merits, never to whoever happens to be on the scale
 * now: it used to follow the live weight, which sent one person's stored
 * weigh-in into another person's Garmin account. The scale's own user slot
 * decides when the frame carries one and exactly one user claims that slot;
 * otherwise the ordinary weight matcher does. A record the matcher can place
 * only by config order, or not at all, is dropped with a line saying why.
 */
function attributeStored(ctx: AppContext, frame: Frame): UserConfig | null {
  const tag = frameTag('', frame);
  const { weight, userIndex } = frame.reading;
  const users = ctx.config.users;

  if (userIndex !== undefined) {
    const owners = users.filter((u) => u.beurer_user_index === userIndex);
    if (owners.length === 1) return owners[0];
    if (owners.length > 1) {
      log.warn(
        `${tag} Dropping a stored record of scale user ${userIndex}: ` +
          `${owners.map((u) => u.name).join(' and ')} all claim that slot (beurer_user_index).`,
      );
      return null;
    }
    // Nobody claims the slot: the weight is the only evidence left.
  }

  const match = matchUserByWeight(users, weight, ctx.config.unknown_user);
  if (!match.user) {
    log.warn(
      `${tag} Dropping a stored record of ${fmtWeight(weight, ctx.weightUnit)}: it matches no user.`,
    );
    return null;
  }
  if (match.ambiguous) {
    log.warn(
      `${tag} Dropping a stored record of ${fmtWeight(weight, ctx.weightUnit)}: it fits more ` +
        'than one user and nothing tells them apart, so it cannot be attributed safely.',
    );
    return null;
  }
  return match.user;
}

async function processMultiUser(
  ctx: AppContext,
  raw: RawReading,
  stored: Frame[],
  live: Frame[],
  getExportersForUser: ((slug: string) => Exporter[]) | undefined,
): Promise<boolean> {
  const items: Assigned[] = [];
  const latestLive = live[live.length - 1];

  if (latestLive) {
    log.info(
      `\nRaw reading: ${fmtWeight(latestLive.reading.weight, ctx.weightUnit)} / ` +
        `${latestLive.reading.impedance} Ohm` +
        (stored.length > 0 ? ` (+ ${stored.length} historical)` : ''),
    );
  } else if (stored.length > 0) {
    log.info(`\n${stored.length} stored reading(s) from the scale's memory, no live weigh-in.`);
  }

  for (const frame of stored) {
    const user = attributeStored(ctx, frame);
    if (!user) continue;
    if (skipOutOfRange(ctx, user, frame.reading.weight, frameTag(`[${user.name}]`, frame), false)) {
      continue;
    }
    items.push({ frame, user });
  }

  if (latestLive) {
    const match = matchUserByWeight(
      ctx.config.users,
      latestLive.reading.weight,
      ctx.config.unknown_user,
    );
    if (!match.user) {
      // matchUserByWeight has already logged its warning, if it has one.
      ctx.display?.beep(600, 150, 3);
    } else {
      const user = match.user;
      const prefix = `[${user.name}]`;
      // Before the "Matched" line, the beep, the exporters and the
      // last_known_weight write. A match is not an endorsement of the weight:
      // tier 4 in particular matches by proximity to a remembered weight, not
      // by any range containing this one (#395).
      if (!skipOutOfRange(ctx, user, latestLive.reading.weight, prefix, true)) {
        log.info(`${prefix} Matched (tier: ${match.tier})`);
        ctx.display?.beep(1200, 200, 2);
        const drift = detectWeightDrift(user, latestLive.reading.weight);
        if (drift) log.warn(`${prefix} ${drift}`);
        // Every live frame of the cycle goes to the person on the scale; the
        // drift warning rides on the one the matcher looked at.
        for (const frame of live) {
          items.push({ frame, user, ...(drift && frame === latestLive ? { drift } : {}) });
        }
      }
    }
  }

  if (items.length === 0) return true;

  // Once per cycle that has something to export, independent of replay dedup:
  // inside the per-frame loop it would be skipped whenever the newest reading
  // happens to be deduped.
  checkAndLogUpdate(ctx.config.update_check);

  return exportAssigned(
    ctx,
    raw,
    items,
    (user) => (getExportersForUser ? getExportersForUser(user.slug) : []),
    (user) => `[${user.name}]`,
  );
}
