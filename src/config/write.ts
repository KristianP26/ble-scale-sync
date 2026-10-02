import {
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  existsSync,
  chmodSync,
} from 'node:fs';
import { parseDocument } from 'yaml';
import { createLogger } from '../logger.js';
import { errMsg } from '../utils/error.js';

const log = createLogger('ConfigWrite');

// --- Atomic file write ---

/**
 * Mode for files this module writes.
 *
 * config.yaml holds the Garmin password and every exporter token in plaintext,
 * so the wizard chmods it to 0600 after saving. The rename below replaces the
 * file, and with it the mode: without an explicit mode the tmp file is created
 * 0666 & ~umask, i.e. usually 0644, and that mode is what survives. The wizard
 * only chmods once, at save time, but updateLastKnownWeight() calls this on
 * every non-dry weigh-in - so the first export after setup silently made the
 * credentials world-readable, permanently. The tmp file needs it too: it holds
 * the same content, briefly, under a predictable name.
 */
const SECRET_FILE_MODE = 0o600;

/**
 * Write content to a file atomically via tmp+rename.
 * Falls back to direct overwrite when the target is a Docker bind mount
 * (which cannot be unlinked/renamed over — EBUSY).
 *
 * The rename REPLACES the target; the original is never unlinked first. It used
 * to be, and a rename that then failed with anything outside the fallback list
 * (ENOSPC, EIO) left no target at all - and the outer cleanup removed the tmp
 * copy too, so both were gone. Since v1.29.0 this also carries the export retry
 * queue, so that was not only a config-file risk. libuv renames with
 * MOVEFILE_REPLACE_EXISTING on Windows, so replacing in place is not
 * POSIX-only; EEXIST is handled below for any filesystem that refuses anyway.
 */
export function atomicWrite(filePath: string, content: string): void {
  const tmpPath = filePath + '.tmp';
  try {
    // A stale tmp from an earlier interrupted write must not be reused:
    // writeFileSync applies `mode` only when it CREATES the file, so a leftover
    // 0644 tmp would keep those permissions and the rename would carry them
    // onto a file holding the Garmin password. Remove it, then create
    // exclusively - if something recreates it in between, 'wx' fails loudly
    // rather than silently widening the mode.
    try {
      if (existsSync(tmpPath)) unlinkSync(tmpPath);
    } catch {
      // Best effort; the 'wx' below is what actually guarantees the mode.
    }
    writeFileSync(tmpPath, content, { encoding: 'utf8', mode: SECRET_FILE_MODE, flag: 'wx' });
    try {
      renameSync(tmpPath, filePath);
    } catch (renameErr: unknown) {
      const code = renameErr instanceof Error ? (renameErr as NodeJS.ErrnoException).code : '';
      if (code === 'EBUSY' || code === 'EPERM' || code === 'EXDEV' || code === 'EEXIST') {
        // Docker bind mount, Windows EPERM, cross-device rename, or a
        // filesystem that will not rename over an existing file: overwrite
        // directly. Not atomic, and deliberately so - the alternative is
        // refusing to write at all on the documented single-file mount.
        writeFileSync(filePath, content, 'utf8');
        // writeFileSync applies `mode` only when it CREATES the file, and this
        // branch exists precisely because the target already exists. The rename
        // path above needs no chmod: it carries the tmp file's mode with it.
        try {
          chmodSync(filePath, SECRET_FILE_MODE);
        } catch {
          // Best effort: some filesystems (and Windows) do not honour it.
        }
        try {
          unlinkSync(tmpPath);
        } catch {
          /* ignore */
        }
      } else {
        throw renameErr;
      }
    }
  } catch (err) {
    // Clean up tmp file on failure
    try {
      if (existsSync(tmpPath)) unlinkSync(tmpPath);
    } catch {
      // ignore cleanup failure
    }
    throw err;
  }
}

// --- Write lock (async mutex) ---

let lockChain: Promise<void> = Promise.resolve();

/**
 * Serialize concurrent async operations via a promise chain.
 * Ensures only one config write happens at a time.
 */
export function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const result = lockChain.then(fn, fn);
  // Swallow errors in the chain so one failure doesn't block the next
  lockChain = result.then(
    () => {},
    () => {},
  );
  return result;
}

/** Reset the write lock chain (for tests). */
export function _resetWriteLock(): void {
  lockChain = Promise.resolve();
}

// --- Self-write suppress window (used by config watcher to ignore our own writes) ---

let suppressedUntil = 0;
let selfWrittenContent: string | null = null;

