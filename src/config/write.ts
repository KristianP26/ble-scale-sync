import { readFileSync, writeFileSync, renameSync, unlinkSync, existsSync } from 'node:fs';
import { parseDocument } from 'yaml';
import { createLogger } from '../logger.js';
import { errMsg } from '../utils/error.js';

const log = createLogger('ConfigWrite');

// --- Atomic file write ---

/**
 * Write content to a file atomically via tmp+rename.
 * Falls back to direct overwrite when the target is a Docker bind mount
 * (which cannot be unlinked/renamed over — EBUSY).
 */
export function atomicWrite(filePath: string, content: string): void {
  const tmpPath = filePath + '.tmp';
  try {
    writeFileSync(tmpPath, content, 'utf8');
    try {
      if (existsSync(filePath)) unlinkSync(filePath);
      renameSync(tmpPath, filePath);
    } catch {
      // Rename failed (Docker bind mount, Windows EPERM, etc.) — overwrite directly
      writeFileSync(filePath, content, 'utf8');
      try {
        unlinkSync(tmpPath);
      } catch {
        /* ignore */
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

  atomicWrite(configPath, doc.toString());
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
