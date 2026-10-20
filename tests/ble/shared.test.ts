import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  waitForReading,
  waitForRawReading,
  withAbandonmentCleanup,
  findMissingCharacteristics,
  resolveWriteChar,
  getRawCaptureConfig,
  toHex,
  stopDeferredNotifications,
} from '../../src/ble/shared.js';
import { untilAborted, withIdleTimeout } from '../../src/ble/types.js';
import type { BleChar, BleDevice } from '../../src/ble/shared.js';
import { normalizeUuid, bleLog } from '../../src/ble/types.js';
import { KoogeekS1Adapter } from '../../src/scales/koogeek-s1.js';
import { RenphoMsc04Adapter } from '../../src/scales/renpho-msc04.js';
import { BeurerSanitasScaleAdapter } from '../../src/scales/beurer-sanitas.js';
import { EsCs20mAdapter, buildGuestProfileFrame } from '../../src/scales/es-cs20m.js';
import { QnScaleAdapter } from '../../src/scales/qn-scale/index.js';
import { YunmaiScaleAdapter } from '../../src/scales/yunmai.js';
import { applyForcedAdapter } from '../../src/scales/force.js';
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

  // #461: the advertisement the transport matched on, for adapters that read
  // per-unit flags from it. The bytes are the #461 Physiq advertisement.
  it('hands the advertised manufacturer data to onConnected as ConnectionContext.manufacturerData', async () => {
    const mfg = { id: 0xffff, data: Buffer.from('081401000025e0160005ff6108010015', 'hex') };
    const run = async (manufacturerData?: {
      id: number;
      data: Buffer;
    }): Promise<ConnectionContext> => {
      const notifyChar = createMockChar();
      const { charMap } = createCharMap([[NOTIFY_UUID, notifyChar]]);
      const seen: ConnectionContext[] = [];
      const adapter = createLegacyAdapter({
        characteristics: [{ uuid: NOTIFY_UUID, type: 'notify' }],
        onConnected: vi.fn(async (ctx: ConnectionContext) => {
          seen.push(ctx);
        }),
        parseNotification: vi.fn(() => ({ weight: 75, impedance: 500 })),
      });
      const promise = waitForRawReading(
        charMap,
        createMockDevice(),
        adapter,
        PROFILE,
        '',
        undefined,
        undefined,
        undefined,
        undefined,
        'QN-Scale',
        manufacturerData,
      );
      await vi.waitFor(() => expect(seen).toHaveLength(1));
      notifyChar.triggerData(Buffer.from([0x01]));
      await promise;
      return seen[0];
    };
    expect((await run(mfg)).manufacturerData).toBe(mfg);
    expect('manufacturerData' in (await run())).toBe(false);
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

  // #331: a scale that replays a stored record and then disconnects while a
  // live weight is held. The history branch ran first, so the session ended on
  // the stored record and the live weigh-in was lost entirely.
  it('keeps the held live reading on disconnect after a stored record, which goes to history', async () => {
    const notifyChar = createMockChar();
    const writeChar = createMockChar();
    const device = createMockDevice();
    const { charMap } = createCharMap([
      [NOTIFY_UUID, notifyChar],
      [WRITE_UUID, writeChar],
    ]);

    const storedAt = new Date(Date.now() - 3_600_000);
    const adapter = createLegacyAdapter({
      completionHoldMs: 15000,
      isComplete: vi.fn((r: ScaleReading) => r.weight > 0),
      isFinal: vi.fn((r: ScaleReading) => r.impedance > 0),
      parseNotification: vi.fn((data: Buffer) =>
        data[0] === 0x01
          ? { weight: 70.1, impedance: 0, timestamp: storedAt }
          : { weight: 76.85, impedance: 0 },
      ),
    });

    const promise = waitForRawReading(charMap, device, adapter, PROFILE, '');
    await vi.waitFor(() => expect(notifyChar.subscribeCalled).toBe(true));

    notifyChar.triggerData(Buffer.from([0x01])); // stored record, an hour old
    notifyChar.triggerData(Buffer.from([0x02])); // live weight, held
    device.triggerDisconnect();

    const result = await promise;
    expect(result.reading).toEqual({ weight: 76.85, impedance: 0 });
    expect(result.history).toEqual([{ weight: 70.1, impedance: 0, timestamp: storedAt }]);
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
    // Three adapters declare 0 (Active Era, Hesley, 1byone new).
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

// ─── Yunmai end to end through the real adapter (#474) ──────────────────────

// The real adapter through the real session (#474). The hold is decided by the
// frame just parsed, which works only because the session reads
// completionHoldMs when the hold arms, right after that parse (#406).
describe('waitForRawReading() with a forced, nameless Yunmai (#474)', () => {
  const frame = (s: string): Buffer => Buffer.from(s.replace(/\s+/g, ''), 'hex');
  // The derived #474 frames from tests/scales/yunmai.test.ts (user id, weight,
  // resistance and body fat replaced, XOR recomputed; the second also has its
  // resistance field zeroed).
  const FINAL = frame('0d 1f 14 02 00 00 0c 51 ef 00 00 12 34 1f 40 01 d6 09 f6 ea');
  const NO_RESISTANCE = frame('0d 1f 14 02 00 00 0c 51 ef 00 00 12 34 1f 40 00 00 09 f6 3d');

  it('holds after a frame whose resistance field is 0 and settles on the one that has it', async () => {
    vi.useFakeTimers();
    try {
      const notifyChar = createMockChar();
      const writeChar = createMockChar();
      const device = createMockDevice();
      const { charMap } = createCharMap([
        [uuid16(0xffe4), notifyChar],
        [uuid16(0xffe9), writeChar],
      ]);
      const adapter = applyForcedAdapter([new YunmaiScaleAdapter()], 'Yunmai')[0];
      adapter.matches({ localName: '', serviceUuids: [] });
      const promise = waitForRawReading(charMap, device, adapter, PROFILE, '');
      await vi.advanceTimersByTimeAsync(1);
      expect(notifyChar.subscribeCalled).toBe(true);

      notifyChar.triggerData(NO_RESISTANCE);
      let settled = false;
      void promise.then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(3000);
      expect(settled, 'a frame with an empty resistance field must not end the session').toBe(
        false,
      );

      notifyChar.triggerData(FINAL);
      expect((await promise).reading).toEqual({ weight: 80, impedance: 470 });
    } finally {
      vi.useRealTimers();
    }
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
  /** The clock of the #117 capture's b3 (Unix 0x6a478eb1, UTC+10). */
  const captureClock = (): Date => {
    const d = new Date(0x6a478eb1 * 1000);
    d.getTimezoneOffset = () => -600;
    return d;
  };

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
    const adapter = new RenphoMsc04Adapter(captureClock);
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
      // The record was computed for the guest b2 we wrote, so its body fat is
      // not exported (D038): the estimate, although PROFILE_187 passes the
      // D022 height gate.
      expect(s.adapter.computeMetrics(raw.reading, PROFILE_187)).toEqual(
        buildPayload(95.55, 0, {}, PROFILE_187),
      );

      // The guest b2 (PROFILE: 180.0 cm, no last weight -> 70.00 kg) and the
      // b3 clock, no start command, then exactly the app's three status acks.
      expect(s.write.writtenData.map((b) => Buffer.from(b).toString('hex'))).toEqual([
        '55aab20009000907081b58a9ff02ef',
        '55aab3000b010701016a478eb102580011',
        '55aab000020001b2',
        '55aab000020201b4',
        '55aab000020301b5',
      ]);
      const calls = vi.mocked(s.write.write).mock.calls;
      expect(calls.every(([, withResponse]) => withResponse === true)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('writes only the clock and exports the record under BLE_RMSC04_HANDSHAKE=time', async () => {
    vi.useFakeTimers();
    vi.stubEnv('BLE_RMSC04_HANDSHAKE', 'time');
    try {
      const s = await startSession();
      // The same #117 capture frames as above, compressed in time.
      s.indicate.triggerData(hex('55aa200005000101005076'));
      s.indicate.triggerData(hex('55aa240006011100002553b3'));
      await vi.advanceTimersByTimeAsync(6165);
      s.indicate.triggerData(hex('55aa200005020901005080'));
      s.indicate.triggerData(hex('ad040255aa2500240411000025530a00de0c200b'));
      s.indicate.triggerData(hex('ae0401ef08e4092a00ae0ac10a9007e108250100'));
      s.indicate.triggerData(hex('af0400ed011101b70008ea'));
      const raw = await s.promise;

      // No guest b2 went out, so the D022 height gate decides: 187 cm passes.
      expect(s.adapter.computeMetrics(raw.reading, PROFILE_187).bodyFatPercent).toBe(23.7);
      expect(s.write.writtenData.map((b) => Buffer.from(b).toString('hex'))).toEqual([
        '55aab3000b000701016a478eb102580010', // the capture's b3, byte for byte
        '55aab000020001b2',
        '55aab000020201b4',
      ]);
    } finally {
      vi.unstubAllEnvs();
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

  it('settles on the record in a session that starts at weight locked (D057)', async () => {
    vi.useFakeTimers();
    try {
      const s = await startSession();
      // #117 capture, second connection, from weight locked on (20:28:20.418 ..
      // 30.363): what a session made after the 0x24 sees.
      s.indicate.triggerData(hex('55aa200005020901005080')); // weight locked, 0 stored
      await vi.advanceTimersByTimeAsync(9630);
      s.indicate.triggerData(hex('55aa200005031101005089')); // complete
      await vi.advanceTimersByTimeAsync(135);
      s.indicate.triggerData(hex('ad040255aa2500240411000025530a00de0c200b'));
      await vi.advanceTimersByTimeAsync(91);
      s.indicate.triggerData(hex('ae0401ef08e4092a00ae0ac10a9007e108250100'));
      await vi.advanceTimersByTimeAsync(89);
      s.indicate.triggerData(hex('af0400ed011101b70008ea'));
      await vi.advanceTimersByTimeAsync(0);
      expect(s.isSettled(), 'the record must end the session').toBe(true);

      const raw = await s.promise;
      expect(raw.reading).toEqual({ weight: 95.55, impedance: 0 });
      expect(s.adapter.isFinal(raw.reading)).toBe(true);
      // Our guest b2 went out, so the estimate (D038).
      expect(s.adapter.computeMetrics(raw.reading, PROFILE_187)).toEqual(
        buildPayload(95.55, 0, {}, PROFILE_187),
      );
      expect(s.write.writtenData.map((b) => Buffer.from(b).toString('hex'))).toEqual([
        '55aab20009000907081b58a9ff02ef',
        '55aab3000b010701016a478eb102580011',
        '55aab000020201b4',
        '55aab000020301b5',
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('gets no weight when the record of such a session is ignored, so the disconnect rejects', async () => {
    vi.useFakeTimers();
    try {
      const s = await startSession();
      // First status from vossitch's #434 log (0x09, 1 stored record), the
      // rest from the #117 capture.
      s.indicate.triggerData(hex('55aa200005010901014676'));
      s.indicate.triggerData(hex('55aa200005031101005089'));
      s.indicate.triggerData(hex('ad040255aa2500240411000025530a00de0c200b'));
      s.indicate.triggerData(hex('ae0401ef08e4092a00ae0ac10a9007e108250100'));
      s.indicate.triggerData(hex('af0400ed011101b70008ea'));
      await vi.advanceTimersByTimeAsync(0);
      expect(s.isSettled()).toBe(false);
      s.device.triggerDisconnect();
      await expect(s.promise).rejects.toThrow(/Scale disconnected before reading completed/);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ─── QN 19-byte dialect weigh-in, end to end (#331, D037) ───────────────────

// The real adapter through the real session. The adapter tests pin what
// isFinal and isCompositionPending answer; these pin that the session stays
// open through the scale's BIA after the stable weight and settles on 0x16.
describe('QN 19-byte dialect hold through waitForRawReading (#331)', () => {
  const hex = (h: string): Buffer => Buffer.from(h.replace(/ /g, ''), 'hex');
  const withSum = (frame: Buffer): Buffer => {
    const f = Buffer.from(frame);
    f[f.length - 1] = [...f.subarray(0, f.length - 1)].reduce((a, b) => a + b, 0) & 0xff;
    return f;
  };
  // #331 DEBUG log, 2026-10-06. Byte for byte from the log.
  const INFO = hex('12 13 ff 54 0b 04 00 07 ff 15 0f 27 00 00 05 03 e0 6f 2f');
  const READY = hex('14 0b ff 01 00 01 00 00 00 00 20');
  const CONFIG_REQ = hex('21 05 ff 01 26');
  const STABLE = hex('10 14 01 01 11 1e 05 00 00 00 00 00 00 00 00 00 00 00 00 5a');
  const END_MARKER = hex('23 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 23');
  // Derived from the captured frames: payload zeroed, checksum recomputed (the
  // payload is the person's body composition and is not decoded).
  const PART1 = withSum(hex('10 14 01 02 31 1e 05' + ' 00'.repeat(13)));
  const PART2 = withSum(hex('10 14 00 00 32' + ' 00'.repeat(15)));
  const PART3 = withSum(hex('10 14 00 00 33' + ' 00'.repeat(15)));
  const COMP_15 = withSum(hex('15 10 ff' + ' 00'.repeat(13)));
  const DONE_16 = withSum(hex('16 10 ff' + ' 00'.repeat(13)));
  // #331 attachment `qn-scale-v1.31.0-76.55kg.log.txt` (2026-10-07), byte for
  // byte, used with the reporter's permission: scale info (line 53), a stored
  // record from 199 s before the connect (lines 207-241) and the result block
  // after it (lines 251-287).
  const INFO_1007 = hex('12 13 ff 54 0b 04 00 07 ff 15 0f 27 00 01 05 03 e0 6f 30');
  const STORED_1007 = [
    '23 01 01 01 31 a5 60 59 32 1d e7 0e 3d 0c ad 0d e4 0c 54 40',
    '23 09 14 01 32 08 18 09 e2 08 f7 01 75 02 8d 00 00 00 00 82',
    '23 00 00 01 33 00 00 00 00 00 00 00 00 00 00 00 00 00 00 57',
    '24 13 ff 00 e7 00 00 00 00 00 00 00 00 00 00 00 00 00 1d',
    '25 0f ff 00 00 00 00 00 00 00 00 00 00 00 00 33',
  ].map(hex);
  const LIVE_1007 = [
    '10 14 01 02 31 1d e7 0e 1e 0c 8e 0d bf 0c 2f 09 3f 08 4e c7',
    '10 14 09 6b 32 08 70 01 7c 02 88 0e 1e 0c 8e 0d bf 0c 2f 16',
    '10 14 09 3f 33 08 4e 09 6b 08 70 01 86 01 72 00 ae 00 00 89',
    '15 10 ff 00 e7 02 54 03 10 06 2f 06 c7 00 bb 31',
    '16 10 ff 00 00 2a 03 3a 00 9b 02 15 03 a9 04 ee',
  ].map(hex);

  /** `idleTimeoutMs`: bound the session the way the transports do (#404). */
  async function startSession(
    scaleInfo: Buffer = INFO,
    idleTimeoutMs?: number,
    abortSignal?: AbortSignal,
  ) {
    const notify = createMockChar();
    const write = createMockChar();
    const device = createMockDevice();
    const { charMap } = createCharMap([
      [NOTIFY_UUID, notify],
      [WRITE_UUID, write],
    ]);
    const adapter = new QnScaleAdapter();
    adapter.configure({ qnWeightAck: true });
    const wait = (onActivity?: (minIdleMs?: number) => void) =>
      waitForRawReading(
        charMap,
        device,
        adapter,
        { ...PROFILE, lastKnownWeight: 76 },
        'AABBCCDDEEFF',
        undefined,
        undefined,
        undefined,
        onActivity,
      );
    const promise =
      idleTimeoutMs === undefined
        ? wait()
        : withAbandonmentCleanup(
            device,
            () =>
              untilAborted(
                withIdleTimeout(wait, idleTimeoutMs, 'GATT reading timeout'),
                abortSignal,
              ),
            abortSignal,
          );
    let settled = false;
    void promise.then(
      () => (settled = true),
      () => (settled = true),
    );
    await vi.waitFor(() => expect(notify.subscribeCalled).toBe(true));
    await vi.advanceTimersByTimeAsync(0);
    notify.triggerData(scaleInfo);
    notify.triggerData(READY);
    notify.triggerData(CONFIG_REQ);
    await vi.advanceTimersByTimeAsync(2000);
    const info = vi.spyOn(bleLog, 'info');
    const infoLines = (needle: string): number =>
      info.mock.calls.filter((c) => String(c[0]).includes(needle)).length;
    return { notify, write, device, adapter, promise, isSettled: () => settled, infoLines };
  }

  it('holds past the stable weight and settles on 0x16, with the spacing of the log', async () => {
    vi.useFakeTimers();
    try {
      const s = await startSession();
      const writesBefore = s.write.writtenData.length;
      s.notify.triggerData(STABLE); // t = 0
      await vi.advanceTimersByTimeAsync(13_150);
      s.notify.triggerData(END_MARKER);
      await vi.advanceTimersByTimeAsync(204);
      s.notify.triggerData(PART1);
      await vi.advanceTimersByTimeAsync(62);
      s.notify.triggerData(PART2);
      await vi.advanceTimersByTimeAsync(241);
      s.notify.triggerData(PART3);
      await vi.advanceTimersByTimeAsync(66);
      s.notify.triggerData(COMP_15);
      await vi.advanceTimersByTimeAsync(235);
      expect(s.isSettled(), 'the stable weight alone must not end the session').toBe(false);

      s.notify.triggerData(DONE_16); // +13.958 s
      await vi.advanceTimersByTimeAsync(0);
      expect(s.isSettled()).toBe(true);
      const raw = await s.promise;
      expect(raw.reading).toEqual({ weight: 76.85, impedance: 0 });
      expect(s.adapter.isFinal(raw.reading)).toBe(true);
      // Nothing written for any frame of the weigh-in.
      expect(s.write.writtenData.length).toBe(writesBefore);
    } finally {
      vi.useRealTimers();
    }
  });

  it('extends the hold while the BIA runs past 20 s and settles on a late 0x16', async () => {
    vi.useFakeTimers();
    try {
      const s = await startSession();
      s.notify.triggerData(STABLE);
      await vi.advanceTimersByTimeAsync(19_999);
      expect(s.infoLines('still arriving')).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(s.infoLines('still arriving')).toBe(1);

      await vi.advanceTimersByTimeAsync(10_000);
      expect(s.isSettled()).toBe(false);
      s.notify.triggerData(DONE_16); // 30 s after the stable weight
      await vi.advanceTimersByTimeAsync(0);
      expect(s.isSettled()).toBe(true);
      const raw = await s.promise;
      // The 0x16 reading, not the held one, which is provisional.
      expect(s.adapter.isFinal(raw.reading)).toBe(true);
      expect(raw.reading).toEqual({ weight: 76.85, impedance: 0 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not restart the window on the result block's first part", async () => {
    vi.useFakeTimers();
    try {
      const s = await startSession();
      s.notify.triggerData(STABLE);
      await vi.advanceTimersByTimeAsync(13_150);
      s.notify.triggerData(END_MARKER);
      await vi.advanceTimersByTimeAsync(204);
      s.notify.triggerData(PART1); // repeats the weight, status 0x02
      expect(s.infoLines('Weight stable; holding')).toBe(1);
      // The window still ends 20 s after the stable frame, not after PART1.
      await vi.advanceTimersByTimeAsync(20_000 - 13_354 - 1);
      expect(s.infoLines('still arriving')).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(s.infoLines('still arriving')).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('settles weight-only after 20 s plus the full extension when 0x16 never comes', async () => {
    vi.useFakeTimers();
    try {
      const s = await startSession();
      s.notify.triggerData(STABLE);
      await vi.advanceTimersByTimeAsync(39_999);
      expect(s.isSettled()).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(s.isSettled()).toBe(true);
      const raw = await s.promise;
      expect(raw.reading).toEqual({ weight: 76.85, impedance: 0 });
      expect(s.adapter.isFinal(raw.reading)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  // The 2026-10-07 log: the scale hands over a weigh-in from 199 s before the
  // connect, then the result block of that same weigh-in.
  it('settles on the result block after a fresh stored record, with no history', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-10-07T20:00:44Z'));
      const s = await startSession(INFO_1007);
      for (const f of STORED_1007) s.notify.triggerData(f);
      await vi.advanceTimersByTimeAsync(500);
      expect(s.isSettled(), 'a fresh stored record is held, not final').toBe(false);
      for (const f of LIVE_1007) s.notify.triggerData(f);
      await vi.advanceTimersByTimeAsync(0);
      expect(s.isSettled()).toBe(true);
      const raw = await s.promise;
      expect(raw.reading).toEqual({ weight: 76.55, impedance: 0 });
      expect(s.adapter.isFinal(raw.reading)).toBe(true);
      expect(raw.history ?? []).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('hands an older stored record over as history next to the live weigh-in', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-10-07T20:30:00Z'));
      const s = await startSession(INFO_1007);
      for (const f of STORED_1007) s.notify.triggerData(f);
      await vi.advanceTimersByTimeAsync(500);
      expect(s.isSettled()).toBe(false);
      s.notify.triggerData(STABLE);
      await vi.advanceTimersByTimeAsync(13_000);
      for (const f of [PART1, PART2, PART3, COMP_15, DONE_16]) s.notify.triggerData(f);
      await vi.advanceTimersByTimeAsync(0);
      const raw = await s.promise;
      expect(raw.reading).toEqual({ weight: 76.85, impedance: 0 });
      expect(raw.history).toEqual([
        { weight: 76.55, impedance: 0, timestamp: new Date('2026-10-07T19:57:25Z') },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  // The scale hands over a stored weigh-in, nobody is weighing, and the scale
  // keeps the link up until the caller's idle timeout gives up. The adapter
  // counted the record as reported when it handed it over (dedupMark), so a
  // timeout that dropped it would lose it for good.
  it('hands over the stored records of a session its idle timeout ended', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-10-07T20:30:00Z'));
      const s = await startSession(INFO_1007, 60_000);
      for (const f of STORED_1007) s.notify.triggerData(f);
      await vi.advanceTimersByTimeAsync(61_000);
      expect(s.isSettled()).toBe(true);
      const raw = await s.promise;
      expect(raw.reading).toEqual({
        weight: 76.55,
        impedance: 0,
        timestamp: new Date('2026-10-07T19:57:25Z'),
      });
      expect(raw.history ?? []).toEqual([]);
      expect(s.adapter.dedupMark()).toBe(844718245);
    } finally {
      vi.useRealTimers();
    }
  });

  // A shutdown only cleans up: the process is on its way out, and the stored
  // records are read again by the next one (the mark is saved after processing).
  it('hands nothing over when the session ends for a shutdown', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-10-07T20:30:00Z'));
      const shutdown = new AbortController();
      const s = await startSession(INFO_1007, 60_000, shutdown.signal);
      for (const f of STORED_1007) s.notify.triggerData(f);
      await vi.advanceTimersByTimeAsync(500);
      const outcome = s.promise.then(
        () => 'resolved',
        (e: Error) => e.message,
      );
      shutdown.abort(new Error('shutting down'));
      expect(await outcome).toBe('shutting down');
    } finally {
      vi.useRealTimers();
    }
  });

  it('still gives up on a timed-out session that collected nothing', async () => {
    vi.useFakeTimers();
    try {
      const s = await startSession(INFO_1007, 60_000);
      const outcome = s.promise.then(
        () => 'resolved',
        (e: Error) => e.message,
      );
      await vi.advanceTimersByTimeAsync(61_000);
      expect(await outcome).toBe('GATT reading timeout');
    } finally {
      vi.useRealTimers();
    }
  });

  it('settles on the held weight when the scale disconnects during the hold', async () => {
    vi.useFakeTimers();
    try {
      const s = await startSession();
      s.notify.triggerData(STABLE);
      await vi.advanceTimersByTimeAsync(5000);
      expect(s.isSettled()).toBe(false);
      s.device.triggerDisconnect();
      await vi.advanceTimersByTimeAsync(0);
      expect(s.isSettled()).toBe(true);
      const raw = await s.promise;
      expect(raw.reading).toEqual({ weight: 76.85, impedance: 0 });
    } finally {
      vi.useRealTimers();
    }
  });
});

// ─── A reading from memory whose time cannot be read (D065) ─────────────────

// The contract says an adapter must not flag a reading `fromMemory` without a
// trusted stamp; if one does anyway, the reading goes the history way dated by
// its receipt. An unreadable Date used to throw out of the notification
// handler instead, on node-ble straight out of the characteristic's emitter.
describe('waitForRawReading: a reading from memory with an unreadable stamp (D065)', () => {
  it('buffers it as history without throwing and hands it over on the disconnect', async () => {
    const debug = vi.spyOn(bleLog, 'debug').mockImplementation(() => {});
    try {
      const notify = createMockChar();
      const write = createMockChar();
      const device = createMockDevice();
      const { charMap } = createCharMap([
        [NOTIFY_UUID, notify],
        [WRITE_UUID, write],
      ]);
      const adapter = createLegacyAdapter({
        parseNotification: () => ({
          weight: 70,
          impedance: 500,
          timestamp: new Date(NaN),
          fromMemory: true,
        }),
      });
      const promise = waitForRawReading(charMap, device, adapter, PROFILE, 'AABBCCDDEEFF');
      await vi.waitFor(() => expect(notify.subscribeCalled).toBe(true));

      expect(() => notify.triggerData(Buffer.from([0x01]))).not.toThrow();
      device.triggerDisconnect();
      const raw = await promise;
      expect(raw.reading.fromMemory).toBe(true);
      expect(raw.reading.weight).toBe(70);
      const lines = debug.mock.calls.map((c) => String(c[0]));
      expect(
        lines.some((l) => l.includes('Historical reading buffered') && l.includes('receipt time')),
      ).toBe(true);
    } finally {
      debug.mockRestore();
    }
  });
});

// ─── QN 18-byte stored weigh-in through waitForRawReading (#463, D065) ──────

// The real adapter through the real session, frames and their spacing from the
// public #463 DEBUG log of the first connection after step 3 (2026-10-13
// 18:03:57). Where a frame carries the scale's own body fat (0x23 [16..17],
// live 0x10 [11..12]) those bytes are zeroed and the checksum recomputed;
// nothing here reads them. The 0x24/0x25 composition frames of the record are
// left out: the adapter ignores them on this dialect.
describe('QN 18-byte stored weigh-in through waitForRawReading (#463)', () => {
  const hex = (h: string): Buffer => Buffer.from(h.replace(/ /g, ''), 'hex');
  const INFO = hex('12 12 ff 25 e0 16 00 05 ff 13 07 16 00 01 05 9f 32 49');
  const READY = hex('14 0b ff 01 00 01 09 03 00 00 2c');
  const CONFIG_REQ = hex('21 05 ff 01 26');
  const VISIT_OK = hex('a1 06 02 01 01 ab');
  const MEASURING = hex('10 0f ff 01 01 1b f8 00 00 00 00 00 00 00 33');
  const RECORD = hex('23 14 ff 01 01 01 0a 2e 61 32 1b f3 10 d9 10 fe 00 00 00 09');
  const LIVE = hex('10 0f ff 01 02 1b f8 10 fb 10 f9 00 00 00 48');
  const ADVERT = {
    id: 0xffff,
    data: hex('08 14 01 00 01 25 e0 16 00 05 ff 61 08 01 00 15'),
  };
  const ADDRESS = 'FF050016E025';
  /** The record, 71.55 kg at 17:59:38Z in user slot 1, as the reading it becomes. */
  const STORED = {
    weight: 71.55,
    impedance: 497,
    timestamp: new Date('2026-10-13T17:59:38.000Z'),
    fromMemory: true,
  };

  async function startSession() {
    const notify = createMockChar();
    const write = createMockChar();
    const device = createMockDevice();
    const { charMap } = createCharMap([
      [NOTIFY_UUID, notify],
      [WRITE_UUID, write],
    ]);
    const adapter = new QnScaleAdapter();
    adapter.configure({ qnUserKey: 1000 });
    const promise = waitForRawReading(
      charMap,
      device,
      adapter,
      PROFILE,
      ADDRESS,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      ADVERT,
    );
    let settled = false;
    void promise.then(
      () => (settled = true),
      () => (settled = true),
    );
    await vi.waitFor(() => expect(notify.subscribeCalled).toBe(true));
    await vi.advanceTimersByTimeAsync(0);
    return { notify, device, promise, isSettled: () => settled };
  }

  /** The session of the log up to and including the stored record. */
  async function upToTheRecord(s: Awaited<ReturnType<typeof startSession>>) {
    const steps: [number, Buffer][] = [
      [132, INFO],
      [732, READY],
      [246, CONFIG_REQ],
      [290, VISIT_OK],
      [341, MEASURING],
      [781, RECORD],
    ];
    for (const [gapMs, frame] of steps) {
      await vi.advanceTimersByTimeAsync(gapMs);
      s.notify.triggerData(frame);
    }
  }

  it.each([
    ['from minutes before the session (start chosen at 18:09:00)', '2026-10-13T18:09:00Z'],
    ['259 s before the session, as in the log', '2026-10-13T18:03:57.411Z'],
  ])(
    'hands a stored weigh-in %s over as history next to the live one',
    async (_label, startedAt) => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date(startedAt));
        const s = await startSession();
        await upToTheRecord(s);
        await vi.advanceTimersByTimeAsync(974);
        expect(s.isSettled(), 'a stored weigh-in does not end the session').toBe(false);
        s.notify.triggerData(LIVE);
        await vi.advanceTimersByTimeAsync(0);
        const raw = await s.promise;
        expect(raw.reading).toEqual({ weight: 71.6, impedance: 507 });
        expect(raw.history).toEqual([STORED]);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it('hands it over on the disconnect when no live weigh-in follows', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-10-13T18:09:00Z'));
      const s = await startSession();
      await upToTheRecord(s);
      await vi.advanceTimersByTimeAsync(500);
      s.device.triggerDisconnect();
      const raw = await s.promise;
      expect(raw.reading).toEqual(STORED);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ─── QN 18-byte weigh-in before the stored-record answer (#463, D065) ──────

// The real adapter through the real session. Frames and their spacing up to
// the final live frame are from the public #463 DEBUG log of 2026-10-19 16:38:
// the scale accepted the profile and sent its final 49 ms later, and the
// session used to end on it before our 0x22 went out. The answers after it
// are real frames in orders and at times no log shows: the #463 record of
// 2026-10-13 (body fat zeroed, checksum recomputed) or the #461 "no stored
// weigh-ins" frames, at the 0x23 -> 0x24 -> 0x25 spacing of the 10-13 log.
// No 18-byte log has a batch of two records, so `ofTwo` derives one.
describe('QN 18-byte weigh-in before the stored-record answer through waitForRawReading (#463)', () => {
  const hex = (h: string): Buffer => Buffer.from(h.replace(/ /g, ''), 'hex');
  const INFO = hex('12 12 ff 25 e0 16 00 05 ff 13 07 16 00 03 05 9f 32 4b');
  const READY = hex('14 0b ff 01 00 01 09 03 00 00 2c');
  const CONFIG_REQ = hex('21 05 ff 01 26');
  const VISIT_OK = hex('a1 06 02 01 01 ab');
  const FINAL = hex('10 0f ff 01 02 1b cb 10 db 10 d9 00 00 00 db');
  const RECORD = hex('23 14 ff 01 01 01 0a 2e 61 32 1b f3 10 d9 10 fe 00 00 00 09');
  const NO_RECORDS = hex('23 14 ff' + ' 00'.repeat(16) + ' 36');
  const EMPTY_24 = hex('24 10 ff' + ' 00'.repeat(12) + ' 33');
  const EMPTY_25 = hex('25 0f ff' + ' 00'.repeat(12) + ' 33');
  const ADVERT = { id: 0xffff, data: hex('08 14 01 00 03 25 e0 16 00 05 ff 61 08 02 00 15') };
  const ADDRESS = 'FF050016E025';
  const QUERY = hex('22 06 00 00 03 2b');
  const ACK = hex('1f 05 00 10 34');
  const WEIGH_IN = { weight: 71.15, impedance: 499 };
  /** The record, 71.55 kg at 2026-10-13T17:59:38Z in user slot 1, as history. */
  const STORED = {
    weight: 71.55,
    impedance: 497,
    timestamp: new Date('2026-10-13T17:59:38.000Z'),
    fromMemory: true,
  };
  /** RECORD as record `index` of two, `later` s after its time: [3], [4], [6..9], [19]. */
  const ofTwo = (index: number, later: number): Buffer => {
    const f = Buffer.from(RECORD);
    f[3] = 2;
    f[4] = index;
    f.writeUInt32LE(RECORD.readUInt32LE(6) + later, 6);
    f[19] = [...f.subarray(0, 19)].reduce((a, b) => a + b, 0) & 0xff;
    return f;
  };

  async function startSession(opts: { key?: boolean; idleTimeoutMs?: number } = {}) {
    const notify = createMockChar();
    const write = createMockChar();
    const device = createMockDevice();
    const { charMap } = createCharMap([
      [NOTIFY_UUID, notify],
      [WRITE_UUID, write],
    ]);
    const adapter = new QnScaleAdapter();
    if (opts.key !== false) adapter.configure({ qnUserKey: 1000 });
    const wait = (onActivity?: (minIdleMs?: number) => void) =>
      waitForRawReading(
        charMap,
        device,
        adapter,
        PROFILE,
        ADDRESS,
        undefined,
        undefined,
        undefined,
        onActivity,
        undefined,
        ADVERT,
      );
    const promise =
      opts.idleTimeoutMs === undefined
        ? wait()
        : withAbandonmentCleanup(device, () =>
            withIdleTimeout(wait, opts.idleTimeoutMs!, 'GATT reading timeout'),
          );
    let settled = false;
    void promise.then(
      () => (settled = true),
      () => (settled = true),
    );
    await vi.waitFor(() => expect(notify.subscribeCalled).toBe(true));
    await vi.advanceTimersByTimeAsync(0);
    const info = vi.spyOn(bleLog, 'info');
    const infoLines = (needle: string): number =>
      info.mock.calls.filter((c) => String(c[0]).includes(needle)).length;
    const writes = (frame: Buffer): number =>
      write.writtenData.filter((w) => w.equals(frame)).length;
    const writtenAt = (frame: Buffer): number =>
      write.writtenData.findIndex((w) => w.equals(frame));
    return {
      notify,
      device,
      promise,
      isSettled: () => settled,
      infoLines,
      writes,
      writtenAt,
    };
  }

  /** The log up to its final live frame; returns how many 0x22 went out before it. */
  async function upToTheFinal(s: Awaited<ReturnType<typeof startSession>>): Promise<number> {
    const steps: [number, Buffer][] = [
      [130, INFO],
      [194, INFO],
      [210, INFO],
      [146, READY],
      [249, CONFIG_REQ],
      [287, VISIT_OK],
    ];
    for (const [gapMs, frame] of steps) {
      await vi.advanceTimersByTimeAsync(gapMs);
      s.notify.triggerData(frame);
    }
    await vi.advanceTimersByTimeAsync(49);
    const queriesBefore = s.writes(QUERY);
    s.notify.triggerData(FINAL);
    await vi.advanceTimersByTimeAsync(0);
    return queriesBefore;
  }

  /** Feed frames at the given gaps (ms) and let the session react. */
  async function feed(s: Awaited<ReturnType<typeof startSession>>, steps: [number, Buffer][]) {
    for (const [gapMs, frame] of steps) {
      await vi.advanceTimersByTimeAsync(gapMs);
      s.notify.triggerData(frame);
    }
    await vi.advanceTimersByTimeAsync(0);
  }

  const START = '2026-10-19T16:38:13.480Z';

  it('asks on the acceptance, holds the weigh-in and settles on the last 0x25 with the record', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(START));
      const s = await startSession();
      expect(await upToTheFinal(s), 'the 0x22 goes out on the acceptance').toBe(1);
      expect(s.isSettled(), 'the weigh-in waits for the answer').toBe(false);
      await feed(s, [
        [300, RECORD],
        [146, EMPTY_24],
      ]);
      expect(s.isSettled(), 'not on the 0x24').toBe(false);
      await feed(s, [[146, EMPTY_25]]);
      expect(s.isSettled()).toBe(true);
      const raw = await s.promise;
      expect(raw.reading).toEqual(WEIGH_IN);
      expect(raw.history).toEqual([STORED]);
      expect(s.writes(QUERY)).toBe(1);
      expect(s.writtenAt(QUERY)).toBeLessThan(s.writtenAt(ACK));
    } finally {
      vi.useRealTimers();
    }
  });

  it('settles at once on a "no stored weigh-ins" answer', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(START));
      const s = await startSession();
      await upToTheFinal(s);
      await vi.advanceTimersByTimeAsync(305);
      expect(s.isSettled()).toBe(false);
      await feed(s, [[1, NO_RECORDS]]);
      expect(s.isSettled()).toBe(true);
      const raw = await s.promise;
      expect(raw.reading).toEqual(WEIGH_IN);
      expect(raw.history ?? []).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('settles 3 s after the weigh-in when the scale does not answer', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(START));
      const s = await startSession();
      await upToTheFinal(s);
      await vi.advanceTimersByTimeAsync(2999);
      expect(s.isSettled()).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(s.isSettled()).toBe(true);
      expect((await s.promise).reading).toEqual(WEIGH_IN);
      expect(s.infoLines('holding connection up to 3s')).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps holding while a batch is still arriving', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(START));
      const s = await startSession();
      await upToTheFinal(s);
      await feed(s, [
        [300, ofTwo(1, 0)],
        [146, EMPTY_24],
        [146, EMPTY_25],
      ]);
      await vi.advanceTimersByTimeAsync(3000 - 592);
      expect(s.isSettled()).toBe(false);
      expect(s.infoLines('still arriving')).toBe(1);
      await feed(s, [
        [300, ofTwo(2, 60)],
        [146, EMPTY_24],
        [146, EMPTY_25],
      ]);
      expect(s.isSettled()).toBe(true);
      const raw = await s.promise;
      expect(raw.reading).toEqual(WEIGH_IN);
      expect(raw.history).toEqual([
        STORED,
        { ...STORED, timestamp: new Date('2026-10-13T18:00:38.000Z') },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  // Through the transports' idle deadline at session_timeout_sec's minimum.
  it('settles 23 s after the weigh-in when the rest of a batch never comes', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(START));
      const s = await startSession({ idleTimeoutMs: 5000 });
      await upToTheFinal(s);
      await feed(s, [
        [300, ofTwo(1, 0)],
        [146, EMPTY_24],
        [146, EMPTY_25],
      ]);
      await vi.advanceTimersByTimeAsync(23_000 - 592 - 1);
      expect(s.isSettled()).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(s.isSettled()).toBe(true);
      const raw = await s.promise;
      expect(raw.reading).toEqual(WEIGH_IN);
      expect(raw.history).toEqual([STORED]);
    } finally {
      vi.useRealTimers();
    }
  });

  // A unit that sends no 0x24 and 0x25 after its record waits the 3 s, no more.
  it("settles 3 s after the weigh-in when the last record's 0x25 never comes", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(START));
      const s = await startSession();
      await upToTheFinal(s);
      await feed(s, [[300, RECORD]]);
      await vi.advanceTimersByTimeAsync(3000 - 300 - 1);
      expect(s.isSettled()).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(s.isSettled()).toBe(true);
      const raw = await s.promise;
      expect(raw.reading).toEqual(WEIGH_IN);
      expect(raw.history).toEqual([STORED]);
      expect(s.infoLines('still arriving')).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('settles on the held weigh-in when the scale disconnects during the hold', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(START));
      const s = await startSession();
      await upToTheFinal(s);
      await vi.advanceTimersByTimeAsync(500);
      expect(s.isSettled()).toBe(false);
      s.device.triggerDisconnect();
      await vi.advanceTimersByTimeAsync(0);
      expect(s.isSettled()).toBe(true);
      expect((await s.promise).reading).toEqual(WEIGH_IN);
    } finally {
      vi.useRealTimers();
    }
  });

  it('still ends on the weigh-in at once without ble.qn_user_key', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(START));
      const s = await startSession({ key: false });
      expect(await upToTheFinal(s)).toBe(0);
      expect(s.isSettled()).toBe(true);
      expect((await s.promise).reading).toEqual(WEIGH_IN);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ─── ES-CS20M with AE00 through waitForRawReading (#436) ─────────────────────

describe('ES-CS20M on an AE00 unit through waitForRawReading (#436)', () => {
  const hex = (h: string): Buffer => Buffer.from(h, 'hex');
  const clock = (): Date => {
    const d = new Date(0x6ac01376 * 1000);
    d.getTimezoneOffset = () => 240;
    return d;
  };

  it('writes nothing to 2A11 before the first notification, then the app sequence with response', async () => {
    const notify = createMockChar();
    const write = createMockChar();
    const device = createMockDevice();
    const { charMap } = createCharMap([
      [uuid16(0x2a10), notify],
      [uuid16(0x2a11), write],
      [uuid16(0xae01), createMockChar()],
      [uuid16(0xae02), createMockChar()],
    ]);
    const adapter = new EsCs20mAdapter(clock);
    const promise = waitForRawReading(charMap, device, adapter, PROFILE, 'AABBCCDDEEFF');
    await vi.waitFor(() => expect(notify.subscribeCalled).toBe(true));
    await new Promise((r) => setTimeout(r, 20));
    // The legacy path wrote the kg command here, before CCCD, on every unit.
    expect(write.writtenData).toEqual([]);

    // The power-on frame from the #436 app capture (lb on the display).
    notify.triggerData(hex('55aa11000a010201000000000000001e'));
    await vi.waitFor(() => expect(write.writtenData).toHaveLength(4));
    expect(write.writtenData.map((b) => Buffer.from(b).toString('hex'))).toEqual([
      '55aa9100010192',
      '55aa9700090100006ac01376010458',
      buildGuestProfileFrame(PROFILE, clock()).toString('hex'),
      '55aa9000040200000095',
    ]);
    expect(vi.mocked(write.write).mock.calls.every(([, withResponse]) => withResponse)).toBe(true);

    // Public #376 frames to finish the session: a weight, then power-off.
    notify.triggerData(hex('55aa140007000000286e0000b0'));
    notify.triggerData(hex('55aa11000a0001010000550000000071'));
    const raw = await promise;
    expect(raw.reading).toEqual({ weight: 103.5, impedance: 0 });
  });

  // The two barefoot weigh-ins of #436 comment 6112383314, with the log's
  // timing (ms after the power-on frame). The 0x18 frames have the scale's BMI
  // and body fat zeroed and the checksum recomputed; see es-cs20m.test.ts.
  const POWER_ON = '55aa11000a010201000000000000001e';
  const POWER_OFF = '55aa11000a000201000000000000001d';
  const W = (tail: string): string => '55aa140007000000' + tail;

  async function startSession() {
    const notify = createMockChar();
    const write = createMockChar();
    const device = createMockDevice();
    const { charMap } = createCharMap([
      [uuid16(0x2a10), notify],
      [uuid16(0x2a11), write],
      [uuid16(0xae01), createMockChar()],
      [uuid16(0xae02), createMockChar()],
    ]);
    const adapter = new EsCs20mAdapter(clock);
    const promise = waitForRawReading(charMap, device, adapter, PROFILE, 'AABBCCDDEEFF');
    let settled = false;
    void promise.then(
      () => (settled = true),
      () => (settled = true),
    );
    await vi.waitFor(() => expect(notify.subscribeCalled).toBe(true));
    await vi.advanceTimersByTimeAsync(0);
    /** Deliver frames at their offsets from the first one's delivery. */
    const play = async (frames: [number, string][]): Promise<void> => {
      let at = 0;
      for (const [t, h] of frames) {
        await vi.advanceTimersByTimeAsync(t - at);
        at = t;
        notify.triggerData(hex(h));
      }
    };
    return { promise, play, isSettled: () => settled };
  }

  it('completes the weigh-in that got no power-off 30 s after its 0x18', async () => {
    vi.useFakeTimers();
    try {
      const s = await startSession();
      // First barefoot weigh-in: the session timed out 60 s after the 0x18.
      await s.play([
        [0, POWER_ON],
        [323, '55aa17000201011a'],
        [536, '55aa160001091f'],
        [536, W('36560000a6')], // 139.10
        [711, W('36600000b0')], // 139.20
        [808, '55aa1000010111'],
        [908, W('36600000b0')],
        [1045, W('36560000a6')],
        [11_867, '55aa18000d0101090000365601d60000000092'], // 139.10 kg, 470 ohm
      ]);
      await vi.advanceTimersByTimeAsync(29_999);
      expect(s.isSettled()).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(s.isSettled()).toBe(true);
      expect((await s.promise).reading).toEqual({ weight: 139.1, impedance: 470 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('holds from the 0x18 to the power-off and completes with the resistance', async () => {
    vi.useFakeTimers();
    try {
      const s = await startSession();
      // Second barefoot weigh-in.
      await s.play([
        [0, POWER_ON],
        [305, '55aa17000201011a'],
        [413, '55aa160001091f'],
        [528, W('3548000097')], // 136.40
        [616, '55aa1000010111'],
        [617, W('36c4000014')], // 140.20
        [805, W('358e0000dd')],
        [1042, W('37500000a1')],
        [1144, W('35d4000023')],
        [1345, W('369c0000ec')],
        [1435, W('3732000083')],
        [1976, W('35d4000023')],
        [1978, W('367e0000ce')],
        [1982, W('36740000c4')],
        [2149, W('36740000c4')],
        [2340, W('36e2000032')],
        [2457, W('35b6000005')],
        [2682, W('36920000e2')],
        [2956, W('369c0000ec')],
        [2968, W('36560000a6')], // 139.10
        [3175, W('36560000a6')],
        [3365, W('369c0000ec')],
        [3480, W('36560000a6')],
        [3687, W('36560000a6')],
        [3896, W('36560000a6')],
        [3992, W('36560000a6')],
        [4134, W('36560000a6')],
        [4338, W('36560000a6')],
        [4509, W('36560000a6')],
        [12_084, '55aa18000d0101090000365601940000000050'], // 139.10 kg, 404 ohm
      ]);
      await vi.advanceTimersByTimeAsync(22_920);
      expect(s.isSettled()).toBe(false);
      await s.play([[1, POWER_OFF]]);
      await vi.advanceTimersByTimeAsync(0);
      expect(s.isSettled()).toBe(true);
      expect((await s.promise).reading).toEqual({ weight: 139.1, impedance: 404 });
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

// ─── Deferred notify binding (#408) ─────────────────────────────────────────

describe('deferred notify binding (#408)', () => {
  const DEFERRED_UUID = '00002a9d00001000800000805f9b34fb';
  const TIME_UUID = '00002a0800001000800000805f9b34fb';

  /** Mock chars that log every write and subscribe into one shared wire order. */
  function wiredChar(label: string, wire: string[]): MockBleChar {
    const char = createMockChar();
    const baseSubscribe = char.subscribe;
    const baseWrite = char.write;
    char.subscribe = vi.fn(async (onData: (data: Buffer) => void) => {
      wire.push(`subscribe ${label}`);
      return baseSubscribe(onData);
    });
    char.write = vi.fn(async (data: Buffer, withResponse: boolean) => {
      wire.push(`write ${label}`);
      return baseWrite(data, withResponse);
    });
    return char;
  }

  it('leaves a deferred binding to onConnected, which writes before it subscribes', async () => {
    // The order the vendor app uses on the wire: the time write first, then the
    // CCCD (oliexdev/openScale#1505 capture, 3 of 3 connections). Without the
    // flag the handler enabled the binding before onConnected ever ran.
    const wire: string[] = [];
    const indicate = wiredChar('2a9d', wire);
    const time = wiredChar('2a08', wire);
    const device = createMockDevice();
    const { charMap } = createCharMap([
      [DEFERRED_UUID, indicate],
      [TIME_UUID, time],
    ]);
    const infoSpy = vi.spyOn(bleLog, 'info');

    const adapter = createLegacyAdapter({
      characteristics: [
        { uuid: DEFERRED_UUID, type: 'notify', deferred: true },
        { uuid: TIME_UUID, type: 'write', optional: true },
      ],
      onConnected: vi.fn(async (ctx: ConnectionContext) => {
        await ctx.write(TIME_UUID, [0x01], true);
        await ctx.subscribe(DEFERRED_UUID);
      }),
      parseCharNotification: vi.fn(() => ({ weight: 65.7, impedance: 500 })),
    });

    const promise = waitForRawReading(charMap, device, adapter, PROFILE, '');
    await vi.waitFor(() => expect(adapter.onConnected).toHaveBeenCalled());
    await vi.waitFor(() => expect(wire).toContain('subscribe 2a9d'));
    indicate.triggerData(Buffer.from([0x02]));
    const raw = await promise;

    expect(raw.reading.weight).toBe(65.7);
    expect(wire).toEqual(['write 2a08', 'subscribe 2a9d']);
    // The handler's own prompt would come before the scale can say anything.
    expect(
      infoSpy.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith('Subscribed')),
    ).toEqual([]);
  });

  it('accepts an adapter whose only notify binding is deferred', async () => {
    const indicate = createMockChar();
    const device = createMockDevice();
    const { charMap } = createCharMap([[DEFERRED_UUID, indicate]]);

    const adapter = createLegacyAdapter({
      characteristics: [{ uuid: DEFERRED_UUID, type: 'notify', deferred: true }],
      onConnected: vi.fn(async (ctx: ConnectionContext) => {
        await ctx.subscribe(DEFERRED_UUID);
      }),
      parseCharNotification: vi.fn(() => ({ weight: 65.7, impedance: 500 })),
    });

    const promise = waitForRawReading(charMap, device, adapter, PROFILE, '');
    await vi.waitFor(() => expect(indicate.subscribeCalled).toBe(true));
    indicate.triggerData(Buffer.from([0x02]));
    await expect(promise).resolves.toMatchObject({ reading: { weight: 65.7 } });
    expect(indicate.subscribe).toHaveBeenCalledTimes(1);
  });

  // Guard, green before and after: every other adapter keeps its order and its
  // log line byte for byte.
  it('enables an ordinary binding before onConnected next to a deferred one', async () => {
    const wire: string[] = [];
    const ordinary = wiredChar('fff1', wire);
    const indicate = wiredChar('2a9d', wire);
    const device = createMockDevice();
    const { charMap } = createCharMap([
      [NOTIFY_UUID, ordinary],
      [DEFERRED_UUID, indicate],
    ]);

    const adapter = createLegacyAdapter({
      characteristics: [
        { uuid: NOTIFY_UUID, type: 'notify' },
        { uuid: DEFERRED_UUID, type: 'notify', deferred: true },
      ],
      onConnected: vi.fn(async (ctx: ConnectionContext) => {
        wire.push('onConnected');
        await ctx.subscribe(DEFERRED_UUID);
      }),
      parseCharNotification: vi.fn(() => ({ weight: 75, impedance: 500 })),
    });

    const promise = waitForRawReading(charMap, device, adapter, PROFILE, '');
    await vi.waitFor(() => expect(wire).toContain('subscribe 2a9d'));
    ordinary.triggerData(Buffer.from([0x01]));
    await promise;
    expect(wire).toEqual(['subscribe fff1', 'onConnected', 'subscribe 2a9d']);
  });

  it('keeps the order and the prompt of an adapter without a deferred binding', async () => {
    const wire: string[] = [];
    const first = wiredChar('fff1', wire);
    const second = wiredChar('fff3', wire);
    const device = createMockDevice();
    const NOTIFY2_UUID = '0000fff300001000800000805f9b34fb';
    const { charMap } = createCharMap([
      [NOTIFY_UUID, first],
      [NOTIFY2_UUID, second],
    ]);
    const infoSpy = vi.spyOn(bleLog, 'info');

    const adapter = createLegacyAdapter({
      characteristics: [
        { uuid: NOTIFY_UUID, type: 'notify' },
        { uuid: NOTIFY2_UUID, type: 'notify' },
      ],
      onConnected: vi.fn(() => {
        wire.push('onConnected');
      }),
      parseCharNotification: vi.fn(() => ({ weight: 75, impedance: 500 })),
    });

    const promise = waitForRawReading(charMap, device, adapter, PROFILE, '');
    await vi.waitFor(() => expect(adapter.onConnected).toHaveBeenCalled());
    first.triggerData(Buffer.from([0x01]));
    await promise;
    expect(wire).toEqual(['subscribe fff1', 'subscribe fff3', 'onConnected']);
    expect(infoSpy.mock.calls.map((c) => String(c[0]))).toContain(
      'Subscribed to 2 notification(s). Step on the scale.',
    );
  });
});

describe('stopDeferredNotifications() (#408)', () => {
  const DEFERRED_UUID = '00002a9d00001000800000805f9b34fb';

  function stoppable(): MockBleChar & { stop: ReturnType<typeof vi.fn> } {
    return Object.assign(createMockChar(), { stop: vi.fn(async () => {}) });
  }

  it('turns off each deferred binding the transport can stop, and nothing else', async () => {
    const deferredChar = stoppable();
    const ordinary = stoppable();
    const { charMap } = createCharMap([
      [DEFERRED_UUID, deferredChar],
      [NOTIFY_UUID, ordinary],
    ]);
    const adapter = createLegacyAdapter({
      characteristics: [
        { uuid: NOTIFY_UUID, type: 'notify' },
        { uuid: DEFERRED_UUID, type: 'notify', deferred: true },
      ],
      onConnected: vi.fn(),
    });

    await expect(stopDeferredNotifications(charMap, adapter)).resolves.toBe(1);
    expect(deferredChar.stop).toHaveBeenCalledTimes(1);
    expect(ordinary.stop).not.toHaveBeenCalled();
  });

  it('touches nothing for an adapter without a deferred binding', async () => {
    const char = stoppable();
    const { charMap } = createCharMap([[NOTIFY_UUID, char]]);
    const adapter = createLegacyAdapter({
      characteristics: [{ uuid: NOTIFY_UUID, type: 'notify' }],
      onConnected: vi.fn(),
    });
    await expect(stopDeferredNotifications(charMap, adapter)).resolves.toBe(0);
    expect(char.stop).not.toHaveBeenCalled();
  });

  it('never throws: a failing stop costs nothing but a debug line', async () => {
    const char = stoppable();
    char.stop.mockRejectedValue(new Error('org.bluez.Error.NotConnected'));
    const { charMap } = createCharMap([[DEFERRED_UUID, char]]);
    const adapter = createLegacyAdapter({
      characteristics: [{ uuid: DEFERRED_UUID, type: 'notify', deferred: true }],
      onConnected: vi.fn(),
    });
    await expect(stopDeferredNotifications(charMap, adapter)).resolves.toBe(0);
  });
});
