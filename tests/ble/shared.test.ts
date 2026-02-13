import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { waitForReading, waitForRawReading } from '../../src/ble/shared.js';
import type { BleChar, BleDevice } from '../../src/ble/shared.js';
import { normalizeUuid } from '../../src/ble/types.js';
import type {
  ScaleAdapter,
  ScaleReading,
  BodyComposition,
  UserProfile,
  BleDeviceInfo,
  ConnectionContext,
} from '../../src/interfaces/scale-adapter.js';

// Suppress log output during tests
vi.spyOn(console, 'log').mockImplementation(() => {});
vi.spyOn(console, 'error').mockImplementation(() => {});
vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── Test helpers ────────────────────────────────────────────────────────────

const PROFILE: UserProfile = { height: 180, age: 30, gender: 'male', isAthlete: false };

const SAMPLE_BODY_COMP: BodyComposition = {
  weight: 75.5,
  impedance: 500,
  bmi: 23.3,
  bodyFatPercent: 18.2,
  waterPercent: 55.1,
  boneMass: 3.1,
  muscleMass: 58.4,
  visceralFat: 5,
  physiqueRating: 5,
  bmr: 1650,
  metabolicAge: 28,
};

const NOTIFY_UUID = '0000fff100001000800000805f9b34fb';
const WRITE_UUID = '0000fff200001000800000805f9b34fb';

interface MockBleChar extends BleChar {
  triggerData(data: Buffer): void;
  subscribeCalled: boolean;
  writtenData: Buffer[];
}

function createMockChar(): MockBleChar {
  let onDataCallback: ((data: Buffer) => void) | null = null;
  const char: MockBleChar = {
    subscribeCalled: false,
    writtenData: [],
    subscribe: vi.fn(async (onData) => {
      char.subscribeCalled = true;
      onDataCallback = onData;
      return () => {
        onDataCallback = null;
      };
    }),
    write: vi.fn(async (data) => {
      char.writtenData.push(data);
    }),
    read: vi.fn(async () => Buffer.alloc(0)),
    triggerData: (data: Buffer) => {
      if (onDataCallback) onDataCallback(data);
    },
  };
  return char;
}

function createMockDevice(): BleDevice & { triggerDisconnect: () => void } {
  let disconnectCallback: (() => void) | null = null;
  return {
    onDisconnect: (callback) => {
      disconnectCallback = callback;
    },
    triggerDisconnect: () => {
      if (disconnectCallback) disconnectCallback();
    },
  };
}

function createCharMap(entries: [string, MockBleChar][]): {
  charMap: Map<string, BleChar>;
  chars: Map<string, MockBleChar>;
} {
  const charMap = new Map<string, BleChar>();
  const chars = new Map<string, MockBleChar>();
  for (const [uuid, char] of entries) {
    const normalized = normalizeUuid(uuid);
    charMap.set(normalized, char);
    chars.set(normalized, char);
  }
  return { charMap, chars };
}

/**
 * Create a minimal legacy-mode adapter (no onConnected, no characteristics).
 * Uses charNotifyUuid + charWriteUuid + unlockCommand.
 */
function createLegacyAdapter(overrides: Partial<ScaleAdapter> = {}): ScaleAdapter {
  return {
    name: 'TestScale',
    charNotifyUuid: NOTIFY_UUID,
    charWriteUuid: WRITE_UUID,
    unlockCommand: [0x13, 0x09],
    unlockIntervalMs: 2000,
    normalizesWeight: true,
    matches: (_info: BleDeviceInfo) => true,
    parseNotification: vi.fn((_data: Buffer): ScaleReading | null => null),
    isComplete: vi.fn((reading: ScaleReading) => reading.weight > 10 && reading.impedance > 200),
    computeMetrics: vi.fn((_reading: ScaleReading, _profile: UserProfile) => SAMPLE_BODY_COMP),
    ...overrides,
  };
}

// ─── Legacy mode tests ──────────────────────────────────────────────────────

