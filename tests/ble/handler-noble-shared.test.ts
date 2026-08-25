import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { createNobleHandler, type NobleApi } from '../../src/ble/handler-noble-shared.js';

// Suppress log output during tests
vi.spyOn(console, 'log').mockImplementation(() => {});
vi.spyOn(console, 'warn').mockImplementation(() => {});
vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

/**
 * #181 seam test: the shared handler must read the adapter state ONLY through the
 * injected `getState()` accessor, never by touching `noble.state` directly.
 *
 * This matters because `@abandonware/noble`'s `.state` getter triggers
 * `bindings.init()` as a side effect; the legacy entrypoint deliberately reads
 * the raw `._state` field instead. If the shared code ever reached for `.state`,
 * that side effect would fire on the abandonware driver and change behaviour.
 */
class FakeNoble extends EventEmitter {
  _state = 'poweredOn';
  stateAccessed = 0;
  // A getter that records access (and would, on the real abandonware driver,
  // lazily init the bindings). The shared code must NOT trip this.
  get state(): string {
    this.stateAccessed++;
    return this._state;
  }
  startScanningAsync = vi.fn(async () => {});
  stopScanningAsync = vi.fn(async () => {});
}

describe('createNobleHandler getState injection (#181)', () => {
  it('reads adapter state through getState(), not noble.state', async () => {
    const fake = new FakeNoble();
    const getState = vi.fn(() => fake._state);

    const handler = createNobleHandler({
      noble: fake as unknown as NobleApi,
      getState,
    });

    // scanDevices() calls waitForPoweredOn() which reads the state.
    await handler.scanDevices([], 1);

    expect(getState).toHaveBeenCalled();
    // The legacy-style accessor (raw field) was used; the side-effecting getter
    // was never touched by the shared code.
    expect(fake.stateAccessed).toBe(0);
    expect(fake.startScanningAsync).toHaveBeenCalledTimes(1);
    expect(fake.stopScanningAsync).toHaveBeenCalledTimes(1);
  });

  it('bounds a notify-enable that never settles and cleans up its listener (#283)', async () => {
    // @abandonware/noble resolves subscribeAsync only from a single
    // once('notify') and its WinRT binding emits nothing on several failure
    // branches, including a CCCD write that returns AsyncStatus::Error. The
    // reporter's log shows exactly that as "BLEManager::OnNotify: status: 3",
    // after which the whole reading used to hang until the scale gave up.
    vi.useFakeTimers();
    try {
      const fake = new FakeNoble();
      const handler = createNobleHandler({
        noble: fake as unknown as NobleApi,
        getState: () => fake._state,
      });

      const listeners = new Map<string, Array<(d: Buffer) => void>>();
      const char = {
        uuid: 'fff1',
        on: (ev: string, fn: (d: Buffer) => void) => {
          (listeners.get(ev) ?? listeners.set(ev, []).get(ev)!).push(fn);
        },
        removeListener: (ev: string, fn: (d: Buffer) => void) => {
          const arr = listeners.get(ev) ?? [];
          const i = arr.indexOf(fn);
          if (i >= 0) arr.splice(i, 1);
        },
        // Never settles, exactly like the WinRT silent branch.
        subscribeAsync: () => new Promise<void>(() => {}),
      };

      const wrapped = handler._internals.wrapChar(char as never);
      const promise = wrapped.subscribe(() => {});
      const assertion = expect(promise).rejects.toThrow(/did not complete within/);
      await vi.advanceTimersByTimeAsync(11_000);
      await assertion;

      // The data listener must not be left behind, or every failed cycle leaks one.
      expect(listeners.get('data') ?? []).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('falls back to a direct CCCD write when the driver subscribe fails (#283)', async () => {
    // The WinRT binding fails a subscribe in two ways: silently (covered by the
    // timeout test above) and with an error. Either way the session used to die.
    // The fallback must enable notifications AND keep the data listener, which
    // is attached before the subscribe precisely so no early frame is lost.
    const fake = new FakeNoble();
    const handler = createNobleHandler({
      noble: fake as unknown as NobleApi,
      getState: () => fake._state,
    });

    const listeners = new Map<string, Array<(d: Buffer) => void>>();
    const written: Buffer[] = [];
    const cccd = {
      uuid: '00002902-0000-1000-8000-00805f9b34fb',
      writeValueAsync: async (d: Buffer) => {
        written.push(d);
      },
    };
    const char = {
      uuid: 'fff1',
      on: (ev: string, fn: (d: Buffer) => void) => {
        (listeners.get(ev) ?? listeners.set(ev, []).get(ev)!).push(fn);
      },
      removeListener: (ev: string, fn: (d: Buffer) => void) => {
        const arr = listeners.get(ev) ?? [];
        const i = arr.indexOf(fn);
        if (i >= 0) arr.splice(i, 1);
      },
      subscribeAsync: () => Promise.reject(new Error('BLEManager::OnNotify: status: 3')),
      discoverDescriptorsAsync: async () => [cccd],
    };

    const wrapped = handler._internals.wrapChar(char as never);
    const received: Buffer[] = [];
    const unsub = await wrapped.subscribe((d) => received.push(d));

    expect(written).toHaveLength(1);
    expect([...written[0]]).toEqual([0x01, 0x00]);
    // The listener survived the fallback, so frames still arrive.
    expect(listeners.get('data') ?? []).toHaveLength(1);
    listeners.get('data')![0](Buffer.from([0x10]));
    expect(received).toHaveLength(1);

    unsub();
    expect(listeners.get('data') ?? []).toHaveLength(0);
  });

  it('still reports the subscribe failure when there is no CCCD to fall back to (#283)', async () => {
    // A characteristic without a CCCD, or a driver without descriptor support,
    // must surface the ORIGINAL subscribe error: that is the informative half,
    // and a descriptor error would send the reader down the wrong path.
    const fake = new FakeNoble();
    const handler = createNobleHandler({
      noble: fake as unknown as NobleApi,
      getState: () => fake._state,
    });
    const listeners = new Map<string, Array<(d: Buffer) => void>>();
    const char = {
      uuid: 'fff1',
      on: (ev: string, fn: (d: Buffer) => void) => {
        (listeners.get(ev) ?? listeners.set(ev, []).get(ev)!).push(fn);
      },
      removeListener: (ev: string, fn: (d: Buffer) => void) => {
        const arr = listeners.get(ev) ?? [];
        const i = arr.indexOf(fn);
        if (i >= 0) arr.splice(i, 1);
      },
      subscribeAsync: () => Promise.reject(new Error('BLEManager::OnNotify: status: 3')),
      discoverDescriptorsAsync: async () => [],
    };

    const wrapped = handler._internals.wrapChar(char as never);
    await expect(wrapped.subscribe(() => {})).rejects.toThrow(/status: 3/);
    expect(listeners.get('data') ?? []).toHaveLength(0);
  });

  it('exposes the broadcastScan internal for both driver entrypoints', () => {
    const fake = new FakeNoble();
    const handler = createNobleHandler({
      noble: fake as unknown as NobleApi,
      getState: () => fake._state,
    });
    expect(typeof handler._internals.broadcastScan).toBe('function');
  });
});
