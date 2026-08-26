import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { atomicWrite } from './config/write.js';
import { ROOT } from './config/paths.js';
import { createLogger } from './logger.js';
import { errMsg } from './utils/error.js';

const log = createLogger('UpdateState');

/**
 * Filename of the persisted update-check cooldown state. Lives next to the
 * resolved config.yaml, which is the one directory guaranteed writable and
 * persistent on every deployment target (HA add-on /data, Docker bind mount,
 * bare Node repo root).
 */
export const UPDATE_STATE_FILENAME = '.update-check-state.json';

/** YYYY-MM-DD, the same UTC day key the check itself uses. */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface UpdateCheckState {
  /** UTC calendar day (YYYY-MM-DD) of the last update check attempt. */
  lastCheckDate: string;
}

// Persistence is OFF until configureUpdateState() runs. Tests therefore can
// never touch a real state file by accident, and library use of
// checkForUpdate() keeps today's process-local behaviour.
let statePath: string | null = null;
let cached: UpdateCheckState | null = null;
let loaded = false;

/**
 * Absolute path of the state file for a resolved config path.
 * Without a config.yaml (.env-only deployments) it falls back to the repo
 * root, which is the directory the .env itself is read from.
 */
export function resolveUpdateStatePath(configPath?: string): string {
  const dir = configPath ? dirname(resolve(configPath)) : ROOT;
  return join(dir, UPDATE_STATE_FILENAME);
}

/** Enable persistence next to `configPath` and drop any cached value. */
export function configureUpdateState(configPath?: string): void {
  statePath = resolveUpdateStatePath(configPath);
  cached = null;
  loaded = false;
}

/**
 * Read the state file once per process, then serve the cached value.
 * Anything unreadable, unparseable or malformed is treated exactly like
 * "never checked": this must never throw and never block startup.
 */
export function readUpdateState(): UpdateCheckState | null {
  if (loaded || statePath === null) return cached;
  loaded = true;
  cached = loadFromDisk(statePath);
  return cached;
}

/**
 * Update the in-memory value, then write it through. The cache is updated
 * first on purpose: a host that cannot write (read-only FS, no permission)
 * still gets correct once-per-process behaviour.
 */
export function writeUpdateState(state: UpdateCheckState): void {
  cached = state;
  loaded = true;
  if (statePath === null) return;

  try {
    atomicWrite(statePath, JSON.stringify(state) + '\n');
  } catch (err) {
    // The update check is a nicety. A failed state write is never an error.
    log.debug(`Could not persist update-check state: ${errMsg(err)}`);
  }
}

/** Disable persistence and drop the cache (tests, resetUpdateCheckTimer). */
export function resetUpdateState(): void {
  statePath = null;
  cached = null;
  loaded = false;
}

function loadFromDisk(path: string): UpdateCheckState | null {
  try {
    if (!existsSync(path)) return null;

    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return null;

    const date = (parsed as Record<string, unknown>).lastCheckDate;
    if (typeof date !== 'string' || !DATE_RE.test(date)) return null;
    // A date in the future can only come from a clock that ran ahead or a
    // state file copied from another host. Persisting it would suppress the
    // check until that day actually arrives, with no self-heal on restart.
    if (date > new Date().toISOString().slice(0, 10)) return null;

    return { lastCheckDate: date };
  } catch (err) {
    log.debug(`Update-check state unreadable, treating as never checked: ${errMsg(err)}`);
    return null;
  }
}
