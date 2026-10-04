import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { atomicWrite } from '../config/write.js';
import { defaultEnvPath } from '../config/paths.js';
import { createLogger } from '../logger.js';
import { errMsg } from '../utils/error.js';
import type { BodyComposition } from '../interfaces/scale-adapter.js';
import type { Exporter, ExportContext } from '../interfaces/exporter.js';

const log = createLogger('Retry');

/**
 * Readings whose export failed, kept so a later cycle can deliver them (#412).
 *
 * Lives next to the resolved config.yaml, the same directory
 * `.update-check-state.json` uses: the one place writable and persistent on
 * every target. On the Home Assistant add-on that is /data, a real volume. On
 * Docker with the documented single-file mount it survives a restart but not a
 * re-create, exactly as recorded for the update-check state (ADR D008).
 */
export const EXPORT_QUEUE_FILENAME = '.export-retry-queue.jsonl';

/** Older than this and a late delivery is a surprise, not a recovery. */
const MAX_AGE_MS = 72 * 60 * 60 * 1000;
/** A target that has refused this many times is not coming back on its own. */
const MAX_ATTEMPTS = 5;
/**
 * Minimum wait before retry N+1, indexed by the attempts already spent (E-01).
 *
 * ADR D014 bounds an entry at 72 h and 5 attempts and relies on the age bound
 * being the one that decides. That only holds when attempts are spaced in
 * time: a flush runs at the start of every loop iteration, which on node-ble
 * is a scan cycle of about two minutes, so without spacing all five attempts
 * were gone ten minutes after the failure and an overnight outage still cost
 * the reading.
 *
 * Measured from the previous attempt (or the original failure), not from
 * queuedAt, so attempts the process could not make on time (process down, or
 * a watcher transport where an iteration needs a weigh-in) are never made up
 * in a burst. On time, retries land about 15 min, 1 h, 6 h, 24 h and 71 h
 * after the failure: a short outage recovers quickly, and the fifth and last
 * attempt sits just inside the age bound, which therefore still decides.
 */
const RETRY_DELAYS_MS = [15, 45, 5 * 60, 18 * 60, 47 * 60].map((min) => min * 60 * 1000);
/** Hard cap; the oldest go first. */
const MAX_ENTRIES = 50;

export interface QueuedExport {
  exporter: string;
  payload: BodyComposition;
  /**
   * ISO 8601. The time the reading was MEASURED, which is what makes it
   * redeliverable.
   *
   * Written for EVERY entry since the audit fix. It used to be copied from the
   * ExportContext, which only carries a timestamp for a historical replay - a
   * live weigh-in queued without one, and the retry then had no measurement
   * time at all. `file` falls back to `new Date()`, so a reading taken at 07:00
   * and redelivered at 09:00 was recorded as 09:00.
   */
  timestamp?: string;
  userName?: string;
  userSlug?: string;
  /** ISO 8601, when the failure happened. Drives the age bound. */
  queuedAt: string;
  attempts: number;
  /**
   * ISO 8601, when the last retry failed. Absent until the first retry, and in
   * files written before attempts were spaced in time, where queuedAt stands
   * in for it.
   */
  lastAttemptAt?: string;
  lastError?: string;
}

/** Whether the spacing in RETRY_DELAYS_MS allows another attempt at `now`. */
function isDue(entry: QueuedExport, now: number): boolean {
  const attempts = entry.attempts ?? 0;
  const delay = RETRY_DELAYS_MS[Math.min(attempts, RETRY_DELAYS_MS.length - 1)];
  const last = Date.parse(entry.lastAttemptAt ?? entry.queuedAt);
  // An unparseable stamp must not park the entry forever; the age bound in
  // loadQueue still retires it.
  if (Number.isNaN(last)) return true;
  return now - last >= delay;
}

/**
 * Identity of an entry across rewrites. Stable while its attempt count and
 * error change, and distinct for every failed export: one exporter, one user,
 * one failure time.
 */
function entryId(e: QueuedExport): string {
  return JSON.stringify([e.exporter, e.userSlug ?? '', e.queuedAt, e.timestamp ?? '']);
}

/**
 * Absolute path of the queue file for a resolved config path. Mirrors
 * `resolveUpdateStatePath`: without a config.yaml it falls back to the
 * directory the .env is read from.
 */
