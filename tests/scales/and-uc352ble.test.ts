import { describe, it, expect, vi, afterEach } from 'vitest';
import { AndUc352bleAdapter } from '../../src/scales/and-uc352ble.js';
import { StandardGattScaleAdapter } from '../../src/scales/standard-gatt.js';
import { adapters } from '../../src/scales/index.js';
import { resolveAdapter, resolveAfterDiscovery } from '../../src/scales/resolve.js';
import { checkRegistryIntegrity } from '../../src/scales/registry-check.js';
import { uuid16 } from '../../src/scales/body-comp-helpers.js';
import { isHistoricalReading } from '../../src/interfaces/reading-time.js';
import { waitForRawReading } from '../../src/ble/shared.js';
import type { BleChar, BleDevice } from '../../src/ble/session/ports.js';
import { bleLog, normalizeUuid } from '../../src/ble/types.js';
import { assertPayloadRanges, defaultProfile } from '../helpers/scale-test-utils.js';
import type { BleDeviceInfo, ConnectionContext } from '../../src/interfaces/scale-adapter.js';

/*
 * Every frame here is from one public capture: the btsnoop_hci.log attached to
 * oliexdev/openScale#1505 (mrblowntobits), an Android phone talking to
 * A&D_UC-352BLE_01166D (5C:31:3E:01:16:6D) on 2026-08-22, three connections.
 * Times are the capture's, UTC; the phone was on CEST (UTC+2), so the scale's
 * local stamps read two hours later. The only altered frames are changes to
 * these, used to show a refusal or a stored record, and each says which bytes
 * changed.
 */

/** Advertising report, 06:42:34.698 (ADV_IND): flags 0x04, WSS 0x181D, conn interval. */
const ADV_IND_RAW = '02010403021d18051240005000';
/** Its scan response, 06:42:34.699: TX power 0 dBm, the name. */
const SCAN_RSP_RAW = '020a0015094126445f55432d333532424c455f303131363644';

const MAC = '5C:31:3E:01:16:6D';
/** The name from SCAN_RSP_RAW, bytes 5.. ("A&D_UC-352BLE_01166D"). */
const NAME = Buffer.from(SCAN_RSP_RAW, 'hex').subarray(5).toString('latin1');

/** The 16-bit service list in ADV_IND_RAW, bytes 5..6 ("1d 18"). */
const WSS = Buffer.from(ADV_IND_RAW, 'hex').readUInt16LE(5).toString(16);

/** Both reports merged, as noble and the proxies deliver them. */
const ADVERT: BleDeviceInfo = { localName: NAME, address: MAC, serviceUuids: [WSS] };

/** Connection 1, 06:42:37.199: Weight Measurement indication, 65.70 kg, stamped 08:42:36 local. */
const WM_6570 = '025433ea070816082a24';
/** Connection 2, 06:43:11.909: 65.60 kg, stamped 08:43:11 local. */
const WM_6560 = '024033ea070816082b0b';
/** Connection 3, 06:43:41.257: 65.90 kg, stamped 08:43:40 local. */
const WM_6590 = '027c33ea070816082b28';
/** Connection 1, 06:42:36.869: the app's 7-byte Write Request to Date Time (handle 0x0017). */
const DATE_TIME_0842_36 = 'ea070816082a24';

/**
 * GATT layout: the discovery dump in HEADS-project/ThingML-BLE
 * (Documentation/AND_Medical_UC352BLE.md, another unit). The capture has no
 * discovery, but every handle it touches has the type this dump predicts.
 */
const VENDOR_SERVICE = '233bf0005a341b6d975c000d5690abe4';
const VENDOR_CHAR = '233bf0015a341b6d975c000d5690abe4';
const GATT_LAYOUT = {
  serviceUuids: [...[0x1800, 0x1801, 0x181d, 0x180a, 0x180f].map(uuid16), VENDOR_SERVICE],
  characteristicUuids: [
    ...[
      0x2a00, 0x2a01, 0x2a02, 0x2a03, 0x2a04, 0x2a05, 0x2a9d, 0x2a9e, 0x2a08, 0x2a29, 0x2a24,
      0x2a25, 0x2a27, 0x2a26, 0x2a28, 0x2a23, 0x2a2a, 0x2a19,
    ].map(uuid16),
    VENDOR_CHAR,
  ],
};