describe('waitForReading() — legacy mode', () => {
  it('resolves with body composition on complete reading', async () => {
    const notifyChar = createMockChar();
    const writeChar = createMockChar();
    const device = createMockDevice();
    const { charMap } = createCharMap([
      [NOTIFY_UUID, notifyChar],
      [WRITE_UUID, writeChar],
    ]);

    const adapter = createLegacyAdapter({
      parseNotification: vi.fn((data: Buffer) => {
        if (data[0] === 0x10) {
          return { weight: 75.5, impedance: 500 };
        }
        return null;
      }),
    });

    const promise = waitForReading(charMap, device, adapter, PROFILE);

    // Wait for subscription to be set up
    await vi.waitFor(() => expect(notifyChar.subscribeCalled).toBe(true));

    // Simulate a complete notification
    notifyChar.triggerData(Buffer.from([0x10]));

    const result = await promise;
    expect(result).toEqual(SAMPLE_BODY_COMP);
    expect(adapter.computeMetrics).toHaveBeenCalledWith({ weight: 75.5, impedance: 500 }, PROFILE);
  });

  it('ignores null readings from parseNotification', async () => {
    const notifyChar = createMockChar();
    const writeChar = createMockChar();
    const device = createMockDevice();
    const { charMap } = createCharMap([
      [NOTIFY_UUID, notifyChar],
      [WRITE_UUID, writeChar],
    ]);

    const callCount = { n: 0 };
    const adapter = createLegacyAdapter({
      parseNotification: vi.fn((_data: Buffer) => {
        callCount.n++;
        if (callCount.n >= 3) return { weight: 80, impedance: 600 };
        return null;
      }),
    });

    const promise = waitForReading(charMap, device, adapter, PROFILE);
    await vi.waitFor(() => expect(notifyChar.subscribeCalled).toBe(true));

    // First two notifications return null — ignored
    notifyChar.triggerData(Buffer.from([0x01]));
    notifyChar.triggerData(Buffer.from([0x02]));

    // Third notification returns a complete reading
    notifyChar.triggerData(Buffer.from([0x03]));

    const result = await promise;
    expect(result).toEqual(SAMPLE_BODY_COMP);
    expect(adapter.parseNotification).toHaveBeenCalledTimes(3);
  });

  it('waits for isComplete to return true', async () => {
    const notifyChar = createMockChar();
    const writeChar = createMockChar();
    const device = createMockDevice();
    const { charMap } = createCharMap([
      [NOTIFY_UUID, notifyChar],
      [WRITE_UUID, writeChar],
    ]);

    const adapter = createLegacyAdapter({
      parseNotification: vi.fn(() => ({ weight: 5, impedance: 0 })),
      // isComplete requires weight > 10 AND impedance > 200
    });

    const promise = waitForReading(charMap, device, adapter, PROFILE);
    await vi.waitFor(() => expect(notifyChar.subscribeCalled).toBe(true));

    // Incomplete reading — weight too low
    notifyChar.triggerData(Buffer.from([0x01]));

    // Override parseNotification to return complete reading
    vi.mocked(adapter.parseNotification).mockReturnValueOnce({ weight: 75, impedance: 500 });
    notifyChar.triggerData(Buffer.from([0x02]));

    await expect(promise).resolves.toEqual(SAMPLE_BODY_COMP);
  });

  it('sends unlock command to write characteristic', async () => {
    const notifyChar = createMockChar();
    const writeChar = createMockChar();
    const device = createMockDevice();
    const { charMap } = createCharMap([
      [NOTIFY_UUID, notifyChar],
      [WRITE_UUID, writeChar],
    ]);

    const adapter = createLegacyAdapter({
      unlockCommand: [0x13, 0x09, 0x00],
      parseNotification: vi.fn(() => ({ weight: 75, impedance: 500 })),
    });

    const promise = waitForReading(charMap, device, adapter, PROFILE);
    await vi.waitFor(() => expect(notifyChar.subscribeCalled).toBe(true));

    // Unlock command should have been sent
    await vi.waitFor(() => expect(writeChar.writtenData.length).toBeGreaterThanOrEqual(1));
    expect(writeChar.writtenData[0]).toEqual(Buffer.from([0x13, 0x09, 0x00]));

    notifyChar.triggerData(Buffer.from([0x01]));
    await promise;
  });

  it('calls onLiveData callback for each valid reading', async () => {
    const notifyChar = createMockChar();
    const writeChar = createMockChar();
    const device = createMockDevice();
    const { charMap } = createCharMap([
      [NOTIFY_UUID, notifyChar],
      [WRITE_UUID, writeChar],
    ]);

    const onLiveData = vi.fn();
    let callN = 0;
    const adapter = createLegacyAdapter({
      parseNotification: vi.fn(() => {
        callN++;
        if (callN === 1) return { weight: 5, impedance: 0 };
        return { weight: 75, impedance: 500 };
      }),
    });

    const promise = waitForReading(charMap, device, adapter, PROFILE, undefined, onLiveData);
    await vi.waitFor(() => expect(notifyChar.subscribeCalled).toBe(true));

    notifyChar.triggerData(Buffer.from([0x01])); // incomplete
    notifyChar.triggerData(Buffer.from([0x02])); // complete

    await promise;
    expect(onLiveData).toHaveBeenCalledTimes(2);
    expect(onLiveData).toHaveBeenCalledWith({ weight: 5, impedance: 0 });
    expect(onLiveData).toHaveBeenCalledWith({ weight: 75, impedance: 500 });
  });

  it('rejects on unexpected disconnect', async () => {
    const notifyChar = createMockChar();
    const writeChar = createMockChar();
    const device = createMockDevice();
    const { charMap } = createCharMap([
      [NOTIFY_UUID, notifyChar],
      [WRITE_UUID, writeChar],
    ]);

    const adapter = createLegacyAdapter();

    const promise = waitForReading(charMap, device, adapter, PROFILE);
    await vi.waitFor(() => expect(notifyChar.subscribeCalled).toBe(true));

    device.triggerDisconnect();

    await expect(promise).rejects.toThrow('Scale disconnected before reading completed');
  });

  it('rejects when required notify characteristic is missing', async () => {
    const writeChar = createMockChar();
    const device = createMockDevice();
    // Only write char — no notify char
    const { charMap } = createCharMap([[WRITE_UUID, writeChar]]);

    const adapter = createLegacyAdapter();

    await expect(waitForReading(charMap, device, adapter, PROFILE)).rejects.toThrow(
      'Required characteristics not found',
    );
  });

  it('rejects when required write characteristic is missing', async () => {
    const notifyChar = createMockChar();
    const device = createMockDevice();
    // Only notify char — no write char
    const { charMap } = createCharMap([[NOTIFY_UUID, notifyChar]]);

    const adapter = createLegacyAdapter();

    await expect(waitForReading(charMap, device, adapter, PROFILE)).rejects.toThrow(
      'Required characteristics not found',
    );
  });

  it('uses alt UUIDs when primary characteristics are missing', async () => {
    const altNotifyChar = createMockChar();
    const altWriteChar = createMockChar();
    const device = createMockDevice();

    const ALT_NOTIFY = '0000ffe100001000800000805f9b34fb';
    const ALT_WRITE = '0000ffe300001000800000805f9b34fb';

    const { charMap } = createCharMap([
      [ALT_NOTIFY, altNotifyChar],
      [ALT_WRITE, altWriteChar],
    ]);

    const adapter = createLegacyAdapter({
      altCharNotifyUuid: ALT_NOTIFY,
      altCharWriteUuid: ALT_WRITE,
      parseNotification: vi.fn(() => ({ weight: 75, impedance: 500 })),
    });

    const promise = waitForReading(charMap, device, adapter, PROFILE);
    await vi.waitFor(() => expect(altNotifyChar.subscribeCalled).toBe(true));

    altNotifyChar.triggerData(Buffer.from([0x01]));
    await expect(promise).resolves.toEqual(SAMPLE_BODY_COMP);
  });

  it('rejects when computeMetrics throws', async () => {
    const notifyChar = createMockChar();
    const writeChar = createMockChar();
    const device = createMockDevice();
    const { charMap } = createCharMap([
      [NOTIFY_UUID, notifyChar],
      [WRITE_UUID, writeChar],
    ]);

    const adapter = createLegacyAdapter({
      parseNotification: vi.fn(() => ({ weight: 75, impedance: 500 })),
      computeMetrics: vi.fn(() => {
        throw new Error('Division by zero');
      }),
    });

    const promise = waitForReading(charMap, device, adapter, PROFILE);
    await vi.waitFor(() => expect(notifyChar.subscribeCalled).toBe(true));

    notifyChar.triggerData(Buffer.from([0x01]));
    await expect(promise).rejects.toThrow('Division by zero');
  });
});

