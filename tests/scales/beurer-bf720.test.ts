import { describe, it, expect, vi } from 'vitest';
import { BeurerBf720Adapter } from '../../src/scales/beurer-bf720.js';
import type { BleDeviceInfo, ConnectionContext } from '../../src/interfaces/scale-adapter.js';
import { uuid16 } from '../../src/scales/body-comp-helpers.js';
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
  describe('matches()', () => {
    it.each(['BF720', 'beurer bf105', 'My BF720 Scale'])('matches name "%s"', (name) => {
      expect(makeAdapter().matches(mockPeripheral(name))).toBe(true);
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
});
