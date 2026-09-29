import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.spyOn(console, 'log').mockImplementation(() => {});
vi.spyOn(console, 'warn').mockImplementation(() => {});

const h = vi.hoisted(() => ({
  probeLiveness: vi.fn(),
  buildCharMap: vi.fn(),
}));

vi.mock('../../../src/ble/handler-node-ble/liveness.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../src/ble/handler-node-ble/liveness.js')>();
  return { ...actual, probeLiveness: h.probeLiveness, makeLivenessAdapter: () => ({}) };
});
vi.mock('../../../src/ble/handler-node-ble/gatt.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/ble/handler-node-ble/gatt.js')>();
  return { ...actual, buildCharMap: h.buildCharMap };
});

const { classifyBleFailure, buildCharMapWithRetry, readWithTimeouts } =
  await import('../../../src/ble/handler-node-ble/scan-stages.js');
const { bleFailureKind } = await import('../../../src/ble/failure-kind.js');
const { normalizeUuid } = await import('../../../src/ble/types.js');
import type { BleChar, BleDevice } from '../../../src/ble/shared.js';
import type { ScaleAdapter } from '../../../src/interfaces/scale-adapter.js';

/**
 * #406: this module is the primary Linux/RPi GATT path and the home of #143,
 * #297 and #335, and no test imported it. classifyBleFailure decides whether
 * the watchdog restarts the process; buildCharMapWithRetry decides whether a
 * scale whose GATT enumeration is slow is usable at all.
 */
describe('classifyBleFailure', () => {
  beforeEach(() => vi.clearAllMocks());

  it('calls a failure after a GATT attempt a wedge suspect, without probing', async () => {
    const err = new Error('le-connection-abort-by-local');
    await classifyBleFailure(err, { gattAttempted: true, probeAdapter: {} as never });
    expect(bleFailureKind(err)).toBe('wedge-suspect');
    expect(h.probeLiveness).not.toHaveBeenCalled();
  });

  it('calls it a wedge suspect when we never got far enough to probe', async () => {
    const err = new Error('adapter unavailable');
    await classifyBleFailure(err, { gattAttempted: false, probeAdapter: undefined });
    expect(bleFailureKind(err)).toBe('wedge-suspect');
    expect(h.probeLiveness).not.toHaveBeenCalled();
  });

  it('calls a no-show idle when the radio still sees other advertisers', async () => {
    h.probeLiveness.mockResolvedValue(true);
    const err = new Error('Device not found');
    await classifyBleFailure(err, { gattAttempted: false, probeAdapter: {} as never });
    expect(bleFailureKind(err)).toBe('idle');
  });

  it('calls a no-show a wedge suspect when the radio sees nothing at all', async () => {
    h.probeLiveness.mockResolvedValue(false);
    const err = new Error('Device not found');
    await classifyBleFailure(err, { gattAttempted: false, probeAdapter: {} as never });
    expect(bleFailureKind(err)).toBe('wedge-suspect');
  });

  it('leaves an already tagged error alone', async () => {
    const err = new Error('Device not found');
    await classifyBleFailure(err, { gattAttempted: true, probeAdapter: {} as never });
    await classifyBleFailure(err, { gattAttempted: false, probeAdapter: {} as never });
    expect(bleFailureKind(err)).toBe('wedge-suspect');
    expect(h.probeLiveness).not.toHaveBeenCalled();
  });

  it('tags nothing during a shutdown', async () => {
    const ac = new AbortController();
    ac.abort();
    const err = new Error('Device not found');
    await classifyBleFailure(err, {
      gattAttempted: false,
      probeAdapter: {} as never,
      abortSignal: ac.signal,
    });
    expect(bleFailureKind(err)).toBeUndefined();
  });
});

describe('buildCharMapWithRetry', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns the first map when nothing is missing', async () => {
    const map = new Map([['a', {} as never]]);
    h.buildCharMap.mockResolvedValue(map);
    const result = await buildCharMapWithRetry({} as never, () => []);
    expect(result).toBe(map);
    expect(h.buildCharMap).toHaveBeenCalledTimes(1);
  });

  it('rebuilds until the missing characteristic appears', async () => {
    const partial = new Map([['a', {} as never]]);
    const complete = new Map([
      ['a', {} as never],
      ['b', {} as never],
    ]);
    h.buildCharMap.mockResolvedValueOnce(partial).mockResolvedValue(complete);

    const result = await buildCharMapWithRetry({} as never, (m) => (m.has('b') ? [] : ['b']));
    expect(result).toBe(complete);
    expect(h.buildCharMap).toHaveBeenCalledTimes(2);
  }, 20_000);

  it('gives up and returns what it has rather than failing the session', async () => {
    const partial = new Map([['a', {} as never]]);
    h.buildCharMap.mockResolvedValue(partial);

    const result = await buildCharMapWithRetry({} as never, () => ['b']);
    // The incomplete map is returned: an adapter may still work with what was
    // discovered, and failing here would turn a slow enumeration into no
    // reading at all.
    expect(result).toBe(partial);
    expect(h.buildCharMap.mock.calls.length).toBeGreaterThan(1);
  }, 20_000);
});

