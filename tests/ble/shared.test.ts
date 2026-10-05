import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  waitForReading,
  waitForRawReading,
  withAbandonmentCleanup,
  findMissingCharacteristics,
  resolveWriteChar,
  getRawCaptureConfig,
  toHex,
} from '../../src/ble/shared.js';
import { withIdleTimeout } from '../../src/ble/types.js';
import type { BleChar, BleDevice } from '../../src/ble/shared.js';
import { normalizeUuid, bleLog } from '../../src/ble/types.js';
import { KoogeekS1Adapter } from '../../src/scales/koogeek-s1.js';
import { RenphoMsc04Adapter } from '../../src/scales/renpho-msc04.js';
import { BeurerSanitasScaleAdapter } from '../../src/scales/beurer-sanitas.js';
import { mockPeripheral } from '../helpers/scale-test-utils.js';
import { uuid16, xorChecksum, buildPayload } from '../../src/scales/body-comp-helpers.js';
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
  let fired = false;
  const fireDisconnect = (): void => {
    if (fired || !disconnectCallback) return;
    fired = true;
    disconnectCallback();
  };
  return {
    onDisconnect: (callback) => {
      disconnectCallback = callback;
    },
    fireDisconnect,
    triggerDisconnect: fireDisconnect,
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

    const promise = waitForReading(charMap, device, adapter, PROFILE, '');

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

    const promise = waitForReading(charMap, device, adapter, PROFILE, '');
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

    const promise = waitForReading(charMap, device, adapter, PROFILE, '');
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

    const promise = waitForReading(charMap, device, adapter, PROFILE, '');
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

    const promise = waitForReading(charMap, device, adapter, PROFILE, '', undefined, onLiveData);
    await vi.waitFor(() => expect(notifyChar.subscribeCalled).toBe(true));

    notifyChar.triggerData(Buffer.from([0x01])); // incomplete
    notifyChar.triggerData(Buffer.from([0x02])); // complete

    await promise;
    expect(onLiveData).toHaveBeenCalledTimes(2);
    expect(onLiveData).toHaveBeenCalledWith({ weight: 5, impedance: 0 });
    expect(onLiveData).toHaveBeenCalledWith({ weight: 75, impedance: 500 });
  });

  it('sends all unlockCommands when defined', async () => {
    const notifyChar = createMockChar();
    const writeChar = createMockChar();
    const device = createMockDevice();
    const { charMap } = createCharMap([
      [NOTIFY_UUID, notifyChar],
      [WRITE_UUID, writeChar],
    ]);

    const adapter = createLegacyAdapter({
      unlockCommand: [0x13, 0x09],
      unlockCommands: [
        [0x13, 0x09, 0x00, 0x01, 0x01, 0x02],
        [0x13, 0x09, 0x00, 0x01, 0x10, 0x00, 0x00, 0x00, 0x2d],
      ],
      parseNotification: vi.fn(() => ({ weight: 75, impedance: 500 })),
    });

    const promise = waitForReading(charMap, device, adapter, PROFILE, '');
    await vi.waitFor(() => expect(notifyChar.subscribeCalled).toBe(true));

    // Both unlock commands should have been sent
    await vi.waitFor(() => expect(writeChar.writtenData.length).toBeGreaterThanOrEqual(2));
    expect(writeChar.writtenData[0]).toEqual(Buffer.from([0x13, 0x09, 0x00, 0x01, 0x01, 0x02]));
    expect(writeChar.writtenData[1]).toEqual(
      Buffer.from([0x13, 0x09, 0x00, 0x01, 0x10, 0x00, 0x00, 0x00, 0x2d]),
    );

    notifyChar.triggerData(Buffer.from([0x01]));
    await promise;
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

    const promise = waitForReading(charMap, device, adapter, PROFILE, '');
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

    await expect(waitForReading(charMap, device, adapter, PROFILE, '')).rejects.toThrow(
      'Required characteristics not found',
    );
  });

  it('rejects when required write characteristic is missing', async () => {
    const notifyChar = createMockChar();
    const device = createMockDevice();
    // Only notify char — no write char
    const { charMap } = createCharMap([[NOTIFY_UUID, notifyChar]]);

    const adapter = createLegacyAdapter();

    await expect(waitForReading(charMap, device, adapter, PROFILE, '')).rejects.toThrow(
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

    const promise = waitForReading(charMap, device, adapter, PROFILE, '');
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

    const promise = waitForReading(charMap, device, adapter, PROFILE, '');
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

    const promise = waitForReading(charMap, device, adapter, PROFILE, '');
    await vi.waitFor(() => expect(onConnected).toHaveBeenCalled());

    // Trigger data through the subscription set up by characteristics bindings
    notifyChar.triggerData(Buffer.from([0x01]));

    await expect(promise).resolves.toEqual(SAMPLE_BODY_COMP);
  });

  it('hands the advertised device name to onConnected as ConnectionContext.deviceName', async () => {
    const notifyChar = createMockChar();
    const device = createMockDevice();
    const { charMap } = createCharMap([[NOTIFY_UUID, notifyChar]]);
    const seen: Array<string | undefined> = [];
    const adapter = createLegacyAdapter({
      characteristics: [{ uuid: NOTIFY_UUID, type: 'notify' }],
      onConnected: vi.fn(async (ctx: ConnectionContext) => {
        seen.push(ctx.deviceName);
      }),
      parseNotification: vi.fn(() => ({ weight: 75, impedance: 500 })),
    });

    const promise = waitForRawReading(
      charMap,
      device,
      adapter,
      PROFILE,
      '',
      undefined,
      undefined,
      undefined,
      undefined,
      '013197A1',
    );
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    notifyChar.triggerData(Buffer.from([0x01]));
    await promise;
    expect(seen[0]).toBe('013197A1');
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

    const promise = waitForReading(charMap, device, adapter, PROFILE, '');
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

    const promise = waitForReading(charMap, device, adapter, PROFILE, '');
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

    const promise = waitForReading(charMap, device, adapter, PROFILE, '');
    await vi.waitFor(() => {
      expect(char1.subscribeCalled).toBe(true);
      expect(char2.subscribeCalled).toBe(true);
    });

    // Trigger data from second characteristic
    char2.triggerData(Buffer.from([0x01]));
    await expect(promise).resolves.toEqual(SAMPLE_BODY_COMP);
  });

  it('continues when an optional notify binding cannot be subscribed (#229)', async () => {
    // A characteristic being discovered says nothing about it being notifiable:
    // the char map holds every discovered characteristic. A vendor char that is
    // write-only on a sibling model must not fail the whole reading.
    const char1 = createMockChar();
    const optional = createMockChar();
    optional.subscribe = async (): Promise<() => void> => {
      throw new Error('Not permitted');
    };
    const device = createMockDevice();

    const OPTIONAL_UUID = '0000fff200001000800000805f9b34fb';
    const { charMap } = createCharMap([
      [NOTIFY_UUID, char1],
      [OPTIONAL_UUID, optional],
    ]);

    const adapter = createLegacyAdapter({
      characteristics: [
        { uuid: NOTIFY_UUID, type: 'notify' },
        { uuid: OPTIONAL_UUID, type: 'notify', optional: true },
      ],
      onConnected: vi.fn(),
      parseNotification: vi.fn(() => ({ weight: 75, impedance: 500 })),
    });

    const promise = waitForReading(charMap, device, adapter, PROFILE, '');
    await vi.waitFor(() => expect(char1.subscribeCalled).toBe(true));
    char1.triggerData(Buffer.from([0x01]));
    await expect(promise).resolves.toEqual(SAMPLE_BODY_COMP);
  });

  it('still fails when a REQUIRED notify binding cannot be subscribed', async () => {
    const char1 = createMockChar();
    char1.subscribe = async (): Promise<() => void> => {
      throw new Error('Not permitted');
    };
    const device = createMockDevice();
    const { charMap } = createCharMap([[NOTIFY_UUID, char1]]);

    const adapter = createLegacyAdapter({
      characteristics: [{ uuid: NOTIFY_UUID, type: 'notify' }],
      onConnected: vi.fn(),
    });

    await expect(waitForReading(charMap, device, adapter, PROFILE, '')).rejects.toThrow(
      /Failed to enable notifications/,
    );
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

    const promise = waitForReading(charMap, device, adapter, PROFILE, '');
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

    await expect(waitForReading(charMap, device, adapter, PROFILE, '')).rejects.toThrow(
      'No notify characteristics',
    );
  });

  // #168: a CCCD enable that fails (e.g. unbonded BF720 SIG service) must surface
  // the exact characteristic + underlying error, not an opaque disconnect.
  it('names the characteristic when enabling notifications fails', async () => {
    const failingChar = createMockChar();
    failingChar.subscribe = vi.fn(async () => {
      throw new Error('org.bluez.Error.NotAuthorized');
    });
    const device = createMockDevice();
    const { charMap } = createCharMap([[NOTIFY_UUID, failingChar]]);

    const adapter = createLegacyAdapter({
      characteristics: [{ uuid: NOTIFY_UUID, type: 'notify' }],
      onConnected: vi.fn(),
    });

    const promise = waitForReading(charMap, device, adapter, PROFILE, '');
    await expect(promise).rejects.toThrow('Failed to enable notifications on');
    await expect(promise).rejects.toThrow(NOTIFY_UUID);
    await expect(promise).rejects.toThrow('org.bluez.Error.NotAuthorized');
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

    const promise = waitForRawReading(charMap, device, adapter, PROFILE, '');
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

    const promise = waitForRawReading(charMap, device, adapter, PROFILE, '', 'lbs');
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

    const promise = waitForRawReading(charMap, device, adapter, PROFILE, '');
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

    const promise = waitForRawReading(charMap, device, adapter, PROFILE, '', undefined, onLiveData);
    await vi.waitFor(() => expect(notifyChar.subscribeCalled).toBe(true));

    notifyChar.triggerData(Buffer.from([0x01])); // incomplete
    notifyChar.triggerData(Buffer.from([0x02])); // complete

    const result = await promise;
    expect(result.reading).toEqual({ weight: 75, impedance: 500 });
    expect(onLiveData).toHaveBeenCalledTimes(2);
  });
});

// ─── waitForRawReading raw capture mode (#211) ──────────────────────────────

