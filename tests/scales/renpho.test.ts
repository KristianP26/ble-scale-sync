import { describe, it, expect, vi } from 'vitest';
import { RenphoScaleAdapter } from '../../src/scales/renpho.js';
import type { ConnectionContext } from '../../src/interfaces/scale-adapter.js';
import { uuid16 } from '../../src/scales/body-comp-helpers.js';
import { isHistoricalReading } from '../../src/interfaces/reading-time.js';
import { QnScaleAdapter } from '../../src/scales/qn-scale/index.js';
import {
  mockPeripheral,
  defaultProfile,
  assertPayloadRanges,
} from '../helpers/scale-test-utils.js';

const CHR_WEIGHT = uuid16(0x2a9d);
const CHR_BODYCOMP = uuid16(0x2a9c);
const CHR_UCP = uuid16(0x2a9f);
const CHR_VENDOR_NOTIFY = uuid16(0xffe1);
const CHR_VENDOR_WRITE = uuid16(0xffe2);
const CHR_GENDER = uuid16(0x2a8c);
const CHR_HEIGHT = uuid16(0x2a8e);
const CHR_DOB = uuid16(0x2a85);
const CHR_AGE = uuid16(0x2a80);
const CHR_VENDOR_2AFF = uuid16(0x2aff);

// Live frames decoded from the physical-device btsnoop capture.
// Weight frame 1374: flags 0x4E, raw 0x076A = 1898 → 94.9 kg (×0.05).
const WSS_FRAME = Buffer.from('4e6a07ea0707040c1a06aa00000000', 'hex');
// Body-comp packet 2 (frame 1477): flags 0x020C, impedance 0x0D00 = 3328 → 332.8 Ω.
const BCS_PACKET2 = Buffer.from('0c02f901f70144000dec00a500290091020600', 'hex');

function makeAdapter() {
  return new RenphoScaleAdapter();
}

/** Run at the time the capture's weight frame is stamped, so it reads as live. */
function atCaptureTime(fn: () => void): void {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 6, 4, 12, 26, 10));
  try {
    fn();
  } finally {
    vi.useRealTimers();
  }
}

const ALL_CHARS = new Set([
  CHR_WEIGHT,
  CHR_BODYCOMP,
  CHR_UCP,
  CHR_VENDOR_NOTIFY,
  CHR_VENDOR_WRITE,
  CHR_GENDER,
  CHR_HEIGHT,
  CHR_DOB,
  CHR_AGE,
  CHR_VENDOR_2AFF,
]);

function makeCtx(over: Partial<ConnectionContext> = {}): ConnectionContext {
  return {
    profile: defaultProfile(),
    deviceAddress: '',
    availableChars: ALL_CHARS,
    write: vi.fn().mockResolvedValue(undefined),
    read: vi.fn().mockResolvedValue(Buffer.alloc(0)),
    subscribe: vi.fn().mockResolvedValue(undefined),
    ...over,
  } as ConnectionContext;
}

