import {
  LIVE_MATCH_AFTER_MS,
  LIVE_MATCH_BEFORE_MS,
  LIVE_MATCH_WEIGHT_KG,
  LIVE_REPLAY_WINDOW_MS,
  RECENT_LIVE_RESULTS,
  SCALE_EPOCH_OFFSET,
} from './constants.js';

/** A live result the adapter published: its weight and when it was published. */
export interface LiveResult {
  weight: number;
  atMs: number;
}

/**
 * What the adapter reported, kept across sessions: what a later session's
 * stored records and repeated result blocks are compared with (#331, #463).
 */
export class QnLedger {
  /**
   * High-water mark of the stored weigh-ins reported, in scale-epoch seconds,
   * persisted by the runtime across restarts (dedupMark, D032). Records are
   * judged against the mark as it stood when the session started: a batch need
   * not arrive in time order, and an earlier record behind a later one is still
   * new.
   */
  mark = 0;

  /** The last few live results published, by weight and the time of their last frame. */
  private readonly live: LiveResult[] = [];

  /** Keep a live result for the stored records of later sessions to be compared with. */
  remember(weight: number): void {
    this.live.push({ weight, atMs: Date.now() });
    if (this.live.length > RECENT_LIVE_RESULTS) this.live.shift();
  }

  /** The live result a stored weigh-in of `weight` kg taken at `atMs` is a copy of, if any. */
  copyOf(weight: number, atMs: number): LiveResult | undefined {
    return this.live.find(
      (r) =>
        Math.abs(r.weight - weight) <= LIVE_MATCH_WEIGHT_KG &&
        atMs >= r.atMs - LIVE_MATCH_BEFORE_MS &&
        atMs <= r.atMs + LIVE_MATCH_AFTER_MS,
    );
  }

  /** The live result of the last LIVE_REPLAY_WINDOW_MS a result block of `weight` kg repeats. */
  repeatOf(weight: number): LiveResult | undefined {
    return this.live.find(
      (r) =>
        Math.abs(r.weight - weight) <= LIVE_MATCH_WEIGHT_KG &&
        Date.now() - r.atMs <= LIVE_REPLAY_WINDOW_MS,
    );
  }

  /** The newest stored weigh-in reported, in scale-epoch seconds (#331). */
  dedupMark(): number | undefined {
    return this.mark || undefined;
  }

  /**
   * Take back the mark of an earlier process. Raises only, and ignores anything
   * that is not a whole number of seconds up to a day past now on the scale's
   * clock: the file can be edited by hand.
   */
  restoreDedupMark(mark: number): void {
    const limit = Math.floor(Date.now() / 1000) - SCALE_EPOCH_OFFSET + 86_400;
    if (!Number.isInteger(mark) || mark <= 0 || mark > limit) return;
    if (mark > this.mark) this.mark = mark;
  }
}