/**
 * Mark the next `ms` milliseconds as a self-write window. The config watcher
 * checks this before firing a reload so writes from updateLastKnownWeight()
 * do not trigger a reload loop. Default 2000 ms covers atomicWrite + a small
 * safety margin against fs.watch event latency.
 */
export function setSuppressReloadWindow(ms = 2000): void {
  suppressedUntil = Date.now() + ms;
}

/**
 * Record the exact bytes a self-write is about to put on disk.
 *
 * A time window alone cannot tell our own write from anybody else's. The
 * watcher used to drop every change inside it, and because it had already
 * advanced its `lastContent` when the event arrived, a real edit landing in
 * that window was gone for good: no later event looked like a change, so the
 * operator's edit never took effect until a restart or a SIGHUP. Comparing the
 * content instead distinguishes them exactly, with no reload loop and nothing
 * discarded.
 */
export function noteSelfWrite(content: string, ms = 2000): void {
  suppressedUntil = Date.now() + ms;
  selfWrittenContent = content;
}

/** True when a recent self-write should suppress a reload trigger. */
export function isReloadSuppressed(): boolean {
  return Date.now() < suppressedUntil;
}

/**
 * True when `content` is exactly what this process just wrote, and recently
 * enough for that to still be the explanation.
 */
export function isSelfWrite(content: string | null): boolean {
  return isReloadSuppressed() && content !== null && content === selfWrittenContent;
}

/** Reset the suppress window (for tests). */
export function _resetSuppressWindow(): void {
  suppressedUntil = 0;
  selfWrittenContent = null;
}

// --- Last known weight writer (sync, testable) ---

/**
 * Read a YAML config, find the user by slug, update their last_known_weight,
 * and write back atomically. Preserves comments via `parseDocument()`.
 */
export function writeLastKnownWeight(configPath: string, userSlug: string, weight: number): void {
  const raw = readFileSync(configPath, 'utf8');
  const doc = parseDocument(raw);

  const users = doc.get('users');
  if (!users || typeof users !== 'object' || !('items' in users)) {
    log.warn(`Cannot update last_known_weight: no users array in ${configPath}`);
    return;
  }

  const items = (users as { items: unknown[] }).items;
  let found = false;

  for (const item of items) {
    if (item && typeof item === 'object' && 'get' in item) {
      const node = item as { get(key: string): unknown; set(key: string, value: unknown): void };
      if (node.get('slug') === userSlug) {
        node.set('last_known_weight', Math.round(weight * 100) / 100);
        found = true;
        break;
      }
    }
  }

  if (!found) {
    log.warn(`User slug '${userSlug}' not found in ${configPath} — skipping weight update`);
    return;
  }

  const next = doc.toString();
  // Register the bytes before they land: the watcher compares against these to
  // tell our own bump from an edit somebody made in the same two seconds.
  noteSelfWrite(next);
  atomicWrite(configPath, next);
}

// --- Debounced async updater ---

const DEBOUNCE_MS = 5000;
const pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Update a user's last_known_weight in config.yaml.
 * Debounced per-slug (5s) — if multiple measurements arrive quickly,
 * only the last one is written. Acquires write lock for thread safety.
 *
 * Skips if the weight change is less than 0.5 kg from the current value.
 */
export function updateLastKnownWeight(
  configPath: string,
  userSlug: string,
  weight: number,
  currentWeight: number | null,
): void {
  // Skip if change is insignificant (< 0.5 kg)
  if (currentWeight !== null && Math.abs(weight - currentWeight) < 0.5) {
    log.debug(`Skipping weight update for ${userSlug}: change < 0.5 kg`);
    return;
  }

  // Clear any pending timer for this slug
  const existing = pendingTimers.get(userSlug);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(() => {
    pendingTimers.delete(userSlug);
    withWriteLock(async () => {
      try {
        // Mark this as a self-write so the config watcher does not loop
        // on our own last_known_weight bumps.
        setSuppressReloadWindow();
        writeLastKnownWeight(configPath, userSlug, weight);
        log.info(`Updated last_known_weight for ${userSlug} to ${weight} kg`);
      } catch (err) {
        log.error(`Failed to update last_known_weight for ${userSlug}: ${errMsg(err)}`);
      }
    });
  }, DEBOUNCE_MS);

  pendingTimers.set(userSlug, timer);
}

/** Clear all pending debounce timers (for tests). */
export function _clearPendingWrites(): void {
  for (const timer of pendingTimers.values()) {
    clearTimeout(timer);
  }
  pendingTimers.clear();
}
