import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { atomicWrite } from '../config/write.js';
import type { UserConfig } from '../config/schema.js';
import { createLogger } from '../logger.js';
import { errMsg } from '../utils/error.js';

const log = createLogger('Sync');

/**
 * The last live weigh-in of each user, kept across a restart for the replay
 * dedup (D067, #475, review C1).
 *
 * The dedup asks whether a stored record was measured more than a few minutes
 * after the last live weigh-in it was compared with. That needs the exact
 * weight AND the time of that weigh-in, and both have to belong to the LAST
 * live weigh-in, so they are written after every exported one. last_known_weight
 * in config.yaml cannot carry it: it is rewritten only after a 0.5 kg change,
 * so a time next to it would belong to an older weigh-in than the one a scale
 * replays, and it is internal state that does not belong in a file the user
 * edits (the add-on also rebuilds that file from its options on every start).
 * The process start, which stood in for the time before, is the host's clock,
 * while the record carries the scale's: with a scale clock ahead of the host,
 * a replay from before the restart looked new and was exported twice.
 *
 * Lives next to the resolved config.yaml, like the dedup marks and the retry
 * queue (ADR D008, D032): the one directory that is writable and persistent on
 * every target. Without a config.yaml nothing is kept on purpose: in .env mode
 * no file holds a weight today, and this would put health data on disk where
 * none was (D014). Written through `atomicWrite`, so 0600.
 *
 * Format: `{ "<slug>": { "weight": <kg, as the scale sent it>, "time": "<ISO>" } }`.
 * The time is on the scale's clock when the weigh-in carried a stamp, even one
 * in the future: a stored copy of it arrives with that same stamp. Entries of
 * slugs this process does not know are kept, since another config may share
 * the directory.
 */
export const REPLAY_ANCHORS_FILENAME = '.last-live-weigh-ins.json';

export interface ReplayAnchor {
  /** kg, exactly as exported (not rounded like last_known_weight). */
  weight: number;
  time: Date;
}

/**
 * A time before this is a host clock that was not set yet (a Pi without an RTC
 * before NTP). Saved, it would make every stored record look newer than the
 * weigh-in until the next one, so it is neither saved nor restored.
 */
const MIN_ANCHOR_TIME_MS = Date.UTC(2024, 0, 1);

/**
 * A saved weigh-in this far from last_known_weight is older than config.yaml
 * (a downgrade that moved the config but not this file, a failed save, a
 * config restored from a backup). The weight rule against config.yaml alone,
 * the behaviour before this file existed, is then the safe choice.
 */
const STALE_ANCHOR_KG = 0.5;

/** The anchor file next to config.yaml, or undefined without one (.env mode keeps none). */
export function resolveReplayAnchorsPath(configPath?: string): string | undefined {
  return configPath ? join(dirname(resolve(configPath)), REPLAY_ANCHORS_FILENAME) : undefined;
}

type AnchorRead = { ok: true; anchors: Map<string, ReplayAnchor> } | { ok: false; error: string };

function usableTime(ms: number): boolean {
  return Number.isFinite(ms) && ms >= MIN_ANCHOR_TIME_MS;
}

/**
 * Read the file, telling a missing or broken file (nothing saved) apart from
 * one that could not be read. A save must not act on the second: writing then
 * would drop every other user's entry over a transient EIO or EBUSY.
 */
function readAnchors(path: string): AnchorRead {
  const anchors = new Map<string, ReplayAnchor>();
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true, anchors };
    return { ok: false, error: errMsg(err) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    // An empty or truncated file (a power cut) holds nothing to keep.
    log.debug(`${REPLAY_ANCHORS_FILENAME} is not valid JSON (${errMsg(err)}); nothing restored.`);
    return { ok: true, anchors };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    log.debug(`${REPLAY_ANCHORS_FILENAME} does not hold an object; nothing restored.`);
    return { ok: true, anchors };
  }
  for (const [slug, entry] of Object.entries(parsed)) {
    const e = entry as { weight?: unknown; time?: unknown } | null;
    const weight = e && typeof e === 'object' ? e.weight : undefined;
    const time =
      e && typeof e === 'object' && typeof e.time === 'string' ? Date.parse(e.time) : NaN;
    if (
      typeof weight !== 'number' ||
      !Number.isFinite(weight) ||
      weight <= 0 ||
      !usableTime(time)
    ) {
      log.debug(`${REPLAY_ANCHORS_FILENAME}: ignoring the unusable entry for '${slug}'.`);
      continue;
    }
    anchors.set(slug, { weight, time: new Date(time) });
  }
  return { ok: true, anchors };
}