// ─── onConnected mode tests ─────────────────────────────────────────────────

describe('waitForReading() — onConnected mode', () => {
  it('calls adapter.onConnected with ConnectionContext', async () => {
    const notifyChar = createMockChar();
    const writeChar = createMockChar();
    const device = createMockDevice();
    const { charMap } = createCharMap([
      [NOTIFY_UUID, notifyChar],
      [WRITE_UUID, writeChar],
    ]);

    const onConnected = vi.fn(async (ctx: ConnectionContext) => {
      // Subscribe to notify char via context
      await ctx.subscribe(NOTIFY_UUID);
    });

    const adapter = createLegacyAdapter({
      characteristics: [
        { uuid: NOTIFY_UUID, type: 'notify' },
        { uuid: WRITE_UUID, type: 'write' },
      ],
      onConnected,
      parseNotification: vi.fn(() => ({ weight: 75, impedance: 500 })),
    });

    const promise = waitForReading(charMap, device, adapter, PROFILE);
    await vi.waitFor(() => expect(onConnected).toHaveBeenCalled());

    // Trigger data through the subscription set up by characteristics bindings
    notifyChar.triggerData(Buffer.from([0x01]));

    await expect(promise).resolves.toEqual(SAMPLE_BODY_COMP);
  });

  it('ConnectionContext.write sends data to the correct characteristic', async () => {
    const notifyChar = createMockChar();
    const writeChar = createMockChar();
    const device = createMockDevice();
    const { charMap } = createCharMap([
      [NOTIFY_UUID, notifyChar],
      [WRITE_UUID, writeChar],
    ]);

    const onConnected = vi.fn(async (ctx: ConnectionContext) => {
      await ctx.write(WRITE_UUID, Buffer.from([0xab, 0xcd]));
      await ctx.subscribe(NOTIFY_UUID);
    });

    const adapter = createLegacyAdapter({
      characteristics: [
        { uuid: NOTIFY_UUID, type: 'notify' },
        { uuid: WRITE_UUID, type: 'write' },
      ],
      onConnected,
      parseNotification: vi.fn(() => ({ weight: 75, impedance: 500 })),
    });

    const promise = waitForReading(charMap, device, adapter, PROFILE);
    await vi.waitFor(() => expect(writeChar.writtenData.length).toBeGreaterThanOrEqual(1));
    expect(writeChar.writtenData[0]).toEqual(Buffer.from([0xab, 0xcd]));

    notifyChar.triggerData(Buffer.from([0x01]));
    await promise;
  });

  it('ConnectionContext.write accepts number[] arrays', async () => {
    const notifyChar = createMockChar();
    const writeChar = createMockChar();
    const device = createMockDevice();
    const { charMap } = createCharMap([
      [NOTIFY_UUID, notifyChar],
      [WRITE_UUID, writeChar],
    ]);

    const onConnected = vi.fn(async (ctx: ConnectionContext) => {
      await ctx.write(WRITE_UUID, [0x01, 0x02, 0x03]);
      await ctx.subscribe(NOTIFY_UUID);
    });

    const adapter = createLegacyAdapter({
      characteristics: [
        { uuid: NOTIFY_UUID, type: 'notify' },
        { uuid: WRITE_UUID, type: 'write' },
      ],
      onConnected,
      parseNotification: vi.fn(() => ({ weight: 75, impedance: 500 })),
    });

    const promise = waitForReading(charMap, device, adapter, PROFILE);
    await vi.waitFor(() => expect(writeChar.writtenData.length).toBeGreaterThanOrEqual(1));
    expect(writeChar.writtenData[0]).toEqual(Buffer.from([0x01, 0x02, 0x03]));

    notifyChar.triggerData(Buffer.from([0x01]));
    await promise;
  });
});

