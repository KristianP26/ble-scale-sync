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
  /** Exporter TYPE ('garmin'); with the slot below, which entry of the user's exporters. */
  exporter: string;
  /**
   * Which list the failed exporter's config entry is in, and where (D029). A
   * list may hold two entries of one type, so the type alone cannot say which
   * of them failed. Both absent in files written before this existed; such an
   * entry is redelivered through the first exporter of its type, as before.
   */
  exporterList?: 'user' | 'global';
  exporterIndex?: number;
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

/**
 * When the spacing in RETRY_DELAYS_MS allows the next attempt, in epoch ms.
 * NaN for an unparseable stamp, which isDue treats as due.
 */
function nextDueAt(entry: QueuedExport): number {
  const attempts = entry.attempts ?? 0;
  const delay = RETRY_DELAYS_MS[Math.min(attempts, RETRY_DELAYS_MS.length - 1)];
  return Date.parse(entry.lastAttemptAt ?? entry.queuedAt) + delay;
}

/** Whether the spacing in RETRY_DELAYS_MS allows another attempt at `now`. */
function isDue(entry: QueuedExport, now: number): boolean {
  const dueAt = nextDueAt(entry);
  // An unparseable stamp must not park the entry forever; the age bound in
  // loadQueue still retires it.
  if (Number.isNaN(dueAt)) return true;
  return now >= dueAt;
}

/**
 * "N queued export(s) <verb>; next retry ..." for a non-empty list (#460).
 *
 * Each entry keeps its own clock, so a pass that retries two of three says
 * nothing about the third unless this does: "Retrying 2" alone read exactly
 * like a queue that had lost an entry. An entry that is already due (kept
 * after a lookup threw, or left by a shutdown) gets "on the next cycle", not a
 * time in the past.
 */
function describeWaiting(entries: QueuedExport[], verb: string, now: number): string {
  const dueTimes = entries.map(nextDueAt);
  const earliest = Math.min(...dueTimes);
  const next =
    dueTimes.some((t) => Number.isNaN(t)) || earliest <= now
      ? 'next retry on the next cycle'
      : `next retry not before ${new Date(earliest).toISOString()}`;
  return `${entries.length} queued export(s) ${verb}; ${next}.`;
}

/**
 * Identity of an entry across rewrites. Stable while its attempt count and
 * error change, and distinct for every failed export: one exporter, one user,
 * one failure time.
 */
function entryId(e: QueuedExport): string {
  // The slot is part of the identity: two webhooks of one user failing on the
  // same reading in the same millisecond are two entries, and without it the
  // re-read in flushQueue would take the second for one it already holds and
  // drop it on the next write.
  return JSON.stringify([
    e.exporter,
    e.exporterList ?? '',
    e.exporterIndex ?? -1,
    e.userSlug ?? '',
    e.queuedAt,
    e.timestamp ?? '',
  ]);
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

/** Set once a failed read has been reported at warn, cleared by the next good read. */
let readFailureReported = false;

/** Test seam: the read-failure warning is once per process on purpose. */
export function _resetExportQueueStateForTests(): void {
  readFailureReported = false;
}

/**
 * The reading an entry holds, in the form a person can re-enter by hand (E-10):
 * target, user, measurement time and weight.
 */
function describeEntry(e: QueuedExport): string {
  const weight = e.payload?.weight;
  return (
    `${e.exporter} export${e.userSlug ? ` for '${e.userSlug}'` : ''}` +
    (e.timestamp ? ` measured at ${e.timestamp}` : ` queued at ${e.queuedAt}`) +
    (typeof weight === 'number' ? ` (${weight.toFixed(2)} kg)` : '')
  );
}

type QueueRead =
  { ok: true; entries: QueuedExport[]; pruned: number } | { ok: false; error: string };

/**
 * Read the queue, telling a missing file (an empty queue) apart from one that
 * exists and could not be read.
 *
 * The difference is the whole point. Both used to come back as an empty list,
 * and the callers then acted on "empty": a flush deleted the file and an
 * enqueue overwrote it with the one new entry, so a single failed read (EIO
 * on an SD card, a file owned by another UID after an image update) erased
 * every reading in it with nothing above debug (#460).
 *
 * `report` is set for the read that starts a change (a flush, an enqueue):
 * what it drops is warned about there, by name where it can be, and the
 * caller writes the file so the warning is not repeated. Every other read
 * (the re-read before each write in a pass, the startup summary) stays quiet,
 * or each drop would be reported more than once. `pruned` counts the drops.
 */
function readQueue(path: string, now: number, report = false): QueueRead {
  if (!existsSync(path)) return { ok: true, entries: [], pruned: 0 };
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (err) {
    // Gone between the check and the read: that is an empty queue, not a
    // failure.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ok: true, entries: [], pruned: 0 };
    }
    return { ok: false, error: errMsg(err) };
  }

  const say = report ? log.warn : log.debug;
  const entries: QueuedExport[] = [];
  let pruned = 0;
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: QueuedExport | undefined;
    try {
      parsed = JSON.parse(trimmed) as QueuedExport;
    } catch {
      parsed = undefined;
    }
    // An unparseable queuedAt would make the age check below compare NaN,
    // which is never true, so the entry could never age out. Without a time
    // it is as unreadable as a broken line.
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      typeof parsed.exporter !== 'string' ||
      typeof parsed.queuedAt !== 'string' ||
      Number.isNaN(Date.parse(parsed.queuedAt))
    ) {
      pruned += 1;
      say('Skipping an unreadable line in the retry queue; a queued reading may be lost.');
      continue;
    }
    // The weight goes in the warning on purpose: it is what someone needs to
    // re-enter the reading by hand, the same as for a shutdown (E-10).
    if (now - Date.parse(parsed.queuedAt) > MAX_AGE_MS) {
      pruned += 1;
      say(`Dropping a queued ${describeEntry(parsed)}: older than ${MAX_AGE_MS / 3_600_000} h.`);
      continue;
    }
    if ((parsed.attempts ?? 0) >= MAX_ATTEMPTS) {
      pruned += 1;
      say(`Dropping a queued ${describeEntry(parsed)}: its ${MAX_ATTEMPTS} attempts are used up.`);
      continue;
    }
    entries.push(parsed);
  }
  // Deliberately NOT capped here. The count bound belongs to the write path:
  // capping on read would mean a flush over an oversized file (hand-edited, or
  // written by a version with a larger bound) permanently deleting readings it
  // never even attempted.
  return { ok: true, entries, pruned };
}