describe('waitForRawReading() — raw capture mode', () => {
  afterEach(() => {
    delete process.env.BLE_RAW_CAPTURE;
    delete process.env.BLE_RAW_CAPTURE_HOLD_SEC;
  });

  // Adapter: 0x58-prefixed frames parse to a complete reading; everything else
  // (e.g. a 0x59 composition frame) parses to null, like the BF710 path.
  const captureAdapter = (): ScaleAdapter =>
    createLegacyAdapter({
      parseNotification: vi.fn((data: Buffer) =>
        data[0] === 0x58 ? { weight: 75, impedance: 0 } : null,
      ),
      isComplete: vi.fn((reading: ScaleReading) => reading.weight > 0),
    });

  it('logs every notify frame as hex, including frames that parse to null', async () => {
    process.env.BLE_RAW_CAPTURE = '1';
    const infoSpy = vi.spyOn(bleLog, 'info');
    const notifyChar = createMockChar();
    const writeChar = createMockChar();
    const device = createMockDevice();
    const { charMap } = createCharMap([
      [NOTIFY_UUID, notifyChar],
      [WRITE_UUID, writeChar],
    ]);
    const adapter = captureAdapter();

    const promise = waitForRawReading(charMap, device, adapter, PROFILE, '');
    await vi.waitFor(() => expect(notifyChar.subscribeCalled).toBe(true));

    notifyChar.triggerData(Buffer.from([0x58, 0x01, 0x0a, 0x0b])); // complete -> starts hold
    notifyChar.triggerData(Buffer.from([0x59, 0x12, 0x34])); // null-parsing 0x59 frame

    const logged = infoSpy.mock.calls.map((c) => c[0]);
    expect(logged.some((m) => m.includes('[RAW]') && m.includes('58 01 0a 0b'))).toBe(true);
    expect(logged.some((m) => m.includes('[RAW]') && m.includes('59 12 34'))).toBe(true);

    device.triggerDisconnect();
    const result = await promise;
    expect(result.reading).toEqual({ weight: 75, impedance: 0 });
  });

  it('does not resolve on isComplete; resolves with the last reading on disconnect', async () => {
    process.env.BLE_RAW_CAPTURE = 'true';
    const notifyChar = createMockChar();
    const writeChar = createMockChar();
    const device = createMockDevice();
    const { charMap } = createCharMap([
      [NOTIFY_UUID, notifyChar],
      [WRITE_UUID, writeChar],
    ]);
    const adapter = captureAdapter();

    const promise = waitForRawReading(charMap, device, adapter, PROFILE, '');
    await vi.waitFor(() => expect(notifyChar.subscribeCalled).toBe(true));

    notifyChar.triggerData(Buffer.from([0x58, 0x01])); // complete, but capture holds

    // Promise must still be pending: race it against a settled sentinel.
    const sentinel = Symbol('pending');
    const raced = await Promise.race([promise, Promise.resolve(sentinel)]);
    expect(raced).toBe(sentinel);

    device.triggerDisconnect();
    const result = await promise;
    expect(result.reading).toEqual({ weight: 75, impedance: 0 });
    expect(result.history).toBeUndefined();
  });

  it('resolves with the last reading when the hold window elapses (no disconnect)', async () => {
    vi.useFakeTimers();
    try {
      process.env.BLE_RAW_CAPTURE = '1';
      process.env.BLE_RAW_CAPTURE_HOLD_SEC = '5';
      const notifyChar = createMockChar();
      const writeChar = createMockChar();
      const device = createMockDevice();
      const { charMap } = createCharMap([
        [NOTIFY_UUID, notifyChar],
        [WRITE_UUID, writeChar],
      ]);
      const adapter = captureAdapter();

      const promise = waitForRawReading(charMap, device, adapter, PROFILE, '');
      await vi.advanceTimersByTimeAsync(0); // flush async subscribe
      expect(notifyChar.subscribeCalled).toBe(true);

      notifyChar.triggerData(Buffer.from([0x58, 0x01])); // complete -> starts 5s hold
      await vi.advanceTimersByTimeAsync(5000); // fire the hold timer

      const result = await promise;
      expect(result.reading).toEqual({ weight: 75, impedance: 0 });
      expect(result.history).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('is off by default: a complete reading resolves immediately', async () => {
    const notifyChar = createMockChar();
    const writeChar = createMockChar();
    const device = createMockDevice();
    const { charMap } = createCharMap([
      [NOTIFY_UUID, notifyChar],
      [WRITE_UUID, writeChar],
    ]);
    const adapter = captureAdapter();

    const promise = waitForRawReading(charMap, device, adapter, PROFILE, '');
    await vi.waitFor(() => expect(notifyChar.subscribeCalled).toBe(true));

    notifyChar.triggerData(Buffer.from([0x58, 0x01]));

    const result = await promise; // resolves without any disconnect
    expect(result.reading).toEqual({ weight: 75, impedance: 0 });
  });
});

// ─── waitForRawReading history collection ───────────────────────────────────

describe('waitForRawReading() history collection', () => {
  it('routes timestamped readings into history and resolves on the live one', async () => {
    const notifyChar = createMockChar();
    const writeChar = createMockChar();
    const device = createMockDevice();
    const { charMap } = createCharMap([
      [NOTIFY_UUID, notifyChar],
      [WRITE_UUID, writeChar],
    ]);

    const t1 = new Date(Date.now() - 7200_000);
    const t2 = new Date(Date.now() - 3600_000);
    const adapter = createLegacyAdapter({
      parseNotification: vi
        .fn()
        .mockReturnValueOnce({ weight: 80, impedance: 480, timestamp: t1 })
        .mockReturnValueOnce({ weight: 81, impedance: 490, timestamp: t2 })
        .mockReturnValueOnce({ weight: 82, impedance: 500 }),
    });

    const promise = waitForRawReading(charMap, device, adapter, PROFILE, '');
    await vi.waitFor(() => expect(notifyChar.subscribeCalled).toBe(true));

    notifyChar.triggerData(Buffer.from([0x01]));
    notifyChar.triggerData(Buffer.from([0x02]));
    notifyChar.triggerData(Buffer.from([0x03]));

    const result = await promise;
    expect(result.reading.weight).toBe(82);
    expect(result.reading.timestamp).toBeUndefined();
    expect(result.history).toHaveLength(2);
    expect(result.history![0].weight).toBe(80);
    expect(result.history![0].timestamp).toBe(t1);
    expect(result.history![1].weight).toBe(81);
    expect(result.history![1].timestamp).toBe(t2);
  });

  it('resolves with last historical as reading on disconnect when no live arrived', async () => {
    const notifyChar = createMockChar();
    const writeChar = createMockChar();
    const device = createMockDevice();
    const { charMap } = createCharMap([
      [NOTIFY_UUID, notifyChar],
      [WRITE_UUID, writeChar],
    ]);

    const t1 = new Date(Date.now() - 7200_000);
    const t2 = new Date(Date.now() - 3600_000);
    const adapter = createLegacyAdapter({
      parseNotification: vi
        .fn()
        .mockReturnValueOnce({ weight: 70, impedance: 480, timestamp: t1 })
        .mockReturnValueOnce({ weight: 71, impedance: 490, timestamp: t2 }),
    });

    const promise = waitForRawReading(charMap, device, adapter, PROFILE, '');
    await vi.waitFor(() => expect(notifyChar.subscribeCalled).toBe(true));

    notifyChar.triggerData(Buffer.from([0x01]));
    notifyChar.triggerData(Buffer.from([0x02]));
    device.triggerDisconnect();

    const result = await promise;
    expect(result.reading.weight).toBe(71);
    expect(result.reading.timestamp).toBe(t2);
    expect(result.history).toHaveLength(1);
    expect(result.history![0].weight).toBe(70);
  });

  it('rejects on disconnect when no readings at all arrived', async () => {
    const notifyChar = createMockChar();
    const writeChar = createMockChar();
    const device = createMockDevice();
    const { charMap } = createCharMap([
      [NOTIFY_UUID, notifyChar],
      [WRITE_UUID, writeChar],
    ]);

    const adapter = createLegacyAdapter({
      parseNotification: vi.fn(() => null),
    });

    const promise = waitForRawReading(charMap, device, adapter, PROFILE, '');
    await vi.waitFor(() => expect(notifyChar.subscribeCalled).toBe(true));

    device.triggerDisconnect();

    await expect(promise).rejects.toThrow('Scale disconnected before reading completed');
  });

  // D027: history is decided by AGE. A scale that stamps its live frames too
  // (the SIG Time Stamp flag) used to have its weigh-in buffered as history,
  // and the session never ended on it: it waited for the scale to disconnect.
  it('ends the session on a live frame the scale stamped seconds ago', async () => {
    const notifyChar = createMockChar();
    const writeChar = createMockChar();
    const device = createMockDevice();
    const { charMap } = createCharMap([
      [NOTIFY_UUID, notifyChar],
      [WRITE_UUID, writeChar],
    ]);

    const stamped = new Date(Date.now() - 20_000);
    const adapter = createLegacyAdapter({
      parseNotification: vi
        .fn()
        .mockReturnValueOnce({ weight: 82, impedance: 500, timestamp: stamped }),
    });

    const promise = waitForRawReading(charMap, device, adapter, PROFILE, '');
    await vi.waitFor(() => expect(notifyChar.subscribeCalled).toBe(true));

    notifyChar.triggerData(Buffer.from([0x01]));

    // No disconnect: the stamped live frame alone must resolve the session.
    const result = await promise;
    expect(result.reading.weight).toBe(82);
    expect(result.reading.timestamp).toBe(stamped);
    expect(result.history).toBeUndefined();
  });

  it('skips an incomplete timestamped reading (does not push to history)', async () => {
    const notifyChar = createMockChar();
    const writeChar = createMockChar();
    const device = createMockDevice();
    const { charMap } = createCharMap([
      [NOTIFY_UUID, notifyChar],
      [WRITE_UUID, writeChar],
    ]);

    const adapter = createLegacyAdapter({
      parseNotification: vi
        .fn()
        // An hour old: a stamp of "now" is a live frame since D027, and this
        // test is about an incomplete STORED record.
        .mockReturnValueOnce({
          weight: 70,
          impedance: 0,
          timestamp: new Date(Date.now() - 3600_000),
        })
        .mockReturnValueOnce({ weight: 82, impedance: 500 }),
    });

    const promise = waitForRawReading(charMap, device, adapter, PROFILE, '');
    await vi.waitFor(() => expect(notifyChar.subscribeCalled).toBe(true));

    notifyChar.triggerData(Buffer.from([0x01]));
    notifyChar.triggerData(Buffer.from([0x02]));

    const result = await promise;
    expect(result.reading.weight).toBe(82);
    expect(result.history).toBeUndefined();
  });

  it('caps history at MAX_HISTORY_FRAMES and warns once when full', async () => {
    // Spy on bleLog.warn directly rather than console.warn: the assertion
    // stays valid even if the logger's output format or sink (timestamps,
    // structured output) changes.
    const warnSpy = vi.spyOn(bleLog, 'warn').mockImplementation(() => {});

    const notifyChar = createMockChar();
    const writeChar = createMockChar();
    const device = createMockDevice();
    const { charMap } = createCharMap([
      [NOTIFY_UUID, notifyChar],
      [WRITE_UUID, writeChar],
    ]);

    const t0 = Date.now() - 1_000_000;
    const readings: ScaleReading[] = [
      ...Array.from({ length: 501 }, (_, i) => ({
        weight: 80 + i * 0.001,
        impedance: 480,
        timestamp: new Date(t0 + i * 1000),
      })),
      { weight: 82, impedance: 500 },
    ];
    const parse = vi.fn<(data: Buffer) => ScaleReading | null>();
    readings.forEach((r) => parse.mockReturnValueOnce(r));

    const adapter = createLegacyAdapter({ parseNotification: parse });

    const promise = waitForRawReading(charMap, device, adapter, PROFILE, '');
    await vi.waitFor(() => expect(notifyChar.subscribeCalled).toBe(true));

    for (let i = 0; i < readings.length; i++) {
      notifyChar.triggerData(Buffer.from([i & 0xff]));
    }

    const result = await promise;
    expect(result.reading.weight).toBe(82);
    expect(result.history).toHaveLength(500);

    const capWarnCalls = warnSpy.mock.calls.filter((args) =>
      String(args[0] ?? '').includes('Cached frame buffer hit 500'),
    );
    expect(capWarnCalls).toHaveLength(1);

    warnSpy.mockRestore();
  });
});

// ─── per-frame ACK + completion hold ────────────────────────────────────────

describe('waitForRawReading() — per-frame ACK + completion hold', () => {
  /** #270: run one notify frame through an ACK adapter and report the write call. */
  async function ackWriteCall(ackWithResponse?: boolean) {
    const notifyChar = createMockChar();
    const writeChar = createMockChar();
    const device = createMockDevice();
    const { charMap } = createCharMap([
      [NOTIFY_UUID, notifyChar],
      [WRITE_UUID, writeChar],
    ]);

    const adapter = createLegacyAdapter({
      buildAck: vi.fn(() => [0x01]),
      parseNotification: vi.fn(() => null),
      ...(ackWithResponse === undefined ? {} : { ackWithResponse }),
    });

    void waitForRawReading(charMap, device, adapter, PROFILE, '');
    await vi.waitFor(() => expect(notifyChar.subscribeCalled).toBe(true));
    notifyChar.triggerData(Buffer.from([0xe7]));
    await vi.waitFor(() => expect(writeChar.write).toHaveBeenCalled());
    return writeChar.write.mock.calls.at(-1);
  }

  it('writes the ACK with a response by default (Beurer/Sanitas behaviour)', async () => {
    expect((await ackWriteCall(undefined))?.[1]).toBe(true);
  });

  it('writes the ACK without a response when the adapter opts out (#270)', async () => {
    expect((await ackWriteCall(false))?.[1]).toBe(false);
  });

  it('writes the buildAck result back for every notify frame', async () => {
    const notifyChar = createMockChar();
    const writeChar = createMockChar();
    const device = createMockDevice();
    const { charMap } = createCharMap([
      [NOTIFY_UUID, notifyChar],
      [WRITE_UUID, writeChar],
    ]);

    const adapter = createLegacyAdapter({
      buildAck: vi.fn((data: Buffer) => [0xe7, 0xf1, data[1]]),
      parseNotification: vi.fn((data: Buffer) =>
        data[0] === 0x99 ? { weight: 75, impedance: 500 } : null,
      ),
    });

    const promise = waitForRawReading(charMap, device, adapter, PROFILE, '');
    await vi.waitFor(() => expect(notifyChar.subscribeCalled).toBe(true));

    // A frame that parseNotification drops must still be ACKed.
    notifyChar.triggerData(Buffer.from([0xe7, 0x59, 0x03]));
    await vi.waitFor(() =>
      expect(writeChar.writtenData.some((b) => b.equals(Buffer.from([0xe7, 0xf1, 0x59])))).toBe(
        true,
      ),
    );

    notifyChar.triggerData(Buffer.from([0x99]));
    await promise;
  });

  it('holds the link open on a non-final complete reading, resolves on the later final one', async () => {
    const notifyChar = createMockChar();
    const writeChar = createMockChar();
    const device = createMockDevice();
    const { charMap } = createCharMap([
      [NOTIFY_UUID, notifyChar],
      [WRITE_UUID, writeChar],
    ]);

    const adapter = createLegacyAdapter({
      completionHoldMs: 15000,
      isComplete: vi.fn((r: ScaleReading) => r.weight > 0),
      isFinal: vi.fn((r: ScaleReading) => r.impedance > 0),
      parseNotification: vi.fn((data: Buffer) =>
        data[0] === 0x02 ? { weight: 83.55, impedance: 437 } : { weight: 83.4, impedance: 0 },
      ),
    });

    const promise = waitForRawReading(charMap, device, adapter, PROFILE, '');
    await vi.waitFor(() => expect(notifyChar.subscribeCalled).toBe(true));

    // Weight-only complete reading: must NOT resolve yet (link held).
    notifyChar.triggerData(Buffer.from([0x01]));
    const pending = await Promise.race([
      promise.then(() => 'resolved'),
      new Promise((r) => setTimeout(() => r('pending'), 50)),
    ]);
    expect(pending).toBe('pending');

    // Composition (final) reading: resolves immediately with impedance.
    notifyChar.triggerData(Buffer.from([0x02]));
    const result = await promise;
    expect(result.reading).toEqual({ weight: 83.55, impedance: 437 });
  });

  it('resolves with the last weight-only reading when the hold window elapses', async () => {
    vi.useFakeTimers();
    try {
      const notifyChar = createMockChar();
      const writeChar = createMockChar();
      const device = createMockDevice();
      const { charMap } = createCharMap([
        [NOTIFY_UUID, notifyChar],
        [WRITE_UUID, writeChar],
      ]);

      const adapter = createLegacyAdapter({
        completionHoldMs: 15000,
        isComplete: vi.fn((r: ScaleReading) => r.weight > 0),
        isFinal: vi.fn((r: ScaleReading) => r.impedance > 0),
        parseNotification: vi.fn(() => ({ weight: 83.4, impedance: 0 })),
      });

      const promise = waitForRawReading(charMap, device, adapter, PROFILE, '');
      // Flush the fire-and-forget subscribe microtask under fake timers
      // (vi.waitFor would not advance the faked clock — known footgun; the
      // documented fix is advanceTimersByTimeAsync, which flushes async timers).
      await vi.advanceTimersByTimeAsync(1);
      expect(notifyChar.subscribeCalled).toBe(true);

      notifyChar.triggerData(Buffer.from([0x01]));
      await vi.advanceTimersByTimeAsync(15000);

      const result = await promise;
      expect(result.reading).toEqual({ weight: 83.4, impedance: 0 });
    } finally {
      vi.useRealTimers();
    }
  });

  // #211: the SBF75's 0x59 stream starts just before the window ends on a slow
  // link. The handler asks the adapter whether a transfer is under way and
  // keeps the link open for the parts that carry the impedance.
  it('keeps holding past the window while the adapter reports a composition pending', async () => {
    vi.useFakeTimers();
    try {
      const notifyChar = createMockChar();
      const writeChar = createMockChar();
      const device = createMockDevice();
      const { charMap } = createCharMap([
        [NOTIFY_UUID, notifyChar],
        [WRITE_UUID, writeChar],
      ]);

      let pending = false;
      const adapter = createLegacyAdapter({
        completionHoldMs: 15000,
        isComplete: vi.fn((r: ScaleReading) => r.weight > 0),
        isFinal: vi.fn((r: ScaleReading) => r.impedance > 0),
        isCompositionPending: () => pending,
        parseNotification: vi.fn((data: Buffer) => {
          if (data[0] === 0x03) {
            pending = true;
            return null;
          }
          return data[0] === 0x02
            ? { weight: 83.55, impedance: 437 }
            : { weight: 83.4, impedance: 0 };
        }),
      });

      const promise = waitForRawReading(charMap, device, adapter, PROFILE, '');
      await vi.advanceTimersByTimeAsync(1);
      expect(notifyChar.subscribeCalled).toBe(true);

      notifyChar.triggerData(Buffer.from([0x01])); // weight stable, hold arms
      await vi.advanceTimersByTimeAsync(14000);
      notifyChar.triggerData(Buffer.from([0x03])); // 0x59 part 1, late
      await vi.advanceTimersByTimeAsync(3000); // past the 15 s window
      notifyChar.triggerData(Buffer.from([0x02])); // last part, with impedance

      const result = await promise;
      expect(result.reading).toEqual({ weight: 83.55, impedance: 437 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('resolves with the held reading (not reject) on disconnect during the hold', async () => {
    const notifyChar = createMockChar();
    const writeChar = createMockChar();
    const device = createMockDevice();
    const { charMap } = createCharMap([
      [NOTIFY_UUID, notifyChar],
      [WRITE_UUID, writeChar],
    ]);

    const adapter = createLegacyAdapter({
      completionHoldMs: 15000,
      isComplete: vi.fn((r: ScaleReading) => r.weight > 0),
      isFinal: vi.fn((r: ScaleReading) => r.impedance > 0),
      parseNotification: vi.fn(() => ({ weight: 83.4, impedance: 0 })),
    });

    const promise = waitForRawReading(charMap, device, adapter, PROFILE, '');
    await vi.waitFor(() => expect(notifyChar.subscribeCalled).toBe(true));

    notifyChar.triggerData(Buffer.from([0x01]));
    device.triggerDisconnect();

    const result = await promise;
    expect(result.reading).toEqual({ weight: 83.4, impedance: 0 });
  });

  it('routes per-frame ACK through the characteristics[] write binding (not charWriteUuid)', async () => {
    const notifyChar = createMockChar();
    const writeChar = createMockChar();
    const device = createMockDevice();
    const WRITE2 = '0000fff500001000800000805f9b34fb';
    const { charMap } = createCharMap([
      [NOTIFY_UUID, notifyChar],
      [WRITE2, writeChar],
    ]);

    const adapter = createLegacyAdapter({
      charWriteUuid: '0000dead00001000800000805f9b34fb', // absent: old code could not ack
      characteristics: [
        { uuid: NOTIFY_UUID, type: 'notify' },
        { uuid: WRITE2, type: 'write' },
      ],
      onConnected: vi.fn(),
      buildAck: vi.fn(() => [0xaa, 0xbb]),
      parseNotification: vi.fn((d: Buffer) =>
        d[0] === 0x99 ? { weight: 75, impedance: 500 } : null,
      ),
    });

    const promise = waitForRawReading(charMap, device, adapter, PROFILE, '');
    await vi.waitFor(() => expect(notifyChar.subscribeCalled).toBe(true));

    notifyChar.triggerData(Buffer.from([0x01]));
    await vi.waitFor(() =>
      expect(writeChar.writtenData.some((b) => b.equals(Buffer.from([0xaa, 0xbb])))).toBe(true),
    );

    notifyChar.triggerData(Buffer.from([0x99]));
    await promise;
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

    const promise = waitForReading(charMap, device, adapter, PROFILE, '', 'lbs');
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

    const promise = waitForReading(charMap, device, adapter, PROFILE, '', 'lbs');
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

    const promise = waitForReading(charMap, device, adapter, PROFILE, '', 'kg');
    await vi.waitFor(() => expect(notifyChar.subscribeCalled).toBe(true));

    notifyChar.triggerData(Buffer.from([0x01]));

    await promise;
    const call = vi.mocked(adapter.computeMetrics).mock.calls[0];
    expect(call[0].weight).toBe(75.5); // unchanged
  });
});

describe('findMissingCharacteristics()', () => {
  const SERVICE_UUID = '0000fff000001000800000805f9b34fb';
  const OTHER_UUID = '0000fff400001000800000805f9b34fb';

  it('returns empty array when legacy adapter has both notify and write chars', () => {
    const { charMap } = createCharMap([
      [NOTIFY_UUID, createMockChar()],
      [WRITE_UUID, createMockChar()],
    ]);
    const adapter = createLegacyAdapter();
    expect(findMissingCharacteristics(charMap, adapter)).toEqual([]);
  });

  it('returns missing notify UUID when legacy notify char absent', () => {
    const { charMap } = createCharMap([[WRITE_UUID, createMockChar()]]);
    const adapter = createLegacyAdapter();
    expect(findMissingCharacteristics(charMap, adapter)).toEqual([NOTIFY_UUID]);
  });

  it('returns missing write UUID when legacy write char absent', () => {
    const { charMap } = createCharMap([[NOTIFY_UUID, createMockChar()]]);
    const adapter = createLegacyAdapter();
    expect(findMissingCharacteristics(charMap, adapter)).toEqual([WRITE_UUID]);
  });

  it('accepts altCharNotifyUuid when primary notify absent', () => {
    const altNotify = '0000fff300001000800000805f9b34fb';
    const { charMap } = createCharMap([
      [altNotify, createMockChar()],
      [WRITE_UUID, createMockChar()],
    ]);
    const adapter = createLegacyAdapter({ altCharNotifyUuid: altNotify });
    expect(findMissingCharacteristics(charMap, adapter)).toEqual([]);
  });

  it('returns empty array when multi-char adapter has all bindings', () => {
    const { charMap } = createCharMap([
      [NOTIFY_UUID, createMockChar()],
      [WRITE_UUID, createMockChar()],
      [OTHER_UUID, createMockChar()],
    ]);
    const adapter = createLegacyAdapter({
      characteristics: [
        { service: SERVICE_UUID, uuid: NOTIFY_UUID, type: 'notify' },
        { service: SERVICE_UUID, uuid: WRITE_UUID, type: 'write' },
        { service: SERVICE_UUID, uuid: OTHER_UUID, type: 'notify' },
      ],
    });
    expect(findMissingCharacteristics(charMap, adapter)).toEqual([]);
  });

  it('returns every missing UUID from a multi-char adapter', () => {
    const { charMap } = createCharMap([[NOTIFY_UUID, createMockChar()]]);
    const adapter = createLegacyAdapter({
      characteristics: [
        { service: SERVICE_UUID, uuid: NOTIFY_UUID, type: 'notify' },
        { service: SERVICE_UUID, uuid: WRITE_UUID, type: 'write' },
        { service: SERVICE_UUID, uuid: OTHER_UUID, type: 'notify' },
      ],
    });
    expect(findMissingCharacteristics(charMap, adapter).sort()).toEqual(
      [WRITE_UUID, OTHER_UUID].sort(),
    );
  });

  it('skips optional bindings that are not present (used by Trisa/ADE variant detection)', () => {
    const { charMap } = createCharMap([
      [NOTIFY_UUID, createMockChar()],
      [WRITE_UUID, createMockChar()],
    ]);
    const adapter = createLegacyAdapter({
      characteristics: [
        { service: SERVICE_UUID, uuid: NOTIFY_UUID, type: 'notify' },
        { service: SERVICE_UUID, uuid: WRITE_UUID, type: 'write' },
        // Optional and missing: must NOT show up as missing.
        { service: SERVICE_UUID, uuid: OTHER_UUID, type: 'notify', optional: true },
      ],
    });
    expect(findMissingCharacteristics(charMap, adapter)).toEqual([]);
  });

  it('still flags non-optional missing chars when other bindings are optional', () => {
    const { charMap } = createCharMap([[NOTIFY_UUID, createMockChar()]]);
    const adapter = createLegacyAdapter({
      characteristics: [
        { service: SERVICE_UUID, uuid: NOTIFY_UUID, type: 'notify' },
        { service: SERVICE_UUID, uuid: WRITE_UUID, type: 'write' }, // required, missing
        { service: SERVICE_UUID, uuid: OTHER_UUID, type: 'notify', optional: true }, // optional, missing
      ],
    });
    expect(findMissingCharacteristics(charMap, adapter)).toEqual([WRITE_UUID]);
  });
});

describe('resolveWriteChar()', () => {
  const WRITE2_UUID = '0000fff500001000800000805f9b34fb';

  it('resolves the legacy charWriteUuid when no characteristics declared', () => {
    const writeChar = createMockChar();
    const { charMap } = createCharMap([[WRITE_UUID, writeChar]]);
    const adapter = createLegacyAdapter();
    expect(resolveWriteChar(charMap, adapter)).toBe(writeChar);
  });

  it('falls back to altCharWriteUuid when primary write char absent', () => {
    const altWriteChar = createMockChar();
    const ALT_WRITE = '0000ffe300001000800000805f9b34fb';
    const { charMap } = createCharMap([[ALT_WRITE, altWriteChar]]);
    const adapter = createLegacyAdapter({ altCharWriteUuid: ALT_WRITE });
    expect(resolveWriteChar(charMap, adapter)).toBe(altWriteChar);
  });

  it('resolves the characteristics[] write binding even when charWriteUuid is absent', () => {
    const writeChar = createMockChar();
    const { charMap } = createCharMap([[WRITE2_UUID, writeChar]]);
    const adapter = createLegacyAdapter({
      charWriteUuid: '0000dead00001000800000805f9b34fb', // not in the map
      characteristics: [
        { uuid: NOTIFY_UUID, type: 'notify' },
        { uuid: WRITE2_UUID, type: 'write' },
      ],
    });
    expect(resolveWriteChar(charMap, adapter)).toBe(writeChar);
  });

  it('returns undefined when nothing resolves', () => {
    const { charMap } = createCharMap([[NOTIFY_UUID, createMockChar()]]);
    const adapter = createLegacyAdapter({
      charWriteUuid: '0000dead00001000800000805f9b34fb',
    });
    expect(resolveWriteChar(charMap, adapter)).toBeUndefined();
  });
});

describe('waitForReading() — adapter with no unlock wiring (#244)', () => {
  it('arms no unlock interval and writes nothing when unlock fields are absent', async () => {
    const notifyChar = createMockChar();
    const writeChar = createMockChar();
    const device = createMockDevice();
    const { charMap } = createCharMap([
      [NOTIFY_UUID, notifyChar],
      [WRITE_UUID, writeChar],
    ]);

    // No unlockCommand / unlockIntervalMs, no onConnected: a pure
    // notify-and-parse adapter. Legal because Unlockable is now opt-in.
    const adapter: ScaleAdapter = {
      name: 'NoUnlock',
      charNotifyUuid: NOTIFY_UUID,
      charWriteUuid: WRITE_UUID,
      matches: (_i: BleDeviceInfo) => true,
      parseNotification: (data: Buffer) =>
        data[0] === 0x10 ? { weight: 75.5, impedance: 500 } : null,
      isComplete: (r: ScaleReading) => r.weight > 0 && r.impedance > 0,
      computeMetrics: () => SAMPLE_BODY_COMP,
    };

    const promise = waitForReading(charMap, device, adapter, PROFILE, '');
    await vi.waitFor(() => expect(notifyChar.subscribeCalled).toBe(true));
    notifyChar.triggerData(Buffer.from([0x10]));

    const result = await promise;
    expect(result).toEqual(SAMPLE_BODY_COMP);
    // No legacy unlock write was issued.
    expect(writeChar.writtenData.length).toBe(0);
  });

  it('re-sends a send-once unlock after notifications are enabled (#283)', async () => {
    // Noble queues the CCCD write from inside its descriptor discovery
    // callback, so the first unlock always reaches the scale before
    // notifications are on. Before this repeat, removing the accidental 1 ms
    // flood left send-once adapters with a single pre-CCCD write and no retry.
    const notifyChar = createMockChar();
    const writeChar = createMockChar();
    const device = createMockDevice();
    const { charMap } = createCharMap([
      [NOTIFY_UUID, notifyChar],
      [WRITE_UUID, writeChar],
    ]);

    let releaseSubscribe: (() => void) | undefined;
    const originalSubscribe = notifyChar.subscribe.bind(notifyChar);
    notifyChar.subscribe = async (onData: (d: Buffer) => void): Promise<() => void> => {
      await new Promise<void>((resolve) => {
        releaseSubscribe = resolve;
      });
      return originalSubscribe(onData);
    };

    const adapter = createLegacyAdapter({
      unlockCommand: [0xa5, 0x01],
      unlockIntervalMs: 0,
      parseNotification: (data: Buffer) =>
        data[0] === 0x10 ? { weight: 75.5, impedance: 500 } : null,
    });

    const promise = waitForReading(charMap, device, adapter, PROFILE, '');
    // The unlock goes out while the subscribe is still pending, exactly as it
    // does on a real noble connection.
    await vi.waitFor(() => expect(writeChar.writtenData.length).toBe(1));
    releaseSubscribe?.();
    await vi.waitFor(() => expect(writeChar.writtenData.length).toBe(2));

    notifyChar.triggerData(Buffer.from([0x10]));
    await expect(promise).resolves.toEqual(SAMPLE_BODY_COMP);
  });

  it('sends the unlock exactly once before and once after subscribe when interval is 0', async () => {
    // `?? 5000` does not catch 0, so this used to arm setInterval(fn, 0), which
    // clamps to about 1 ms on Linux and floods the link for the whole session.
    // Four adapters declare 0 (Active Era, ES-CS20M, Hesley, 1byone new).
    const notifyChar = createMockChar();
    const writeChar = createMockChar();
    const device = createMockDevice();
    const { charMap } = createCharMap([
      [NOTIFY_UUID, notifyChar],
      [WRITE_UUID, writeChar],
    ]);

    const adapter = createLegacyAdapter({
      unlockCommand: [0xa5, 0x01],
      unlockIntervalMs: 0,
      parseNotification: (data: Buffer) =>
        data[0] === 0x10 ? { weight: 75.5, impedance: 500 } : null,
    });

    const promise = waitForReading(charMap, device, adapter, PROFILE, '');
    // One before the subscribe resolves, one repeat after. No interval timer,
    // so the count must then stay put.
    await vi.waitFor(() => expect(writeChar.writtenData.length).toBe(2));
    await new Promise((r) => setTimeout(r, 60));
    expect(writeChar.writtenData.length).toBe(2);

    notifyChar.triggerData(Buffer.from([0x10]));
    await expect(promise).resolves.toEqual(SAMPLE_BODY_COMP);
  });
});

// ─── Koogeek-S1 end to end through the real adapter (#270) ──────────────────

describe('waitForRawReading() with the real KoogeekS1Adapter (#270)', () => {
  const KOOGEEK_NOTIFY = uuid16(0xfff4);
  const KOOGEEK_WRITE = uuid16(0xfff3);

  /** A stable (command 0x03) frame with the given weight tenths and impedance. */
  function stableFrame(weightTenths: number, impedance: number): Buffer {
    const body = [
      0x55,
      0xaa,
      0x55,
      0xaa,
      0x03,
      0x01,
      0,
      0,
      0,
      (weightTenths >> 8) & 0xff,
      weightTenths & 0xff,
      (impedance >> 8) & 0xff,
      impedance & 0xff,
    ];
    return Buffer.from([...body, xorChecksum(body, 0, body.length)]);
  }

  function koogeekHarness() {
    const notifyChar = createMockChar();
    const writeChar = createMockChar();
    const device = createMockDevice();
    const { charMap } = createCharMap([
      [KOOGEEK_NOTIFY, notifyChar],
      [KOOGEEK_WRITE, writeChar],
    ]);
    return { notifyChar, writeChar, device, charMap, adapter: new KoogeekS1Adapter() };
  }

  it('answers the init frame on fff3 without a response, and never resolves on it', async () => {
    const { notifyChar, writeChar, device, charMap, adapter } = koogeekHarness();
    const promise = waitForRawReading(charMap, device, adapter, PROFILE, '');
    await vi.waitFor(() => expect(notifyChar.subscribeCalled).toBe(true));

    notifyChar.triggerData(Buffer.from('55aa55aa010d010101162601735500000000001a', 'hex'));
    await vi.waitFor(() => expect(writeChar.write).toHaveBeenCalled());

    const [data, withResponse] = writeChar.write.mock.calls.at(-1)!;
    expect([...(data as Buffer)]).toEqual([0x55, 0xaa, 0x55, 0xaa, 0x81, 0x01, 0x01, 0x81]);
    expect(withResponse).toBe(false);

    const pending = await Promise.race([
      promise.then(() => 'resolved'),
      new Promise((r) => setTimeout(() => r('pending'), 50)),
    ]);
    expect(pending).toBe('pending');

    notifyChar.triggerData(stableFrame(783, 470));
    expect((await promise).reading).toEqual({ weight: 78.3, impedance: 470 });
  });

  it('resolves immediately on a stable frame carrying impedance', async () => {
    const { notifyChar, device, charMap, adapter } = koogeekHarness();
    const promise = waitForRawReading(charMap, device, adapter, PROFILE, '');
    await vi.waitFor(() => expect(notifyChar.subscribeCalled).toBe(true));

    notifyChar.triggerData(stableFrame(783, 470));
    expect((await promise).reading).toEqual({ weight: 78.3, impedance: 470 });
  });

  it('holds, then resolves weight-only when a stable frame reports no impedance', async () => {
    vi.useFakeTimers();
    try {
      const { notifyChar, device, charMap, adapter } = koogeekHarness();
      const promise = waitForRawReading(charMap, device, adapter, PROFILE, '');
      await vi.advanceTimersByTimeAsync(1);
      expect(notifyChar.subscribeCalled).toBe(true);

      // Measured through socks: stable, but no impedance. Must not hang.
      notifyChar.triggerData(stableFrame(800, 0));
      await vi.advanceTimersByTimeAsync(2000);

      expect((await promise).reading).toEqual({ weight: 80, impedance: 0 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('prefers a later impedance-bearing stable frame inside the hold window', async () => {
    const { notifyChar, device, charMap, adapter } = koogeekHarness();
    const promise = waitForRawReading(charMap, device, adapter, PROFILE, '');
    await vi.waitFor(() => expect(notifyChar.subscribeCalled).toBe(true));

    notifyChar.triggerData(stableFrame(800, 0));
    notifyChar.triggerData(stableFrame(783, 470));
    expect((await promise).reading).toEqual({ weight: 78.3, impedance: 470 });
  });
});

// ─── Notification teardown on a failed init ─────────────────────────────────

describe('waitForRawReading() — notification teardown', () => {
  it('releases the notify subscription when adapter init rejects mid-subscribe', async () => {
    // Legacy mode races the subscribe against the adapter handshake. When the
    // handshake loses, Promise.all abandons the subscribe, which goes on to
    // install its listener with nobody left to remove it. On the proxy
    // transports the client outlives the session, so that listener then
    // re-processes every later notification (#338).
    const unsub = vi.fn();
    let releaseSubscribe!: () => void;
    const gate = new Promise<void>((r) => {
      releaseSubscribe = r;
    });

    const notifyChar = createMockChar();
    notifyChar.subscribe = vi.fn(async () => {
      await gate;
      notifyChar.subscribeCalled = true;
      return unsub;
    });
    const writeChar = createMockChar();
    const device = createMockDevice();
    const { charMap } = createCharMap([
      [NOTIFY_UUID, notifyChar],
      [WRITE_UUID, writeChar],
    ]);

    const adapter = createLegacyAdapter({
      onConnected: vi.fn(async (_ctx: ConnectionContext) => {
        throw new Error('handshake failed');
      }),
    });

    const promise = waitForRawReading(charMap, device, adapter, PROFILE, '');
    await expect(promise).rejects.toThrow('handshake failed');

    // The session is already torn down while the subscribe is still in flight.
    expect(unsub).not.toHaveBeenCalled();

    releaseSubscribe();
    await vi.waitFor(() => expect(unsub).toHaveBeenCalledTimes(1));
  });

  it('releases every notify subscription once the session ends normally', async () => {
    const unsub = vi.fn();
    const notifyChar = createMockChar();
    notifyChar.subscribe = vi.fn(async (onData) => {
      notifyChar.subscribeCalled = true;
      notifyChar.triggerData = (data: Buffer) => onData(data);
      return unsub;
    });
    const writeChar = createMockChar();
    const device = createMockDevice();
    const { charMap } = createCharMap([
      [NOTIFY_UUID, notifyChar],
      [WRITE_UUID, writeChar],
    ]);

    const adapter = createLegacyAdapter({
      parseNotification: vi.fn((data: Buffer) =>
        data[0] === 0x10 ? { weight: 75.5, impedance: 500 } : null,
      ),
    });

    const promise = waitForRawReading(charMap, device, adapter, PROFILE, '');
    await vi.waitFor(() => expect(notifyChar.subscribeCalled).toBe(true));
    notifyChar.triggerData(Buffer.from([0x10]));

    await promise;
    await vi.waitFor(() => expect(unsub).toHaveBeenCalledTimes(1));
  });
});

// ─── native call-site wiring: idle deadline over waitForRawReading ───────────
// Both native handlers (noble, node-ble) wrap waitForRawReading in
// withIdleTimeout(onActivity => waitForRawReading(..., onActivity), timeout).
// These pin that composition: the onActivity ninth argument must reach
// waitForRawReading so an adapter-rejected frame restarts the deadline, and a
// silent session must still reject at the configured timeout (#83 wiring).
describe('waitForRawReading() under the native idle deadline', () => {
  const IDLE_MS = 1000;

  function runWithIdle(adapter: ScaleAdapter, notifyChar: MockBleChar, device: BleDevice) {
    const { charMap } = createCharMap([
      [NOTIFY_UUID, notifyChar],
      [WRITE_UUID, createMockChar()],
    ]);
    return withIdleTimeout(
      (onActivity) =>
        waitForRawReading(
          charMap,
          device,
          adapter,
          PROFILE,
          '',
          undefined,
          undefined,
          undefined,
          onActivity,
        ),
      IDLE_MS,
      'Timed out waiting for a complete scale reading',
    );
  }

  it('restarts the deadline on an adapter-rejected frame so a later complete frame resolves', async () => {
    vi.useFakeTimers();
    try {
      const notifyChar = createMockChar();
      const device = createMockDevice();
      let seen = 0;
      const adapter = createLegacyAdapter({
        parseNotification: vi.fn((): ScaleReading | null => {
          seen++;
          // First frame parses to null (adapter-rejected), so this also covers
          // onActivity firing before the parse gate, not only before isComplete.
          return seen === 1 ? null : { weight: 75, impedance: 500 };
        }),
      });

      const promise = runWithIdle(adapter, notifyChar, device);
      await vi.advanceTimersByTimeAsync(0);
      expect(notifyChar.subscribeCalled).toBe(true);

      // Just before the deadline, a rejected frame arrives and must re-arm it.
      await vi.advanceTimersByTimeAsync(IDLE_MS - 100);
      notifyChar.triggerData(Buffer.from([0x01]));

      // Past the original deadline: only the restart keeps the session alive.
      await vi.advanceTimersByTimeAsync(IDLE_MS - 100);
      notifyChar.triggerData(Buffer.from([0x02]));

      const result = await promise;
      expect(result.reading).toEqual({ weight: 75, impedance: 500 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects at the timeout when the scale stays silent', async () => {
    vi.useFakeTimers();
    try {
      const notifyChar = createMockChar();
      const device = createMockDevice();
      const promise = runWithIdle(createLegacyAdapter(), notifyChar, device);
      const rejection = expect(promise).rejects.toThrow(
        'Timed out waiting for a complete scale reading',
      );
      await vi.advanceTimersByTimeAsync(IDLE_MS);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });

  // A composition hold longer than the idle deadline, on a scale that says
  // nothing more after the weight settles. Before #434 the idle timeout won
  // this race and the settled weight was discarded with the session.
  it('lets a composition hold outlast the idle deadline and settle on the held weight', async () => {
    vi.useFakeTimers();
    try {
      const notifyChar = createMockChar();
      const device = createMockDevice();
      const adapter = createLegacyAdapter({
        unlockCommand: undefined,
        completionHoldMs: IDLE_MS * 5,
        parseNotification: vi.fn(() => ({ weight: 81.55, impedance: 0 })),
        isComplete: () => true,
        isFinal: () => false,
      });

      const promise = runWithIdle(adapter, notifyChar, device);
      let failure: unknown = null;
      promise.catch((e: unknown) => {
        failure = e;
      });
      await vi.advanceTimersByTimeAsync(0);
      notifyChar.triggerData(Buffer.from([0x01]));

      // Several idle windows of silence, still inside the hold.
      await vi.advanceTimersByTimeAsync(IDLE_MS * 4);
      expect(failure).toBeNull();

      await vi.advanceTimersByTimeAsync(IDLE_MS);
      const result = await promise;
      expect(result.reading).toEqual({ weight: 81.55, impedance: 0 });
    } finally {
      vi.useRealTimers();
    }
  });
});

// ─── getRawCaptureConfig + toHex ─────────────────────────────────────────────

describe('toHex()', () => {
  it('formats a buffer as space-separated lowercase hex', () => {
    expect(toHex(Buffer.from([0xe7, 0x58, 0x01, 0x0a]))).toBe('e7 58 01 0a');
  });

  it('formats a number array and zero-pads single digits', () => {
    expect(toHex([0x00, 0x5, 0xff])).toBe('00 05 ff');
  });
});

describe('getRawCaptureConfig()', () => {
  afterEach(() => {
    delete process.env.BLE_RAW_CAPTURE;
    delete process.env.BLE_RAW_CAPTURE_HOLD_SEC;
  });

  it('is disabled by default with the 20s hold', () => {
    expect(getRawCaptureConfig()).toEqual({ enabled: false, holdMs: 20_000 });
  });

  it.each(['1', 'true', 'yes', 'on', 'TRUE'])('enables on %s', (val) => {
    process.env.BLE_RAW_CAPTURE = val;
    expect(getRawCaptureConfig().enabled).toBe(true);
  });

  it.each(['', '0', 'false', 'no', 'off', 'OFF'])('stays disabled on %s', (val) => {
    process.env.BLE_RAW_CAPTURE = val;
    expect(getRawCaptureConfig().enabled).toBe(false);
  });

  it('overrides the hold window from BLE_RAW_CAPTURE_HOLD_SEC', () => {
    process.env.BLE_RAW_CAPTURE = '1';
    process.env.BLE_RAW_CAPTURE_HOLD_SEC = '8';
    expect(getRawCaptureConfig().holdMs).toBe(8000);
  });

  it('ignores a non-positive or non-numeric hold override', () => {
    process.env.BLE_RAW_CAPTURE = '1';
    process.env.BLE_RAW_CAPTURE_HOLD_SEC = '-5';
    expect(getRawCaptureConfig().holdMs).toBe(20_000);
    process.env.BLE_RAW_CAPTURE_HOLD_SEC = 'abc';
    expect(getRawCaptureConfig().holdMs).toBe(20_000);
  });
});

// ─── Completion hold, end to end (#413) ─────────────────────────────────────

// The adapter-level tests assert what isComplete and isFinal answer. This one
// asserts what the SESSION does with those answers, which is the behaviour the
// hold exists for and the part no adapter test can reach.
describe('completionHoldMs through waitForRawReading', () => {
  it('holds a complete-but-not-final reading, then settles once on expiry', async () => {
    vi.useFakeTimers();
    try {
      const notifyChar = createMockChar();
      const writeChar = createMockChar();
      const device = createMockDevice();
      const { charMap } = createCharMap([
        [NOTIFY_UUID, notifyChar],
        [WRITE_UUID, writeChar],
      ]);

      let final = false;
      const adapter = createLegacyAdapter({
        unlockCommand: undefined,
        completionHoldMs: 4000,
        parseNotification: vi.fn(() => ({ weight: 78.4, impedance: final ? 500 : 0 })),
        isComplete: () => true,
        isFinal: () => final,
      });

      const promise = waitForRawReading(charMap, device, adapter, PROFILE, '');
      await vi.waitFor(() => expect(notifyChar.subscribeCalled).toBe(true));

      // A complete but not-final frame must NOT settle the session.
      notifyChar.triggerData(Buffer.from([0x01]));
      let settled = false;
      void promise.then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(3999);
      expect(settled, 'the session must still be waiting for a richer frame').toBe(false);

      // On expiry the held reading is delivered rather than lost.
      await vi.advanceTimersByTimeAsync(1);
      const raw = await promise;
      expect(raw.reading.weight).toBe(78.4);
      expect(raw.reading.impedance).toBe(0);

      // A frame arriving after the window must not settle it a second time.
      final = true;
      notifyChar.triggerData(Buffer.from([0x02]));
      await vi.advanceTimersByTimeAsync(10);
      expect(adapter.parseNotification).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('settles at once on a final frame, without arming the hold', async () => {
    vi.useFakeTimers();
    try {
      const notifyChar = createMockChar();
      const writeChar = createMockChar();
      const device = createMockDevice();
      const { charMap } = createCharMap([
        [NOTIFY_UUID, notifyChar],
        [WRITE_UUID, writeChar],
      ]);

      const adapter = createLegacyAdapter({
        unlockCommand: undefined,
        completionHoldMs: 4000,
        parseNotification: vi.fn(() => ({ weight: 78.4, impedance: 500 })),
        isComplete: () => true,
        isFinal: () => true,
      });

      const promise = waitForRawReading(charMap, device, adapter, PROFILE, '');
      await vi.waitFor(() => expect(notifyChar.subscribeCalled).toBe(true));
      notifyChar.triggerData(Buffer.from([0x01]));

      // No timer advance: a final frame must not wait out the window.
      const raw = await promise;
      expect(raw.reading.impedance).toBe(500);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ─── R-MSC04 composition hold, end to end (#434) ────────────────────────────

// The real adapter through the real session, with the frame spacing of the
// captures. The adapter tests pin what isComplete/isFinal answer; these pin
// that the session stays open past the 0x24 weight and settles on the record.
describe('R-MSC04 composition hold through waitForRawReading (#434)', () => {
  const hex = (h: string): Buffer => Buffer.from(h, 'hex');
  const PROFILE_187: UserProfile = { height: 187, age: 30, gender: 'male', isAthlete: false };

  async function startSession() {
    const write = createMockChar();
    const notify = createMockChar();
    const indicate = createMockChar();
    const device = createMockDevice();
    const { charMap } = createCharMap([
      [uuid16(0x2a11), write],
      [uuid16(0x2a10), notify],
      [uuid16(0x2a12), indicate],
    ]);
    const adapter = new RenphoMsc04Adapter();
    const promise = waitForRawReading(charMap, device, adapter, PROFILE, 'AABBCCDDEEFF');
    let settled = false;
    void promise.then(
      () => (settled = true),
      () => (settled = true),
    );
    await vi.waitFor(() => expect(indicate.subscribeCalled).toBe(true));
    await vi.advanceTimersByTimeAsync(0);
    return { write, notify, indicate, device, adapter, promise, isSettled: () => settled };
  }

  it('holds past the 0x24 weight and settles on the record, with the capture spacing', async () => {
    vi.useFakeTimers();
    try {
      const s = await startSession();
      // #117 capture, second connection (20:28:09.513 .. 20:28:30.363).
      s.indicate.triggerData(hex('55aa200005000101005076'));
      s.notify.triggerData(hex('55aa2100050100002558a3'));
      await vi.advanceTimersByTimeAsync(270);
      s.notify.triggerData(hex('55aa2100050100002558a3'));
      await vi.advanceTimersByTimeAsync(270);
      s.indicate.triggerData(hex('55aa240006011100002553b3')); // 14.253, 95.55 kg

      await vi.advanceTimersByTimeAsync(6165);
      s.indicate.triggerData(hex('55aa200005020901005080')); // 20.418, weight locked
      await vi.advanceTimersByTimeAsync(9630);
      s.indicate.triggerData(hex('55aa200005031101005089')); // 30.048, complete
      await vi.advanceTimersByTimeAsync(135);
      s.indicate.triggerData(hex('ad040255aa2500240411000025530a00de0c200b'));
      await vi.advanceTimersByTimeAsync(91);
      s.indicate.triggerData(hex('ae0401ef08e4092a00ae0ac10a9007e108250100'));
      await vi.advanceTimersByTimeAsync(89);
      expect(s.isSettled(), 'the 0x24 weight alone must not end the session').toBe(false);

      s.indicate.triggerData(hex('af0400ed011101b70008ea'));
      const raw = await s.promise;
      expect(raw.reading).toEqual({ weight: 95.55, impedance: 0 });
      expect(s.adapter.isFinal(raw.reading)).toBe(true);
      expect(s.adapter.computeMetrics(raw.reading, PROFILE_187).bodyFatPercent).toBe(23.7);

      // After the start command, exactly the app's three status acks, in order.
      expect(s.write.writtenData.map((b) => Buffer.from(b).toString('hex'))).toEqual([
        '55aa9000040100000094',
        '55aab000020001b2',
        '55aab000020201b4',
        '55aab000020301b5',
      ]);
      const ackCalls = vi.mocked(s.write.write).mock.calls.slice(1);
      expect(ackCalls.every(([, withResponse]) => withResponse === true)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('settles weight-only on the 0x24 weight when no record arrives within 30 s', async () => {
    vi.useFakeTimers();
    try {
      const s = await startSession();
      // #434, vossitch's DEBUG log.
      s.indicate.triggerData(hex('55aa20000500010100466c'));
      s.notify.triggerData(hex('55aa21000501000022b0f8')); // 88.80
      await vi.advanceTimersByTimeAsync(270);
      s.notify.triggerData(hex('55aa2100050100001fe025')); // 81.60
      await vi.advanceTimersByTimeAsync(135);
      s.indicate.triggerData(hex('55aa240006011100001fdb35')); // settled 81.55
      // A live frame after the settled weight must not replace the held one.
      await vi.advanceTimersByTimeAsync(270);
      s.notify.triggerData(hex('55aa21000501000022b0f8'));

      await vi.advanceTimersByTimeAsync(30_000 - 271);
      expect(s.isSettled()).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const raw = await s.promise;
      expect(raw.reading).toEqual({ weight: 81.55, impedance: 0 });
      expect(s.adapter.computeMetrics(raw.reading, PROFILE)).toEqual(
        buildPayload(81.55, 0, {}, PROFILE),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('settles on the held weight at once when the scale disconnects during the hold', async () => {
    vi.useFakeTimers();
    try {
      const s = await startSession();
      s.indicate.triggerData(hex('55aa240006011100001fdb35'));
      await vi.advanceTimersByTimeAsync(5000);
      expect(s.isSettled()).toBe(false);
      s.device.triggerDisconnect();
      const raw = await s.promise;
      expect(raw.reading).toEqual({ weight: 81.55, impedance: 0 });
    } finally {
      vi.useRealTimers();
    }
  });
});

// ─── Session hook placement (#394) ──────────────────────────────────────────

// The whole point of onSessionStart is WHERE it runs. Every adapter-level test
// calls the hook directly, so deleting the call in shared.ts left the suite
// green while the fix did nothing.
describe('onSessionStart placement', () => {
  it('fires before the first subscribe, in both wiring modes', async () => {
    for (const mode of ['legacy', 'multi-char'] as const) {
      const seen: string[] = [];
      const notifyChar = createMockChar();
      const writeChar = createMockChar();
      const baseSubscribe = notifyChar.subscribe;
      notifyChar.subscribe = vi.fn(async (onData: (data: Buffer) => void) => {
        seen.push('subscribe');
        return baseSubscribe(onData);
      });
      const device = createMockDevice();
      const { charMap } = createCharMap([
        [NOTIFY_UUID, notifyChar],
        [WRITE_UUID, writeChar],
      ]);

      const adapter = createLegacyAdapter({
        ...(mode === 'multi-char'
          ? {
              characteristics: [
                { uuid: NOTIFY_UUID, type: 'notify' as const },
                { uuid: WRITE_UUID, type: 'write' as const },
              ],
              onConnected: vi.fn(() => {
                seen.push('onConnected');
              }),
            }
          : {}),
        onSessionStart: vi.fn(() => {
          seen.push('onSessionStart');
        }),
        parseNotification: vi.fn(() => ({ weight: 75, impedance: 500 })),
        parseCharNotification: vi.fn(() => ({ weight: 75, impedance: 500 })),
      });

      const promise = waitForRawReading(charMap, device, adapter, PROFILE, 'AABBCCDDEEFF');
      await vi.waitFor(() => expect(notifyChar.subscribeCalled).toBe(true));
      if (mode === 'multi-char') {
        await vi.waitFor(() => expect(adapter.onConnected).toHaveBeenCalled());
      }
      notifyChar.triggerData(Buffer.from([0x01]));
      await promise;

      expect(adapter.onSessionStart).toHaveBeenCalledTimes(1);
      // With the address (#406): an adapter that keeps per-device state resolves
      // it here. Dropping the argument in shared.ts leaves every adapter-level
      // test green while the feature does nothing, which is the same trap the
      // comment above this describe block records for the call itself.
      expect(adapter.onSessionStart).toHaveBeenCalledWith('AABBCCDDEEFF');
      expect(seen[0], `${mode}: hook must run before anything is subscribed`).toBe(
        'onSessionStart',
      );
      // In multi-char mode subscribe precedes onConnected, which is exactly why
      // the reset cannot live in onConnected.
      if (mode === 'multi-char') {
        expect(seen.indexOf('subscribe')).toBeLessThan(seen.indexOf('onConnected'));
      }
    }
  });

  it('does not abort the session when the hook throws', async () => {
    const notifyChar = createMockChar();
    const writeChar = createMockChar();
    const device = createMockDevice();
    const { charMap } = createCharMap([
      [NOTIFY_UUID, notifyChar],
      [WRITE_UUID, writeChar],
    ]);

    const adapter = createLegacyAdapter({
      onSessionStart: vi.fn(() => {
        throw new Error('adapter bug');
      }),
      parseNotification: vi.fn(() => ({ weight: 75, impedance: 500 })),
    });

    const promise = waitForRawReading(charMap, device, adapter, PROFILE, '');
    await vi.waitFor(() => expect(notifyChar.subscribeCalled).toBe(true));
    notifyChar.triggerData(Buffer.from([0x01]));
    await expect(promise).resolves.toMatchObject({ reading: { weight: 75 } });
  });
});

describe('withAbandonmentCleanup() (#404)', () => {
  // waitForRawReading only settles on a reading, a subscribe failure or a
  // disconnect. Its callers bound it with withTimeout/withIdleTimeout, which
  // ABANDON the promise rather than cancelling it, so before this the unlock
  // interval kept writing through a dead link for the life of the process and
  // the adapter was never told its session had ended.
  it('cleans up a session its caller gave up on', async () => {
    const notifyChar = createMockChar();
    const writeChar = createMockChar();
    const device = createMockDevice();
    const { charMap } = createCharMap([
      [NOTIFY_UUID, notifyChar],
      [WRITE_UUID, writeChar],
    ]);

    const onSessionEnd = vi.fn();
    const adapter = createLegacyAdapter({ unlockIntervalMs: 2000, onSessionEnd });

    let unsubscribed = false;
    notifyChar.subscribe = vi.fn(async (onData) => {
      notifyChar.subscribeCalled = true;
      void onData;
      return () => {
        unsubscribed = true;
      };
    }) as MockBleChar['subscribe'];

    const attempt = withAbandonmentCleanup(device, () =>
      withIdleTimeout(
        () => waitForRawReading(charMap, device, adapter, PROFILE, ''),
        50,
        'Timed out waiting for a complete scale reading',
      ),
    );

    await expect(attempt).rejects.toThrow('Timed out waiting');

    expect(onSessionEnd).toHaveBeenCalledTimes(1);
    expect(unsubscribed).toBe(true);

    // The unlock interval is gone: nothing is written after the give-up, even
    // well past the 2 s interval.
    const writesAtGiveUp = writeChar.writtenData.length;
    await new Promise((r) => setTimeout(r, 120));
    expect(writeChar.writtenData.length).toBe(writesAtGiveUp);
  });

  it('is idempotent, so a real disconnect afterwards changes nothing', async () => {
    const notifyChar = createMockChar();
    const writeChar = createMockChar();
    const device = createMockDevice();
    const { charMap } = createCharMap([
      [NOTIFY_UUID, notifyChar],
      [WRITE_UUID, writeChar],
    ]);

    const onSessionEnd = vi.fn();
    const adapter = createLegacyAdapter({ onSessionEnd });

    const attempt = withAbandonmentCleanup(device, () =>
      withIdleTimeout(
        () => waitForRawReading(charMap, device, adapter, PROFILE, ''),
        50,
        'gave up',
      ),
    );
    await expect(attempt).rejects.toThrow('gave up');

    device.triggerDisconnect();
    expect(onSessionEnd).toHaveBeenCalledTimes(1);
  });

  it('passes a successful read through untouched', async () => {
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

    const promise = withAbandonmentCleanup(device, () =>
      waitForRawReading(charMap, device, adapter, PROFILE, ''),
    );
    await vi.waitFor(() => expect(notifyChar.subscribeCalled).toBe(true));
    notifyChar.triggerData(Buffer.from([0x01]));

    const result = await promise;
    expect(result.reading).toEqual({ weight: 75.5, impedance: 500 });
  });
});

// ─── Write lane (#211) ──────────────────────────────────────────────────────

interface WriteRecord {
  hex: string;
  withResponse: boolean;
}

interface BluezLikeChar extends BleChar {
  triggerData(data: Buffer): void;
  /** Answer the oldest write that is still waiting for its response. */
  release(): void;
  subscribeCalled: boolean;
  accepted: WriteRecord[];
  rejections: WriteRecord[];
}

/**
 * A characteristic that refuses writes the way BlueZ does. While a write WITH
 * a response is open on it, every other write to it is refused with
 * "In Progress", a write-without-response included, because
 * characteristic_write_value() checks chrc->write_op before it even parses the
 * write type (src/gatt-client.c:1045-1046, master ae69dcd). The open write
 * stays open until the test calls release(). A write without a response on an
 * idle characteristic settles at once.
 *
 * With `refuseWhileBusy: false` it models a stack that queues writes itself
 * (WinRT, CoreBluetooth): nothing is refused, writes with a response still
 * wait for release(). The invariant tests use that mode, so they pass on code
 * without the lane and only catch a lane that loses or reorders a write.
 *
 * It is notifiable as well, so one instance can be Beurer's FFE1.
 */
function createBluezLikeChar(opts: { refuseWhileBusy?: boolean } = {}): BluezLikeChar {
  const refuse = opts.refuseWhileBusy ?? true;
  let onData: ((data: Buffer) => void) | null = null;
  const open: (() => void)[] = [];
  const char: BluezLikeChar = {
    subscribeCalled: false,
    accepted: [],
    rejections: [],
    subscribe: vi.fn(async (cb: (data: Buffer) => void) => {
      char.subscribeCalled = true;
      onData = cb;
      return () => {
        onData = null;
      };
    }),
    write: vi.fn((data: Buffer, withResponse: boolean) => {
      const rec = { hex: data.toString('hex'), withResponse };
      if (refuse && open.length > 0) {
        char.rejections.push(rec);
        return Promise.reject(new Error('In Progress'));
      }
      char.accepted.push(rec);
      if (!withResponse) return Promise.resolve();
      return new Promise<void>((resolve) => open.push(resolve));
    }),
    read: vi.fn(async () => Buffer.alloc(0)),
    triggerData: (data: Buffer) => {
      if (onData) onData(data);
    },
    release: () => {
      open.shift()?.();
    },
  };
  return char;
}

describe('waitForRawReading() write lane (#211)', () => {
  const FFE1 = '0000ffe100001000800000805f9b34fb';
  const OTHER_UUID = '0000fff300001000800000805f9b34fb';

  /** Real frames from the SBF75 debug log in #211 (2026-09-30). */
  const SBF75_58_0732 = Buffer.from('e758010732', 'hex');
  const SBF75_58_0739 = Buffer.from('e758010739', 'hex');
  const SBF75_58_072E = Buffer.from('e75801072e', 'hex');
  const SBF75_58_0733 = Buffer.from('e758010733', 'hex');
  const SBF75_58_OFF_0733 = Buffer.from('e758000733', 'hex');
  /** Real 0x59 parts from the official-app HCI snoop in #211. */
  const PART1 = Buffer.from('e7590301010000000000000065', 'hex');
  const PART2 = Buffer.from('e75903026a21f4c6068701b500df02', 'hex');
  const PART3 = Buffer.from('e759030309018d00e907170aa20108', 'hex');

  const acks = (char: BluezLikeChar): string[] =>
    char.accepted.map((a) => a.hex).filter((h) => h.startsWith('e7f1'));

  /** A fresh Beurer/Sanitas adapter on its single FFE1 notify+write characteristic. */
  function beurerSession(ffe1: BluezLikeChar) {
    const adapter = new BeurerSanitasScaleAdapter();
    adapter.matches(mockPeripheral('SBF75'));
    const device = createMockDevice();
    const charMap = new Map<string, BleChar>([[normalizeUuid(FFE1), ffe1]]);
    const promise = waitForRawReading(charMap, device, adapter, PROFILE, '');
    promise.catch(() => {});
    return { promise, device };
  }

  /** Release open writes one at a time, letting the lane start the next each time. */
  async function drain(char: BluezLikeChar): Promise<void> {
    for (let i = 0; i < 20; i++) {
      char.release();
      for (let j = 0; j < 5; j++) await Promise.resolve();
    }
  }

  it('R1: queues an ACK behind the one still open instead of having it refused', async () => {
    const ffe1 = createBluezLikeChar();
    const { device } = beurerSession(ffe1);
    await vi.waitFor(() => expect(ffe1.subscribeCalled).toBe(true));

    ffe1.triggerData(SBF75_58_0732); // ACK e7 f1 58 01 07 opens write_op
    ffe1.triggerData(SBF75_58_0739); // 7 ms later in the log, and refused there
    await Promise.resolve();
    expect(ffe1.rejections).toEqual([]);

    ffe1.release();
    await vi.waitFor(() => expect(acks(ffe1)).toEqual(['e7f1580107', 'e7f1580107']));
    expect(ffe1.rejections).toEqual([]);
    device.triggerDisconnect();
  });

  it('R2: queues the unlock tick behind an open ACK instead of having it refused', async () => {
    vi.useFakeTimers();
    try {
      const ffe1 = createBluezLikeChar();
      const errorSpy = vi.spyOn(bleLog, 'error');
      const { device } = beurerSession(ffe1);
      // The unlock interval is armed at t=0. Step to t=1 before the frame, so
      // the lane's 5000 ms release timer (armed by the ACK) lands at 5001,
      // after the unlock tick at 5000 rather than in the same millisecond.
      await vi.advanceTimersByTimeAsync(1);
      expect(ffe1.subscribeCalled).toBe(true);
      expect(ffe1.accepted.map((a) => a.hex)).toEqual(['e701']);

      ffe1.triggerData(SBF75_58_0732); // ACK opens write_op
      await vi.advanceTimersByTimeAsync(4999); // t=5000: unlock tick, lane not yet released
      expect(ffe1.rejections).toEqual([]);
      expect(errorSpy).not.toHaveBeenCalled();

      ffe1.release();
      await vi.advanceTimersByTimeAsync(0);
      expect(ffe1.accepted.map((a) => a.hex)).toEqual(['e701', 'e7f1580107', 'e701']);
      expect(ffe1.rejections).toEqual([]);
      device.triggerDisconnect();
    } finally {
      vi.useRealTimers();
    }
  });

  it('R3: joins identical waiting ACKs and keeps a different one', async () => {
    const ffe1 = createBluezLikeChar();
    const { device } = beurerSession(ffe1);
    await vi.waitFor(() => expect(ffe1.subscribeCalled).toBe(true));

    ffe1.triggerData(SBF75_58_0732); // ACK e7 f1 58 01 07, running
    ffe1.triggerData(SBF75_58_0739); // ACK e7 f1 58 01 07, waits
    ffe1.triggerData(SBF75_58_072E); // ACK e7 f1 58 01 07, joins the waiting one
    ffe1.triggerData(SBF75_58_OFF_0733); // ACK e7 f1 58 00 07, different, waits
    await drain(ffe1);

    expect(acks(ffe1)).toEqual(['e7f1580107', 'e7f1580107', 'e7f1580007']);
    expect(ffe1.rejections).toEqual([]);
    device.triggerDisconnect();
  });

  it("R4: serializes an adapter's own concurrent writes to one characteristic", async () => {
    const notifyChar = createMockChar();
    const writeChar = createBluezLikeChar();
    const device = createMockDevice();
    const { charMap } = createCharMap([[NOTIFY_UUID, notifyChar]]);
    charMap.set(normalizeUuid(WRITE_UUID), writeChar);

    let connected = false;
    const adapter = createLegacyAdapter({
      onConnected: async (ctx: ConnectionContext) => {
        await Promise.all([
          ctx.write(WRITE_UUID, [0x01], true),
          ctx.write(WRITE_UUID, [0x02], true),
        ]);
        connected = true;
      },
      parseNotification: vi.fn(() => ({ weight: 75, impedance: 500 })),
    });

    const promise = waitForRawReading(charMap, device, adapter, PROFILE, '');
    promise.catch(() => {});
    await vi.waitFor(() => expect(writeChar.accepted).toHaveLength(1));
    expect(writeChar.rejections).toEqual([]);

    writeChar.release();
    await vi.waitFor(() => expect(writeChar.accepted.map((a) => a.hex)).toEqual(['01', '02']));
    writeChar.release();
    await vi.waitFor(() => expect(connected).toBe(true));
    expect(writeChar.rejections).toEqual([]);

    notifyChar.triggerData(Buffer.from([0x99]));
    await promise;
  });

  it('S1: a write open on one characteristic does not hold up another', async () => {
    const notifyChar = createMockChar();
    const writeChar = createBluezLikeChar();
    const otherChar = createBluezLikeChar();
    const device = createMockDevice();
    const { charMap } = createCharMap([[NOTIFY_UUID, notifyChar]]);
    charMap.set(normalizeUuid(WRITE_UUID), writeChar);
    charMap.set(normalizeUuid(OTHER_UUID), otherChar);

    const adapter = createLegacyAdapter({
      onConnected: async (ctx: ConnectionContext) => {
        void ctx.write(WRITE_UUID, [0x01], true).catch(() => {});
        void ctx.write(OTHER_UUID, [0x02], true).catch(() => {});
      },
      parseNotification: vi.fn(() => ({ weight: 75, impedance: 500 })),
    });

    const promise = waitForRawReading(charMap, device, adapter, PROFILE, '');
    await vi.waitFor(() => expect(writeChar.accepted).toHaveLength(1));
    // Started while the write on WRITE_UUID is still open.
    expect(otherChar.accepted.map((a) => a.hex)).toEqual(['02']);

    notifyChar.triggerData(Buffer.from([0x99]));
    await promise;
  });

  it('S2: every 0x59 part gets its own ACK, in order, with 0x58 frames in between', async () => {
    const ffe1 = createBluezLikeChar({ refuseWhileBusy: false });
    const { promise } = beurerSession(ffe1);
    await vi.waitFor(() => expect(ffe1.subscribeCalled).toBe(true));

    ffe1.triggerData(SBF75_58_0733); // its ACK stays open
    ffe1.triggerData(PART1);
    ffe1.triggerData(SBF75_58_OFF_0733);
    ffe1.triggerData(PART2);
    ffe1.triggerData(PART3); // completes the reading
    await drain(ffe1);

    expect(acks(ffe1)).toEqual([
      'e7f1580107',
      'e7f1590301',
      'e7f1580007',
      'e7f1590302',
      'e7f1590303',
    ]);
    expect((await promise).reading.impedance).toBeGreaterThan(0);
  });

  it('S3: an adapter write fired after the reading completed still goes out (#370)', async () => {
    const notifyChar = createMockChar();
    const writeChar = createBluezLikeChar({ refuseWhileBusy: false });
    const device = createMockDevice();
    const { charMap } = createCharMap([[NOTIFY_UUID, notifyChar]]);
    charMap.set(normalizeUuid(WRITE_UUID), writeChar);

    let ctxRef: ConnectionContext | null = null;
    const adapter = createLegacyAdapter({
      onConnected: async (ctx: ConnectionContext) => {
        ctxRef = ctx;
        void ctx.write(WRITE_UUID, [0x01], true); // stays open
      },
      parseNotification: vi.fn(() => {
        void ctxRef!.write(WRITE_UUID, [0x02], true);
        return { weight: 75, impedance: 500 };
      }),
    });

    const promise = waitForRawReading(charMap, device, adapter, PROFILE, '');
    await vi.waitFor(() => expect(writeChar.accepted).toHaveLength(1));
    notifyChar.triggerData(Buffer.from([0x99]));
    await promise; // session over, lanes closed

    await drain(writeChar);
    expect(writeChar.accepted.map((a) => a.hex)).toEqual(['01', '02']);
  });

  it('S4: the ACK of the frame that completed the reading still goes out', async () => {
    const ffe1 = createBluezLikeChar({ refuseWhileBusy: false });
    const { promise } = beurerSession(ffe1);
    await vi.waitFor(() => expect(ffe1.subscribeCalled).toBe(true));

    ffe1.triggerData(PART1); // its ACK stays open
    ffe1.triggerData(PART2);
    ffe1.triggerData(PART3); // finishWith() closes the lanes in this same tick
    await promise;

    await drain(ffe1);
    expect(acks(ffe1)).toEqual(['e7f1590301', 'e7f1590302', 'e7f1590303']);
  });

  it('R5: drops an unlock still queued when the session ends, and does not log it', async () => {
    vi.useFakeTimers();
    try {
      const notifyChar = createMockChar();
      const writeChar = createBluezLikeChar();
      const device = createMockDevice();
      const { charMap } = createCharMap([[NOTIFY_UUID, notifyChar]]);
      charMap.set(normalizeUuid(WRITE_UUID), writeChar);
      const errorSpy = vi.spyOn(bleLog, 'error');

      const adapter = createLegacyAdapter({
        unlockCommand: [0x13, 0x09],
        unlockIntervalMs: 1000,
        buildAck: (data: Buffer) => (data[0] === 0x01 ? [0xaa] : null),
        parseNotification: vi.fn((data: Buffer) =>
          data[0] === 0x02 ? { weight: 75, impedance: 500 } : null,
        ),
      });

      const promise = waitForRawReading(charMap, device, adapter, PROFILE, '');
      await vi.advanceTimersByTimeAsync(1);
      expect(writeChar.accepted.map((a) => a.hex)).toEqual(['1309']);

      notifyChar.triggerData(Buffer.from([0x01])); // ACK aa opens write_op
      await vi.advanceTimersByTimeAsync(999); // t=1000: unlock tick, queued behind it
      notifyChar.triggerData(Buffer.from([0x02])); // completes the reading
      await promise;

      writeChar.release();
      await vi.advanceTimersByTimeAsync(0);
      expect(writeChar.accepted.map((a) => a.hex)).toEqual(['1309', 'aa']);
      expect(writeChar.rejections).toEqual([]);
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('logs how long each ACK took, and which ones were coalesced', async () => {
    const ffe1 = createBluezLikeChar();
    const debugSpy = vi.spyOn(bleLog, 'debug');
    const { device } = beurerSession(ffe1);
    await vi.waitFor(() => expect(ffe1.subscribeCalled).toBe(true));

    ffe1.triggerData(SBF75_58_0732); // running
    ffe1.triggerData(SBF75_58_0739); // waits
    ffe1.triggerData(SBF75_58_072E); // joins it
    await drain(ffe1);

    const lines = debugSpy.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith('ACK'));
    expect(lines).toHaveLength(3);
    expect(
      lines.filter((l) => /^ACK \[e7 f1 58 01 07\] written in \d+ ms \(waited \d+ ms\)$/.test(l)),
    ).toHaveLength(2);
    expect(lines).toContain('ACK [e7 f1 58 01 07] coalesced with an identical one still waiting');
    device.triggerDisconnect();
  });
});
