import type { ScaleReading, WeightStabilityGate } from '../interfaces/scale-adapter.js';
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

  constructor(
    private readonly holdMs: number,
    private readonly onElapsed: (reading: ScaleReading) => void,
  ) {}

  hold(reading: ScaleReading): void {
    this.held = reading;
    if (this.timer) return;
    bleLog.info(
      `Reading complete; holding connection up to ` +
        `${Math.round(this.holdMs / 1000)}s for body composition...`,
    );
    this.timer = setTimeout(() => {
      this.timer = null;
      const r = this.held;
      if (r) this.onElapsed(r);
    }, this.holdMs);
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

/**
 * Tracks an opt-in consecutive-weight stability rule across live readings.
 * This is deliberately outside individual adapters so protocols can keep their
 * own "complete" semantics while sharing the common "weight stopped moving"
 * gate where it is useful.
 */
export class WeightStabilityTracker {
  private readonly requiredSamples: number;
  private readonly toleranceKg: number;
  private previousWeight: number | null = null;
  private consecutiveSamples = 0;

  constructor(config: NonNullable<WeightStabilityGate['weightStability']>) {
    this.requiredSamples = Math.max(1, Math.trunc(config.samples ?? 2));
    this.toleranceKg = Math.max(0, config.toleranceKg ?? 0);
  }

  observe(reading: ScaleReading): boolean {
    const weight = reading.weight;
    if (!Number.isFinite(weight)) {
      this.reset();
      return false;
    }

    if (
      this.previousWeight !== null &&
      Math.abs(weight - this.previousWeight) <= this.toleranceKg
    ) {
      this.consecutiveSamples += 1;
    } else {
      this.consecutiveSamples = 1;
    }

    this.previousWeight = weight;
    return this.consecutiveSamples >= this.requiredSamples;
  }

  reset(): void {
    this.previousWeight = null;
    this.consecutiveSamples = 0;
  }
}