// ─── Multi-char mode tests ──────────────────────────────────────────────────

describe('waitForReading() — multi-char mode (characteristics[])', () => {
  it('subscribes to all notify bindings', async () => {
    const char1 = createMockChar();
    const char2 = createMockChar();
    const writeChar = createMockChar();
    const device = createMockDevice();

    const NOTIFY2_UUID = '0000fff300001000800000805f9b34fb';
    const { charMap } = createCharMap([
      [NOTIFY_UUID, char1],
      [NOTIFY2_UUID, char2],
      [WRITE_UUID, writeChar],
    ]);

    const adapter = createLegacyAdapter({
      characteristics: [
        { uuid: NOTIFY_UUID, type: 'notify' },
        { uuid: NOTIFY2_UUID, type: 'notify' },
        { uuid: WRITE_UUID, type: 'write' },
      ],
      onConnected: vi.fn(),
      parseNotification: vi.fn(() => ({ weight: 75, impedance: 500 })),
    });

    const promise = waitForReading(charMap, device, adapter, PROFILE);
    await vi.waitFor(() => {
      expect(char1.subscribeCalled).toBe(true);
      expect(char2.subscribeCalled).toBe(true);
    });

    // Trigger data from second characteristic
    char2.triggerData(Buffer.from([0x01]));
    await expect(promise).resolves.toEqual(SAMPLE_BODY_COMP);
  });

  it('uses parseCharNotification when defined', async () => {
    const char1 = createMockChar();
    const device = createMockDevice();
    const { charMap } = createCharMap([[NOTIFY_UUID, char1]]);

    const parseCharNotification = vi.fn((charUuid: string, _data: Buffer): ScaleReading | null =>
      charUuid === normalizeUuid(NOTIFY_UUID) ? { weight: 75, impedance: 500 } : null,
    );

    const adapter = createLegacyAdapter({
      characteristics: [{ uuid: NOTIFY_UUID, type: 'notify' }],
      onConnected: vi.fn(),
      parseCharNotification,
    });

    const promise = waitForReading(charMap, device, adapter, PROFILE);
    await vi.waitFor(() => expect(char1.subscribeCalled).toBe(true));

    char1.triggerData(Buffer.from([0x01]));
    await expect(promise).resolves.toEqual(SAMPLE_BODY_COMP);
    expect(parseCharNotification).toHaveBeenCalledWith(
      normalizeUuid(NOTIFY_UUID),
      Buffer.from([0x01]),
    );
  });

  it('rejects when no notify bindings exist', async () => {
    const writeChar = createMockChar();
    const device = createMockDevice();
    const { charMap } = createCharMap([[WRITE_UUID, writeChar]]);

    const adapter = createLegacyAdapter({
      characteristics: [{ uuid: WRITE_UUID, type: 'write' }],
      onConnected: vi.fn(),
    });

    await expect(waitForReading(charMap, device, adapter, PROFILE)).rejects.toThrow(
      'No notify characteristics',
    );
  });
});

