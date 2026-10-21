/**
 * State the broadcast adapters keep across advertisements (A-08). They have no
 * session, so it lives for the process or per unit, and one copy here keeps
 * the adapters' copies from drifting apart (D052-D054 de-duplication).
 */

/**
 * How long a logging key outlives the last frame that carried it. Inside one
 * finished state the #423 capture has at most 0.41 s between adverts, so a
 * watcher stays on one key. A poll transport (node-ble, noble) stops at the
 * first finished frame and reads again only after runtime.scan_cooldown (5 s
 * at the least), so every one of its scans still logs the frame it completed
 * on. Without the expiry, a scan that reads the same payload as the previous
 * one (a finished state outliving the cooldown, or a cached advertisement)
 * would export a reading with no frame of its own in the log, and the counter
 * in that frame is what tells those two cases apart.
 */
const LOG_KEY_TTL_MS = 3_000;

/** One logging key: the last payload logged, and when it was last seen (#372). */
export class LogKey {
  key: string | null = null;
  private seenAt = -Infinity;

  /** Whether `key` is worth a log line: new, or not seen for LOG_KEY_TTL_MS. */
  first(key: string, at: number): boolean {
    const first = key !== this.key || at - this.seenAt > LOG_KEY_TTL_MS;
    this.key = key;
    this.seenAt = at;
    return first;
  }
}

/** Units tracked at once, oldest out. A household has one; this is a leak bound. */
const MAX_UNITS = 8;

/** Per-unit state of a broadcast scale, at most MAX_UNITS units. */
export class UnitMap<T> extends Map<string, T> {
  /** Store `value` as the newest entry; a new unit drops the oldest one when full. */
  put(key: string, value: T): T {
    if (!this.has(key) && this.size >= MAX_UNITS) {
      const oldest = this.keys().next().value;
      if (oldest !== undefined) this.delete(oldest);
    }
    this.delete(key);
    this.set(key, value);
    return value;
  }
}
