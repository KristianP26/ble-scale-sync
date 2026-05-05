import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type {
  ScaleAdapter,
  ScaleReading,
  BleDeviceInfo,
  BodyComposition,
} from '../../src/interfaces/scale-adapter.js';

// Suppress log output during tests
vi.spyOn(console, 'log').mockImplementation(() => {});
vi.spyOn(console, 'warn').mockImplementation(() => {});
vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

// ─── Mock @abandonware/noble before importing the handler ────────────────────

class MockNoble extends EventEmitter {
  _state = 'poweredOn';
  state = 'poweredOn';
  startScanningAsync = vi.fn(async () => {});
  stopScanningAsync = vi.fn(async () => {});
}

const mockNoble = new MockNoble();

vi.mock('@abandonware/noble', () => ({
  default: mockNoble,
}));

const { _internals } = await import('../../src/ble/handler-noble-legacy.js');
const { IMPEDANCE_GRACE_MS } = await import('../../src/ble/types.js');

// ─── Test helpers ────────────────────────────────────────────────────────────

interface FakePeripheral {
  id: string;
  address: string;
  advertisement: {
    localName?: string;
    serviceUuids?: string[];
    manufacturerData?: Buffer;
    serviceData?: Array<{ uuid: string; data: Buffer }>;
  };
}

function makePeripheral(serviceData: Array<{ uuid: string; data: Buffer }>): FakePeripheral {
  return {
    id: 'peer-id',
    address: 'aa:bb:cc:dd:ee:ff',
    advertisement: { serviceData },
  };
}

function makePassiveAdapter(
  mode: 'complete' | 'partial-then-complete' | 'always-partial',
): ScaleAdapter {
  let frameIdx = 0;
  return {
    name: 'MockPassive',
    preferPassive: true,
    matches: vi.fn((info: BleDeviceInfo) => Array.isArray(info.serviceData)),
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

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('handler-noble-legacy broadcastScan grace timer (#163)', () => {
  beforeEach(() => {
    mockNoble.removeAllListeners();
    mockNoble.startScanningAsync.mockClear();
    mockNoble.stopScanningAsync.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('complete-immediately: resolves on the first complete frame, no timer', async () => {
    const adapter = makePassiveAdapter('complete');
    const target = makePeripheral([
      { uuid: '0x181b', data: Buffer.from([0x01, 0x02, 0x03, 0x04]) },
    ]);

    const promise = _internals.broadcastScan(adapter, target as never, {});
    await new Promise((r) => setImmediate(r));
    mockNoble.emit('discover', target);

    const result = await promise;
    expect(result.reading.impedance).toBe(500);
    expect(adapter.parseServiceData).toHaveBeenCalledTimes(1);
  });

  it('partial-then-complete: cancels the grace timer when complete frame arrives', async () => {
    const adapter = makePassiveAdapter('partial-then-complete');
    const target = makePeripheral([
      { uuid: '0x181b', data: Buffer.from([0x01, 0x02, 0x03, 0x04]) },
    ]);

    const promise = _internals.broadcastScan(adapter, target as never, {});
    await new Promise((r) => setImmediate(r));
    mockNoble.emit('discover', target);
    mockNoble.emit('discover', target);

    const result = await promise;
    expect(result.reading.impedance).toBe(500);
    expect(adapter.parseServiceData).toHaveBeenCalledTimes(2);
  });

  it('partial-then-timeout: emits weight-only fallback after IMPEDANCE_GRACE_MS', async () => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    });
    const adapter = makePassiveAdapter('always-partial');
    const target = makePeripheral([
      { uuid: '0x181b', data: Buffer.from([0x01, 0x02, 0x03, 0x04]) },
    ]);

    const promise = _internals.broadcastScan(adapter, target as never, {});
    await new Promise((r) => setImmediate(r));
    mockNoble.emit('discover', target);

    await vi.advanceTimersByTimeAsync(IMPEDANCE_GRACE_MS + 100);

    const result = await promise;
    expect(result.reading.weight).toBe(70.0);
    expect(result.reading.impedance).toBe(0);
  });
});
