import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type {
  ScaleAdapter,
  ScaleReading,
  BleDeviceInfo,
  BodyComposition,
} from '../../src/interfaces/scale-adapter.js';

// Suppress log output during tests.
vi.spyOn(console, 'log').mockImplementation(() => {});
vi.spyOn(console, 'warn').mockImplementation(() => {});
vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

// Mock dbus-next so the dynamic import inside broadcastScanNodeBle does not
// require the real native module on the test host.
vi.mock('dbus-next', () => ({
  Variant: class {
    constructor(
      public signature: string,
      public value: unknown,
    ) {}
  },
  // Minimal surface for the pairing agent module (#168); not exercised here.
  interface: {
    Interface: class {
      constructor(_name?: string) {}
      static configureMembers(): void {}
    },
    ACCESS_READWRITE: 'readwrite',
  },
  DBusError: class extends Error {},
}));

// Mock node-ble (only handler-node-ble's surface is used in this file).
vi.mock('node-ble', () => ({
  default: {
    createBluetooth: vi.fn(),
  },
}));

const { _internals } = await import('../../src/ble/handler-node-ble/index.js');
const { IMPEDANCE_GRACE_MS } = await import('../../src/ble/types.js');

// ─── Mocks ───────────────────────────────────────────────────────────────────

interface MockHelper extends EventEmitter {
  prop: ReturnType<typeof vi.fn>;
  callMethod: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  object: string;
}

function makeHelper(): MockHelper {
  const ee = new EventEmitter() as MockHelper;
  // ServiceData polling falls through with `undefined` so it does not
  // accidentally produce readings outside of PropertiesChanged emissions.
  ee.prop = vi.fn(async () => undefined);
  ee.callMethod = vi.fn(async () => undefined);
  ee.set = vi.fn(async () => undefined);
  ee.object = '/org/bluez/hci0/dev_AA_BB_CC_DD_EE_FF';
  return ee;
}

interface MockDevice {
  helper: MockHelper;
}

interface MockAdapter {
  helper: MockHelper;
}

function makeDevice(): MockDevice {
  return { helper: makeHelper() };
}

function makeAdapter(): MockAdapter {
  return { helper: makeHelper() };
}

function makePassiveAdapter(
  mode: 'complete' | 'partial-then-complete' | 'always-partial',
): ScaleAdapter {
  let frameIdx = 0;
  return {
    name: 'MockPassive',
    preferPassive: true,
    matches: vi.fn((_info: BleDeviceInfo) => true),
    parseServiceData: vi.fn((_uuid: string, _data: Buffer): ScaleReading | null => {
      const i = frameIdx++;
      switch (mode) {
        case 'complete':
          return { weight: 70.0, impedance: 500 };
        case 'partial-then-complete':
          return i === 0 ? { weight: 70.0, impedance: 0 } : { weight: 70.0, impedance: 500 };
        case 'always-partial':
          return { weight: 70.0, impedance: 0 };
      }
    }) as ScaleAdapter['parseServiceData'],
    isComplete: (r: ScaleReading): boolean => r.weight > 0 && r.impedance > 0,
    computeMetrics: (_r: ScaleReading): BodyComposition => ({ weight: 70.0, impedance: 500 }),
    parseNotification: () => null,
    charNotifyUuid: undefined as unknown as string,
    charWriteUuid: undefined as unknown as string,
    unlockCommand: [],
    unlockIntervalMs: 0,
  } as unknown as ScaleAdapter;
}

/**
 * Service-data record matching the BlueZ `Device1.ServiceData` shape:
 * a record keyed by UUID where each entry is a Variant-wrapped Buffer of
 * the advertisement payload bytes.
 */
function serviceDataPayload(): Record<string, { value: Buffer }> {
  return {
    '0000181b-0000-1000-8000-00805f9b34fb': { value: Buffer.from([0x01, 0x02, 0x03, 0x04]) },
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('handler-node-ble broadcastScanNodeBle grace timer (#163 follow-up)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('complete-immediately: resolves on the first complete frame, no timer', async () => {
    const adapter = makePassiveAdapter('complete');
    const device = makeDevice();
    const btAdapter = makeAdapter();

    const promise = _internals.broadcastScanNodeBle(
      adapter,
      btAdapter as never,
      device as never,
      'AA:BB:CC:DD:EE:FF',
      {},
    );

    // broadcastScanNodeBle awaits getDbusNext() (an uncached dynamic
    // import('dbus-next') on the FIRST test) plus a callMethod before it
    // attaches the PropertiesChanged listener, so a fixed setImmediate flush
    // is race-prone. Wait deterministically until the listener is registered
    // (the mock ServiceData poll returns undefined, so the emitted advert is
    // the only path to a reading here).
    await vi.waitUntil(() => device.helper.listenerCount('PropertiesChanged') > 0, {
      timeout: 2000,
      interval: 10,
    });
    device.helper.emit('PropertiesChanged', { ServiceData: serviceDataPayload() });

    const result = await promise;
    expect(result.reading.impedance).toBe(500);
    expect(adapter.parseServiceData).toHaveBeenCalledTimes(1);
  });

  it('partial-then-complete: cancels the grace timer when complete frame arrives', async () => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    });
    const adapter = makePassiveAdapter('partial-then-complete');
    const device = makeDevice();
    const btAdapter = makeAdapter();

    const promise = _internals.broadcastScanNodeBle(
      adapter,
      btAdapter as never,
      device as never,
      'AA:BB:CC:DD:EE:FF',
      {},
    );

    // Two setImmediate flushes so the polling IIFE definitely reaches its
    // first `await sleep(500)` and registers the timer in the fake timer
    // queue. With a single flush the polling timer might not exist yet,
    // making the captured baselineTimers race-prone.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    // Polling loop also schedules timers (sleep(500)), so capture baseline first
    // and assert "increased by 1" after the partial frame to isolate the grace
    // timer from the polling/sleep timers.
    const baselineTimers = vi.getTimerCount();
    device.helper.emit('PropertiesChanged', { ServiceData: serviceDataPayload() });
    expect(vi.getTimerCount()).toBe(baselineTimers + 1);
    device.helper.emit('PropertiesChanged', { ServiceData: serviceDataPayload() });
    // Headline check: grace timer was clearTimeout'd inside cleanup() on
    // resolve. Polling sleep is still pending until its 500 ms elapses, so
    // assert "back to baseline" rather than zero.
    expect(vi.getTimerCount()).toBe(baselineTimers);

    const result = await promise;
    expect(result.reading.impedance).toBe(500);
    expect(adapter.parseServiceData).toHaveBeenCalledTimes(2);
  });

  it('partial-then-timeout: emits weight-only fallback after IMPEDANCE_GRACE_MS', async () => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    });
    const adapter = makePassiveAdapter('always-partial');
    const device = makeDevice();
    const btAdapter = makeAdapter();

    const promise = _internals.broadcastScanNodeBle(
      adapter,
      btAdapter as never,
      device as never,
      'AA:BB:CC:DD:EE:FF',
      {},
    );

    await new Promise((r) => setImmediate(r));
    device.helper.emit('PropertiesChanged', { ServiceData: serviceDataPayload() });

    await vi.advanceTimersByTimeAsync(IMPEDANCE_GRACE_MS + 100);

    const result = await promise;
    expect(result.reading.weight).toBe(70.0);
    expect(result.reading.impedance).toBe(0);
  });
});

