import { describe, it, expect, vi, afterEach } from 'vitest';
import { createWriteLanes, WriteLaneClosed } from '../../src/ble/write-lane.js';
import type { WritableChar } from '../../src/ble/write-lane.js';

/**
 * A characteristic whose writes stay open until the test settles them, so the
 * lane's ordering is visible. `started` records each write at the moment the
 * lane hands it to the transport.
 */
function createHeldChar() {
  const started: string[] = [];
  const open: { hex: string; resolve: () => void; reject: (e: unknown) => void }[] = [];
  const char: WritableChar & {
    started: string[];
    settle: (hex?: string) => void;
    fail: (e: unknown) => void;
    openCount: () => number;
  } = {
    started,
    write: vi.fn((data: Buffer) => {
      const hex = data.toString('hex');
      started.push(hex);
      return new Promise<void>((resolve, reject) => {
        open.push({ hex, resolve, reject });
      });
    }),
    settle: (hex?: string) => {
      const i = hex === undefined ? 0 : open.findIndex((o) => o.hex === hex);
      const [o] = open.splice(i, 1);
      o.resolve();
    },
    fail: (e: unknown) => {
      const o = open.shift()!;
      o.reject(e);
    },
    openCount: () => open.length,
  };
  return char;
}

/** Let settle callbacks and the lane's follow-up start run. */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

const b = (hex: string): Buffer => Buffer.from(hex, 'hex');

afterEach(() => {
  vi.useRealTimers();
});