const WM = uuid16(0x2a9d);
const DT = uuid16(0x2a08);
const frame = (hex: string): Buffer => Buffer.from(hex, 'hex');

/** Run `fn` with the process in the reporter's zone, then put the zone back. */
function inBratislava<T>(fn: () => T): T {
  const saved = process.env.TZ;
  process.env.TZ = 'Europe/Bratislava';
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env.TZ;
    else process.env.TZ = saved;
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('A&D UC-352BLE matching', () => {
  const a = new AndUc352bleAdapter();

  it.each([
    ['noble / proxy (both reports merged)', ADVERT],
    ['node-ble before connect (no services)', { localName: NAME, address: MAC, serviceUuids: [] }],
    ['noble on macOS (no address)', { localName: NAME, serviceUuids: ['181d'] }],
    ['lower case', { localName: NAME.toLowerCase(), serviceUuids: [] }],
  ])('claims the name: %s', (_label, info) => {
    expect(a.matches(info as BleDeviceInfo)).toBe(true);
  });

  it.each([
    ['the nameless ADV_IND (0x181D only)', { localName: '', address: MAC, serviceUuids: ['181d'] }],
    // Derived from SCAN_RSP_RAW: the sibling model openScale's test rejects too.
    ['A&D_UC-355BLE_01166D', { localName: 'A&D_UC-355BLE_01166D', serviceUuids: ['181d'] }],
    ['a generic WSS scale', { localName: 'GenericScale', serviceUuids: ['181d'] }],
    // The model number without the vendor prefix: the claim is the whole prefix.
    ['UC-352BLE alone', { localName: 'UC-352BLE', serviceUuids: [] }],
  ])('does not claim %s', (_label, info) => {
    expect(a.matches(info as BleDeviceInfo)).toBe(false);
  });

  it('wins every named shape in the live registry, and leaves the nameless one to Standard GATT', () => {
    expect(resolveAdapter(ADVERT, adapters)?.name).toBe('A&D UC-352BLE');
    expect(
      resolveAdapter({ localName: NAME, address: MAC, serviceUuids: [] }, adapters)?.name,
    ).toBe('A&D UC-352BLE');
    expect(resolveAdapter({ localName: NAME, serviceUuids: [] }, adapters)?.name).toBe(
      'A&D UC-352BLE',
    );
    expect(
      resolveAdapter({ localName: '', address: MAC, serviceUuids: ['181d'] }, adapters)?.name,
    ).toBe('Standard GATT (BCS/WSS)');
  });

  it('keeps the claim once GATT discovery has run', () => {
    // node-ble with ble.scale_mac: advertised services unknown.
    expect(
      resolveAfterDiscovery(
        { localName: NAME, address: MAC, serviceUuids: [] },
        { ...GATT_LAYOUT, advertisedServicesKnown: false },
        adapters,
      )?.name,
    ).toBe('A&D UC-352BLE');
    expect(resolveAfterDiscovery(ADVERT, GATT_LAYOUT, adapters)?.name).toBe('A&D UC-352BLE');
    expect(
      resolveAfterDiscovery({ localName: '', serviceUuids: ['181d'] }, GATT_LAYOUT, adapters)?.name,
    ).toBe('Standard GATT (BCS/WSS)');
  });

  it('is excluded from the generic adapter by its name', () => {
    expect(new StandardGattScaleAdapter().matches(ADVERT)).toBe(false);
  });

  it('passes the registry checks, under Renpho ES-WBE28', () => {
    expect(checkRegistryIntegrity(adapters).errors).toEqual([]);
    const wbe28 = adapters.find((x) => x.name === 'Renpho ES-WBE28')!;
    const and = adapters.find((x) => x.name === 'A&D UC-352BLE')!;
    expect(and.match!.priority).toBeLessThan(wbe28.match!.priority);
  });
});

describe('A&D UC-352BLE wiring (#394, #406 class of traps)', () => {
  const a = new AndUc352bleAdapter();

  it('declares what the transports and the gates read', () => {
    expect(a.requiresBonding).toBe(true);
    expect(a.singleBond).toBe(true);
    expect(a.charNotifyUuid).toBe(WM);
    expect(a.completionHoldMs).toBe(4000);
    expect(a.characteristics).toEqual([
      { uuid: WM, type: 'notify', deferred: true },
      { uuid: DT, type: 'write', optional: true },
    ]);
  });
});

describe('A&D UC-352BLE decoding', () => {
  const a = new AndUc352bleAdapter();

  it.each([
    [WM_6570, 65.7, '2026-08-22T06:42:36.000Z'],
    [WM_6560, 65.6, '2026-08-22T06:43:11.000Z'],
    [WM_6590, 65.9, '2026-08-22T06:43:40.000Z'],
  ])('decodes %s as %f kg stamped %s', (hex, kg, iso) => {
    const r = inBratislava(() => a.parseCharNotification(WM, frame(hex)));
    expect(r).not.toBeNull();
    expect(r!.weight).toBeCloseTo(kg, 6);
    expect(r!.impedance).toBe(0);
    expect(r!.userIndex).toBeUndefined();
    expect(r!.timestamp?.toISOString()).toBe(iso);
  });

  it('reads the same frame through parseNotification', () => {
    expect(a.parseNotification(frame(WM_6570))!.weight).toBeCloseTo(65.7, 6);
  });

  it('ignores any other characteristic', () => {
    expect(a.parseCharNotification(DT, frame(WM_6570))).toBeNull();
  });

  // WM_6570 with the weight bytes [1..2] set to ff ff: "Measurement Unsuccessful".
  it('drops the 0xFFFF sentinel', () => {
    expect(a.parseCharNotification(WM, frame('02ffffea070816082a24'))).toBeNull();
  });

  // Characterisation of the capture only: received 1.2 s after its stamp, so
  // the runtime reads it as a live weigh-in. Nothing here can tell a mutant.
  it('reads as live when received 1.2 s after its stamp, as in the capture', () => {
    const r = inBratislava(() => a.parseCharNotification(WM, frame(WM_6570)))!;
    expect(isHistoricalReading(r, r.timestamp!.getTime() + 1199)).toBe(false);
  });

  it('estimates composition from the weight alone', () => {
    const r = a.parseNotification(frame(WM_6570))!;
    const payload = a.computeMetrics(r, defaultProfile());
    expect(payload.weight).toBeCloseTo(65.7, 6);
    expect(payload.impedance).toBe(0);
    assertPayloadRanges(payload);
  });
});

describe('A&D UC-352BLE onConnected', () => {
  function fakeCtx(opts: { chars?: string[]; writeFails?: boolean; subscribeFails?: boolean }) {
    const order: string[] = [];
    const ctx = {
      profile: defaultProfile(),
      deviceAddress: '5C313E01166D',
      availableChars: new Set((opts.chars ?? [WM, DT]).map(normalizeUuid)),
      write: vi.fn(async (uuid: string, data: Buffer | number[]) => {
        order.push(`write ${uuid}`);
        if (opts.writeFails)
          throw new Error('org.bluez.Error.NotPermitted: Insufficient Authentication');
        return void data;
      }),
      read: vi.fn(async () => Buffer.alloc(0)),
      subscribe: vi.fn(async (uuid: string) => {
        order.push(`subscribe ${uuid}`);
        if (opts.subscribeFails) throw new Error('org.bluez.Error.NotPermitted');
      }),
    } as unknown as ConnectionContext & {
      write: ReturnType<typeof vi.fn>;
      subscribe: ReturnType<typeof vi.fn>;
    };
    return { ctx, order };
  }

  it('writes the local time with a response, then enables indications', async () => {
    const a = new AndUc352bleAdapter(() => new Date('2026-08-22T06:42:36Z'));
    const { ctx, order } = fakeCtx({});
    const saved = process.env.TZ;
    process.env.TZ = 'Europe/Bratislava';
    try {
      await a.onConnected(ctx);
    } finally {
      if (saved === undefined) delete process.env.TZ;
      else process.env.TZ = saved;
    }
    expect(order).toEqual([`write ${DT}`, `subscribe ${WM}`]);
    const [, data, withResponse] = ctx.write.mock.calls[0];
    expect(Buffer.from(data as number[]).toString('hex')).toBe(DATE_TIME_0842_36);
    expect(withResponse).toBe(true);
  });

  it('without a Date Time characteristic, only enables indications and warns once', async () => {
    const a = new AndUc352bleAdapter();
    const warn = vi.spyOn(bleLog, 'warn').mockImplementation(() => {});
    const first = fakeCtx({ chars: [WM] });
    await a.onConnected(first.ctx);
    await a.onConnected(fakeCtx({ chars: [WM] }).ctx);
    expect(first.order).toEqual([`subscribe ${WM}`]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('0x2A08');
  });

  it('fails the session with pairing instructions when the time write is refused', async () => {
    const a = new AndUc352bleAdapter();
    const { ctx } = fakeCtx({ writeFails: true });
    const err = await a.onConnected(ctx).catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toContain('Pr');
    expect(err!.message).toContain('ble.scale_mac');
    expect(err!.message).toContain('Insufficient Authentication');
    expect(ctx.subscribe).not.toHaveBeenCalled();
  });

  it('says the same when the indications are refused', async () => {
    const a = new AndUc352bleAdapter();
    const { ctx } = fakeCtx({ subscribeFails: true });
    await expect(a.onConnected(ctx)).rejects.toThrow(/ble\.scale_mac/);
  });
});

describe('A&D UC-352BLE through waitForRawReading', () => {
  function session(a: AndUc352bleAdapter) {
    let onData: ((d: Buffer) => void) | undefined;
    const indicate: BleChar = {
      subscribe: vi.fn(async (cb: (d: Buffer) => void) => {
        onData = cb;
        return () => {
          onData = undefined;
        };
      }),
      write: vi.fn(async () => {}),
      read: vi.fn(async () => Buffer.alloc(0)),
    };
    const time: BleChar = {
      subscribe: vi.fn(async () => () => {}),
      write: vi.fn(async () => {}),
      read: vi.fn(async () => Buffer.alloc(0)),
    };
    const charMap = new Map<string, BleChar>([
      [normalizeUuid(WM), indicate],
      [normalizeUuid(DT), time],
    ]);
    const device: BleDevice = { onDisconnect: () => {}, fireDisconnect: () => {} };
    const promise = waitForRawReading({
      charMap,
      device,
      adapter: a,
      profile: defaultProfile(),
      address: '5C313E01166D',
      scaleAuth: undefined,
    });
    return {
      promise,
      send: (hex: string) => onData?.(frame(hex)),
      subscribed: () => onData !== undefined,
    };
  }

  /** Fake timers at `iso`, with the process in the reporter's zone. */
  async function at(iso: string, body: () => Promise<void>): Promise<void> {
    const saved = process.env.TZ;
    process.env.TZ = 'Europe/Bratislava';
    vi.useFakeTimers();
    vi.setSystemTime(new Date(iso));
    vi.spyOn(bleLog, 'info').mockImplementation(() => {});
    vi.spyOn(bleLog, 'debug').mockImplementation(() => {});
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await body();
    } finally {
      if (saved === undefined) delete process.env.TZ;
      else process.env.TZ = saved;
    }
  }

  it('hands a stored record over as history next to the live weigh-in', async () => {
    // WM_6570 with the day byte [6] changed 0x16 -> 0x15: the same weigh-in a
    // day older, as a record the scale kept while nobody was listening.
    const STORED = '025433ea070815082a24';
    await at('2026-08-22T06:43:12Z', async () => {
      const s = session(new AndUc352bleAdapter(() => new Date()));
      await vi.waitFor(() => expect(s.subscribed()).toBe(true));
      s.send(STORED);
      s.send(WM_6560);
      await vi.advanceTimersByTimeAsync(4_000);
      const raw = await s.promise;
      expect(raw.reading.weight).toBeCloseTo(65.6, 6);
      expect(raw.history?.map((r) => r.weight)).toEqual([expect.closeTo(65.7, 6)]);
    });
  });

  it('keeps the later of two live weigh-ins in one session', async () => {
    await at('2026-08-22T06:43:12Z', async () => {
      const s = session(new AndUc352bleAdapter(() => new Date()));
      await vi.waitFor(() => expect(s.subscribed()).toBe(true));
      s.send(WM_6570);
      s.send(WM_6560);
      await vi.advanceTimersByTimeAsync(4_000);
      const raw = await s.promise;
      expect(raw.reading.weight).toBeCloseTo(65.6, 6);
    });
  });
});