export function resolveExportQueuePath(configPath?: string): string {
  const dir = configPath ? dirname(resolve(configPath)) : dirname(defaultEnvPath());
  return join(dir, EXPORT_QUEUE_FILENAME);
}

/**
 * Read the queue, dropping entries that are past a bound or unreadable.
 *
 * A corrupt line is skipped rather than fatal: one bad line must not cost the
 * other readings.
 */
export function loadQueue(path: string, now: number = Date.now()): QueuedExport[] {
  if (!existsSync(path)) return [];
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (err) {
    log.debug(`Could not read the retry queue: ${errMsg(err)}`);
    return [];
  }

  const entries: QueuedExport[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as QueuedExport;
      if (typeof parsed.exporter !== 'string' || typeof parsed.queuedAt !== 'string') continue;
      if (now - Date.parse(parsed.queuedAt) > MAX_AGE_MS) continue;
      if ((parsed.attempts ?? 0) >= MAX_ATTEMPTS) continue;
      entries.push(parsed);
    } catch {
      log.debug('Skipping an unreadable line in the retry queue');
    }
  }
  // Deliberately NOT capped here. The count bound belongs to the write path:
  // capping on read would mean a flush over an oversized file (hand-edited, or
  // written by a version with a larger bound) permanently deleting readings it
  // never even attempted.
  return entries;
}

/**
 * Write the queue, or delete the file when there is nothing left.
 *
 * Deleting matters: this holds body composition and a user name, so an empty
 * file left behind is health data lingering after the last entry was delivered.
 */