describe('RenphoScaleAdapter', () => {
  describe('matches()', () => {
    it('matches a real ES-WBE28 advert (renpho + SIG WSS/BCS, no QN UUID)', () => {
      expect(makeAdapter().matches(mockPeripheral('Renpho-Scale', ['181b', '181d']))).toBe(true);
    });
    it('matches case-insensitively without QN services', () => {
      expect(makeAdapter().matches(mockPeripheral('RENPHO', []))).toBe(true);
    });
    it.each(['ffe0', 'fff0', '0000ffe000001000800000805f9b34fb'])(
      'rejects renpho advertising QN service %s',
      (svc) => {
        expect(makeAdapter().matches(mockPeripheral('Renpho Scale', [svc]))).toBe(false);
      },
    );
    it('does not match an unrelated name', () => {
      expect(makeAdapter().matches(mockPeripheral('Yunmai ISM', []))).toBe(false);
    });

    // D-04: after GATT discovery the device carries the 0xFFE0 service that
    // hosts its vendor pair, which the service rule reads as QN. Its
    // characteristics (ALL_CHARS, from the #267 capture) say otherwise: the SIG
    // consent pair, and no QN write characteristic (0xFFF2 / 0xFFE3).
    it('claims the discovered ES-WBE28 on its characteristics, and QN declines it', () => {
      const discovered = {
        localName: 'Renpho-Scale',
        serviceUuids: [0x181b, 0x181d, 0x181c, 0xffe0].map(uuid16),
        characteristicUuids: [...ALL_CHARS],
      };
      expect(makeAdapter().matches(discovered)).toBe(true);
      expect(new QnScaleAdapter().matches(discovered)).toBe(false);
    });

    it('leaves a renpho device with the QN characteristic pair to QN', () => {
      const qn = {
        localName: 'Renpho',
        serviceUuids: [uuid16(0xfff0)],
        characteristicUuids: [0xfff1, 0xfff2, 0x2a9d, 0x2a9f].map(uuid16),
      };
      expect(makeAdapter().matches(qn)).toBe(false);
      expect(new QnScaleAdapter().matches(qn)).toBe(true);
    });
  });

  describe('onConnected()', () => {
    it('replays handshake → consent → profile, then enables measurement notifs LAST', async () => {
      const a = makeAdapter();
      const ctx = makeCtx();
      await a.onConnected(ctx);

      const write = ctx.write as ReturnType<typeof vi.fn>;
      const subscribe = ctx.subscribe as ReturnType<typeof vi.fn>;

      // Three vendor handshake writes to 0xFFE2 come first.
      expect(write.mock.calls[0]).toEqual([CHR_VENDOR_WRITE, [0x10, 0x01, 0x00, 0x11], true]);
      expect(write.mock.calls[1]).toEqual([CHR_VENDOR_WRITE, [0x03, 0x00, 0x01, 0x04], true]);
      expect(write.mock.calls[2]).toEqual([CHR_VENDOR_WRITE, [0x19, 0x00, 0x19], true]);

      // Consent: opcode 0x02, user 0xAA (170), code 9999 = 0x270F → LE 0F 27.
      expect(write.mock.calls[3]).toEqual([CHR_UCP, [0x02, 0xaa, 0x0f, 0x27], true]);

      // Profile writes follow (gender/height/dob/age/vendor).
      const writtenChars = write.mock.calls.map((c) => c[0]);
      expect(writtenChars).toContain(CHR_GENDER);
      expect(writtenChars).toContain(CHR_HEIGHT);
      expect(writtenChars).toContain(CHR_AGE);

      // Measurement notifications are enabled ONLY after all init writes.
      expect(subscribe).toHaveBeenCalledWith(CHR_WEIGHT);
      expect(subscribe).toHaveBeenCalledWith(CHR_BODYCOMP);
      expect(subscribe).not.toHaveBeenCalledBefore(write);
    });

    it('throws a clear error when consent/vendor chars are missing', async () => {
      const a = makeAdapter();
      await expect(
        a.onConnected(makeCtx({ availableChars: new Set([CHR_WEIGHT]) })),
      ).rejects.toThrow(/discovery race/);
    });

    it('skips profile writes for characteristics the firmware lacks', async () => {
      const a = makeAdapter();
      // Only the essential consent/vendor chars present — profile chars absent.
      const ctx = makeCtx({ availableChars: new Set([CHR_UCP, CHR_VENDOR_WRITE]) });
      await a.onConnected(ctx);
      const writtenChars = (ctx.write as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
      expect(writtenChars).not.toContain(CHR_GENDER);
      // Handshake + consent still happened.
      expect(writtenChars).toContain(CHR_VENDOR_WRITE);
      expect(writtenChars).toContain(CHR_UCP);
    });

    // #267 review (P1): the vendor 0xFFE2 service is not advertised (the matcher
    // rejects devices advertising 0xFFE0), so a firmware variant may not expose
    // it. Consent alone unlocks the stream, so a missing 0xFFE2 must not abort.
    it('consents without throwing when the vendor write char is absent', async () => {
      const a = makeAdapter();
      const ctx = makeCtx({ availableChars: new Set([CHR_UCP]) });
      await expect(a.onConnected(ctx)).resolves.toBeUndefined();
      const writtenChars = (ctx.write as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
      expect(writtenChars).toContain(CHR_UCP);
      expect(writtenChars).not.toContain(CHR_VENDOR_WRITE);
    });
  });

  describe('parseCharNotification()', () => {
    it('decodes a real SIG weight frame (flags byte, not a 0x2E marker)', () => {
      const a = makeAdapter();
      const reading = a.parseCharNotification(CHR_WEIGHT, WSS_FRAME);
      expect(reading).not.toBeNull();
      expect(reading!.weight).toBeCloseTo(94.9, 1);
    });

    it('extracts impedance from a body-composition packet', () => {
      atCaptureTime(() => {
        const a = makeAdapter();
        a.parseCharNotification(CHR_WEIGHT, WSS_FRAME);
        const reading = a.parseCharNotification(CHR_BODYCOMP, BCS_PACKET2);
        expect(reading).not.toBeNull();
        expect(reading!.weight).toBeCloseTo(94.9, 1);
        expect(reading!.impedance).toBeCloseTo(332.8, 1);
      });
    });

    // D-11 / D027: the captured live weight frame has flags 0x4E, so it carries
    // a SIG Date Time (2026-07-04 12:26:06) that the adapter used to drop.
    it('carries the time stamp of the weight frame', () => {
      atCaptureTime(() => {
        const reading = makeAdapter().parseCharNotification(CHR_WEIGHT, WSS_FRAME);
        expect(reading!.timestamp).toEqual(new Date(2026, 6, 4, 12, 26, 6));
        expect(isHistoricalReading(reading!)).toBe(false);
      });
    });

    // D-11: the impedance is held across frames ("first impedance seen"), so a
    // weigh-in's impedance completed the NEXT weight's hold too: a stored record
    // replayed after the consent lent its impedance to the live weigh-in.
    it('does not carry one weigh-in impedance onto the next weight', () => {
      atCaptureTime(() => {
        const a = makeAdapter();
        a.parseCharNotification(CHR_WEIGHT, WSS_FRAME);
        expect(a.parseCharNotification(CHR_BODYCOMP, BCS_PACKET2)!.impedance).toBeCloseTo(332.8, 1);
        const next = a.parseCharNotification(CHR_WEIGHT, WSS_FRAME);
        expect(next!.impedance).toBe(0);
        expect(a.isFinal(next!)).toBe(false);
      });
    });

    // A stored record is buffered as history the moment it is emitted, so its
    // impedance joins that reading instead of becoming a second export of it.
    it('emits a stored record once, with the impedance that follows it', () => {
      // Real clock: the July capture stamp is a stored record by now.
      const a = makeAdapter();
      const stored = a.parseCharNotification(CHR_WEIGHT, WSS_FRAME);
      expect(isHistoricalReading(stored!)).toBe(true);
      expect(a.parseCharNotification(CHR_BODYCOMP, BCS_PACKET2)).toBeNull();
      expect(stored!.impedance).toBeCloseTo(332.8, 1);
    });

    it('parses imperial (lb) weight frames to kg', () => {
      const a = makeAdapter();
      const buf = Buffer.alloc(3);
      buf[0] = 0x01; // flags: imperial, no optional fields
      buf.writeUInt16LE(2000, 1); // 2000 × 0.1 lb = 200 lb → ~90.72 kg
      const reading = a.parseCharNotification(CHR_WEIGHT, buf);
      expect(reading!.weight).toBeCloseTo(200 * 0.45359237, 1);
    });

    it('ignores User Control Point responses without emitting a reading', () => {
      const a = makeAdapter();
      expect(a.parseCharNotification(CHR_UCP, Buffer.from([0x20, 0x02, 0x01]))).toBeNull();
      expect(a.parseCharNotification(CHR_UCP, Buffer.from([0x20, 0x02, 0x05]))).toBeNull();
    });

    it('does not throw on a truncated body-comp frame that over-claims via flags', () => {
      const a = makeAdapter();
      // flags 0x0300 claim body-water + impedance, but only fat% fits.
      const truncated = Buffer.from([0x00, 0x03, 0x12, 0x01]);
      expect(() => a.parseCharNotification(CHR_BODYCOMP, truncated)).not.toThrow();
    });
  });

  describe('isComplete() / isFinal()', () => {
    it('is complete once weight is positive', () => {
      const a = makeAdapter();
      expect(a.isComplete({ weight: 80, impedance: 0 })).toBe(true);
      expect(a.isComplete({ weight: 0, impedance: 0 })).toBe(false);
    });
    it('is final only once impedance has arrived', () => {
      const a = makeAdapter();
      expect(a.isFinal({ weight: 80, impedance: 0 })).toBe(false);
      expect(a.isFinal({ weight: 80, impedance: 332.8 })).toBe(true);
    });
  });

  describe('computeMetrics()', () => {
    it('uses impedance (BIA) for body fat when present', () => {
      const a = makeAdapter();
      const profile = defaultProfile();
      const withImp = a.computeMetrics({ weight: 80, impedance: 500 }, profile);
      const noImp = a.computeMetrics({ weight: 80, impedance: 0 }, profile);
      assertPayloadRanges(withImp);
      assertPayloadRanges(noImp);
      expect(withImp.impedance).toBe(500);
      // BIA-derived fat should differ from the BMI-only estimate.
      expect(withImp.bodyFatPercent).not.toBe(noImp.bodyFatPercent);
    });
  });
});