/** The saved weigh-ins by slug; empty when there are none or the file cannot be read. Never throws. */
export function loadReplayAnchors(path: string): Map<string, ReplayAnchor> {
  const read = readAnchors(path);
  if (read.ok) return read.anchors;
  log.debug(`Could not read ${REPLAY_ANCHORS_FILENAME}: ${read.error}; nothing restored.`);
  return new Map();
}

/**
 * Put the weigh-ins an earlier process saved into the dedup maps, for the
 * users of this config. Call once, when the context is built.
 */
export function restoreReplayAnchors(
  path: string,
  users: readonly UserConfig[],
  weights: Map<string, number>,
  times: Map<string, Date>,
): void {
  const saved = loadReplayAnchors(path);
  for (const user of users) {
    const anchor = saved.get(user.slug);
    if (!anchor) continue;
    const configured = user.last_known_weight;
    if (configured !== null && Math.abs(anchor.weight - configured) >= STALE_ANCHOR_KG) {
      log.debug(
        `Ignoring the saved last weigh-in of ${user.slug} (${anchor.weight} kg at ` +
          `${anchor.time.toISOString()}): it is ${STALE_ANCHOR_KG} kg or more from ` +
          `last_known_weight ${configured} kg, so it is older than config.yaml.`,
      );
      continue;
    }
    weights.set(user.slug, anchor.weight);
    times.set(user.slug, anchor.time);
    log.debug(
      `Restored the last live weigh-in of ${user.slug} for the replay check: ` +
        `${anchor.weight} kg at ${anchor.time.toISOString()}.`,
    );
  }
}

/** Set once a save failed at warn; cleared by the next save that works. */
let saveFailureReported = false;

/** Test seam: the save-failure warning is once per process on purpose. */
export function _resetReplayAnchorStateForTests(): void {
  saveFailureReported = false;
}

function reportSaveFailure(slug: string, error: string): void {
  const msg =
    `Could not save the last weigh-in of ${slug} (${error}); after a restart, ` +
    'a stored copy of it may be exported again.';
  // A directory that cannot be written stays that way, and every weigh-in of
  // every user would repeat the same warning.
  if (saveFailureReported) {
    log.debug(msg);
    return;
  }
  saveFailureReported = true;
  log.warn(`${msg} Further failures to save it are logged at debug level.`);
}

/**
 * Save the last live weigh-in of `slug` from the dedup maps. Called after every
 * exported live weigh-in, unlike the config write, which waits for a 0.5 kg
 * change. The other users' entries are kept: from the file when it can be
 * read, from memory for any it no longer holds (deleted while running). Never
 * throws; on failure the in-memory anchor still protects this process.
 */
export function persistReplayAnchor(
  path: string,
  slug: string,
  weights: ReadonlyMap<string, number>,
  times: ReadonlyMap<string, Date>,
): void {
  const weight = weights.get(slug);
  const time = times.get(slug);
  if (weight === undefined || time === undefined) return;
  if (!usableTime(time.getTime())) {
    log.debug(
      `Not saving the last weigh-in of ${slug}: its time is before 2024, so the clock ` +
        'that dated it was not set.',
    );
    return;
  }
  const read = readAnchors(path);
  if (!read.ok) {
    reportSaveFailure(slug, read.error);
    return;
  }
  const anchors = read.anchors;
  anchors.set(slug, { weight, time });
  for (const [other, w] of weights) {
    const t = times.get(other);
    if (anchors.has(other) || t === undefined || !usableTime(t.getTime())) continue;
    anchors.set(other, { weight: w, time: t });
  }
  const out: Record<string, { weight: number; time: string }> = {};
  for (const [s, a] of anchors) out[s] = { weight: a.weight, time: a.time.toISOString() };
  try {
    atomicWrite(path, JSON.stringify(out) + '\n');
    saveFailureReported = false;
  } catch (err) {
    reportSaveFailure(slug, errMsg(err));
  }
}