describe('createWriteLanes()', () => {
  it('I1: starts the write on an idle lane synchronously, before any await', () => {
    const lanes = createWriteLanes();
    const char = createHeldChar();

    void lanes.write(char, b('01'), true, 'adapter');

    // No await between write() and this check: a queue.then()-style lane would
    // only start the write in a later microtask (#370).
    expect(char.write).toHaveBeenCalledTimes(1);
    expect(char.started).toEqual(['01']);
  });

  it('I2: runs one write at a time per characteristic, in FIFO order', async () => {
    const lanes = createWriteLanes();
    const char = createHeldChar();

    const p1 = lanes.write(char, b('01'), true, 'adapter');
    const p2 = lanes.write(char, b('02'), false, 'unlock');
    const p3 = lanes.write(char, b('03'), true, 'ack');
    expect(char.started).toEqual(['01']);

    char.settle('01');
    // A write queued after the settle but before the lane has started the next
    // one must not overtake the waiting ones.
    const p4 = lanes.write(char, b('04'), true, 'adapter');
    await flush();
    expect(char.started).toEqual(['01', '02']);

    char.settle('02');
    await flush();
    expect(char.started).toEqual(['01', '02', '03']);
    char.settle('03');
    await flush();
    char.settle('04');
    await Promise.all([p1, p2, p3, p4]);
    expect(char.started).toEqual(['01', '02', '03', '04']);
  });

  it('runs writes to different characteristics side by side', () => {
    const lanes = createWriteLanes();
    const a = createHeldChar();
    const c = createHeldChar();

    void lanes.write(a, b('01'), true, 'adapter');
    void lanes.write(c, b('02'), true, 'adapter');

    expect(a.started).toEqual(['01']);
    expect(c.started).toEqual(['02']);
  });

  it('I3: releaseAfterMs frees the lane but the caller still follows the transport', async () => {
    vi.useFakeTimers();
    const lanes = createWriteLanes({ releaseAfterMs: 5000 });
    const char = createHeldChar();

    let firstSettled = false;
    const p1 = lanes.write(char, b('01'), true, 'adapter').then(() => {
      firstSettled = true;
    });
    void lanes.write(char, b('02'), true, 'adapter');
    void lanes.write(char, b('03'), true, 'adapter');

    await vi.advanceTimersByTimeAsync(4999);
    expect(char.started).toEqual(['01']);

    await vi.advanceTimersByTimeAsync(1);
    expect(char.started).toEqual(['01', '02']);
    expect(firstSettled).toBe(false);

    // The first write finally answers. It was already released, so it must not
    // release the second one, which is still running.
    char.settle('01');
    await p1;
    expect(firstSettled).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(char.started).toEqual(['01', '02']);

    char.settle('02');
    await vi.advanceTimersByTimeAsync(0);
    expect(char.started).toEqual(['01', '02', '03']);
  });

  describe('I4: ACK coalescing', () => {
    it('joins an identical ACK that is still waiting', async () => {
      const lanes = createWriteLanes();
      const char = createHeldChar();

      void lanes.write(char, b('e7f1580107'), true, 'ack');
      const waiting = lanes.write(char, b('e7f1580107'), true, 'ack'); // queued
      const joined = lanes.write(char, b('e7f1580107'), true, 'ack'); // joins

      char.settle();
      await flush();
      char.settle();
      const [w, j] = await Promise.all([waiting, joined]);

      expect(char.started).toEqual(['e7f1580107', 'e7f1580107']);
      expect(w.coalesced).toBe(false);
      expect(j.coalesced).toBe(true);
      expect(j.tookMs).toBe(w.tookMs);
    });

    it('never joins the running ACK', async () => {
      const lanes = createWriteLanes();
      const char = createHeldChar();

      void lanes.write(char, b('e7f1580107'), true, 'ack');
      void lanes.write(char, b('e7f1580107'), true, 'ack');

      expect(char.write).toHaveBeenCalledTimes(1);
      char.settle();
      await flush();
      expect(char.started).toEqual(['e7f1580107', 'e7f1580107']);
    });

    it('queues a different ACK and never replaces the waiting one', async () => {
      const lanes = createWriteLanes();
      const char = createHeldChar();

      void lanes.write(char, b('e7f1580107'), true, 'ack');
      void lanes.write(char, b('e7f1590301'), true, 'ack');
      void lanes.write(char, b('e7f1580107'), true, 'ack');

      for (let i = 0; i < 3; i++) {
        char.settle();
        await flush();
      }
      expect(char.started).toEqual(['e7f1580107', 'e7f1590301', 'e7f1580107']);
    });

    it('joins only the tail: an identical ACK behind a different one queues again', async () => {
      const lanes = createWriteLanes();
      const char = createHeldChar();

      void lanes.write(char, b('01'), true, 'adapter'); // running
      void lanes.write(char, b('e7f1580107'), true, 'ack'); // waits
      void lanes.write(char, b('e7f1590301'), true, 'ack'); // waits, the tail
      // Joining the older identical ACK would put it on the wire before 0x59
      // part 1's, an order the scale never saw.
      void lanes.write(char, b('e7f1580107'), true, 'ack');

      for (let i = 0; i < 4; i++) {
        char.settle();
        await flush();
      }
      expect(char.started).toEqual(['01', 'e7f1580107', 'e7f1590301', 'e7f1580107']);
    });

    it('does not join an identical ACK of a different write type', async () => {
      const lanes = createWriteLanes();
      const char = createHeldChar();

      void lanes.write(char, b('01'), true, 'adapter');
      void lanes.write(char, b('aa'), true, 'ack');
      void lanes.write(char, b('aa'), false, 'ack');

      for (let i = 0; i < 3; i++) {
        char.settle();
        await flush();
      }
      expect(char.started).toEqual(['01', 'aa', 'aa']);
    });

    it('never joins adapter writes, even identical ones', async () => {
      const lanes = createWriteLanes();
      const char = createHeldChar();

      void lanes.write(char, b('01'), true, 'adapter');
      void lanes.write(char, b('a2'), true, 'adapter');
      void lanes.write(char, b('a2'), true, 'adapter');

      for (let i = 0; i < 3; i++) {
        char.settle();
        await flush();
      }
      expect(char.started).toEqual(['01', 'a2', 'a2']);
    });
  });

  it('I5: close() drops waiting and new unlocks, ACK and adapter writes still run', async () => {
    const lanes = createWriteLanes();
    const char = createHeldChar();

    void lanes.write(char, b('01'), true, 'adapter');
    const unlock = lanes.write(char, b('e701'), false, 'unlock');
    const ack = lanes.write(char, b('e7f1590303'), true, 'ack');

    lanes.close();
    await expect(unlock).rejects.toBeInstanceOf(WriteLaneClosed);
    await expect(lanes.write(char, b('e701'), false, 'unlock')).rejects.toBeInstanceOf(
      WriteLaneClosed,
    );
    const late = lanes.write(char, b('ffe3'), false, 'adapter');

    char.settle('01');
    await flush();
    char.settle('e7f1590303');
    await flush();
    char.settle('ffe3');
    await Promise.all([ack, late]);

    expect(char.started).toEqual(['01', 'e7f1590303', 'ffe3']);
  });

  it('I6: neither a rejecting nor a synchronously throwing write stalls the lane', async () => {
    const lanes = createWriteLanes();
    const char = createHeldChar();
    const throwing: WritableChar = {
      write: vi.fn(() => {
        throw new Error('sync boom');
      }),
    };

    await expect(lanes.write(throwing, b('01'), true, 'adapter')).rejects.toThrow('sync boom');
    // A non-promise return value is fine too.
    const plain: WritableChar = { write: vi.fn(() => undefined as unknown as Promise<void>) };
    await expect(lanes.write(plain, b('01'), true, 'adapter')).resolves.toMatchObject({
      coalesced: false,
    });

    const p1 = lanes.write(char, b('01'), true, 'adapter');
    const p2 = lanes.write(char, b('02'), true, 'adapter');
    char.fail(new Error('In Progress'));
    await expect(p1).rejects.toThrow('In Progress');
    await flush();
    expect(char.started).toEqual(['01', '02']);
    char.settle('02');
    await p2;

    // The throwing char's lane is free again too.
    await expect(lanes.write(throwing, b('02'), true, 'adapter')).rejects.toThrow('sync boom');
    expect(throwing.write).toHaveBeenCalledTimes(2);
  });

  it('I7: a rejecting transport produces no unhandled rejection when the caller handles it', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const lanes = createWriteLanes();
      const char = createHeldChar();

      const p1 = lanes.write(char, b('aa'), true, 'ack').catch(() => 'handled');
      const queued = lanes.write(char, b('bb'), true, 'ack').catch(() => 'handled');
      const joined = lanes.write(char, b('bb'), true, 'ack').catch(() => 'handled');
      const syncThrow = lanes
        .write(
          {
            write: () => {
              throw new Error('sync boom');
            },
          },
          b('cc'),
          true,
          'adapter',
        )
        .catch(() => 'handled');

      // Fail whatever is open until nothing is left: two writes with ACK
      // coalescing, three without, so this does not depend on it.
      for (let i = 0; i < 5 && char.openCount() > 0; i++) {
        char.fail(new Error('In Progress'));
        await flush();
      }
      expect(await Promise.all([p1, queued, joined, syncThrow])).toEqual([
        'handled',
        'handled',
        'handled',
        'handled',
      ]);

      // Node reports an unhandled rejection only after the microtask queue
      // drains, so give it a macrotask turn.
      await new Promise((r) => setTimeout(r, 10));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('I8: leaves no timer behind once every write has settled', async () => {
    vi.useFakeTimers();
    const lanes = createWriteLanes();
    const char = createHeldChar();

    const p1 = lanes.write(char, b('01'), true, 'adapter');
    const p2 = lanes.write(char, b('02'), true, 'adapter');
    expect(vi.getTimerCount()).toBe(1);

    char.settle('01');
    await vi.advanceTimersByTimeAsync(0);
    char.settle('02');
    await Promise.all([p1, p2]);

    expect(vi.getTimerCount()).toBe(0);
  });

  it('I9: the release timer of a write still open does not keep the process alive', () => {
    // Real timers: the single-shot run ends by draining the event loop, so a
    // ref'd 5 s timer on a write the stack never answers would hold the exit.
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const lanes = createWriteLanes();
    const char = createHeldChar();

    void lanes.write(char, b('01'), true, 'adapter');

    expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
    const timer = setTimeoutSpy.mock.results[0].value as NodeJS.Timeout;
    expect(timer.hasRef()).toBe(false);
    clearTimeout(timer);
    setTimeoutSpy.mockRestore();
  });
});
