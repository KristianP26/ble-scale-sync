import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  raceWithLiveness,
  TransportWedgedError,
  LIVENESS_POLL_MS,
} from '../../src/runtime/proxy-liveness.js';
import type { Watcher } from '../../src/ble/reading-source.js';
import type { RawReading } from '../../src/ble/shared.js';

const LIMIT_MS = 30 * 60_000;

/**
 * A watcher whose reading never arrives, which is the state BOTH failure modes
 * present as: a wedged transport and a house nobody has weighed in at (#281).
 * Only `lastTransportActivityMs` separates them.
 */
function makeWatcher(lastActivity: () => number | null): Watcher {
  return {
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    updateConfig: vi.fn(),
    nextReading: vi.fn(() => new Promise<RawReading>(() => {})),
    lastTransportActivityMs: lastActivity,
  };
}

describe('proxy liveness (#281)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('rejects when the transport has delivered nothing for the whole window', async () => {
    const start = 1_000_000;
    let clock = start;
    // Adverts stopped at `start` and never resumed.
    const watcher = makeWatcher(() => start);
    const p = raceWithLiveness(watcher, LIMIT_MS, undefined, () => clock);
    const caught = p.catch((e: unknown) => e);

    clock = start + LIMIT_MS - 1;
    await vi.advanceTimersByTimeAsync(LIMIT_MS);
    clock = start + LIMIT_MS;
    await vi.advanceTimersByTimeAsync(LIVENESS_POLL_MS);

    const err = await caught;
    expect(err).toBeInstanceOf(TransportWedgedError);
    expect((err as Error).message).toContain('no advertisements');
  });

  // The acceptance criterion that matters most: getting this wrong restart-loops
  // somebody who simply has not stood on the scale.
  it('never fires while advertisements keep arriving from other devices', async () => {
    let clock = 1_000_000;
    const watcher = makeWatcher(() => clock - 5_000); // something was heard 5 s ago
    let settled = false;
    void raceWithLiveness(watcher, LIMIT_MS, undefined, () => clock).catch(() => {
      settled = true;
    });

    for (let i = 0; i < 200; i++) {
      clock += LIVENESS_POLL_MS;
      await vi.advanceTimersByTimeAsync(LIVENESS_POLL_MS);
    }
    expect(settled).toBe(false);
  });

  it('does not judge a transport that has not started', async () => {
    let clock = 1_000_000;
    const watcher = makeWatcher(() => null);
    let settled = false;
    void raceWithLiveness(watcher, LIMIT_MS, undefined, () => clock).catch(() => {
      settled = true;
    });
    for (let i = 0; i < 100; i++) {
      clock += LIVENESS_POLL_MS;
      await vi.advanceTimersByTimeAsync(LIVENESS_POLL_MS);
    }
    expect(settled).toBe(false);
  });

  it('is disabled at zero and hands the reading straight through', async () => {
    const reading: RawReading = { reading: { weight: 80, impedance: 0 } } as unknown as RawReading;
    const watcher = makeWatcher(() => 0);
    watcher.nextReading = vi.fn(async () => reading);
    await expect(raceWithLiveness(watcher, 0, undefined)).resolves.toBe(reading);
  });

  it('clears its timer once the reading arrives', async () => {
    const reading = {} as RawReading;
    const watcher = makeWatcher(() => Date.now());
    watcher.nextReading = vi.fn(async () => reading);
    await expect(raceWithLiveness(watcher, LIMIT_MS, undefined)).resolves.toBe(reading);
    expect(vi.getTimerCount()).toBe(0);
  });
});
