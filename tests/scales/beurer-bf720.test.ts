import { describe, it, expect, vi } from 'vitest';
import { BeurerBf720Adapter } from '../../src/scales/beurer-bf720.js';
import { resolveAdapter } from '../../src/scales/resolve.js';
import type { BleDeviceInfo, ConnectionContext } from '../../src/interfaces/scale-adapter.js';
import { uuid16 } from '../../src/scales/body-comp-helpers.js';
import { bleLog } from '../../src/ble/types.js';
import {
  mockPeripheral,
  defaultProfile,
  assertPayloadRanges,
} from '../helpers/scale-test-utils.js';

const CHR_WEIGHT = uuid16(0x2a9d);
const CHR_BODYCOMP = uuid16(0x2a9c);
const CHR_UCP = uuid16(0x2a9f);
const CHR_TIME = uuid16(0x2a2b);

// Live frames decoded from the #168 openScale HCI snoop.
const WSS_FRAME = Buffer.from('0e783eea07050c12353601ee002607', 'hex'); // 79.96 kg, ts 2026-05-12
const BCS_FRAME = Buffer.from('9803c200df1a9701cc2fca21a811', 'hex'); // fat 19.4, muscle 40.7, ...

function makeAdapter() {
  return new BeurerBf720Adapter();
}

function makeCtx(over: Partial<ConnectionContext> = {}): ConnectionContext {
  return {
    profile: defaultProfile(),
    deviceAddress: 'E7DB49F186DE',
    availableChars: new Set([CHR_WEIGHT, CHR_BODYCOMP, CHR_UCP]),
    scaleAuth: { pin: 3752, userIndex: 1 },
    write: vi.fn().mockResolvedValue(undefined),
    read: vi.fn().mockResolvedValue(Buffer.alloc(0)),
    subscribe: vi.fn().mockResolvedValue(undefined),
    ...over,
  } as ConnectionContext;
}

