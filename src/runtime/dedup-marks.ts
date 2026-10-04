import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { atomicWrite } from '../config/write.js';
import { defaultEnvPath } from '../config/paths.js';
import { createLogger } from '../logger.js';
import { errMsg } from '../utils/error.js';
import type { ScaleAdapter } from '../interfaces/scale-adapter.js';

const log = createLogger('Sync');

/**
 * Adapter de-duplication marks that have to survive a restart (review D-15).
 *
 * A Salter scale answers every session from a store it never clears, and the
 * adapter's only guard against exporting the same weigh-in twice is a
 * high-water mark. In memory it started at zero after every deploy, crash or
 * add-on restart. Adapters must not do I/O, so the runtime keeps the marks here
 * on their behalf (`ScaleAdapterCore.dedupMark` / `restoreDedupMark`).
 *
 * Lives next to the resolved config.yaml, like the export retry queue and
 * `.update-check-state.json` (ADR D008): the one directory that is writable and
 * persistent on every target. Written through `atomicWrite`, so 0600.
 *
 * Format: `{ "<adapter name>": <mark> }`. Keyed by adapter name because the
 * adapters are registry singletons and the mark already spans every device the
 * adapter talks to in memory; this keeps exactly that scope.
 */
export const DEDUP_MARKS_FILENAME = '.scale-dedup-marks.json';

/** Absolute path of the marks file; falls back to the .env directory like the queue. */
export function resolveDedupMarksPath(configPath?: string): string {
  const dir = configPath ? dirname(resolve(configPath)) : dirname(defaultEnvPath());
  return join(dir, DEDUP_MARKS_FILENAME);
}

/** The stored marks, or an empty map when the file is missing or unreadable. */
function loadMarks(path: string): Record<string, number> {
  if (!existsSync(path)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const marks: Record<string, number> = {};
    for (const [name, value] of Object.entries(parsed)) {
      if (typeof value === 'number' && Number.isFinite(value)) marks[name] = value;
    }
    return marks;
  } catch (err) {
    // A broken file costs at most one duplicate export, which is what every
    // restart cost before this file existed. Refusing to start would cost more.
    log.debug(`Could not read ${DEDUP_MARKS_FILENAME}: ${errMsg(err)}`);
    return {};
  }
}

/**
 * Hand every adapter that keeps a mark the value an earlier process stored.
 * Call once at startup, after the adapter list is final and before the first
 * session.
 */
export function restoreDedupMarks(path: string, adapters: readonly ScaleAdapter[]): void {
  if (!adapters.some((a) => a.restoreDedupMark)) return;
  const marks = loadMarks(path);
  for (const adapter of adapters) {
    const mark = marks[adapter.name];
    if (mark === undefined || !adapter.restoreDedupMark) continue;
    try {
      adapter.restoreDedupMark(mark);
    } catch (err) {
      log.debug(`${adapter.name}: could not restore its de-duplication mark: ${errMsg(err)}`);
    }
  }
}

/**
 * Store the adapter's current mark, when it keeps one and it changed.
 *
 * Called after a reading from the adapter was processed, not before: a process
 * killed during the export then reads the weigh-in again on restart and
 * delivers it, rather than having marked it done without delivering it.
 * Never throws; a write that fails is logged and leaves the in-memory mark,
 * which is what protected this process all along.
 */
export function persistDedupMark(path: string, adapter: ScaleAdapter): void {
  if (!adapter.dedupMark) return;
  try {
    const mark = adapter.dedupMark();
    const marks = loadMarks(path);
    if (marks[adapter.name] === mark) return;
    if (mark === undefined) {
      if (!(adapter.name in marks)) return;
      delete marks[adapter.name];
    } else {
      marks[adapter.name] = mark;
    }
    atomicWrite(path, JSON.stringify(marks) + '\n');
  } catch (err) {
    log.warn(
      `Could not save ${adapter.name}'s de-duplication mark (${errMsg(err)}); ` +
        'a restart in the next few minutes may export the last weigh-in again',
    );
  }
}
