import { describe, it, expect, vi } from 'vitest';
import {
  formatMac,
  normalizeUuid,
  sleep,
  withTimeout,
  withIdleTimeout,
  SessionTimeoutError,
  BT_BASE_UUID_SUFFIX,
} from '../../src/ble/types.js';
import { HoldTimer, HOLD_EXTENSION_MAX_MS } from '../../src/ble/notification-processor.js';

describe('formatMac()', () => {
  it('formats a lowercase MAC with colons', () => {
    expect(formatMac('ff:03:00:13:a1:04')).toBe('FF:03:00:13:A1:04');
  });

  it('formats a MAC without separators', () => {
    expect(formatMac('FF030013A104')).toBe('FF:03:00:13:A1:04');
  });

  it('formats a MAC with dashes', () => {
    expect(formatMac('ff-03-00-13-a1-04')).toBe('FF:03:00:13:A1:04');
  });

  it('uppercases all hex characters', () => {
    expect(formatMac('ab:cd:ef:01:23:45')).toBe('AB:CD:EF:01:23:45');
  });
});

describe('normalizeUuid()', () => {
  it('expands a 4-char short UUID to full 128-bit form', () => {
    expect(normalizeUuid('FFF0')).toBe(`0000fff0${BT_BASE_UUID_SUFFIX}`);
  });

  it('lowercases and strips dashes from a full UUID', () => {
    expect(normalizeUuid('0000FFF0-0000-1000-8000-00805F9B34FB')).toBe(
      `0000fff0${BT_BASE_UUID_SUFFIX}`,
    );
  });

  it('returns lowercase for already-clean UUIDs', () => {
    expect(normalizeUuid('AABBCCDD11223344AABBCCDD11223344')).toBe(
      'aabbccdd11223344aabbccdd11223344',
    );
  });
});

describe('sleep()', () => {
  it('resolves after the specified delay', async () => {
    const start = Date.now();
    await sleep(50);
    expect(Date.now() - start).toBeGreaterThanOrEqual(40);
  });

  it('resolves with undefined', async () => {
    await expect(sleep(1)).resolves.toBeUndefined();
  });
});

describe('withTimeout()', () => {
  it('resolves when the promise completes before timeout', async () => {
    const result = await withTimeout(Promise.resolve(42), 1000, 'timed out');
    expect(result).toBe(42);
  });

  it('rejects with timeout message when promise is too slow', async () => {
    const slow = new Promise((r) => setTimeout(r, 10_000));
    await expect(withTimeout(slow, 10, 'operation timed out')).rejects.toThrow(
      'operation timed out',
    );
  });

  it('clears the timer after the promise resolves', async () => {
    // If the timer leaked, this test would hang or fail in a different way
    const result = await withTimeout(Promise.resolve('ok'), 60_000, 'timeout');
    expect(result).toBe('ok');
  });

  it('propagates the original error if promise rejects before timeout', async () => {
    const failing = Promise.reject(new Error('original error'));
    await expect(withTimeout(failing, 1000, 'timeout')).rejects.toThrow('original error');
  });
});

