import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

// Suppress log output during tests.
vi.spyOn(console, 'log').mockImplementation(() => {});
vi.spyOn(console, 'warn').mockImplementation(() => {});
vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

// Mock dbus-next so the dynamic import in handler-node-ble does not require
// the real native module on the test host.
vi.mock('dbus-next', () => ({
  Variant: class {
    constructor(
      public signature: string,
      public value: unknown,
    ) {}
  },
}));

// Mock node-ble (only handler-node-ble's surface is used in this file).
vi.mock('node-ble', () => ({
  default: {
    createBluetooth: vi.fn(),
  },
}));

const { _internals } = await import('../../src/ble/handler-node-ble.js');

interface MockHelper extends EventEmitter {
  prop: ReturnType<typeof vi.fn>;
  on: EventEmitter['on'];
  removeListener: EventEmitter['removeListener'];
  callMethod: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  object: string;
}

function makeHelper(rssiBehavior: () => unknown): MockHelper {
  const ee = new EventEmitter() as MockHelper;
  ee.prop = vi.fn(async (name: string) => {
    if (name === 'RSSI') return rssiBehavior();
    return undefined;
  });
  ee.callMethod = vi.fn(async () => undefined);
  ee.set = vi.fn(async () => undefined);
  ee.object = '/org/bluez/hci0';
  return ee;
}

interface MockDevice {
  helper: MockHelper;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
}

function makeDevice(rssiBehavior: () => unknown): MockDevice {
  return {
    helper: makeHelper(rssiBehavior),
    connect: vi.fn(async () => undefined),
    disconnect: vi.fn(async () => undefined),
  };
}

interface MockAdapter {
  helper: MockHelper;
  isDiscovering: ReturnType<typeof vi.fn>;
  startDiscovery: ReturnType<typeof vi.fn>;
  stopDiscovery: ReturnType<typeof vi.fn>;
  waitDevice: ReturnType<typeof vi.fn>;
  getDevice: ReturnType<typeof vi.fn>;
}

function makeAdapter(reDiscoveredDevice: MockDevice): MockAdapter {
  return {
    helper: makeHelper(() => -55),
    isDiscovering: vi.fn(async () => false),
    startDiscovery: vi.fn(async () => undefined),
    stopDiscovery: vi.fn(async () => undefined),
    waitDevice: vi.fn(async () => reDiscoveredDevice),
    getDevice: vi.fn(async () => reDiscoveredDevice),
  };
}

describe('connectWithRecovery: RSSI freshness skip (#143 integration)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('skips device.connect() when peer RSSI is the BlueZ "unavailable" sentinel (127)', async () => {
    // Initial device is dark (RSSI=127). Re-discovered device is fresh (RSSI=-55).
    const initialDevice = makeDevice(() => 127);
    const reDiscoveredDevice = makeDevice(() => -55);
    const btAdapter = makeAdapter(reDiscoveredDevice);

    // First isFresh() check on the fresh re-discovered device must succeed,
    // so we let the second tracker.isFresh() also return true via the prop mock.
    const result = await _internals.connectWithRecovery({
      btAdapter: btAdapter as never,
      mac: 'AA:BB:CC:DD:EE:FF',
      initialDevice: initialDevice as never,
      maxRetries: 0,
    });

    // The headline assertion: connect() must NOT have been called on the
    // initial dying-peer device.
    expect(initialDevice.connect).not.toHaveBeenCalled();
    // Re-discovery was attempted.
    expect(btAdapter.waitDevice).toHaveBeenCalledTimes(1);
    // After re-discovery, connect was issued on the fresh device.
    expect(reDiscoveredDevice.connect).toHaveBeenCalledTimes(1);
    expect(result).toBe(reDiscoveredDevice);
  });

  it('throws "dying peer" error after re-discovery also yields stale RSSI (one-shot defense)', async () => {
    // Both initial and re-discovered devices return 127.
    const initialDevice = makeDevice(() => 127);
    const reDiscoveredDevice = makeDevice(() => 127);
    const btAdapter = makeAdapter(reDiscoveredDevice);

    await expect(
      _internals.connectWithRecovery({
        btAdapter: btAdapter as never,
        mac: 'AA:BB:CC:DD:EE:FF',
        initialDevice: initialDevice as never,
        maxRetries: 0,
      }),
    ).rejects.toThrow(/Skipped connect to dying peer/);

    // connect() never called on either device.
    expect(initialDevice.connect).not.toHaveBeenCalled();
    expect(reDiscoveredDevice.connect).not.toHaveBeenCalled();
  });

  it('connects directly when RSSI is fresh on first check (no re-discovery)', async () => {
    const initialDevice = makeDevice(() => -62);
    const reDiscoveredDevice = makeDevice(() => -55);
    const btAdapter = makeAdapter(reDiscoveredDevice);

    const result = await _internals.connectWithRecovery({
      btAdapter: btAdapter as never,
      mac: 'AA:BB:CC:DD:EE:FF',
      initialDevice: initialDevice as never,
      maxRetries: 0,
    });

    // No re-discovery triggered.
    expect(btAdapter.waitDevice).not.toHaveBeenCalled();
    expect(initialDevice.connect).toHaveBeenCalledTimes(1);
    expect(result).toBe(initialDevice);
  });

  it('connects directly when RSSI prop is undefined but tracker is freshly created (#167 regression guard)', async () => {
    // Reproduces the fromport ES-26M fixture: BlueZ drops the Optional RSSI
    // prop after the upstream StopDiscovery, but the peer is alive. The
    // freshness tracker is constructed after waitDevice resolved, so
    // lastRssiUpdateTs is fresh; isFresh() must trust the time window over
    // the absent prop. No re-discovery, connect goes through on first attempt.
    const initialDevice = makeDevice(() => undefined);
    const reDiscoveredDevice = makeDevice(() => -55);
    const btAdapter = makeAdapter(reDiscoveredDevice);

    const result = await _internals.connectWithRecovery({
      btAdapter: btAdapter as never,
      mac: 'FF:04:00:14:AC:0F',
      initialDevice: initialDevice as never,
      maxRetries: 0,
    });

    expect(btAdapter.waitDevice).not.toHaveBeenCalled();
    expect(initialDevice.connect).toHaveBeenCalledTimes(1);
    expect(result).toBe(initialDevice);
  });
});
