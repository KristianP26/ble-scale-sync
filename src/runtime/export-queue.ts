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
/** Hard cap; the oldest go first. */
const MAX_ENTRIES = 50;

export interface QueuedExport {
  exporter: string;
  payload: BodyComposition;
  /** ISO 8601. The time the reading was MEASURED, which is what makes it redeliverable. */
  timestamp?: string;
  userName?: string;
  userSlug?: string;
  /** ISO 8601, when the failure happened. Drives the age bound. */
  queuedAt: string;
  attempts: number;
  lastError?: string;
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
 * Try every queued entry once, oldest first.
 *
 * At-most-once on purpose: an entry is removed from the file BEFORE it is
 * attempted and only put back on a clean failure, so a crash mid-flush loses it
 * rather than delivering it twice. Redelivery is idempotent for the exporters
 * that key on a timestamp or a date, but `file` appends a row unconditionally
 * and runalyze carries no request id, so at-least-once would leave a duplicate
 * in the user's own data. A lost reading is the better failure of the two.
 *
 * No in-flight guard: the only callers are the continuous loop, which awaits
 * this before asking the source for a reading, and the single-run path, which
 * calls it once before anything else. Serialisation comes from that sequencing
 * rather than from this function, so a future caller that fires it concurrently
 * needs its own.
 */
export async function flushQueue(
  path: string,
  exporters: Exporter[],
  now: number = Date.now(),
): Promise<{ delivered: number; failed: number; dropped: number }> {
  const pending = loadQueue(path, now);
  if (pending.length === 0) {
    // loadQueue drops expired entries, so persist that pruning (and delete the
    // file if it emptied) rather than leaving them to be re-read every cycle.
    if (existsSync(path)) saveQueue(path, []);
    return { delivered: 0, failed: 0, dropped: 0 };
  }

  log.info(`Retrying ${pending.length} queued export(s)...`);
  const byName = new Map(exporters.map((e) => [e.name, e]));
  const keep: QueuedExport[] = [];
  let delivered = 0;
  let failed = 0;
  let dropped = 0;

  for (let i = 0; i < pending.length; i += 1) {
    const entry = pending[i];
    // Remove before attempting: everything not yet tried stays on disk, so a
    // crash costs at most the one in flight.
    //
    // If that write fails the file still holds this entry, so attempting it now
    // would deliver a reading the next flush delivers again. A full disk is not
    // a reason to duplicate somebody's weigh-in: stop, and let the next cycle
    // try the whole queue.
    if (!saveQueue(path, [...keep, ...pending.slice(i + 1)])) {
      log.warn('Stopping the retry pass: the queue could not be written, so nothing is attempted.');
      return { delivered, failed, dropped };
    }

    const exporter = byName.get(entry.exporter);
    if (!exporter) {
      // The exporter was removed from the config while this was waiting.
      log.warn(`Dropping a queued ${entry.exporter} export: that exporter is no longer configured`);
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
      keep.push({ ...entry, attempts, lastError: errMsg(err) });
      failed += 1;
    }
  }

  saveQueue(path, keep);
  return { delivered, failed, dropped };
}
