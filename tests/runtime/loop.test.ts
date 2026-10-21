import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runContinuousLoop, type ReadingSource } from '../../src/runtime/loop.js';
import type { RawReading } from '../../src/ble/shared.js';
import { MissingTransportModuleError } from '../../src/ble/transport-availability.js';

const STUB_RAW: RawReading = {
  reading: { weight: 70, impedance: 500 },
  adapter: {} as unknown as RawReading['adapter'],
};

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeSource(): {
  source: ReadingSource;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  nextReading: ReturnType<typeof vi.fn>;
} {
  const start = vi.fn(async () => undefined);
  const stop = vi.fn(async () => undefined);
  const nextReading = vi.fn(async () => STUB_RAW);
  return {
    source: {
      start,
      stop,
      nextReading: nextReading as ReadingSource['nextReading'],
    },
    start,
    stop,
    nextReading,
  };
}

describe('runContinuousLoop', () => {
  // #277: the timer in src/runtime/file-heartbeat.ts is what actually keeps the
  // Docker HEALTHCHECK satisfied while idle, because this loop blocks in
  // nextReading() until a weigh-in arrives. The per-iteration touch is now
  // redundant but deliberately kept, so this locks the contract: do not delete
  // it on the assumption that the timer covers everything.
  it('touches the heartbeat once per iteration', async () => {
    const ac = new AbortController();
    const { source, nextReading } = makeSource();
    const touchHeartbeat = vi.fn();

    // First iteration completes, the second parks in nextReading. That second
    // park is the idle state this whole fix is about: the heartbeat must have
    // been touched before the block, and nothing may touch it again until a
    // reading arrives.
    const parked = deferred<RawReading>();
    nextReading.mockImplementationOnce(async () => STUB_RAW);
    nextReading.mockImplementation(() => parked.promise);

    const loop = runContinuousLoop({
      source,
      processReading: async () => true,
      signal: ac.signal,
      touchHeartbeat,
      isReloadRequested: () => false,
      clearReloadRequest: () => {},
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(nextReading).toHaveBeenCalledTimes(2);
    expect(touchHeartbeat).toHaveBeenCalledTimes(2);

    // Parked in nextReading: no further touches, which is exactly why the
    // timer-based heartbeat exists.
    await vi.advanceTimersByTimeAsync(600_000);
    expect(touchHeartbeat).toHaveBeenCalledTimes(2);

    ac.abort();
    parked.resolve(STUB_RAW);
    await loop;
  });

  it('fails fast when a BLE stack is not installed, instead of retrying forever', async () => {
    // #364: a missing npm package never fixes itself on the next cycle. Left in
    // the backoff path, the install instruction is emitted at info level glued
    // to "retrying in 60s", once per cycle, and an unrecoverable install
    // problem reads exactly like a scale nobody stepped on.
    const ac = new AbortController();
    const { source, nextReading } = makeSource();
    const onFailure = vi.fn();
    const missing = new MissingTransportModuleError(
      'noble-legacy',
      ['@abandonware/noble'],
      'BLE transport noble-legacy needs the npm package @abandonware/noble',
    );
    nextReading.mockImplementation(() => Promise.reject(missing));

    const loop = runContinuousLoop({
      source,
      processReading: async () => true,
      signal: ac.signal,
      touchHeartbeat: () => {},
      isReloadRequested: () => false,
      clearReloadRequest: () => {},
      onFailure,
    });

    await expect(loop).rejects.toBe(missing);
    expect(nextReading).toHaveBeenCalledTimes(1);
    expect(onFailure).not.toHaveBeenCalled();
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('backoff sequence on repeated failures: 5s -> 10s -> 20s -> 40s -> 60s cap', async () => {
    const ac = new AbortController();
    const { source, nextReading } = makeSource();
    nextReading.mockRejectedValue(new Error('scale not found'));

    const touchHeartbeat = vi.fn();
    const isReloadRequested = vi.fn(() => false);
    const clearReloadRequest = vi.fn();

    const loop = runContinuousLoop({
      source,
      processReading: async () => true,
      signal: ac.signal,
      touchHeartbeat,
      isReloadRequested,
      clearReloadRequest,
      failureLogPrefix: 'No scale found',
    });

    // Iteration 1: fail, sleep 5s
    await vi.advanceTimersByTimeAsync(0);
    expect(nextReading).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5_000);

    // Iteration 2: fail, sleep 10s
    expect(nextReading).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(10_000);

    // Iteration 3: fail, sleep 20s
    expect(nextReading).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(20_000);

    // Iteration 4: fail, sleep 40s
    expect(nextReading).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(40_000);

    // Iteration 5: fail, sleep 60s (capped)
    expect(nextReading).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(60_000);

    // Iteration 6: fail, sleep 60s (still capped, not 120s)
    expect(nextReading).toHaveBeenCalledTimes(6);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(nextReading).toHaveBeenCalledTimes(7);

    ac.abort();
    await vi.advanceTimersByTimeAsync(0);
    await loop;
  });

  // #398: an idle cycle (radio alive, nobody on the scale) used to climb the
  // same 5 s -> 60 s ladder as a dead controller, so a quiet house spent a
  // minute per cycle not listening and a scale that only advertises while
  // somebody stands on it could weigh in entirely inside that window.
  it('waits the delay failureDelayMs names, without climbing the backoff ladder', async () => {
    const ac = new AbortController();
    const { source, nextReading } = makeSource();
    nextReading.mockRejectedValue(new Error('idle'));

    const loop = runContinuousLoop({
      source,
      processReading: async () => true,
      signal: ac.signal,
      touchHeartbeat: vi.fn(),
      isReloadRequested: vi.fn(() => false),
      clearReloadRequest: vi.fn(),
      failureDelayMs: () => 5_000,
      failureLogPrefix: 'No scale found',
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(nextReading).toHaveBeenCalledTimes(1);

    // Four more cycles at the same 5 s. Under the backoff this would have been
    // 10 s, 20 s, 40 s and 60 s, so a 5 s tick would have advanced nothing.
    for (let cycle = 2; cycle <= 5; cycle += 1) {
      await vi.advanceTimersByTimeAsync(5_000);
      expect(nextReading).toHaveBeenCalledTimes(cycle);
    }

    ac.abort();
    await vi.advanceTimersByTimeAsync(0);
    await loop;
  });

  it('an idle cycle neither advances nor resets a real failure streak', async () => {
    const ac = new AbortController();
    const { source, nextReading } = makeSource();

    const idle = new Error('idle');
    const broken = new Error('GATT connect failed');
    nextReading
      .mockRejectedValueOnce(broken) // backoff 5s
      .mockRejectedValueOnce(broken) // backoff 10s
      .mockRejectedValueOnce(idle) // claimed: 2s, streak untouched
      .mockRejectedValueOnce(broken) // backoff 20s, not 5s and not 40s
      .mockRejectedValue(broken);

    const loop = runContinuousLoop({
      source,
      processReading: async () => true,
      signal: ac.signal,
      touchHeartbeat: vi.fn(),
      isReloadRequested: vi.fn(() => false),
      clearReloadRequest: vi.fn(),
      failureDelayMs: (err) => (err === idle ? 2_000 : undefined),
      failureLogPrefix: 'No scale found',
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(nextReading).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(nextReading).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(nextReading).toHaveBeenCalledTimes(3);

    // The idle cycle waits its own 2 s and nothing else.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(nextReading).toHaveBeenCalledTimes(4);

    // Back on the ladder where it left off: 20 s. A reset would have fired at
    // 5 s, and counting the idle cycle would have made this 40 s.
    await vi.advanceTimersByTimeAsync(19_999);
    expect(nextReading).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(1);
    expect(nextReading).toHaveBeenCalledTimes(5);

    ac.abort();
    await vi.advanceTimersByTimeAsync(0);
    await loop;
  });

  it('backs off as before when failureDelayMs returns undefined', async () => {
    const ac = new AbortController();
    const { source, nextReading } = makeSource();
    nextReading.mockRejectedValue(new Error('GATT connect failed'));

    const loop = runContinuousLoop({
      source,
      processReading: async () => true,
      signal: ac.signal,
      touchHeartbeat: vi.fn(),
      isReloadRequested: vi.fn(() => false),
      clearReloadRequest: vi.fn(),
      failureDelayMs: () => undefined,
      failureLogPrefix: 'No scale found',
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(nextReading).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(nextReading).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(nextReading).toHaveBeenCalledTimes(2);

    ac.abort();
    await vi.advanceTimersByTimeAsync(0);
    await loop;
  });

  // #475: a scale that accepts a connection all the time shows PAIR through a
  // new session every few minutes. The floor only lengthens the wait; the
  // backoff underneath still advances, so a real failure afterwards carries on
  // where the ladder stands (D041).
  describe('failureDelayFloor (#475)', () => {
    const FLOOR_LABEL = 'runtime.no_reading_rescan_delay';

    function infoLines(): string[] {
      return vi.mocked(console.log).mock.calls.map((c) => String(c[0]));
    }

    it('waits the failureDelayFloor when it is longer than the backoff, and the backoff still advances under it (#475)', async () => {
      const ac = new AbortController();
      const { source, nextReading } = makeSource();
      const noReading = new Error('Timed out');
      const broken = new Error('GATT connect failed');
      nextReading
        .mockRejectedValueOnce(noReading) // backoff 5 s, floor 900 s
        .mockRejectedValueOnce(noReading) // backoff 10 s, floor 900 s
        .mockRejectedValue(broken); // backoff 20 s: the ladder moved twice

      const loop = runContinuousLoop({
        source,
        processReading: async () => true,
        signal: ac.signal,
        touchHeartbeat: vi.fn(),
        isReloadRequested: vi.fn(() => false),
        clearReloadRequest: vi.fn(),
        failureLogPrefix: 'No scale found',
        failureDelayFloor: (err) =>
          err === noReading ? { ms: 900_000, label: FLOOR_LABEL } : undefined,
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(nextReading).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(899_999);
      expect(nextReading).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(nextReading).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(899_999);
      expect(nextReading).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(nextReading).toHaveBeenCalledTimes(3);

      // 20 s, not 5 s: the two floored waits still moved the backoff on.
      await vi.advanceTimersByTimeAsync(19_999);
      expect(nextReading).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(1);
      expect(nextReading).toHaveBeenCalledTimes(4);

      ac.abort();
      await vi.advanceTimersByTimeAsync(0);
      await loop;
    });

    it('lets the backoff decide once it reaches the floor, and names the setting only when the floor decided', async () => {
      const ac = new AbortController();
      const { source, nextReading } = makeSource();
      nextReading.mockRejectedValue(new Error('Timed out'));

      const loop = runContinuousLoop({
        source,
        processReading: async () => true,
        signal: ac.signal,
        touchHeartbeat: vi.fn(),
        isReloadRequested: vi.fn(() => false),
        clearReloadRequest: vi.fn(),
        failureLogPrefix: 'Scale connected but sent no reading',
        failureDelayFloor: () => ({ ms: 10_000, label: FLOOR_LABEL }),
      });

      // Backoff 5 s, floor 10 s: the floor sets the wait.
      await vi.advanceTimersByTimeAsync(0);
      expect(nextReading).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(9_999);
      expect(nextReading).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(nextReading).toHaveBeenCalledTimes(2);
      // Backoff 10 s, floor 10 s: equal, so the backoff decides and the line
      // reads exactly as it did before the setting existed.
      await vi.advanceTimersByTimeAsync(10_000);
      expect(nextReading).toHaveBeenCalledTimes(3);
      // Backoff 20 s, floor 10 s: the backoff.
      await vi.advanceTimersByTimeAsync(19_999);
      expect(nextReading).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(1);
      expect(nextReading).toHaveBeenCalledTimes(4);

      const waits = infoLines().filter((l) => l.includes('retrying in'));
      expect(waits[0]).toContain(`retrying in 10s (${FLOOR_LABEL})...`);
      expect(waits[1]).toContain('retrying in 10s... (Timed out)');
      expect(waits[1]).not.toContain(FLOOR_LABEL);
      expect(waits[2]).toContain('retrying in 20s... (Timed out)');
      expect(waits[2]).not.toContain(FLOOR_LABEL);

      ac.abort();
      await vi.advanceTimersByTimeAsync(0);
      await loop;
    });

    it('ends a long floor at once on shutdown', async () => {
      const ac = new AbortController();
      const { source, nextReading, stop } = makeSource();
      nextReading.mockRejectedValue(new Error('Timed out'));

      let done = false;
      const loop = runContinuousLoop({
        source,
        processReading: async () => true,
        signal: ac.signal,
        touchHeartbeat: vi.fn(),
        isReloadRequested: vi.fn(() => false),
        clearReloadRequest: vi.fn(),
        failureDelayFloor: () => ({ ms: 3_600_000, label: FLOOR_LABEL }),
      }).then(() => {
        done = true;
      });

      await vi.advanceTimersByTimeAsync(10_000);
      expect(nextReading).toHaveBeenCalledTimes(1);

      ac.abort();
      // No clock advance beyond the current tick: a wait that ignored the
      // signal would still be pending here, not at the test's own timeout.
      await vi.advanceTimersByTimeAsync(0);
      expect(done).toBe(true);
      expect(stop).toHaveBeenCalledOnce();
      await loop;
    });

    it('logs the full line with the setting when the floor sets the wait', async () => {
      const ac = new AbortController();
      const { source, nextReading } = makeSource();
      nextReading.mockRejectedValue(new Error('Timed out'));

      const loop = runContinuousLoop({
        source,
        processReading: async () => true,
        signal: ac.signal,
        touchHeartbeat: vi.fn(),
        isReloadRequested: vi.fn(() => false),
        clearReloadRequest: vi.fn(),
        failureLogPrefix: 'No scale found',
        failureLogPrefixFor: () => 'Scale connected but sent no reading',
        failureDelayFloor: () => ({ ms: 900_000, label: FLOOR_LABEL }),
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(
        infoLines().some((l) =>
          l.includes(
            `Scale connected but sent no reading, retrying in 900s (${FLOOR_LABEL})... (Timed out)`,
          ),
        ),
      ).toBe(true);

      ac.abort();
      await vi.advanceTimersByTimeAsync(0);
      await loop;
    });

    it('leaves the ladder and the log line as before when the floor returns undefined', async () => {
      const ac = new AbortController();
      const { source, nextReading } = makeSource();
      nextReading.mockRejectedValue(new Error('Timed out'));
      const floor = vi.fn(() => undefined);

      const loop = runContinuousLoop({
        source,
        processReading: async () => true,
        signal: ac.signal,
        touchHeartbeat: vi.fn(),
        isReloadRequested: vi.fn(() => false),
        clearReloadRequest: vi.fn(),
        failureLogPrefix: 'Scale connected but sent no reading',
        failureDelayFloor: floor,
      });

      await vi.advanceTimersByTimeAsync(0);
      let calls = 1;
      for (const waitMs of [5_000, 10_000, 20_000, 40_000, 60_000, 60_000]) {
        expect(nextReading).toHaveBeenCalledTimes(calls);
        await vi.advanceTimersByTimeAsync(waitMs - 1);
        expect(nextReading).toHaveBeenCalledTimes(calls);
        await vi.advanceTimersByTimeAsync(1);
        calls += 1;
      }
      expect(nextReading).toHaveBeenCalledTimes(7);
      expect(floor).toHaveBeenCalled();
      const waits = infoLines().filter((l) => l.includes('retrying in'));
      expect(
        waits[0].endsWith('Scale connected but sent no reading, retrying in 5s... (Timed out)'),
      ).toBe(true);

      ac.abort();
      await vi.advanceTimersByTimeAsync(0);
      await loop;
    });

    it('still lets failureDelayMs claim an error before the floor is asked', async () => {
      const ac = new AbortController();
      const { source, nextReading } = makeSource();
      nextReading.mockRejectedValue(new Error('idle'));
      const floor = vi.fn(() => ({ ms: 900_000, label: FLOOR_LABEL }));

      const loop = runContinuousLoop({
        source,
        processReading: async () => true,
        signal: ac.signal,
        touchHeartbeat: vi.fn(),
        isReloadRequested: vi.fn(() => false),
        clearReloadRequest: vi.fn(),
        failureLogPrefix: 'No scale found',
        failureDelayMs: () => 2_000,
        failureDelayFloor: floor,
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(nextReading).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(nextReading).toHaveBeenCalledTimes(2);
      expect(floor).not.toHaveBeenCalled();

      ac.abort();
      await vi.advanceTimersByTimeAsync(0);
      await loop;
    });
  });

  // #417: a connect skipped by ble.adapter_privacy found the scale, so the
  // usual "No scale found" line would point at the wrong problem.
  it('logs the prefix failureLogPrefixFor names, and failureLogPrefix otherwise', async () => {
    const ac = new AbortController();
    const { source, nextReading } = makeSource();
    const skipped = new Error('connect skipped');
    nextReading.mockRejectedValueOnce(skipped).mockRejectedValue(new Error('Device not found'));
    const info = vi.mocked(console.log);

    const loop = runContinuousLoop({
      source,
      processReading: async () => true,
      signal: ac.signal,
      touchHeartbeat: vi.fn(),
      isReloadRequested: vi.fn(() => false),
      clearReloadRequest: vi.fn(),
      failureLogPrefix: 'No scale found',
      failureLogPrefixFor: (err) => (err === skipped ? 'Scale found but not connected' : undefined),
    });

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5_000);
    const lines = info.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.includes('Scale found but not connected, retrying in 5s'))).toBe(
      true,
    );
    expect(lines.some((l) => l.includes('No scale found, retrying in 10s'))).toBe(true);

    ac.abort();
    await vi.advanceTimersByTimeAsync(0);
    await loop;
  });

  // #412: a queued export must not wait for the next weigh-in to even be
  // attempted, so the hook runs before the source is asked for anything.
  it('runs onCycleStart before nextReading, every iteration', async () => {
    const ac = new AbortController();
    const { source, nextReading } = makeSource();
    const calls: string[] = [];
    nextReading.mockImplementation(async () => {
      calls.push('nextReading');
      return STUB_RAW;
    });

    const loop = runContinuousLoop({
      source,
      processReading: async () => true,
      signal: ac.signal,
      touchHeartbeat: vi.fn(),
      isReloadRequested: vi.fn(() => false),
      clearReloadRequest: vi.fn(),
      onCycleStart: async () => {
        calls.push('onCycleStart');
      },
      onSuccess: async () => {
        if (calls.length >= 4) ac.abort();
      },
    });

    await vi.advanceTimersByTimeAsync(0);
    await loop;

    expect(calls.slice(0, 4)).toEqual([
      'onCycleStart',
      'nextReading',
      'onCycleStart',
      'nextReading',
    ]);
  });

  // E-02: the flush used to be awaited before nextReading, so a queued Garmin
  // upload hanging on a slow server (3 x upload_timeout_sec per entry) kept the
  // scan off for as long as it took, and a scale that only advertises while
  // somebody stands on it was simply never heard.
  it('does not hold the scan back while a queue flush is still running', async () => {
    const ac = new AbortController();
    const { source, nextReading } = makeSource();
    const flush = deferred<void>();
    const onCycleStart = vi.fn(() => flush.promise);
    let readings = 0;
    nextReading.mockImplementation(async () => {
      readings += 1;
      if (readings >= 2) ac.abort();
      return STUB_RAW;
    });

    const loop = runContinuousLoop({
      source,
      processReading: async () => true,
      signal: ac.signal,
      touchHeartbeat: vi.fn(),
      isReloadRequested: vi.fn(() => false),
      clearReloadRequest: vi.fn(),
      onCycleStart,
    });

    await vi.advanceTimersByTimeAsync(0);
    // Two scans happened while the first flush never finished...
    expect(nextReading).toHaveBeenCalledTimes(2);
    // ...and the second iteration did not start a second flush on top of it:
    // two passes at once would attempt the same queued entries twice.
    expect(onCycleStart).toHaveBeenCalledTimes(1);

    flush.resolve();
    await loop;
  });

  it('starts the next flush once the previous one has finished', async () => {
    const ac = new AbortController();
    const { source, nextReading } = makeSource();
    const onCycleStart = vi.fn(async () => {});
    let readings = 0;
    nextReading.mockImplementation(async () => {
      readings += 1;
      if (readings >= 3) ac.abort();
      return STUB_RAW;
    });

    const loop = runContinuousLoop({
      source,
      processReading: async () => true,
      signal: ac.signal,
      touchHeartbeat: vi.fn(),
      isReloadRequested: vi.fn(() => false),
      clearReloadRequest: vi.fn(),
      onCycleStart,
    });

    await vi.advanceTimersByTimeAsync(0);
    await loop;
    expect(onCycleStart).toHaveBeenCalledTimes(3);
  });

  it('a failing flush is not an iteration failure', async () => {
    const ac = new AbortController();
    const { source, nextReading } = makeSource();
    // Aborts too, so a regression ends the loop and fails on the assertions
    // below instead of parking in the backoff sleep.
    const onFailure = vi.fn(() => ac.abort());
    nextReading.mockImplementation(async () => {
      ac.abort();
      return STUB_RAW;
    });

    const loop = runContinuousLoop({
      source,
      processReading: async () => true,
      signal: ac.signal,
      touchHeartbeat: vi.fn(),
      isReloadRequested: vi.fn(() => false),
      clearReloadRequest: vi.fn(),
      onCycleStart: async () => {
        throw new Error('queue file unreadable');
      },
      onFailure,
    });

    await vi.advanceTimersByTimeAsync(0);
    await loop;
    // Nothing about the queue says anything about the radio: it must neither
    // feed the watchdog nor delay the scan with a backoff.
    expect(onFailure).not.toHaveBeenCalled();
    expect(nextReading).toHaveBeenCalledTimes(1);
  });

  it('SIGHUP reload runs onReload -> clearReloadRequest -> onSourceReload before nextReading', async () => {
    const ac = new AbortController();
    const { source, nextReading } = makeSource();

    // Requested before the first iteration runs.
    let reloadFlag = true;
    const calls: string[] = [];

    nextReading.mockImplementation(async () => {
      calls.push('nextReading');
      return STUB_RAW;
    });

    const onReload = vi.fn(async () => {
      calls.push('onReload');
    });
    const clearReloadRequest = vi.fn(() => {
      calls.push('clearReloadRequest');
      reloadFlag = false;
    });
    const onSourceReload = vi.fn(() => {
      calls.push('onSourceReload');
    });

    const loop = runContinuousLoop({
      source,
      processReading: async () => {
        ac.abort();
        return true;
      },
      signal: ac.signal,
      touchHeartbeat: () => {},
      isReloadRequested: () => reloadFlag,
      clearReloadRequest,
      onReload,
      onSourceReload,
    });

    await vi.advanceTimersByTimeAsync(0);
    await loop;

    expect(calls).toEqual(['onReload', 'clearReloadRequest', 'onSourceReload', 'nextReading']);
    expect(onReload).toHaveBeenCalledOnce();
    expect(clearReloadRequest).toHaveBeenCalledOnce();
    expect(onSourceReload).toHaveBeenCalledOnce();
  });

  // E-17: the flush used to start before a pending reload was applied, so
  // queued uploads went out with the old config (old dry_run, a removed
  // exporter) one more time.
  it('applies a pending reload before starting the queue flush', async () => {
    const ac = new AbortController();
    const { source, nextReading } = makeSource();
    let reloadFlag = true;
    const calls: string[] = [];
    nextReading.mockImplementation(async () => {
      calls.push('nextReading');
      ac.abort();
      return STUB_RAW;
    });

    const loop = runContinuousLoop({
      source,
      processReading: async () => true,
      signal: ac.signal,
      touchHeartbeat: () => {},
      isReloadRequested: () => reloadFlag,
      clearReloadRequest: () => {
        reloadFlag = false;
      },
      onReload: async () => {
        calls.push('onReload');
      },
      onCycleStart: async () => {
        calls.push('onCycleStart');
      },
    });

    await vi.advanceTimersByTimeAsync(0);
    await loop;
    expect(calls).toEqual(['onReload', 'onCycleStart', 'nextReading']);
  });

  it('graceful abort: exits cleanly mid-nextReading and calls source.stop', async () => {
    const ac = new AbortController();
    const { source, nextReading, stop } = makeSource();
    const gate = deferred<RawReading>();

    nextReading.mockImplementation(async (signal: AbortSignal) => {
      signal.addEventListener('abort', () => gate.reject(new Error('aborted')), { once: true });
      return gate.promise;
    });

    const processReading = vi.fn(async () => true);

    const loop = runContinuousLoop({
      source,
      processReading,
      signal: ac.signal,
      touchHeartbeat: () => {},
      isReloadRequested: () => false,
      clearReloadRequest: () => {},
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(nextReading).toHaveBeenCalledOnce();

    // Abort while nextReading is pending.
    ac.abort();
    await vi.advanceTimersByTimeAsync(0);
    await loop;

    expect(processReading).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalledOnce();
  });

  it('successful iteration calls onSuccess and resets backoff', async () => {
    const ac = new AbortController();
    const { source, nextReading } = makeSource();

    // Fail once, succeed once. Abort inside onSuccess so it still fires.
    let call = 0;
    nextReading.mockImplementation(async () => {
      call += 1;
      if (call === 1) throw new Error('boom');
      return STUB_RAW;
    });

    const onSuccess = vi.fn(() => {
      ac.abort();
    });
    const onFailure = vi.fn();

    const loop = runContinuousLoop({
      source,
      processReading: async () => true,
      signal: ac.signal,
      touchHeartbeat: () => {},
      isReloadRequested: () => false,
      clearReloadRequest: () => {},
      onSuccess,
      onFailure,
    });

    await vi.advanceTimersByTimeAsync(5_000); // first backoff
    await vi.advanceTimersByTimeAsync(0);
    await loop;

    expect(onFailure).toHaveBeenCalledOnce();
    expect(onSuccess).toHaveBeenCalledOnce();
  });

  it('does not call onSuccess when abort fires between processReading and onSuccess', async () => {
    const ac = new AbortController();
    const { source } = makeSource();

    const onSuccess = vi.fn();

    const loop = runContinuousLoop({
      source,
      processReading: async () => {
        ac.abort();
        return true;
      },
      signal: ac.signal,
      touchHeartbeat: () => {},
      isReloadRequested: () => false,
      clearReloadRequest: () => {},
      onSuccess,
    });

    await vi.advanceTimersByTimeAsync(0);
    await loop;

    expect(onSuccess).not.toHaveBeenCalled();
  });
});
