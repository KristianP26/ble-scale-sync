import type { ScaleReading } from '../interfaces/scale-adapter.js';
import { bleLog } from './types.js';

/**
 * Buffers cached/offline historical frames dumped during a single GATT session,
 * oldest first, with a hard cap that protects a long-lived continuous-mode
 * process from a misbehaving scale or runaway cache replay. The cap warning is
 * emitted exactly once per buffer instance.
 */
export class HistoryBuffer {
  private readonly frames: ScaleReading[] = [];
  private capWarned = false;

  constructor(
    private readonly max: number,
    private readonly adapterName: string,
  ) {}

  /**
   * Buffer a historical frame. Returns true when stored, false when the cap is
   * already reached (in which case the frame is dropped and a single warning is
   * emitted across the buffer's lifetime).
   */
  push(reading: ScaleReading): boolean {
    if (this.frames.length >= this.max) {
      if (!this.capWarned) {
        bleLog.warn(
          `Cached frame buffer hit ${this.max}, dropping further historical readings ` +
            `from ${this.adapterName}. Misbehaving scale or runaway cache replay?`,
        );
        this.capWarned = true;
      }
      return false;
    }
    this.frames.push(reading);
    return true;
  }

  get length(): number {
    return this.frames.length;
  }

  /** Remove and return the newest buffered frame (disconnect-without-live path). */
  popLatest(): ScaleReading | undefined {
    return this.frames.pop();
  }

  /** Defensive copy of the remaining frames, or undefined when empty. */
  snapshot(): ScaleReading[] | undefined {
    return this.frames.length > 0 ? this.frames.slice() : undefined;
  }
}

/**
 * Implements the `completionHoldMs` window: after a non-final complete reading,
 * keep the link open for up to `holdMs` so a richer frame (e.g. bioimpedance
 * composition sent a few seconds after the weight settles) can arrive. The
 * timer is armed once on the first held reading; later holds only update which
 * reading resolves when the window elapses. On timeout `onElapsed` receives the
 * most recently held reading.
 */
export class HoldTimer {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private held: ScaleReading | null = null;

  /**
   * `holdMs` may be a getter, resolved when the timer arms rather than when it
   * is constructed. The session builds this before `onSessionStart` runs, so an
   * adapter that decides its variant there (yunmai's Mini/SE) would otherwise
   * arm with the value from the PREVIOUS session: a standard unit followed by a
   * Mini gave `setTimeout(..., 0)`, which resolved weight-only on the next tick
   * and dropped the impedance, while logging "holding connection up to 0s"
   * (#406).
   */
  constructor(
    private readonly holdMs: number | (() => number),
    private readonly onElapsed: (reading: ScaleReading) => void,
  ) {}

  hold(reading: ScaleReading): void {
    this.held = reading;
    if (this.timer) return;
    const holdMs = typeof this.holdMs === 'function' ? this.holdMs() : this.holdMs;
    bleLog.info(
      `Weight stable; holding connection up to ` +
        `${Math.round(holdMs / 1000)}s for body composition...`,
    );
    this.timer = setTimeout(() => {
      this.timer = null;
      const r = this.held;
      if (r) this.onElapsed(r);
    }, holdMs);
  }

  get heldReading(): ScaleReading | null {
    return this.held;
  }

  clear(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
