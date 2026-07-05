import { describe, it, expect, vi } from 'vitest';
import { RenphoScaleAdapter } from '../../src/scales/renpho.js';
import type { ConnectionContext } from '../../src/interfaces/scale-adapter.js';
import { uuid16 } from '../../src/scales/body-comp-helpers.js';
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
  });

  describe('parseCharNotification()', () => {
    it('decodes a real SIG weight frame (flags byte, not a 0x2E marker)', () => {
      const a = makeAdapter();
      const reading = a.parseCharNotification(CHR_WEIGHT, WSS_FRAME);
      expect(reading).not.toBeNull();
      expect(reading!.weight).toBeCloseTo(94.9, 1);
    });

    it('extracts impedance from a body-composition packet', () => {
      const a = makeAdapter();
      a.parseCharNotification(CHR_WEIGHT, WSS_FRAME);
      const reading = a.parseCharNotification(CHR_BODYCOMP, BCS_PACKET2);
      expect(reading).not.toBeNull();
      expect(reading!.weight).toBeCloseTo(94.9, 1);
      expect(reading!.impedance).toBeCloseTo(332.8, 1);
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