export function saveQueue(path: string, entries: QueuedExport[]): boolean {
  try {
    if (entries.length === 0) {
      if (existsSync(path)) unlinkSync(path);
      return true;
    }
    // atomicWrite rewrites the whole file (tmp + rename) and applies 0600, the
    // same mode config.yaml gets. The line format is for legibility, not for
    // append-durability: there is no append path here.
    atomicWrite(path, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
    return true;
  } catch (err) {
    log.warn(`Could not write the retry queue: ${errMsg(err)}`);
    return false;
  }
}

/** Add one failed export, applying the count bound. */
export function enqueue(path: string, entry: QueuedExport, now: number = Date.now()): void {
  const entries = loadQueue(path, now);
  entries.push(entry);
  saveQueue(path, entries.slice(-MAX_ENTRIES));
  log.info(
    `${entry.exporter} failed; the reading is queued and will be retried ` +
      `(${entries.length} waiting).`,
  );
}

/**
 * Resolve the exporter instance one queued entry must be delivered through.
 *
 * Deliberately NOT a flat `Exporter[]` keyed by name. `Exporter.name` is the
 * exporter TYPE ('garmin'), a class constant, so two users who each configure
 * their own Garmin account produce two instances that share one name. A
 * name-keyed map across all users kept whichever came first, so a queued
 * reading for user B was delivered through user A's instance - with A's
 * `token_dir`, i.e. into somebody else's Garmin account.
 *
 * `resolveExportersForUser` dedupes by type WITHIN a user, so once the entry's
 * `userSlug` picks the list, the name is unambiguous again.
 */
export type QueuedExporterLookup = (entry: QueuedExport) => Exporter | undefined;

/**
 * Try every queued entry that is due, oldest first.
 *
 * At-most-once on purpose: an entry is removed from the file BEFORE it is
 * attempted and only put back on a clean failure, so a crash mid-flush loses it
 * rather than delivering it twice. Redelivery is idempotent for the exporters
 * that key on a timestamp or a date, but `file` appends a row unconditionally
 * and runalyze carries no request id, so at-least-once would leave a duplicate
 * in the user's own data. A lost reading is the better failure of the two.
 *
 * Safe against an `enqueue` that runs while an export here is awaited (E-02:
 * the loop no longer waits for a flush before it scans, so a live weigh-in can
 * fail and be queued mid-flush). Every write re-reads the file first and
 * carries over any entry this pass did not load, instead of writing back only
 * its own view, which used to erase the newly queued reading. Two flushes at
 * once are NOT safe: each would attempt the same entries, so the caller keeps
 * at most one in flight.
 */
export async function flushQueue(
  path: string,
  lookup: QueuedExporterLookup,
  now: number = Date.now(),
): Promise<{ delivered: number; failed: number; dropped: number }> {
  const pending = loadQueue(path, now);
  if (pending.length === 0) {
    // loadQueue drops expired entries, so persist that pruning (and delete the
    // file if it emptied) rather than leaving them to be re-read every cycle.
    if (existsSync(path)) saveQueue(path, []);
    return { delivered: 0, failed: 0, dropped: 0 };
  }

  const dueCount = pending.filter((e) => isDue(e, now)).length;
  if (dueCount === 0) {
    log.debug(`${pending.length} queued export(s) waiting; none is due for a retry yet.`);
    return { delivered: 0, failed: 0, dropped: 0 };
  }

  log.info(`Retrying ${dueCount} queued export(s)...`);
  const keep: QueuedExport[] = [];
  // Entries somebody else queued while this pass was running. Written last:
  // they are the newest.
  const foreign: QueuedExport[] = [];
  const known = new Set(pending.map(entryId));
  let delivered = 0;
  let failed = 0;
  let dropped = 0;

  const persist = (rest: QueuedExport[]): boolean => {
    for (const e of loadQueue(path, now)) {
      const id = entryId(e);
      if (known.has(id)) continue;
      known.add(id);
      foreign.push(e);
    }
    return saveQueue(path, [...keep, ...rest, ...foreign]);
  };

  for (let i = 0; i < pending.length; i += 1) {
    const entry = pending[i];
    if (!isDue(entry, now)) {
      // Not attempted, so it stays on disk exactly as it was.
      keep.push(entry);
      continue;
    }
    // Remove before attempting: everything not yet tried stays on disk, so a
    // crash costs at most the one in flight.
    //
    // If that write fails the file still holds this entry, so attempting it now
    // would deliver a reading the next flush delivers again. A full disk is not
    // a reason to duplicate somebody's weigh-in: stop, and let the next cycle
    // try the whole queue.
    if (!persist(pending.slice(i + 1))) {
      log.warn('Stopping the retry pass: the queue could not be written, so nothing is attempted.');
      return { delivered, failed, dropped };
    }

    let exporter: Exporter | undefined;
    try {
      exporter = lookup(entry);
    } catch (err) {
      // The entry is already off disk, so a throw escaping here deleted
      // somebody's weigh-in with no trace above debug (E-08). Building the
      // exporter throws when its config entry is invalid, which is an operator
      // edit away from working again: keep the entry exactly as it was, with
      // no attempt spent, and let the age bound decide if it never recovers.
      log.warn(
        `Keeping a queued ${entry.exporter} export${entry.userSlug ? ` for '${entry.userSlug}'` : ''}: ` +
          `its exporter could not be built from the current config (${errMsg(err)})`,
      );
      keep.push(entry);
      failed += 1;
      continue;
    }
    if (!exporter) {
      // The exporter - or the user it was queued for - was removed from the
      // config while this was waiting. Dropping is the only safe answer: the
      // alternative is delivering somebody's weigh-in through a target that was
      // never configured to receive it.
      log.warn(
        `Dropping a queued ${entry.exporter} export${entry.userSlug ? ` for '${entry.userSlug}'` : ''}: ` +
          'that exporter is no longer configured for that user',
      );
      dropped += 1;
      continue;
    }

    const context: ExportContext = {
      ...(entry.timestamp ? { timestamp: new Date(entry.timestamp) } : {}),
      ...(entry.userName ? { userName: entry.userName } : {}),
      ...(entry.userSlug ? { userSlug: entry.userSlug } : {}),
    };

    try {
      const result = await exporter.export(entry.payload, context);
      if (result.success) {
        log.info(`${entry.exporter}: queued reading from ${entry.queuedAt} delivered.`);
        delivered += 1;
        continue;
      }
      throw new Error(result.error ?? 'export reported failure');
    } catch (err) {
      const attempts = (entry.attempts ?? 0) + 1;
      if (attempts >= MAX_ATTEMPTS) {
        log.warn(
          `Giving up on a queued ${entry.exporter} export after ${attempts} attempts: ${errMsg(err)}`,
        );
        dropped += 1;
        continue;
      }
      log.debug(`${entry.exporter} retry ${attempts} failed: ${errMsg(err)}`);
      keep.push({
        ...entry,
        attempts,
        lastAttemptAt: new Date(now).toISOString(),
        lastError: errMsg(err),
      });
      failed += 1;
    }
  }

  persist([]);
  return { delivered, failed, dropped };
}
