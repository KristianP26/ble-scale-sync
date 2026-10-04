/**
 * Per-client limit on the stats write that GET /version triggers.
 *
 * Only the part of the Workers Rate Limiting binding used here is typed
 * locally, so this module needs no Workers globals and the root test suite can
 * run it, the same as version.ts and stats.ts.
 *
 * The limit only decides whether a hit is COUNTED. The version answer itself
 * is never refused: an install behind a busy shared address must still learn
 * about a new release, and a client that loops on /version gains nothing but
 * the same cached answer. What the loop no longer gets is a KV read and write
 * per request, which is what made the stats forgeable and could use up the
 * daily KV write allowance.
 */
export interface StatsLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

/**
 * Whether this hit may be written to the daily stats.
 *
 * `clientIp` is the CF-Connecting-IP header. An address is a coarse key
 * (several installs can share one), which is acceptable here: a real install
 * checks once a day, so the limit in wrangler.toml leaves plenty of room for a
 * whole household, and going over it costs a stats row, never an answer.
 */
export async function mayRecordHit(
  limiter: StatsLimiter | undefined,
  clientIp: string | null,
): Promise<boolean> {
  // No binding (a `wrangler dev` setup without it): count as before.
  if (!limiter) return true;
  try {
    const { success } = await limiter.limit({ key: `stats:${clientIp ?? 'unknown'}` });
    return success;
  } catch {
    // The stats are best effort: if the limiter cannot answer, skip the write
    // rather than let an unlimited client through.
    return false;
  }
}