/**
 * #434: the absolute session cap is session_timeout_sec x 3, so 15 s at the
 * lowest allowed 5 s. A 30 s composition hold (the R-MSC04's) armed after the
 * weight settles must still resolve with the held weight instead of being cut
 * by the cap, and without a hold the cap must behave exactly as before.
 */
describe('readWithTimeouts: composition hold against the session cap', () => {
  const NOTIFY = normalizeUuid('fff1');
  const HOLD_MS = 30_000;

  function makeSession() {
    let onData: ((d: Buffer) => void) | null = null;
    const notifyChar: BleChar = {
      subscribe: vi.fn(async (cb: (d: Buffer) => void) => {
        onData = cb;
        return () => {
          onData = null;
        };
      }),
      write: vi.fn(async () => {}),
      read: vi.fn(async () => Buffer.alloc(0)),
    };
    let disconnect: (() => void) | null = null;
    const device: BleDevice = {
      onDisconnect: (cb) => {
        disconnect = cb;
      },
      fireDisconnect: () => {
        const cb = disconnect;
        disconnect = null;
        cb?.();
      },
    };
    const charMap = new Map<string, BleChar>([[NOTIFY, notifyChar]]);
    return { charMap, device, send: (b: number) => onData?.(Buffer.from([b])) };
  }

  function makeAdapter(overrides: Partial<ScaleAdapter>): ScaleAdapter {
    return {
      name: 'HoldScale',
      charNotifyUuid: NOTIFY,
      charWriteUuid: NOTIFY,
      normalizesWeight: true,
      matches: () => true,
      parseNotification: () => ({ weight: 81.55, impedance: 0 }),
      isComplete: () => true,
      computeMetrics: vi.fn(),
      ...overrides,
    } as ScaleAdapter;
  }

  const PROFILE = { height: 180, age: 30, gender: 'male' as const, isAthlete: false };

  for (const sessionTimeoutSec of [5, 10]) {
    const idleMs = sessionTimeoutSec * 1000;

    it(`resolves the held weight when the hold outlasts the cap (session_timeout_sec ${sessionTimeoutSec})`, async () => {
      vi.useFakeTimers();
      try {
        const s = makeSession();
        const adapter = makeAdapter({ completionHoldMs: HOLD_MS, isFinal: () => false });
        const promise = readWithTimeouts(s.charMap, s.device, adapter, 'AA:BB:CC:DD:EE:FF', {
          profile: PROFILE,
          readingTimeoutMs: idleMs,
        });
        let failure: unknown = null;
        promise.catch((e: unknown) => {
          failure = e;
        });
        await vi.advanceTimersByTimeAsync(1000);
        s.send(0x01);

        // Past the cap (3 x idle), still inside the hold, which ends at 31 s.
        await vi.advanceTimersByTimeAsync(idleMs * 3);
        expect(failure).toBeNull();

        await vi.advanceTimersByTimeAsync(31_000 - 1000 - idleMs * 3);
        const result = await promise;
        expect(result.reading).toEqual({ weight: 81.55, impedance: 0 });
      } finally {
        vi.useRealTimers();
      }
    });

    it(`still ends a session without a hold at the cap (session_timeout_sec ${sessionTimeoutSec})`, async () => {
      vi.useFakeTimers();
      try {
        const s = makeSession();
        // Every frame is rejected, so only the cap can end a scale that keeps
        // talking.
        const adapter = makeAdapter({ parseNotification: () => null });
        const promise = readWithTimeouts(s.charMap, s.device, adapter, 'AA:BB:CC:DD:EE:FF', {
          profile: PROFILE,
          readingTimeoutMs: idleMs,
        });
        let failure: Error | null = null;
        promise.catch((e: Error) => {
          failure = e;
        });
        const step = idleMs / 2;
        for (let t = step; t < idleMs * 3; t += step) {
          await vi.advanceTimersByTimeAsync(step);
          s.send(0x01);
        }
        expect(failure).toBeNull();
        await vi.advanceTimersByTimeAsync(step);
        expect(failure).not.toBeNull();
        expect(failure!.message).toBe('GATT session cap exceeded');
      } finally {
        vi.useRealTimers();
      }
    });
  }
});