/**
 * Read the queue, dropping entries that are past a bound or unreadable.
 *
 * A corrupt line is skipped rather than fatal: one bad line must not cost the
 * other readings. A file that cannot be read at all comes back empty here;
 * the queue's own paths tell that case apart and never act on it.
 */
export function loadQueue(path: string, now: number = Date.now()): QueuedExport[] {
  const read = readQueue(path, now);
  if (read.ok) return read.entries;
  log.debug(`Could not read the retry queue: ${read.error}`);
  return [];
}

/**
 * One line for the log at startup: how many queued exports wait and when the
 * next is due, or undefined when nothing waits (#460).
 *
 * Reads quietly and changes nothing. A restart keeps the file, and without
 * this line nothing says so until the first retry pass, which may be most of
 * an hour away. Drops and read failures are reported by that first pass, not
 * here, so they are not reported twice.
 */
export function describeQueue(path: string, now: number = Date.now()): string | undefined {
  const read = readQueue(path, now);
  if (!read.ok || read.entries.length === 0) return undefined;
  return describeWaiting(read.entries, 'waiting', now);
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

/**
 * Add one failed export, applying the count bound.
 *
 * When the file cannot be read, or the new state cannot be written, the
 * reading is NOT queued and the warning names it. Overwriting an unreadable
 * file with the one new entry used to erase every reading already in it, and
 * a failed write used to be followed by "queued and will be retried" for an
 * entry that was on disk nowhere (#460).
 */
export function enqueue(path: string, entry: QueuedExport, now: number = Date.now()): void {
  const read = readQueue(path, now, true);
  if (!read.ok) {
    log.warn(
      `Could not read the retry queue (${read.error}), so the failed ${describeEntry(entry)} ` +
        'is NOT queued and will not be retried. The queue file is left as it is.',
    );
    return;
  }
  const entries = read.entries;
  entries.push(entry);
  // Count what is kept, not what was loaded: a full queue must not report 51.
  const kept = entries.slice(-MAX_ENTRIES);
  if (!saveQueue(path, kept)) {
    log.warn(`The failed ${describeEntry(entry)} is NOT queued and will not be retried.`);
    return;
  }
  log.info(
    `${entry.exporter} failed; the reading is queued and will be retried ` +
      `(${kept.length} waiting).`,
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
 * Within that user the entry's slot (`exporterList` + `exporterIndex`, D029)
 * picks the instance, since one list may hold two exporters of a type.
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
  signal?: AbortSignal,
): Promise<{ delivered: number; failed: number; dropped: number }> {
  const read = readQueue(path, now, true);
  if (!read.ok) {
    // Attempt nothing and write nothing: the file may hold every queued
    // reading, and the next cycle reads it again. Warn once, not on every
    // cycle a permanently unreadable file would otherwise produce.
    const msg =
      `Could not read the retry queue (${read.error}); nothing is retried and the file ` +
      'is left as it is.';
    if (readFailureReported) log.debug(msg);
    else log.warn(msg);
    readFailureReported = true;
    return { delivered: 0, failed: 0, dropped: 0 };
  }
  readFailureReported = false;
  const pending = read.entries;
  if (pending.length === 0) {
    // loadQueue drops expired entries, so persist that pruning (and delete the
    // file if it emptied) rather than leaving them to be re-read every cycle.
    if (existsSync(path)) saveQueue(path, []);
    return { delivered: 0, failed: 0, dropped: 0 };
  }

  const dueCount = pending.filter((e) => isDue(e, now)).length;
  if (dueCount === 0) {
    // Write only when this read dropped something, so its warnings are not
    // repeated every cycle; otherwise leave the file (and the SD card) alone.
    // No await since the read, so nothing can have been queued in between.
    if (read.pruned > 0) saveQueue(path, pending);
    log.debug(`${pending.length} queued export(s) waiting; none is due for a retry yet.`);
    return { delivered: 0, failed: 0, dropped: 0 };
  }

  log.info(
    dueCount < pending.length
      ? `Retrying ${dueCount} of ${pending.length} queued export(s)...`
      : `Retrying ${dueCount} queued export(s)...`,
  );
  const keep: QueuedExport[] = [];
  // Entries somebody else queued while this pass was running. Written last:
  // they are the newest.
  const foreign: QueuedExport[] = [];
  const known = new Set(pending.map(entryId));
  let delivered = 0;
  let failed = 0;
  let dropped = 0;

  // Entries this pass put back into `keep` after attempting them (a failure,
  // or a lookup that threw) since the last good write. They exist only here:
  // the write before their attempt took them off disk. If no further write
  // succeeds they are lost, and the warning must say which (E-10).
  let unsaved: QueuedExport[] = [];
  const persist = (rest: QueuedExport[]): boolean => {
    // A failed read here must not become a write of this pass's view alone:
    // that would erase whatever was queued while the pass was running.
    const current = readQueue(path, now);
    if (!current.ok) {
      log.warn(`Could not read the retry queue: ${current.error}`);
      return false;
    }
    for (const e of current.entries) {
      const id = entryId(e);
      if (known.has(id)) continue;
      known.add(id);
      foreign.push(e);
    }
    if (!saveQueue(path, [...keep, ...rest, ...foreign])) return false;
    unsaved = [];
    return true;
  };
  const lostFromQueue = (): string =>
    unsaved.length === 0
      ? ''
      : ` Not saved back, so no longer queued: ${unsaved.map(describeEntry).join('; ')}.`;

  for (let i = 0; i < pending.length; i += 1) {
    // Stopping: start nothing new. Taking the next entry off disk now would
    // put it at the mercy of the hard-exit floor for no gain, while left in
    // the file it is simply retried by the next process.
    if (signal?.aborted) {
      keep.push(...pending.slice(i));
      break;
    }
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
      log.warn(
        'Stopping the retry pass: the queue could not be read or written, so nothing more ' +
          `is attempted.${lostFromQueue()}`,
      );
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
      unsaved.push(entry);
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

    // The entry is already off disk (at-most-once, D014). A shutdown while it
    // is being delivered can therefore cost it, and that must not be silent
    // (E-10): name the reading so it can be re-entered by hand.
    const onAbort = (): void => {
      log.warn(
        `Shutdown requested while retrying a queued ${entry.exporter} export` +
          `${entry.userSlug ? ` for '${entry.userSlug}'` : ''}` +
          `${entry.timestamp ? ` measured at ${entry.timestamp}` : ''}` +
          ` (${entry.payload.weight} kg). It is no longer in the queue; if the process ` +
          'exits before this attempt finishes, the reading is lost for that target.',
      );
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });

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
      const retried = {
        ...entry,
        attempts,
        lastAttemptAt: new Date(now).toISOString(),
        lastError: errMsg(err),
      };
      keep.push(retried);
      unsaved.push(retried);
      failed += 1;
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }

  if (!persist([])) {
    if (unsaved.length > 0) {
      log.warn(`Could not save the retry queue after the pass.${lostFromQueue()}`);
    }
  } else if (keep.length + foreign.length > 0) {
    // What the last write left on disk, so the log says what still waits and
    // when, instead of leaving the next "Retrying N" to look like a loss.
    log.info(describeWaiting([...keep, ...foreign], 'still waiting', now));
  }
  return { delivered, failed, dropped };
}
