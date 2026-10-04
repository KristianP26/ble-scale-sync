/**
 * Anonymous usage stats derived from the update check's User-Agent:
 *   ble-scale-sync/1.6.4 (linux; arm64)
 *
 * No Workers globals here either, for the same reason as version.ts.
 */
export interface ClientInfo {
  version: string;
  os: string;
  arch: string;
}

export interface DailyStats {
  total: number;
  versions: Record<string, number>;
  os: Record<string, number>;
  arch: Record<string, number>;
}

const KNOWN_OS = new Set(['linux', 'darwin', 'win32', 'freebsd', 'openbsd', 'sunos', 'aix']);
const KNOWN_ARCH = new Set([
  'arm',
  'arm64',
  'x64',
  'ia32',
  'ppc64',
  's390x',
  'riscv64',
  'mips',
  'mipsel',
  'loong64',
]);

/**
 * A version the app can actually report: three numeric parts of at most three
 * digits each. Anything else counts as 'other'. The old check (any run of
 * digits and dots up to 20 characters) let a scripted client mint a new row in
 * the daily stats with every request.
 */
const VERSION_RE = /^\d{1,3}\.\d{1,3}\.\d{1,3}$/;

/**
 * Upper bound on distinct versions kept per day. Real traffic stays far below
 * it (a few dozen releases ever); past it, new versions count as 'other', so
 * the daily record, and the KV value read and rewritten on every hit, stays
 * small whatever a client sends.
 */
export const MAX_VERSIONS_PER_DAY = 100;

export function parseUserAgent(ua: string | null): ClientInfo | null {
  if (!ua) return null;
  const match = ua.match(/^ble-scale-sync\/([\d.]+)\s+\(([^;]+);\s*([^)]+)\)$/);
  if (!match) return null;
  return {
    version: VERSION_RE.test(match[1]) ? match[1] : 'other',
    os: KNOWN_OS.has(match[2]) ? match[2] : 'other',
    arch: KNOWN_ARCH.has(match[3]) ? match[3] : 'other',
  };
}

export function emptyStats(): DailyStats {
  return { total: 0, versions: {}, os: {}, arch: {} };
}

/** Count one hit into a day's stats (mutates and returns `stats`). */
export function addHit(stats: DailyStats, client: ClientInfo): DailyStats {
  const known = client.version in stats.versions;
  const version =
    known || Object.keys(stats.versions).length < MAX_VERSIONS_PER_DAY ? client.version : 'other';
  stats.total++;
  stats.versions[version] = (stats.versions[version] ?? 0) + 1;
  stats.os[client.os] = (stats.os[client.os] ?? 0) + 1;
  stats.arch[client.arch] = (stats.arch[client.arch] ?? 0) + 1;
  return stats;
}

export interface AggregatedStats {
  period: string;
  days: number;
  uniqueDays: number;
  totalChecks: number;
  versions: Record<string, number>;
  os: Record<string, number>;
  arch: Record<string, number>;
}

/**
 * Sum the most recent `days` entries of `daily` (newest first, null for a day
 * without data). One read of the last 30 days serves all three periods; each
 * used to read its own days again, 38 KV reads per dashboard view.
 */
export function aggregate(daily: (DailyStats | null)[], days: number): AggregatedStats {
  const versions: Record<string, number> = {};
  const os: Record<string, number> = {};
  const arch: Record<string, number> = {};
  let totalChecks = 0;
  let uniqueDays = 0;

  for (const stats of daily.slice(0, days)) {
    if (!stats) continue;
    uniqueDays++;
    totalChecks += stats.total;
    for (const [k, v] of Object.entries(stats.versions)) versions[k] = (versions[k] ?? 0) + v;
    for (const [k, v] of Object.entries(stats.os)) os[k] = (os[k] ?? 0) + v;
    for (const [k, v] of Object.entries(stats.arch)) arch[k] = (arch[k] ?? 0) + v;
  }

  const period = days === 1 ? '24h' : days === 7 ? '7d' : '30d';
  return { period, days, uniqueDays, totalChecks, versions, os, arch };
}
