import { createRequire } from 'node:module';
import { createLogger } from './logger.js';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };

const log = createLogger('Sync');

const UPDATE_CHECK_URL = 'https://api.blescalesync.dev/version';
const TIMEOUT_MS = 3_000;
let lastCheckDate = '';

export interface UpdateInfo {
  latest: string;
  current: string;
}

/**
 * Compare two semver strings. Returns true if `latest` is newer than `current`.
 */
export function isNewerVersion(current: string, latest: string): boolean {
  const parse = (v: string): number[] => v.replace(/^v/, '').split('.').map(Number);
  const [cMajor, cMinor, cPatch] = parse(current);
  const [lMajor, lMinor, lPatch] = parse(latest);
  if (lMajor !== cMajor) return lMajor > cMajor;
  if (lMinor !== cMinor) return lMinor > cMinor;
  return lPatch > cPatch;
}

/**
 * Build the User-Agent string: ble-scale-sync/1.6.4 (linux; arm64)
 */
export function buildUserAgent(): string {
  return `ble-scale-sync/${pkg.version} (${process.platform}; ${process.arch})`;
}

/**
 * Check for updates (awaitable, up to TIMEOUT_MS).
 * Use `checkAndLogUpdate()` for fire-and-forget usage.
 * Respects update_check config, CI env var, and once-per-day cooldown.
 * Returns update info if a newer version is available, null otherwise.
 */
export async function checkForUpdate(updateCheckEnabled = true): Promise<UpdateInfo | null> {
  // Disabled via config
  if (!updateCheckEnabled) return null;

  // Disabled in CI
  if (process.env.CI === 'true') return null;

  // Once per calendar day (UTC)
  const today = new Date().toISOString().slice(0, 10);
  if (today === lastCheckDate) return null;
  lastCheckDate = today;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(UPDATE_CHECK_URL, {
      headers: { 'User-Agent': buildUserAgent() },
      signal: controller.signal,
    });

    if (!res.ok) return null;

    const data = (await res.json()) as { latest?: string };
    if (!data.latest) return null;

    if (isNewerVersion(pkg.version, data.latest)) {
      return { latest: data.latest, current: pkg.version };
    }

    return null;
  } catch {
    // Silent on network errors, timeouts, parse errors
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Check for updates and log a notice if a newer version is available.
 * Fire-and-forget: never throws, never blocks startup.
 */
export function checkAndLogUpdate(updateCheckEnabled = true): void {
  checkForUpdate(updateCheckEnabled)
    .then((info) => {
      if (info) {
        log.info(
          `Update available: v${info.latest} (current: v${info.current}). ` +
            'See https://blescalesync.dev/changelog',
        );
      }
    })
    .catch(() => {
      // Never propagate errors
    });
}

/** Reset internal cooldown (for testing). */
export function resetUpdateCheckTimer(): void {
  lastCheckDate = '';
}

/** Get current version from package.json. */
export function getCurrentVersion(): string {
  return pkg.version;
}
