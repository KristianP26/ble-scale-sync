import { describe, it, expect, vi } from 'vitest';
import { DigooScaleAdapter } from '../../src/scales/digoo.js';
import type { ConnectionContext } from '../../src/interfaces/scale-adapter.js';
import {
  mockPeripheral,
  defaultProfile,
  assertPayloadRanges,
} from '../helpers/scale-test-utils.js';

function makeAdapter() {
  return new DigooScaleAdapter();
}

describe('DigooScaleAdapter', () => {
  describe('matches()', () => {
    it('matches "mengii" exact', () => {
      const adapter = makeAdapter();
      expect(adapter.matches(mockPeripheral('mengii'))).toBe(true);
    });

    it('matches case-insensitive', () => {
      const adapter = makeAdapter();
      expect(adapter.matches(mockPeripheral('Mengii'))).toBe(true);
      expect(adapter.matches(mockPeripheral('MENGII'))).toBe(true);
    });

    it('does not match "digoo"', () => {
      const adapter = makeAdapter();
      expect(adapter.matches(mockPeripheral('digoo'))).toBe(false);
    });

    it('does not match unrelated name', () => {
      const adapter = makeAdapter();
      expect(adapter.matches(mockPeripheral('Random Scale'))).toBe(false);
    });
  });

  describe('parseNotification()', () => {
    it('parses frame with stable + allValues', () => {
      const adapter = makeAdapter();
      const buf = Buffer.alloc(19);
      buf.writeUInt16BE(8000, 3); // weight = 8000 / 100 = 80.0 kg
      buf[5] = 0x03; // control: stable (bit0) + allValues (bit1)
      buf.writeUInt16BE(225, 6); // fat = 22.5%
      buf[10] = 80; // visceral = 8.0
      buf.writeUInt16BE(550, 11); // water = 55.0%
      buf.writeUInt16BE(400, 16); // muscle = 40.0%
      buf[18] = 35; // bone = 3.5 kg

      const reading = adapter.parseNotification(buf);
      expect(reading).not.toBeNull();
      expect(reading!.weight).toBe(80);
    });

    it('parses frame without allValues (weight only)', () => {
      const adapter = makeAdapter();
      const buf = Buffer.alloc(19);
      buf.writeUInt16BE(8000, 3);
      buf[5] = 0x01; // stable only, no allValues

      const reading = adapter.parseNotification(buf);
      expect(reading).not.toBeNull();
      expect(reading!.weight).toBe(80);
    });

    it('returns null for too-short buffer', () => {
      const adapter = makeAdapter();
      expect(adapter.parseNotification(Buffer.alloc(18))).toBeNull();
    });

    it('returns null when weight is zero', () => {
      const adapter = makeAdapter();
      const buf = Buffer.alloc(19);
      buf.writeUInt16BE(0, 3);
      buf[5] = 0x03;
      expect(adapter.parseNotification(buf)).toBeNull();
    });
  });

  describe('isComplete()', () => {
    it('returns true when weight > 0 and stable and allValues', () => {
      const adapter = makeAdapter();
      const buf = Buffer.alloc(19);
      buf.writeUInt16BE(8000, 3);
      buf[5] = 0x03; // stable + allValues
      buf.writeUInt16BE(225, 6);
      buf[10] = 80;
      buf.writeUInt16BE(550, 11);
      buf.writeUInt16BE(400, 16);
      buf[18] = 35;
      adapter.parseNotification(buf);

      expect(adapter.isComplete({ weight: 80, impedance: 0 })).toBe(true);
    });

    it('returns false when not stable', () => {
      const adapter = makeAdapter();
      const buf = Buffer.alloc(19);
      buf.writeUInt16BE(8000, 3);
      buf[5] = 0x02; // allValues but not stable
      buf.writeUInt16BE(225, 6);
      buf[10] = 80;
      buf.writeUInt16BE(550, 11);
      buf.writeUInt16BE(400, 16);
      buf[18] = 35;
      adapter.parseNotification(buf);

      expect(adapter.isComplete({ weight: 80, impedance: 0 })).toBe(false);
    });

    it('returns false when not allValues', () => {
      const adapter = makeAdapter();
      const buf = Buffer.alloc(19);
      buf.writeUInt16BE(8000, 3);
      buf[5] = 0x01; // stable but no allValues
      adapter.parseNotification(buf);

      expect(adapter.isComplete({ weight: 80, impedance: 0 })).toBe(false);
    });

    it('returns false when weight is 0', () => {
      const adapter = makeAdapter();
      expect(adapter.isComplete({ weight: 0, impedance: 0 })).toBe(false);
    });
  });

  describe('onConnected()', () => {
    it('sends user config command with profile data', async () => {
      const adapter = makeAdapter();
      const writeFn = vi.fn().mockResolvedValue(undefined);
      const profile = defaultProfile({ gender: 'male', height: 183, age: 30 });

      const ctx: ConnectionContext = {
        write: writeFn,
        read: vi.fn(),
        subscribe: vi.fn(),
        profile,
      };

      await adapter.onConnected!(ctx);

      expect(writeFn).toHaveBeenCalledOnce();
      const [charUuid, data, withResponse] = writeFn.mock.calls[0];
      expect(charUuid).toBe(adapter.charWriteUuid);
      expect(withResponse).toBe(false);

      // Verify format: [0x09, 0x10, 0x12, 0x11, 0x0D, 0x01, height, age, gender, unit, ...]
      expect(data[0]).toBe(0x09);
      expect(data[5]).toBe(0x01);
      expect(data[6]).toBe(183); // height
      expect(data[7]).toBe(30); // age
      expect(data[8]).toBe(0x00); // male
      expect(data.length).toBe(16); // 15 bytes + checksum
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

      await adapter.onConnected!(ctx);

      const data = writeFn.mock.calls[0][1];
      expect(data[6]).toBe(165);
      expect(data[7]).toBe(25);
      expect(data[8]).toBe(0x01); // female
    });
  });

  describe('computeMetrics()', () => {
    it('returns valid GarminPayload with cached body comp', () => {
      const adapter = makeAdapter();
      const buf = Buffer.alloc(19);
      buf.writeUInt16BE(8000, 3);
      buf[5] = 0x03;
      buf.writeUInt16BE(225, 6);
      buf[10] = 80;
      buf.writeUInt16BE(550, 11);
      buf.writeUInt16BE(400, 16);
      buf[18] = 35;
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