describe('BeurerBf720Adapter', () => {
  // #168: the SIG User Data Service protects its CCCDs, so the node-ble handler
  // must attempt a bond before subscribing. The flag drives that path.
  it('requires bonding', () => {
    expect(makeAdapter().requiresBonding).toBe(true);
  });

  describe('matches()', () => {
    it.each(['BF720', 'beurer bf105', 'My BF720 Scale', 'BF500', 'BF788', 'BF950'])(
      'matches name "%s"',
      (name) => {
        expect(makeAdapter().matches(mockPeripheral(name))).toBe(true);
      },
    );

    // #229 (BF788) and #255 (BF950): both are SIG consent+bond Beurer scales that
    // were mis-routing to Standard GATT (which sends a useless code-0 consent).
    // They must resolve to this adapter (priority 220) on the name alone, the same
    // way BF500 does, so the real consent+bond path runs. "BF950" is the exact
    // advertised name from the #255 log.
    it.each(['BF788', 'BF950'])(
      'resolves "%s" to the Beurer adapter, not Standard GATT',
      (name) => {
        const info: BleDeviceInfo = { localName: name, serviceUuids: ['181d', '181b'] };
        expect(resolveAdapter(info)?.name).toBe('Beurer BF720/BF105');
      },
    );

    // #83: BF500 speaks the same SIG consent+bond protocol; it must route here
    // (priority 220) rather than to Standard GATT (priority 0), which sends a
    // code-0 consent on an unbonded link and reads nothing. Also accept the
    // short-form advertised service UUID via the company-id path.
    it('matches BF500 by name and by short-form 0x181d + Beurer company id (#83)', () => {
      expect(makeAdapter().matches(mockPeripheral('BF500'))).toBe(true);
      const viaShortForm: BleDeviceInfo = {
        localName: '',
        serviceUuids: ['181d'],
        manufacturerData: { id: 0x0611, data: Buffer.alloc(0) },
      };
      expect(makeAdapter().matches(viaShortForm)).toBe(true);
    });

    // #168 review: a bare Beurer company id 0x0611 is too weak on its own.
    // The adapter sits ahead of the name-based Beurer/Sanitas adapters, so an
    // older BF710 / SBF7x advertising 0x0611 must NOT be hijacked here.
    it('does not match a bare Beurer company id 0x0611 without a SIG service', () => {
      const info: BleDeviceInfo = {
        localName: '',
        serviceUuids: [],
        manufacturerData: { id: 0x0611, data: Buffer.alloc(0) },
      };
      expect(makeAdapter().matches(info)).toBe(false);
    });

    it('matches Beurer company id 0x0611 when a SIG WSS/BCS service is present', () => {
      const viaServiceUuids: BleDeviceInfo = {
        localName: '',
        serviceUuids: [uuid16(0x181b)],
        manufacturerData: { id: 0x0611, data: Buffer.alloc(0) },
      };
      expect(makeAdapter().matches(viaServiceUuids)).toBe(true);

      const viaServiceData: BleDeviceInfo = {
        localName: '',
        serviceUuids: [],
        manufacturerData: { id: 0x0611, data: Buffer.alloc(0) },
        serviceData: [{ uuid: uuid16(0x181d), data: Buffer.alloc(0) }],
      };
      expect(makeAdapter().matches(viaServiceData)).toBe(true);
    });

    // The company-id branch is the NAMELESS fallback. A MAC-pinned Sanitas
    // SBF72 reaches matches() post-connect with its name, its discovered
    // services (every SIG scale exposes 0x181B, so the SIG gate is free there)
    // and Beurer's shared company id. Without the name bow-out this adapter
    // (priority 220) stole it from Sanitas SBF72/73 (170) and then hard-failed
    // demanding a consent PIN the SBF72 does not use.
    it('does not hijack a named Beurer sibling that shares the company id', () => {
      const sbf72: BleDeviceInfo = {
        localName: 'SBF72',
        serviceUuids: [uuid16(0x181b), uuid16(0x181c)],
        characteristicUuids: [uuid16(0x2a9c), uuid16(0x2a9f)],
        manufacturerData: { id: 0x0611, data: Buffer.alloc(0) },
      };
      expect(makeAdapter().matches(sbf72)).toBe(false);
      expect(resolveAdapter(sbf72)?.name).toBe('Sanitas SBF72/73');
    });

    it('does not match unrelated name / other company id', () => {
      expect(makeAdapter().matches(mockPeripheral('Random Scale'))).toBe(false);
      const info: BleDeviceInfo = {
        localName: 'X',
        serviceUuids: [],
        manufacturerData: { id: 0x0157, data: Buffer.alloc(0) },
      };
      expect(makeAdapter().matches(info)).toBe(false);
    });
  });

  describe('parseCharNotification()', () => {
    it('pairs weight + body composition and decodes native values', () => {
      const a = makeAdapter();
      expect(a.parseCharNotification(CHR_WEIGHT, WSS_FRAME)).toBeNull();

      const reading = a.parseCharNotification(CHR_BODYCOMP, BCS_FRAME);
      expect(reading).not.toBeNull();
      expect(reading!.weight).toBeCloseTo(79.96, 2);
      // Captured frame is stamped 2026-05-12 -> older than the freshness
      // window in CI -> treated as a historical (back-dated) reading.
      expect(reading!.timestamp).toBeInstanceOf(Date);
      expect(reading!.timestamp!.getFullYear()).toBe(2026);
      expect(reading!.timestamp!.getMonth()).toBe(4); // May (0-based)
      expect(reading!.timestamp!.getDate()).toBe(12);

      const payload = a.computeMetrics(reading!, defaultProfile());
      assertPayloadRanges(payload);
      expect(payload.bodyFatPercent).toBeCloseTo(19.4, 1);
      expect(payload.muscleMass).toBeGreaterThan(0);
      // Body water = water mass (43.25 kg) / weight (79.96) * 100 ~ 54.1 %
      expect(payload.waterPercent).toBeGreaterThan(45);
      expect(payload.waterPercent).toBeLessThan(65);
    });

    it('treats a freshly stamped weigh-in as a live (non-backdated) reading', () => {
      const a = makeAdapter();
      const now = new Date();
      const wss = Buffer.alloc(10);
      wss[0] = 0x02; // flags: timestamp present, kg
      wss.writeUInt16LE(16000, 1); // 16000 * 0.005 = 80.00 kg
      wss.writeUInt16LE(now.getFullYear(), 3);
      wss[5] = now.getMonth() + 1;
      wss[6] = now.getDate();
      wss[7] = now.getHours();
      wss[8] = now.getMinutes();
      wss[9] = now.getSeconds();
      const bcs = Buffer.from([0x00, 0x00, 0xc2, 0x00]); // flags 0, fat 19.4

      expect(a.parseCharNotification(CHR_WEIGHT, wss)).toBeNull();
      const reading = a.parseCharNotification(CHR_BODYCOMP, bcs);
      expect(reading).not.toBeNull();
      expect(reading!.weight).toBeCloseTo(80, 2);
      expect(reading!.timestamp).toBeUndefined();
    });

    // #168 review: a malformed/truncated BCS frame whose flags claim optional
    // fields that are not actually present must not throw a RangeError out of
    // the notification handler.
    it('does not throw on a truncated BCS frame that over-claims via flags', () => {
      const a = makeAdapter();
      // flags 0x0398 claim basal + muscle% + soft-lean + water mass + impedance,
      // but only fat (offset 2) actually fits in the 4-byte buffer.
      const truncated = Buffer.from([0x98, 0x03, 0xc2, 0x00]);
      expect(() => a.parseCharNotification(CHR_BODYCOMP, truncated)).not.toThrow();
      // No weight yet -> no complete reading emitted.
      expect(a.parseCharNotification(CHR_BODYCOMP, truncated)).toBeNull();
    });

    it('ignores User Control Point responses without throwing', () => {
      const a = makeAdapter();
      expect(a.parseCharNotification(CHR_UCP, Buffer.from([0x20, 0x02, 0x01]))).toBeNull();
      expect(a.parseCharNotification(CHR_UCP, Buffer.from([0x20, 0x02, 0x05]))).toBeNull();
    });
  });

  describe('onConnected()', () => {
    it('writes Current Time then the consent frame', async () => {
      const a = makeAdapter();
      const ctx = makeCtx();
      await a.onConnected(ctx);

      const write = ctx.write as ReturnType<typeof vi.fn>;
      expect(write).toHaveBeenCalledTimes(2);
      const [timeUuid, timeData] = write.mock.calls[0];
      expect(timeUuid).toBe(CHR_TIME);
      expect((timeData as number[]).length).toBe(10);

      const [ucpUuid, ucpData] = write.mock.calls[1];
      expect(ucpUuid).toBe(CHR_UCP);
      // 3752 = 0x0EA8 -> [opcode 0x02, userIndex 0x01, lo 0xA8, hi 0x0E]
      expect(ucpData).toEqual([0x02, 0x01, 0xa8, 0x0e]);
    });

    it('throws a clear error when no PIN is configured', async () => {
      const a = makeAdapter();
      await expect(a.onConnected(makeCtx({ scaleAuth: undefined }))).rejects.toThrow(/beurer_pin/);
    });

    it('throws when required characteristics are missing', async () => {
      const a = makeAdapter();
      await expect(
        a.onConnected(makeCtx({ availableChars: new Set([CHR_WEIGHT]) })),
      ).rejects.toThrow(/discovery race/);
    });
  });

  describe('isComplete()', () => {
    it('is complete once weight is positive', () => {
      const a = makeAdapter();
      expect(a.isComplete({ weight: 80, impedance: 0 })).toBe(true);
      expect(a.isComplete({ weight: 0, impedance: 0 })).toBe(false);
    });
  });

  // Frames lifted verbatim from the BF788 HCI snoop attached to #229. The
  // session carried 36 body-composition indications: 35 zeroed stubs paired
  // with the scale's backfilled history, and exactly one real frame.
  describe('BF788 real capture (#229)', () => {
    // 0e | 205c | ea07 07 0e 17 29 20 | 01 | 4001 | 8007
    // flags 0x0e, weight 0x5c20 * 0.005 = 117.92 kg, 2026-07-14 23:41:32,
    // user 1, BMI 32.0, height 192.0 cm. 117.92 / 1.92^2 = 31.99, self-consistent.
    const WEIGHT_FRAME = Buffer.from('0e205cea07070e1729200140018007', 'hex');
    // flags 0x0398: BMR, muscle %, soft lean mass, body water mass, impedance.
    // fat 0x00f3 = 24.3 %, muscle 0x0189 = 39.3 %, soft lean 0x4240 * 0.005 =
    // 84.8 kg, water 0x2ffa * 0.005 = 61.41 kg, impedance 0x0f55 = 392.5 ohm.
    const REAL_COMP = Buffer.from('9803f300962389014042fa2f550f', 'hex');
    // The zeroed stub: every composition field is 0, only BMR varies.
    const ZEROED_COMP = Buffer.from('9803000096230000000000000000', 'hex');

    function atCaptureTime(fn: () => void): void {
      vi.useFakeTimers();
      // Inside HISTORY_MAX_AGE_MS of the frame's embedded stamp, so the reading
      // is classified live rather than backdated and buffered as history.
      vi.setSystemTime(new Date(2026, 6, 14, 23, 41, 40));
      try {
        fn();
      } finally {
        vi.useRealTimers();
      }
    }

    it('decodes the real weight + composition pair', () => {
      atCaptureTime(() => {
        const a = makeAdapter();
        expect(a.parseCharNotification(CHR_WEIGHT, WEIGHT_FRAME)).toBeNull();
        const reading = a.parseCharNotification(CHR_BODYCOMP, REAL_COMP);
        expect(reading).not.toBeNull();
        expect(reading!.weight).toBeCloseTo(117.92, 2);

        const payload = a.computeMetrics(reading!, defaultProfile());
        expect(payload.bodyFatPercent).toBeCloseTo(24.3, 1);
        // Water mass 61.41 kg / 117.92 kg ~ 52.1 %.
        expect(payload.waterPercent).toBeCloseTo(52.1, 0);
        // The regression this guards: bone must be a plausible mass, not the
        // whole body weight.
        expect(payload.boneMass).toBeGreaterThan(0);
        expect(payload.boneMass).toBeLessThan(10);
      });
    });

    // Without the zero guard this yields boneMass = 117.92 kg, because
    // buildReading() gates on `fat == null` (which 0 passes) and computeMetrics
    // derives bone as leanBodyMass - softLean = weight - 0.
    it('emits nothing for a zeroed placeholder composition frame', () => {
      atCaptureTime(() => {
        const a = makeAdapter();
        expect(a.parseCharNotification(CHR_WEIGHT, WEIGHT_FRAME)).toBeNull();
        expect(a.parseCharNotification(CHR_BODYCOMP, ZEROED_COMP)).toBeNull();
      });
    });

    // computeMetrics() runs long after the session resolves, once per buffered
    // frame, so it must use the composition each reading was BUILT from rather
    // than whatever the cache holds at the end. Otherwise a trailing stub wipes
    // the cache and the buffered history reading silently exports Deurenberg
    // estimates in place of the scale's own measured values.
    it('keeps each reading composition even if a later frame resets the cache', () => {
      atCaptureTime(() => {
        const a = makeAdapter();
        a.parseCharNotification(CHR_WEIGHT, WEIGHT_FRAME);
        const reading = a.parseCharNotification(CHR_BODYCOMP, REAL_COMP);
        expect(reading).not.toBeNull();

        // A trailing zeroed stub arrives before the processor computes metrics.
        a.parseCharNotification(CHR_BODYCOMP, ZEROED_COMP);

        const payload = a.computeMetrics(reading!, defaultProfile());
        expect(payload.bodyFatPercent).toBeCloseTo(24.3, 1);
        expect(payload.boneMass).toBeLessThan(10);
      });
    });

    // lb frames: normalizesWeight = true tells the shared layer this adapter
    // already returns kg, so it skips its own conversion.
    it('converts an lb-unit weight frame to kg', () => {
      const a = makeAdapter();
      const lb = Buffer.alloc(3);
      lb[0] = 0x01; // flags: lb, no timestamp
      lb.writeUInt16LE(26000, 1); // 260.00 lb
      a.parseCharNotification(CHR_WEIGHT, lb);
      const reading = a.parseCharNotification(CHR_BODYCOMP, Buffer.from([0x00, 0x00, 0xc2, 0x00]));
      expect(reading).not.toBeNull();
      expect(reading!.weight).toBeCloseTo(117.93, 1); // not 260
    });

    // 0xFFFF is the SIG "measurement unsuccessful" sentinel; unclamped it would
    // export 6553.5 % body fat and a negative bone mass.
    it('rejects the 0xFFFF unsuccessful-measurement sentinel', () => {
      atCaptureTime(() => {
        const a = makeAdapter();
        a.parseCharNotification(CHR_WEIGHT, WEIGHT_FRAME);
        const sentinel = Buffer.from('9803ffff962300000000000000000', 'hex');
        expect(a.parseCharNotification(CHR_BODYCOMP, sentinel)).toBeNull();
      });
    });

    // A zeroed frame must RESET the cache, not merely skip assignment.
    // cachedComp is cleared only in onConnected(), so a stale real value would
    // otherwise be stamped onto every backdated history entry that follows.
    it('does not leak a previously decoded body fat onto a later zeroed frame', () => {
      atCaptureTime(() => {
        const a = makeAdapter();
        a.parseCharNotification(CHR_WEIGHT, WEIGHT_FRAME);
        expect(a.parseCharNotification(CHR_BODYCOMP, REAL_COMP)).not.toBeNull();

        // History frame: same shape, different weight, paired with a stub.
        a.parseCharNotification(CHR_WEIGHT, WEIGHT_FRAME);
        expect(a.parseCharNotification(CHR_BODYCOMP, ZEROED_COMP)).toBeNull();
      });
    });
  });

  // #229: the Beurer app queries the vendor user list before the consent write
  // and, once consent is accepted, reads the user data back, writes it
  // unchanged and bumps the database change increment. Only after that commit
  // does the scale send a body-composition frame with real values.
  describe('post-consent user profile commit (#229)', () => {
    const CHR_FFF2 = uuid16(0xfff2);
    const CHR_FFF3 = uuid16(0xfff3);
    const CHR_DOB = uuid16(0x2a85);
    const CHR_GENDER = uuid16(0x2a8c);
    const CHR_HEIGHT = uuid16(0x2a8e);
    const CHR_DBINC = uuid16(0x2a99);

    /** Characteristic set and stored values from the #229 BF788 capture. */
    function bf788Ctx(over: Partial<ConnectionContext> = {}): ConnectionContext {
      const stored: Record<string, Buffer> = {
        [CHR_DBINC]: Buffer.from('06000000', 'hex'),
        [CHR_DOB]: Buffer.from('bf070808', 'hex'),
        [CHR_GENDER]: Buffer.from('00', 'hex'),
        [CHR_HEIGHT]: Buffer.from('c000', 'hex'),
        [CHR_FFF3]: Buffer.from('03', 'hex'),
      };
      return makeCtx({
        availableChars: new Set([
          CHR_WEIGHT,
          CHR_BODYCOMP,
          CHR_UCP,
          CHR_FFF2,
          CHR_FFF3,
          CHR_DOB,
          CHR_GENDER,
          CHR_HEIGHT,
          CHR_DBINC,
        ]),
        read: vi.fn(async (uuid: string) => stored[uuid] ?? Buffer.alloc(0)),
        ...over,
      });
    }

    const flush = async (): Promise<void> => {
      for (let i = 0; i < 20; i++) await Promise.resolve();
    };

    it('queries the vendor user list between the time write and the consent write', async () => {
      const a = makeAdapter();
      const ctx = bf788Ctx();
      await a.onConnected(ctx);

      const write = ctx.write as ReturnType<typeof vi.fn>;
      expect(write.mock.calls.map((c) => c[0])).toEqual([CHR_TIME, CHR_FFF2, CHR_UCP]);
      expect(write.mock.calls[1][1]).toEqual([0x00]);
    });

    it('skips the vendor query when 0xFFF2 is absent', async () => {
      const a = makeAdapter();
      const ctx = makeCtx();
      await a.onConnected(ctx);
      const write = ctx.write as ReturnType<typeof vi.fn>;
      expect(write.mock.calls.map((c) => c[0])).toEqual([CHR_TIME, CHR_UCP]);
    });

    it('still sends consent when the vendor query is rejected', async () => {
      const a = makeAdapter();
      const ctx = bf788Ctx({
        write: vi.fn(async (uuid: string) => {
          if (uuid === uuid16(0xfff2)) throw new Error('not permitted');
        }),
      });
      await a.onConnected(ctx);
      const write = ctx.write as ReturnType<typeof vi.fn>;
      expect(write.mock.calls.map((c) => c[0])).toContain(CHR_UCP);
    });

    it('reads the user data back, writes it unchanged, then bumps the increment', async () => {
      const a = makeAdapter();
      const ctx = bf788Ctx();
      await a.onConnected(ctx);
      const write = ctx.write as ReturnType<typeof vi.fn>;
      write.mockClear();

      // Consent accepted: `20 02 01` on the User Control Point.
      a.parseCharNotification(CHR_UCP, Buffer.from('200201', 'hex'));
      await flush();

      expect(
        write.mock.calls.map((c) => [c[0], Buffer.from(c[1] as Buffer | number[]).toString('hex')]),
      ).toEqual([
        [CHR_DOB, 'bf070808'],
        [CHR_GENDER, '00'],
        [CHR_HEIGHT, 'c000'],
        [CHR_FFF3, '03'],
        [CHR_DBINC, '01000000'],
      ]);
    });

    it('does not commit anything when consent is rejected', async () => {
      const a = makeAdapter();
      const ctx = bf788Ctx();
      await a.onConnected(ctx);
      const write = ctx.write as ReturnType<typeof vi.fn>;
      write.mockClear();

      a.parseCharNotification(CHR_UCP, Buffer.from('200205', 'hex'));
      await flush();
      expect(write).not.toHaveBeenCalled();
    });

    it('commits at most once per session', async () => {
      const a = makeAdapter();
      const ctx = bf788Ctx();
      await a.onConnected(ctx);
      const write = ctx.write as ReturnType<typeof vi.fn>;
      write.mockClear();

      a.parseCharNotification(CHR_UCP, Buffer.from('200201', 'hex'));
      a.parseCharNotification(CHR_UCP, Buffer.from('200201', 'hex'));
      a.parseCharNotification(CHR_UCP, Buffer.from('200201', 'hex'));
      await flush();

      const increments = write.mock.calls.filter((c) => c[0] === CHR_DBINC);
      expect(increments).toHaveLength(1);
    });

    it('never writes into the previous session after a reconnect', async () => {
      const a = makeAdapter();
      const ctxA = bf788Ctx();
      await a.onConnected(ctxA);
      const ctxB = bf788Ctx();
      await a.onConnected(ctxB);
      (ctxA.write as ReturnType<typeof vi.fn>).mockClear();
      (ctxB.write as ReturnType<typeof vi.fn>).mockClear();

      a.parseCharNotification(CHR_UCP, Buffer.from('200201', 'hex'));
      await flush();

      expect(ctxA.write as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
      expect(ctxB.write as ReturnType<typeof vi.fn>).toHaveBeenCalled();
    });

    it('skips characteristics the scale does not expose', async () => {
      const a = makeAdapter();
      const ctx = bf788Ctx({
        availableChars: new Set([CHR_WEIGHT, CHR_BODYCOMP, CHR_UCP, CHR_DOB, CHR_DBINC]),
      });
      await a.onConnected(ctx);
      const write = ctx.write as ReturnType<typeof vi.fn>;
      write.mockClear();

      a.parseCharNotification(CHR_UCP, Buffer.from('200201', 'hex'));
      await flush();

      expect(write.mock.calls.map((c) => c[0])).toEqual([CHR_DOB, CHR_DBINC]);
    });

    it('reports the increment outcome in the commit line, even when it is rejected', async () => {
      // A rejected increment used to throw past the commit line, so a log
      // missing that line could mean either "the increment failed" or "the
      // whole sync failed". One line now answers it (#229).
      const debug = vi.spyOn(bleLog, 'debug').mockImplementation(() => {});
      const a = makeAdapter();
      const ctx = bf788Ctx({
        write: vi.fn(async (uuid: string) => {
          if (uuid === CHR_DBINC) throw new Error('write not permitted');
        }),
      });
      await a.onConnected(ctx);

      a.parseCharNotification(CHR_UCP, Buffer.from('200201', 'hex'));
      await flush();

      const commit = debug.mock.calls
        .map((c) => String(c[0]))
        .find((line) => line.includes('user profile committed'));
      expect(commit).toBeDefined();
      expect(commit).toContain('change increment rejected');
      debug.mockRestore();
    });

    it('records the increment as written when the scale accepts it', async () => {
      const debug = vi.spyOn(bleLog, 'debug').mockImplementation(() => {});
      const a = makeAdapter();
      const ctx = bf788Ctx();
      await a.onConnected(ctx);

      a.parseCharNotification(CHR_UCP, Buffer.from('200201', 'hex'));
      await flush();

      const commit = debug.mock.calls
        .map((c) => String(c[0]))
        .find((line) => line.includes('user profile committed'));
      expect(commit).toContain('change increment written');
      debug.mockRestore();
    });

    it('still bumps the increment when one profile write is rejected', async () => {
      // The increment is the step the scale actually waits for, so a read-only
      // vendor characteristic on a sibling model must not cost us it.
      const a = makeAdapter();
      const ctx = bf788Ctx({
        write: vi.fn(async (uuid: string) => {
          if (uuid === uuid16(0xfff3)) throw new Error('write not permitted');
        }),
      });
      await a.onConnected(ctx);
      const write = ctx.write as ReturnType<typeof vi.fn>;
      write.mockClear();

      a.parseCharNotification(CHR_UCP, Buffer.from('200201', 'hex'));
      await flush();

      const last = write.mock.calls[write.mock.calls.length - 1];
      expect(last[0]).toBe(CHR_DBINC);
      expect(Buffer.from(last[1] as Buffer | number[]).toString('hex')).toBe('01000000');
    });

    it('still bumps the increment when one profile read is rejected', async () => {
      const a = makeAdapter();
      const ctx = bf788Ctx({
        read: vi.fn(async (uuid: string) => {
          if (uuid === uuid16(0x2a8e)) throw new Error('read not permitted');
          return Buffer.from('00', 'hex');
        }),
      });
      await a.onConnected(ctx);
      const write = ctx.write as ReturnType<typeof vi.fn>;
      write.mockClear();

      a.parseCharNotification(CHR_UCP, Buffer.from('200201', 'hex'));
      await flush();

      expect(write.mock.calls.map((c) => c[0])).toContain(CHR_DBINC);
      expect(write.mock.calls.map((c) => c[0])).not.toContain(uuid16(0x2a8e));
    });

    it('a read failure never breaks the session', async () => {
      const a = makeAdapter();
      const ctx = bf788Ctx({
        read: vi.fn(async () => {
          throw new Error('Not authorized');
        }),
      });
      await a.onConnected(ctx);

      expect(() => a.parseCharNotification(CHR_UCP, Buffer.from('200201', 'hex'))).not.toThrow();
      await flush();
    });

    it('decodes a vendor user-slot frame and emits no reading', () => {
      const a = makeAdapter();
      expect(
        a.parseCharNotification(CHR_FFF2, Buffer.from('0001ffffffbf070808c00103', 'hex')),
      ).toBeNull();
      expect(a.parseCharNotification(CHR_FFF2, Buffer.from('01', 'hex'))).toBeNull();
      expect(a.parseCharNotification(CHR_FFF2, Buffer.from('0001ff', 'hex'))).toBeNull();
      expect(a.parseCharNotification(CHR_FFF2, Buffer.alloc(0))).toBeNull();
    });
  });

  // -- #229: a scale whose user slots were wiped by a battery change ---------
  describe('unprovisioned scale after a battery change (#229)', () => {
    const UCP = uuid16(0x2a9f);
    const FFF2 = uuid16(0xfff2);
    const FFF3 = uuid16(0xfff3);
    const DOB = uuid16(0x2a85);
    const GENDER = uuid16(0x2a8c);
    const HEIGHT = uuid16(0x2a8e);
    const DBINC = uuid16(0x2a99);

    const ALL_CHARS = new Set([
      uuid16(0x2a9d),
      uuid16(0x2a9c),
      UCP,
      FFF2,
      FFF3,
      DOB,
      GENDER,
      HEIGHT,
      DBINC,
    ]);

    const settle = async (): Promise<void> => {
      for (let i = 0; i < 20; i++) await Promise.resolve();
    };

    /** A context whose stored profile values are whatever `stored` says. */
    function ctxWith(
      stored: Record<string, Buffer>,
      opts: { provision?: boolean; profile?: ConnectionContext['profile'] } = {},
    ): ConnectionContext {
      return {
        profile: opts.profile ?? defaultProfile(),
        deviceAddress: 'E7DB49F186DE',
        availableChars: ALL_CHARS,
        scaleAuth: { pin: 3752, userIndex: 1, provision: opts.provision },
        write: vi.fn().mockResolvedValue(undefined),
        read: vi.fn(async (uuid: string) => stored[uuid] ?? Buffer.alloc(0)),
        subscribe: vi.fn().mockResolvedValue(undefined),
      } as unknown as ConnectionContext;
    }

    const ZEROED: Record<string, Buffer> = {
      [DOB]: Buffer.from('00000000', 'hex'),
      [GENDER]: Buffer.from('ff', 'hex'),
      [HEIGHT]: Buffer.from('0000', 'hex'),
      [FFF3]: Buffer.from('00', 'hex'),
    };

    const POPULATED: Record<string, Buffer> = {
      [DOB]: Buffer.from('bf070808', 'hex'),
      [GENDER]: Buffer.from('00', 'hex'),
      [HEIGHT]: Buffer.from('c000', 'hex'),
      [FFF3]: Buffer.from('03', 'hex'),
    };

    /** Writes recorded after consent was accepted. */
    async function writesAfterConsent(
      a: BeurerBf720Adapter,
      ctx: ConnectionContext,
    ): Promise<[string, Buffer | number[]][]> {
      await a.onConnected(ctx);
      const write = ctx.write as ReturnType<typeof vi.fn>;
      write.mockClear();
      a.parseCharNotification(UCP, Buffer.from('200201', 'hex'));
      await settle();
      return write.mock.calls.map((c) => [c[0] as string, c[1] as Buffer | number[]]);
    }

    it('does not write a config value when the profile read is rejected', async () => {
      const a = makeAdapter();
      const ctx = ctxWith({}, { provision: true });
      (ctx.read as ReturnType<typeof vi.fn>).mockImplementation(async (uuid: string) => {
        if (uuid === HEIGHT) throw new Error('read not permitted');
        return ZEROED[uuid] ?? Buffer.alloc(0);
      });
      const writes = await writesAfterConsent(a, ctx);
      expect(writes.map((w) => w[0])).not.toContain(HEIGHT);
      expect(writes.map((w) => w[0])).toContain(DBINC);
    });

    // With provisioning off the bytes on the wire are exactly what they were
    // before the option existed: the empty value is still committed back. Only
    // the warning is new. Changing which characteristics get written on an
    // install that never opted in would be an undeclared behaviour change.
    it('warns but still writes the empty value back when provisioning is off', async () => {
      const warn = vi.spyOn(bleLog, 'warn').mockImplementation(() => {});
      const a = makeAdapter();
      const writes = await writesAfterConsent(a, ctxWith(ZEROED));
      const dob = writes.find((w) => w[0] === DOB);
      expect(Buffer.from(dob![1]).toString('hex')).toBe('00000000');
      expect(warn.mock.calls.flat().join(' ')).toMatch(/no stored date of birth/);
      warn.mockRestore();
    });

    it('writes the configured date of birth when 0x2A85 reads back zeroed', async () => {
      const a = makeAdapter();
      const writes = await writesAfterConsent(a, ctxWith(ZEROED, { provision: true }));
      const year = new Date().getFullYear() - 30;
      expect(writes.find((w) => w[0] === DOB)?.[1]).toEqual([
        year & 0xff,
        (year >> 8) & 0xff,
        1,
        1,
      ]);
    });

    it('writes the configured height when 0x2A8E reads back 0000', async () => {
      const a = makeAdapter();
      const writes = await writesAfterConsent(a, ctxWith(ZEROED, { provision: true }));
      expect(writes.find((w) => w[0] === HEIGHT)?.[1]).toEqual([0xb7, 0x00]);
    });

    it('writes the configured gender when 0x2A8C reads back ff', async () => {
      const female = makeAdapter();
      const femaleWrites = await writesAfterConsent(
        female,
        ctxWith(ZEROED, { provision: true, profile: defaultProfile({ gender: 'female' }) }),
      );
      expect(femaleWrites.find((w) => w[0] === GENDER)?.[1]).toEqual([0x01]);

      const male = makeAdapter();
      const maleWrites = await writesAfterConsent(male, ctxWith(ZEROED, { provision: true }));
      expect(maleWrites.find((w) => w[0] === GENDER)?.[1]).toEqual([0x00]);
    });

    it('restores the vendor activity level when 0xFFF3 reads back 00', async () => {
      const a = makeAdapter();
      const writes = await writesAfterConsent(a, ctxWith(ZEROED, { provision: true }));
      expect(writes.find((w) => w[0] === FFF3)?.[1]).toEqual([0x03]);
    });

    // Guards every working BF105 / BF720 / BF500 install: a populated profile is
    // written back byte for byte and never touched by provisioning.
    it('leaves a populated profile byte for byte unchanged even with provisioning on', async () => {
      const info = vi.spyOn(bleLog, 'info').mockImplementation(() => {});
      const a = makeAdapter();
      const writes = await writesAfterConsent(a, ctxWith(POPULATED, { provision: true }));
      for (const [uuid, value] of writes) {
        if (uuid === DBINC) continue;
        expect(Buffer.from(value).toString('hex')).toBe(POPULATED[uuid].toString('hex'));
      }
      expect(info.mock.calls.flat().join(' ')).not.toMatch(/writing the value from config/);
      info.mockRestore();
    });

    it('still bumps the database change increment after provisioning', async () => {
      const a = makeAdapter();
      const writes = await writesAfterConsent(a, ctxWith(ZEROED, { provision: true }));
      const last = writes[writes.length - 1];
      expect(last[0]).toBe(DBINC);
      expect(Buffer.from(last[1]).toString('hex')).toBe('01000000');
    });
  });

  describe('empty vendor user list (#229)', () => {
    const FFF2 = uuid16(0xfff2);
    const EMPTY = /no stored user profiles/;

    it('warns that the scale has no users when 0xFFF2 answers 02', () => {
      const warn = vi.spyOn(bleLog, 'warn').mockImplementation(() => {});
      const a = makeAdapter();
      expect(a.parseCharNotification(FFF2, Buffer.from('02', 'hex'))).toBeNull();
      expect(warn.mock.calls.flat().join(' ')).toMatch(EMPTY);
      warn.mockRestore();
    });

    it('warns when the list terminates with 01 and no slot records', () => {
      const warn = vi.spyOn(bleLog, 'warn').mockImplementation(() => {});
      const a = makeAdapter();
      a.parseCharNotification(FFF2, Buffer.from('01', 'hex'));
      expect(warn.mock.calls.flat().join(' ')).toMatch(EMPTY);
      warn.mockRestore();
    });

    it('stays quiet when a slot record was listed', () => {
      const warn = vi.spyOn(bleLog, 'warn').mockImplementation(() => {});
      const a = makeAdapter();
      a.parseCharNotification(FFF2, Buffer.from('0001ffffffbf070808c00103', 'hex'));
      a.parseCharNotification(FFF2, Buffer.from('01', 'hex'));
      expect(warn.mock.calls.flat().join(' ')).not.toMatch(EMPTY);
      warn.mockRestore();
    });

    it('does not report an empty user list for a truncated slot record', () => {
      const warn = vi.spyOn(bleLog, 'warn').mockImplementation(() => {});
      const a = makeAdapter();
      expect(a.parseCharNotification(FFF2, Buffer.from('0001ff', 'hex'))).toBeNull();
      expect(warn.mock.calls.flat().join(' ')).not.toMatch(EMPTY);
      warn.mockRestore();
    });

    it('does not report an empty user list for a zero-length frame', () => {
      const warn = vi.spyOn(bleLog, 'warn').mockImplementation(() => {});
      const a = makeAdapter();
      expect(a.parseCharNotification(FFF2, Buffer.alloc(0))).toBeNull();
      expect(warn.mock.calls.flat().join(' ')).not.toMatch(EMPTY);
      warn.mockRestore();
    });

    it('states plainly that the vendor table is empty when the consent was accepted', () => {
      // The SIG characteristics read back fully populated once provisioning has
      // written them, so nothing else in the log distinguishes "this scale has a
      // user" from "this scale has our values but no slot of its own" (#229).
      const warn = vi.spyOn(bleLog, 'warn').mockImplementation(() => {});
      const debug = vi.spyOn(bleLog, 'debug').mockImplementation(() => {});
      const a = makeAdapter();
      a.parseCharNotification(uuid16(0x2a9f), Buffer.from('200201', 'hex')); // consent accepted
      a.parseCharNotification(FFF2, Buffer.from('02', 'hex'));
      expect(debug.mock.calls.flat().join(' ')).toMatch(/named no stored user slot/);
      // Still no advice to change the PIN: the consent this scale holds works.
      expect(warn.mock.calls.flat().join(' ')).not.toMatch(EMPTY);
      warn.mockRestore();
      debug.mockRestore();
    });

    it('warns only once per session', () => {
      const warn = vi.spyOn(bleLog, 'warn').mockImplementation(() => {});
      const a = makeAdapter();
      a.parseCharNotification(FFF2, Buffer.from('02', 'hex'));
      a.parseCharNotification(FFF2, Buffer.from('02', 'hex'));
      const hits = warn.mock.calls.filter((c) => String(c[0]).includes('no stored user')).length;
      expect(hits).toBe(1);
      warn.mockRestore();
    });
  });

  // -- #229 review follow-ups: things the first pass got wrong ---------------
  describe('session hygiene and provisioning bounds (#229)', () => {
    const UCP = uuid16(0x2a9f);
    const FFF2 = uuid16(0xfff2);
    const FFF3 = uuid16(0xfff3);
    const DOB = uuid16(0x2a85);
    const GENDER = uuid16(0x2a8c);
    const HEIGHT = uuid16(0x2a8e);
    const DBINC = uuid16(0x2a99);
    const WEIGHT = uuid16(0x2a9d);
    const BODYCOMP = uuid16(0x2a9c);

    const ALL = new Set([WEIGHT, BODYCOMP, UCP, FFF2, FFF3, DOB, GENDER, HEIGHT, DBINC]);

    const settle = async (): Promise<void> => {
      for (let i = 0; i < 20; i++) await Promise.resolve();
    };

    function ctxWith(
      stored: Record<string, Buffer>,
      opts: { provision?: boolean; profile?: ConnectionContext['profile'] } = {},
    ): ConnectionContext {
      return {
        profile: opts.profile ?? defaultProfile(),
        deviceAddress: 'E7DB49F186DE',
        availableChars: ALL,
        scaleAuth: { pin: 3752, userIndex: 1, provision: opts.provision },
        write: vi.fn().mockResolvedValue(undefined),
        read: vi.fn(async (uuid: string) => stored[uuid] ?? Buffer.alloc(0)),
        subscribe: vi.fn().mockResolvedValue(undefined),
      } as unknown as ConnectionContext;
    }

    // Erased flash reads back as 0xff. An unbounded floor accepted 0xffff as a
    // birth year and as a 65535 cm height, so provisioning wrote it straight
    // back and the scale kept the garbage.
    it('treats an all-ff date of birth and height as unset and provisions them', async () => {
      const a = makeAdapter();
      const ctx = ctxWith(
        {
          [DOB]: Buffer.from('ffffffff', 'hex'),
          [HEIGHT]: Buffer.from('ffff', 'hex'),
          [GENDER]: Buffer.from('ff', 'hex'),
          [FFF3]: Buffer.from('ff', 'hex'),
        },
        { provision: true },
      );
      await a.onConnected(ctx);
      const write = ctx.write as ReturnType<typeof vi.fn>;
      write.mockClear();
      a.parseCharNotification(UCP, Buffer.from('200201', 'hex'));
      await settle();
      const writes = write.mock.calls.map((c) => [c[0] as string, c[1] as Buffer | number[]]);
      expect(Buffer.from(writes.find((w) => w[0] === HEIGHT)![1]).toString('hex')).toBe('b700');
      expect(Buffer.from(writes.find((w) => w[0] === DOB)![1]).toString('hex')).not.toBe(
        'ffffffff',
      );
    });

    // birth_date is a validated YYYY-MM-DD, so the scale should get the real
    // anniversary rather than 1 January of the derived year.
    it('provisions the real date of birth when the profile carries one', async () => {
      const a = makeAdapter();
      const ctx = ctxWith(
        { [DOB]: Buffer.from('00000000', 'hex') },
        { provision: true, profile: defaultProfile({ birthDate: '1990-06-15' }) },
      );
      await a.onConnected(ctx);
      const write = ctx.write as ReturnType<typeof vi.fn>;
      write.mockClear();
      a.parseCharNotification(UCP, Buffer.from('200201', 'hex'));
      await settle();
      const dob = write.mock.calls.find((c) => c[0] === DOB);
      // 1990 = 0x07C6, then month 6, day 15.
      expect(Buffer.from(dob![1] as number[]).toString('hex')).toBe('c607060f');
    });

    // Local and UTC getters agree at or east of Greenwich, so CI (UTC) cannot
    // see #344. Pin the zone or this branch is effectively untested.
    it('provisions the calendar date of birth on a host west of Greenwich', async () => {
      const savedTz = process.env.TZ;
      process.env.TZ = 'America/Montreal';
      try {
        const a = makeAdapter();
        const ctx = ctxWith(
          { [DOB]: Buffer.from('00000000', 'hex') },
          { provision: true, profile: defaultProfile({ birthDate: '1990-06-15' }) },
        );
        await a.onConnected(ctx);
        const write = ctx.write as ReturnType<typeof vi.fn>;
        write.mockClear();
        a.parseCharNotification(UCP, Buffer.from('200201', 'hex'));
        await settle();
        const dob = write.mock.calls.find((c) => c[0] === DOB);
        // 1990-06-15, not the 14th the local getters read back at UTC-4.
        expect(Buffer.from(dob![1] as number[]).toString('hex')).toBe('c607060f');
      } finally {
        if (savedTz === undefined) delete process.env.TZ;
        else process.env.TZ = savedTz;
      }
    });

    it('does not claim the scale is empty once the consent was accepted', () => {
      const warn = vi.spyOn(bleLog, 'warn').mockImplementation(() => {});
      const a = makeAdapter();
      a.parseCharNotification(UCP, Buffer.from('200201', 'hex'));
      a.parseCharNotification(FFF2, Buffer.from('01', 'hex'));
      expect(warn.mock.calls.flat().join(' ')).not.toMatch(/no stored user profiles/);
      warn.mockRestore();
    });

    it('ignores a User Control Point response to a different opcode', async () => {
      const a = makeAdapter();
      const ctx = ctxWith({});
      await a.onConnected(ctx);
      const read = ctx.read as ReturnType<typeof vi.fn>;
      read.mockClear();
      a.parseCharNotification(UCP, Buffer.from('200101', 'hex'));
      await settle();
      expect(read).not.toHaveBeenCalled();
    });

    it('names an unsupported User Control Point result', () => {
      const warn = vi.spyOn(bleLog, 'warn').mockImplementation(() => {});
      const a = makeAdapter();
      a.parseCharNotification(UCP, Buffer.from('200203', 'hex'));
      expect(warn.mock.calls.flat().join(' ')).toMatch(/INVALID_PARAMETER/);
      warn.mockRestore();
    });

    it('does not warn at session end when a reading was emitted', () => {
      const warn = vi.spyOn(bleLog, 'warn').mockImplementation(() => {});
      const a = makeAdapter();
      a.parseCharNotification(WEIGHT, WSS_FRAME);
      expect(a.parseCharNotification(BODYCOMP, BCS_FRAME)).not.toBeNull();
      a.onSessionEnd!();
      expect(warn.mock.calls.flat().join(' ')).not.toMatch(/no usable body-composition/);
      warn.mockRestore();
    });

    it('warns at session end when a weight arrived but no composition did', () => {
      const warn = vi.spyOn(bleLog, 'warn').mockImplementation(() => {});
      const a = makeAdapter();
      a.parseCharNotification(WEIGHT, WSS_FRAME);
      a.onSessionEnd!();
      expect(warn.mock.calls.flat().join(' ')).toMatch(/no usable body-composition/);
      warn.mockRestore();
    });

    // Multi-char subscriptions are enabled before onConnected is awaited, so a
    // frame from the next session must not inherit this session's cache.
    it('clears the cached weight, timestamp and composition at session end', () => {
      const a = makeAdapter();
      a.parseCharNotification(WEIGHT, WSS_FRAME);
      expect(a.parseCharNotification(BODYCOMP, BCS_FRAME)).not.toBeNull();
      a.onSessionEnd!();
      // A weight-only frame in the next session must not resolve on its own.
      expect(a.parseCharNotification(BODYCOMP, BCS_FRAME)).toBeNull();
    });
  });
});