describe('withIdleTimeout()', () => {
  it('rejects after the idle period when nothing signals activity', async () => {
    vi.useFakeTimers();
    try {
      const never = withIdleTimeout(() => new Promise<never>(() => {}), 1000, 'idle');
      const outcome = expect(never).rejects.toThrow('idle');
      await vi.advanceTimersByTimeAsync(1000);
      await outcome;
    } finally {
      vi.useRealTimers();
    }
  });

  // #460: the loop logged a session that connected and then timed out as
  // "No scale found". It needs to recognise this error, with the text the log
  // has always shown.
  it('rejects with a SessionTimeoutError that says which clock ran out', async () => {
    vi.useFakeTimers();
    try {
      const idle = withIdleTimeout(() => new Promise<never>(() => {}), 1000, 'idle message');
      const idleOutcome = idle.catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(1000);
      const idleErr = await idleOutcome;
      expect(idleErr).toBeInstanceOf(SessionTimeoutError);
      expect((idleErr as SessionTimeoutError).reason).toBe('idle');
      expect((idleErr as Error).message).toBe('idle message');
      expect(String(idleErr)).toBe('Error: idle message');

      // Activity every 500 ms keeps the idle window open, so only the cap ends it.
      let signal!: () => void;
      const capped = withIdleTimeout(
        (onActivity) => {
          signal = onActivity;
          return new Promise<never>(() => {});
        },
        1000,
        'idle message',
        { ms: 3000, message: 'cap message' },
      );
      const capOutcome = capped.catch((e: unknown) => e);
      for (let t = 0; t < 3000; t += 500) {
        await vi.advanceTimersByTimeAsync(500);
        signal();
      }
      const capErr = await capOutcome;
      expect(capErr).toBeInstanceOf(SessionTimeoutError);
      expect((capErr as SessionTimeoutError).reason).toBe('cap');
      expect((capErr as Error).message).toBe('cap message');
    } finally {
      vi.useRealTimers();
    }
  });

  it('restarts the deadline on activity so a slow but live source completes', async () => {
    vi.useFakeTimers();
    try {
      let signal!: () => void;
      let finish!: (v: string) => void;
      const result = withIdleTimeout(
        (onActivity) => {
          signal = onActivity;
          return new Promise<string>((resolve) => {
            finish = resolve;
          });
        },
        1000,
        'idle',
      );
      await vi.advanceTimersByTimeAsync(900);
      signal();
      // Past the original deadline, inside the restarted one.
      await vi.advanceTimersByTimeAsync(900);
      finish('reading');
      await expect(result).resolves.toBe('reading');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a requested minimum idle window even when later activity arrives (#434)', async () => {
    vi.useFakeTimers();
    try {
      let signal!: (minIdleMs?: number) => void;
      let finish!: (v: string) => void;
      let failure: unknown = null;
      const result = withIdleTimeout(
        (onActivity) => {
          signal = onActivity;
          return new Promise<string>((resolve) => {
            finish = resolve;
          });
        },
        1000,
        'idle',
      );
      result.catch((e: unknown) => {
        failure = e;
      });
      signal(5000);
      // A plain frame later must not pull the deadline back to 1 s from now.
      await vi.advanceTimersByTimeAsync(500);
      signal();
      await vi.advanceTimersByTimeAsync(4400);
      expect(failure).toBeNull();
      finish('reading');
      await expect(result).resolves.toBe('reading');
    } finally {
      vi.useRealTimers();
    }
  });

  // #211: every extension of a composition hold requests a new minimum window,
  // which also moves the absolute cap, so a silent scale mid-transfer is not
  // cut off by the idle timeout or the cap before the hold resolves.
  it('lets an extended composition hold outlast the idle window and the cap (#211)', async () => {
    vi.useFakeTimers();
    try {
      let failure: unknown = null;
      const result = withIdleTimeout<number>(
        (onActivity) =>
          new Promise<number>((resolve) => {
            const hold = new HoldTimer(
              5000,
              (r) => resolve(r.weight),
              (ms) => onActivity(ms + 2000),
              () => true,
            );
            setTimeout(() => hold.hold({ weight: 83.4, impedance: 0 }), 10_000);
          }),
        12_000,
        'idle',
        { ms: 15_000, message: 'cap' },
      );
      result.catch((e: unknown) => {
        failure = e;
      });
      await vi.advanceTimersByTimeAsync(10_000 + 5000 + HOLD_EXTENSION_MAX_MS - 1);
      expect(failure).toBeNull();
      await vi.advanceTimersByTimeAsync(1);
      await expect(result).resolves.toBe(83.4);
    } finally {
      vi.useRealTimers();
    }
  });

  it('falls back to the plain idle window once the requested minimum has passed', async () => {
    vi.useFakeTimers();
    try {
      let signal!: (minIdleMs?: number) => void;
      const result = withIdleTimeout(
        (onActivity) => {
          signal = onActivity;
          return new Promise<never>(() => {});
        },
        1000,
        'idle',
      );
      const outcome = expect(result).rejects.toThrow('idle');
      signal(2000);
      await vi.advanceTimersByTimeAsync(1500);
      signal();
      // The floor ends at 2000; from 1500 the plain 1000 ms window applies.
      await vi.advanceTimersByTimeAsync(1000);
      await outcome;
    } finally {
      vi.useRealTimers();
    }
  });

  it('ends at the cap however much activity arrives (#434)', async () => {
    vi.useFakeTimers();
    try {
      let signal!: (minIdleMs?: number) => void;
      const result = withIdleTimeout(
        (onActivity) => {
          signal = onActivity;
          return new Promise<never>(() => {});
        },
        1000,
        'idle',
        { ms: 3000, message: 'cap' },
      );
      const outcome = expect(result).rejects.toThrow('cap');
      for (let i = 0; i < 6; i++) {
        await vi.advanceTimersByTimeAsync(500);
        signal();
      }
      await outcome;
    } finally {
      vi.useRealTimers();
    }
  });

  it('moves the cap out to the end of a requested minimum window (#434)', async () => {
    vi.useFakeTimers();
    try {
      let signal!: (minIdleMs?: number) => void;
      let finish!: (v: string) => void;
      let failure: unknown = null;
      const result = withIdleTimeout(
        (onActivity) => {
          signal = onActivity;
          return new Promise<string>((resolve) => {
            finish = resolve;
          });
        },
        1000,
        'idle',
        { ms: 3000, message: 'cap' },
      );
      result.catch((e: unknown) => {
        failure = e;
      });
      await vi.advanceTimersByTimeAsync(900);
      signal(5000);
      // The floor ends at 5900, past the 3000 cap.
      await vi.advanceTimersByTimeAsync(4900);
      expect(failure).toBeNull();
      finish('held');
      await expect(result).resolves.toBe('held');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('normalizeUuid, the only one (#406)', () => {
  it('expands 16-bit, 32-bit and braced forms to the same 32-char value', () => {
    const canonical = '0000fff400001000800000805f9b34fb';
    expect(normalizeUuid('fff4')).toBe(canonical);
    expect(normalizeUuid('FFF4')).toBe(canonical);
    expect(normalizeUuid('0000fff4-0000-1000-8000-00805f9b34fb')).toBe(canonical);
    expect(normalizeUuid('{0000FFF4-0000-1000-8000-00805F9B34FB}')).toBe(canonical);
    // 32-bit: this case used to be handled by three of the five copies and not
    // by the canonical one, which is why the copies existed.
    expect(normalizeUuid('0000fff4')).toBe(canonical);
  });

  it('returns the undashed form, which is what every comparison in the project uses', () => {
    expect(normalizeUuid('181b')).not.toContain('-');
  });
});
