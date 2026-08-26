import type { Watcher } from '../ble/reading-source.js';
import type { RawReading } from '../ble/shared.js';

/**
 * Raised when a proxy transport has delivered no advertisements for long enough
 * that it is wedged rather than idle (#281).
 *
 * Its own type so the failure hook can tell it apart from a scale nobody stood
 * on, which is the whole difficulty of this failure mode.
 */
export class TransportWedgedError extends Error {
  constructor(public readonly silentForMs: number) {
    super(
      `The proxy transport has delivered no advertisements for ` +
        `${Math.round(silentForMs / 60_000)} minutes. Advertisements arrive constantly ` +
        `from any nearby device while the link is alive, so this is a wedged ` +
        `transport rather than an idle scale.`,
    );
    this.name = 'TransportWedgedError';
  }
}

/** How often the silence is re-checked. Small next to any sane limit. */
export const LIVENESS_POLL_MS = 60_000;

/**
 * Wrap `watcher.nextReading` so a transport that has gone silent rejects
 * instead of waiting forever.
 *
 * A plain timeout on `nextReading` would be wrong: it never resolves for an
 * idle scale either, and restarting somebody who simply has not weighed in is
 * worse than the bug. Only the absence of ALL advertisements is treated as
 * evidence, and only after `limitMs`.
 */
export function raceWithLiveness(
  watcher: Watcher,
  limitMs: number,
  signal: AbortSignal | undefined,
  now: () => number = Date.now,
): Promise<RawReading> {
  const reading = watcher.nextReading(signal);
  // No signal to judge by means no judgement: never invent a wedge.
  if (limitMs <= 0 || typeof watcher.lastTransportActivityMs !== 'function') return reading;

  let timer: ReturnType<typeof setInterval> | undefined;
  const wedged = new Promise<never>((_resolve, reject) => {
    timer = setInterval(() => {
      const last = watcher.lastTransportActivityMs();
      // Null means the transport has not started, or has stopped and reset. A
      // watcher that never came up is a start() failure, reported there.
      if (last === null) return;
      const silentFor = now() - last;
      if (silentFor >= limitMs) reject(new TransportWedgedError(silentFor));
    }, LIVENESS_POLL_MS);
    // Never hold the process open on account of the liveness check alone.
    timer.unref?.();
  });

  return Promise.race([reading, wedged]).finally(() => {
    if (timer) clearInterval(timer);
  }) as Promise<RawReading>;
}