// ─── Manufacturer-data broadcast path (#297) ─────────────────────────────────

/**
 * A broadcast adapter that reads manufacturer data instead of service data.
 * Before #297 the node-ble passive path only ever looked at ServiceData, so an
 * adapter shaped like this worked on Noble and read nothing on Linux.
 */
function makeMfgAdapter(): ScaleAdapter {
  return {
    name: 'MockBroadcast',
    preferPassive: true,
    matches: vi.fn((_info: BleDeviceInfo) => true),
    parseBroadcast: vi.fn((data: Buffer): ScaleReading | null =>
      data.length === 4 ? { weight: 91.22, impedance: 0 } : null,
    ) as ScaleAdapter['parseBroadcast'],
    isComplete: (r: ScaleReading): boolean => r.weight > 0,
    computeMetrics: (_r: ScaleReading): BodyComposition => ({ weight: 91.22, impedance: 0 }),
    parseNotification: () => null,
    charNotifyUuid: undefined as unknown as string,
    charWriteUuid: undefined as unknown as string,
    unlockCommand: [],
    unlockIntervalMs: 0,
  } as unknown as ScaleAdapter;
}

/** BlueZ `Device1.ManufacturerData`: keyed by company id, Variant-wrapped bytes. */
function manufacturerPayload(): Record<string, { value: Buffer }> {
  return { '41132': { value: Buffer.from([0x01, 0x02, 0x03, 0x04]) } };
}

describe('handler-node-ble broadcastScanNodeBle manufacturer data (#297)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves from a ManufacturerData PropertiesChanged signal', async () => {
    const adapter = makeMfgAdapter();
    const device = makeDevice();
    const btAdapter = makeAdapter();

    const promise = _internals.broadcastScanNodeBle(
      adapter,
      btAdapter as never,
      device as never,
      'AA:BB:CC:DD:EE:FF',
      {},
    );

    await vi.waitUntil(() => device.helper.listenerCount('PropertiesChanged') > 0, {
      timeout: 2000,
      interval: 10,
    });
    device.helper.emit('PropertiesChanged', { ManufacturerData: manufacturerPayload() });

    const result = await promise;
    expect(result.reading.weight).toBe(91.22);
    expect(adapter.parseBroadcast).toHaveBeenCalledTimes(1);
  });

  it('resolves from the ManufacturerData poll fallback when no signal arrives', async () => {
    // The poll is the path that carries a device whose PropertiesChanged
    // subscription failed, which is why it has to read both properties too.
    const adapter = makeMfgAdapter();
    const device = makeDevice();
    const btAdapter = makeAdapter();
    device.helper.prop = vi.fn(async (name: string) =>
      name === 'ManufacturerData' ? manufacturerPayload() : undefined,
    );

    const result = await _internals.broadcastScanNodeBle(
      adapter,
      btAdapter as never,
      device as never,
      'AA:BB:CC:DD:EE:FF',
      {},
    );

    expect(result.reading.weight).toBe(91.22);
    expect(device.helper.prop).toHaveBeenCalledWith('ManufacturerData');
  });

  it('does not read ServiceData for an adapter that only parses manufacturer data', async () => {
    const adapter = makeMfgAdapter();
    const device = makeDevice();
    const btAdapter = makeAdapter();
    device.helper.prop = vi.fn(async (name: string) =>
      name === 'ManufacturerData' ? manufacturerPayload() : undefined,
    );

    await _internals.broadcastScanNodeBle(
      adapter,
      btAdapter as never,
      device as never,
      'AA:BB:CC:DD:EE:FF',
      {},
    );

    expect(device.helper.prop).not.toHaveBeenCalledWith('ServiceData');
  });
});
