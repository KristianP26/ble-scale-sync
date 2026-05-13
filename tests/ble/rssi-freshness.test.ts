import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { isPeerFresh, startPeerFreshnessTracker } from '../../src/ble/handler-node-ble/index.js';
import { RSSI_FRESHNESS_MS } from '../../src/ble/types.js';
import type NodeBle from 'node-ble';

type Device = NodeBle.Device;
type PropsHandler = (props: Record<string, unknown>) => void;

interface MockHelper {
  prop: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  removeListener: ReturnType<typeof vi.fn>;
  emit: (props: Record<string, unknown>) => void;
}

function makeDevice(propBehavior: () => unknown | Promise<unknown>): {
  device: Device;
  helper: MockHelper;
} {
  let propsHandler: PropsHandler | null = null;
  const helper: MockHelper = {
    prop: vi.fn(propBehavior),
    on: vi.fn((event: string, handler: PropsHandler) => {
      if (event === 'PropertiesChanged') propsHandler = handler;
    }),
    removeListener: vi.fn((event: string, handler: PropsHandler) => {
      if (event === 'PropertiesChanged' && propsHandler === handler) {
        propsHandler = null;
      }
    }),
    emit: (props) => {
      if (propsHandler) propsHandler(props);
    },
  };
  return { device: { helper } as unknown as Device, helper };
}

describe('isPeerFresh()', () => {
  it('returns true when RSSI is a normal negative dBm value', async () => {
    const { device } = makeDevice(() => -62);
    await expect(isPeerFresh(device)).resolves.toBe(true);
  });

  it('returns true when RSSI is undefined and tracker is fresh (#167 regression guard)', async () => {
    // BlueZ may drop the Optional RSSI prop after StopDiscovery. Absence is
    // not a freshness signal; PropertiesChanged + fresh-init timestamp are.
    const { device } = makeDevice(() => undefined);
    await expect(isPeerFresh(device)).resolves.toBe(true);
  });

  it('returns true when RSSI is null and tracker is fresh', async () => {
    const { device } = makeDevice(() => null);
    await expect(isPeerFresh(device)).resolves.toBe(true);
  });

  it('returns false when RSSI is the BlueZ sentinel 127 (unavailable)', async () => {
    const { device } = makeDevice(() => 127);
    await expect(isPeerFresh(device)).resolves.toBe(false);
  });

  it('returns true when prop call throws and tracker is fresh', async () => {
    const { device } = makeDevice(() => {
      throw new Error('Property not found');
    });
    await expect(isPeerFresh(device)).resolves.toBe(true);
  });

  it('returns true when prop rejects asynchronously and tracker is fresh', async () => {
    const { device } = makeDevice(() => Promise.reject(new Error('D-Bus error')));
    await expect(isPeerFresh(device)).resolves.toBe(true);
  });

  it('subscribes to PropertiesChanged and tears down on stop', async () => {
    const { device, helper } = makeDevice(() => -62);
    await isPeerFresh(device);
    expect(helper.on).toHaveBeenCalledWith('PropertiesChanged', expect.any(Function));
    expect(helper.removeListener).toHaveBeenCalledWith('PropertiesChanged', expect.any(Function));
  });
});

describe('startPeerFreshnessTracker()', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('treats a freshly created tracker as fresh (initial timestamp = now)', async () => {
    const { device } = makeDevice(() => -62);
    const tracker = startPeerFreshnessTracker(device);
    await expect(tracker.isFresh()).resolves.toBe(true);
    tracker.stop();
  });

  it('returns false when no PropertiesChanged with RSSI fires within freshness window', async () => {
    const { device } = makeDevice(() => -62);
    const tracker = startPeerFreshnessTracker(device);
    vi.advanceTimersByTime(RSSI_FRESHNESS_MS + 1000);
    await expect(tracker.isFresh()).resolves.toBe(false);
    tracker.stop();
  });

  it('refreshes the timestamp when PropertiesChanged emits an RSSI update', async () => {
    const { device, helper } = makeDevice(() => -62);
    const tracker = startPeerFreshnessTracker(device);
    vi.advanceTimersByTime(RSSI_FRESHNESS_MS - 100);
    helper.emit({ RSSI: -55 });
    vi.advanceTimersByTime(RSSI_FRESHNESS_MS - 1000);
    await expect(tracker.isFresh()).resolves.toBe(true);
    tracker.stop();
  });

  it('ignores PropertiesChanged that does not include RSSI', async () => {
    const { device, helper } = makeDevice(() => -62);
    const tracker = startPeerFreshnessTracker(device);
    vi.advanceTimersByTime(RSSI_FRESHNESS_MS / 2);
    helper.emit({ ServiceData: { '0x181b': Buffer.from([0x01]) } });
    vi.advanceTimersByTime(RSSI_FRESHNESS_MS / 2 + 1000);
    await expect(tracker.isFresh()).resolves.toBe(false);
    tracker.stop();
  });

  it('does not throw when stop is called twice', () => {
    const { device } = makeDevice(() => -62);
    const tracker = startPeerFreshnessTracker(device);
    tracker.stop();
    expect(() => tracker.stop()).not.toThrow();
  });

  it('still works when helper.on throws (subscription unavailable)', async () => {
    const { device, helper } = makeDevice(() => -62);
    helper.on.mockImplementation(() => {
      throw new Error('subscription not supported');
    });
    const tracker = startPeerFreshnessTracker(device);
    await expect(tracker.isFresh()).resolves.toBe(true);
    tracker.stop();
  });

  it('returns false when RSSI is undefined and lastRssiUpdateTs is stale', async () => {
    // Fresh init protects new trackers, but a long-lived tracker that never
    // saw another advert in 5+ s must still report stale.
    const { device } = makeDevice(() => undefined);
    const tracker = startPeerFreshnessTracker(device);
    vi.advanceTimersByTime(RSSI_FRESHNESS_MS + 1000);
    await expect(tracker.isFresh()).resolves.toBe(false);
    tracker.stop();
  });

  it('returns false when prop throws and lastRssiUpdateTs is stale', async () => {
    const { device } = makeDevice(() => {
      throw new Error('D-Bus error');
    });
    const tracker = startPeerFreshnessTracker(device);
    vi.advanceTimersByTime(RSSI_FRESHNESS_MS + 1000);
    await expect(tracker.isFresh()).resolves.toBe(false);
    tracker.stop();
  });
});