// ─── waitForRawReading tests ────────────────────────────────────────────────

describe('waitForRawReading()', () => {
  it('returns raw reading and adapter without calling computeMetrics', async () => {
    const notifyChar = createMockChar();
    const writeChar = createMockChar();
    const device = createMockDevice();
    const { charMap } = createCharMap([
      [NOTIFY_UUID, notifyChar],
      [WRITE_UUID, writeChar],
    ]);

    const adapter = createLegacyAdapter({
      parseNotification: vi.fn(() => ({ weight: 75.5, impedance: 500 })),
    });

    const promise = waitForRawReading(charMap, device, adapter, PROFILE);
    await vi.waitFor(() => expect(notifyChar.subscribeCalled).toBe(true));

    notifyChar.triggerData(Buffer.from([0x01]));

    const result = await promise;
    expect(result.reading).toEqual({ weight: 75.5, impedance: 500 });
    expect(result.adapter).toBe(adapter);
    expect(adapter.computeMetrics).not.toHaveBeenCalled();
  });

  it('applies lbs-to-kg conversion on raw reading', async () => {
    const notifyChar = createMockChar();
    const writeChar = createMockChar();
    const device = createMockDevice();
    const { charMap } = createCharMap([
      [NOTIFY_UUID, notifyChar],
      [WRITE_UUID, writeChar],
    ]);

    const adapter = createLegacyAdapter({
      normalizesWeight: false,
      parseNotification: vi.fn(() => ({ weight: 166.45, impedance: 500 })),
    });

    const promise = waitForRawReading(charMap, device, adapter, PROFILE, 'lbs');
    await vi.waitFor(() => expect(notifyChar.subscribeCalled).toBe(true));

    notifyChar.triggerData(Buffer.from([0x01]));

    const result = await promise;
    expect(result.reading.weight).toBeCloseTo(166.45 * 0.453592, 2);
    expect(adapter.computeMetrics).not.toHaveBeenCalled();
  });

  it('rejects on disconnect before reading completes', async () => {
    const notifyChar = createMockChar();
    const writeChar = createMockChar();
    const device = createMockDevice();
    const { charMap } = createCharMap([
      [NOTIFY_UUID, notifyChar],
      [WRITE_UUID, writeChar],
    ]);

    const adapter = createLegacyAdapter();

    const promise = waitForRawReading(charMap, device, adapter, PROFILE);
    await vi.waitFor(() => expect(notifyChar.subscribeCalled).toBe(true));

    device.triggerDisconnect();

    await expect(promise).rejects.toThrow('Scale disconnected before reading completed');
  });

  it('calls onLiveData callback for each valid reading', async () => {
    const notifyChar = createMockChar();
    const writeChar = createMockChar();
    const device = createMockDevice();
    const { charMap } = createCharMap([
      [NOTIFY_UUID, notifyChar],
      [WRITE_UUID, writeChar],
    ]);

    const onLiveData = vi.fn();
    let callN = 0;
    const adapter = createLegacyAdapter({
      parseNotification: vi.fn(() => {
        callN++;
        if (callN === 1) return { weight: 5, impedance: 0 };
        return { weight: 75, impedance: 500 };
      }),
    });

    const promise = waitForRawReading(charMap, device, adapter, PROFILE, undefined, onLiveData);
    await vi.waitFor(() => expect(notifyChar.subscribeCalled).toBe(true));

    notifyChar.triggerData(Buffer.from([0x01])); // incomplete
    notifyChar.triggerData(Buffer.from([0x02])); // complete

    const result = await promise;
    expect(result.reading).toEqual({ weight: 75, impedance: 500 });
    expect(onLiveData).toHaveBeenCalledTimes(2);
  });
});

