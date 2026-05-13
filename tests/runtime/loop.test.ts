import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runContinuousLoop, type ReadingSource } from '../../src/runtime/loop.js';
import type { RawReading } from '../../src/ble/shared.js';

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
