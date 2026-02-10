import { describe, it, expect, vi } from 'vitest';
import { ExcelvanCF369Adapter } from '../../src/scales/excelvan-cf369.js';
import type { ConnectionContext } from '../../src/interfaces/scale-adapter.js';
import {
  mockPeripheral,
  defaultProfile,
  assertPayloadRanges,
} from '../helpers/scale-test-utils.js';

function makeAdapter() {
  return new ExcelvanCF369Adapter();
}

describe('ExcelvanCF369Adapter', () => {
  describe('matches()', () => {
    it('matches "electronic scale" exact', () => {
      const adapter = makeAdapter();
      expect(adapter.matches(mockPeripheral('electronic scale'))).toBe(true);
    });

    it('matches case-insensitive', () => {
      const adapter = makeAdapter();
      expect(adapter.matches(mockPeripheral('Electronic Scale'))).toBe(true);
      expect(adapter.matches(mockPeripheral('ELECTRONIC SCALE'))).toBe(true);
    });

    it('does not match "cf369"', () => {
      const adapter = makeAdapter();
      expect(adapter.matches(mockPeripheral('cf369'))).toBe(false);
    });

    it('does not match unrelated name', () => {
      const adapter = makeAdapter();
      expect(adapter.matches(mockPeripheral('Random Scale'))).toBe(false);
    });
  });

  describe('parseNotification()', () => {
    it('parses frame with body comp (complete, [6] != 0xFF)', () => {
      const adapter = makeAdapter();
      const buf = Buffer.alloc(14);
      buf[0] = 0xcf; // marker
      buf.writeUInt16BE(800, 4); // weight = 800 / 10 = 80.0 kg
      buf.writeUInt16BE(225, 6); // fat = 22.5%
      buf[8] = 35; // bone = 3.5 kg
      buf.writeUInt16BE(400, 9); // muscle = 40.0%
      buf[11] = 8; // visceral fat
      buf.writeUInt16BE(550, 12); // water = 55.0%

      const reading = adapter.parseNotification(buf);
      expect(reading).not.toBeNull();
      expect(reading!.weight).toBe(80);
      expect(reading!.impedance).toBe(0);
    });

    it('parses incomplete frame ([6] == 0xFF)', () => {
      const adapter = makeAdapter();
      const buf = Buffer.alloc(14);
      buf[0] = 0xcf;
      buf.writeUInt16BE(800, 4);
      buf[6] = 0xff; // incomplete — fat undefined

      const reading = adapter.parseNotification(buf);
      expect(reading).not.toBeNull();
      expect(reading!.weight).toBe(80);
    });

    it('returns null for wrong marker', () => {
      const adapter = makeAdapter();
      const buf = Buffer.alloc(14);
      buf[0] = 0xce; // wrong
      buf.writeUInt16BE(800, 4);
      expect(adapter.parseNotification(buf)).toBeNull();
    });

    it('returns null for too-short buffer', () => {
      const adapter = makeAdapter();
      expect(adapter.parseNotification(Buffer.alloc(13))).toBeNull();
    });

    it('returns null when weight is zero', () => {
      const adapter = makeAdapter();
      const buf = Buffer.alloc(14);
      buf[0] = 0xcf;
      buf.writeUInt16BE(0, 4);
      expect(adapter.parseNotification(buf)).toBeNull();
    });
  });

  describe('isComplete()', () => {
    it('returns true when weight > 0 and cachedFat > 0', () => {
      const adapter = makeAdapter();
      const buf = Buffer.alloc(14);
      buf[0] = 0xcf;
      buf.writeUInt16BE(800, 4);
      buf.writeUInt16BE(225, 6);
      buf[8] = 35;
      buf.writeUInt16BE(400, 9);
      buf[11] = 8;
      buf.writeUInt16BE(550, 12);
      adapter.parseNotification(buf);

      expect(adapter.isComplete({ weight: 80, impedance: 0 })).toBe(true);
    });

    it('returns false when fat is not set (incomplete frame)', () => {
      const adapter = makeAdapter();
      const buf = Buffer.alloc(14);
      buf[0] = 0xcf;
      buf.writeUInt16BE(800, 4);
      buf[6] = 0xff;
      adapter.parseNotification(buf);

      expect(adapter.isComplete({ weight: 80, impedance: 0 })).toBe(false);
    });

    it('returns false when weight is 0', () => {
      const adapter = makeAdapter();
      expect(adapter.isComplete({ weight: 0, impedance: 0 })).toBe(false);
    });
  });

  describe('onConnected()', () => {
    it('sends user-config command with correct profile data', async () => {
      const adapter = makeAdapter();
      const writeFn = vi.fn().mockResolvedValue(undefined);
      const profile = defaultProfile({ gender: 'male', height: 183, age: 30 });

      const ctx: ConnectionContext = {
        write: writeFn,
        read: vi.fn(),
        subscribe: vi.fn(),
        profile,
      };

      await adapter.onConnected(ctx);

      expect(writeFn).toHaveBeenCalledOnce();
      const [charUuid, data, withResponse] = writeFn.mock.calls[0];
      expect(charUuid).toBe(adapter.charWriteUuid);
      expect(withResponse).toBe(false);

      // Verify command structure: [0xFE, userId, sex, activity, height, age, unit, xor]
      expect(data[0]).toBe(0xfe);
      expect(data[1]).toBe(0x01); // userId
      expect(data[2]).toBe(0x01); // male
      expect(data[3]).toBe(0x01); // activity
      expect(data[4]).toBe(183); // height
      expect(data[5]).toBe(30); // age
      expect(data[6]).toBe(0x01); // kg unit
      expect(data.length).toBe(8); // includes XOR checksum
    });

    it('sends female gender code for female profile', async () => {
      const adapter = makeAdapter();
      const writeFn = vi.fn().mockResolvedValue(undefined);
      const profile = defaultProfile({ gender: 'female', height: 165, age: 25 });

      const ctx: ConnectionContext = {
        write: writeFn,
        read: vi.fn(),
        subscribe: vi.fn(),
        profile,
      };

      await adapter.onConnected(ctx);

      const data = writeFn.mock.calls[0][1];
      expect(data[2]).toBe(0x00); // female
      expect(data[4]).toBe(165);
      expect(data[5]).toBe(25);
    });
  });

  describe('computeMetrics()', () => {
    it('returns valid GarminPayload with cached body comp', () => {
      const adapter = makeAdapter();
      const buf = Buffer.alloc(14);
      buf[0] = 0xcf;
      buf.writeUInt16BE(800, 4);
      buf.writeUInt16BE(225, 6);
      buf[8] = 35;
      buf.writeUInt16BE(400, 9);
      buf[11] = 8;
      buf.writeUInt16BE(550, 12);
      adapter.parseNotification(buf);

      const profile = defaultProfile();
      const payload = adapter.computeMetrics({ weight: 80, impedance: 0 }, profile);
      expect(payload.weight).toBe(80);
      assertPayloadRanges(payload);
    });

    it('returns zero weight in payload for zero weight input', () => {
      const adapter = makeAdapter();
      const profile = defaultProfile();
      const payload = adapter.computeMetrics({ weight: 0, impedance: 0 }, profile);
      expect(payload.weight).toBe(0);
    });
  });
});
