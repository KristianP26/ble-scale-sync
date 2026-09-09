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
  updateConfig: ReturnType<typeof vi.fn>;
} {
  const start = vi.fn(async () => undefined);
  const stop = vi.fn(async () => undefined);
  const nextReading = vi.fn(async () => STUB_RAW);
  const updateConfig = vi.fn();
  return {
    source: {
      start,
      stop,
      nextReading: nextReading as ReadingSource['nextReading'],
      updateConfig,
    },
    start,
    stop,
    nextReading,
    updateConfig,
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

  it('SIGHUP reload runs onReload -> clearReloadRequest -> onSourceReload before nextReading', async () => {
    const ac = new AbortController();
    const { source, nextReading } = makeSource();

    let reloadFlag = false;
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

    // Flip reload BEFORE first iteration runs.
    reloadFlag = true;
    await vi.advanceTimersByTimeAsync(0);
    await loop;

    expect(calls).toEqual(['onReload', 'clearReloadRequest', 'onSourceReload', 'nextReading']);
    expect(onReload).toHaveBeenCalledOnce();
    expect(clearReloadRequest).toHaveBeenCalledOnce();
    expect(onSourceReload).toHaveBeenCalledOnce();
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