// ─── Weight normalization tests ─────────────────────────────────────────────

describe('waitForReading() — weight normalization', () => {
  it('converts lbs to kg when normalizesWeight is false', async () => {
    const notifyChar = createMockChar();
    const writeChar = createMockChar();
    const device = createMockDevice();
    const { charMap } = createCharMap([
      [NOTIFY_UUID, notifyChar],
      [WRITE_UUID, writeChar],
    ]);

    const adapter = createLegacyAdapter({
      normalizesWeight: false,
      parseNotification: vi.fn(() => ({ weight: 166.45, impedance: 500 })),
    });

    const promise = waitForReading(charMap, device, adapter, PROFILE, 'lbs');
    await vi.waitFor(() => expect(notifyChar.subscribeCalled).toBe(true));

    notifyChar.triggerData(Buffer.from([0x01]));

    await promise;
    // Weight should be converted: 166.45 * 0.453592 ≈ 75.50
    const call = vi.mocked(adapter.computeMetrics).mock.calls[0];
    expect(call[0].weight).toBeCloseTo(166.45 * 0.453592, 2);
  });

  it('does NOT convert when normalizesWeight is true', async () => {
    const notifyChar = createMockChar();
    const writeChar = createMockChar();
    const device = createMockDevice();
    const { charMap } = createCharMap([
      [NOTIFY_UUID, notifyChar],
      [WRITE_UUID, writeChar],
    ]);

    const adapter = createLegacyAdapter({
      normalizesWeight: true,
      parseNotification: vi.fn(() => ({ weight: 75.5, impedance: 500 })),
    });

    const promise = waitForReading(charMap, device, adapter, PROFILE, 'lbs');
    await vi.waitFor(() => expect(notifyChar.subscribeCalled).toBe(true));

    notifyChar.triggerData(Buffer.from([0x01]));

    await promise;
    const call = vi.mocked(adapter.computeMetrics).mock.calls[0];
    expect(call[0].weight).toBe(75.5); // unchanged
  });

  it('does NOT convert when weightUnit is kg', async () => {
    const notifyChar = createMockChar();
    const writeChar = createMockChar();
    const device = createMockDevice();
    const { charMap } = createCharMap([
      [NOTIFY_UUID, notifyChar],
      [WRITE_UUID, writeChar],
    ]);

    const adapter = createLegacyAdapter({
      normalizesWeight: false,
      parseNotification: vi.fn(() => ({ weight: 75.5, impedance: 500 })),
    });

    const promise = waitForReading(charMap, device, adapter, PROFILE, 'kg');
    await vi.waitFor(() => expect(notifyChar.subscribeCalled).toBe(true));

    notifyChar.triggerData(Buffer.from([0x01]));

    await promise;
    const call = vi.mocked(adapter.computeMetrics).mock.calls[0];
    expect(call[0].weight).toBe(75.5); // unchanged
  });
});
