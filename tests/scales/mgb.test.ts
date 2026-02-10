import { describe, it, expect } from 'vitest';
import { MgbAdapter } from '../../src/scales/mgb.js';
import {
  mockPeripheral,
  defaultProfile,
  assertPayloadRanges,
} from '../helpers/scale-test-utils.js';

function makeAdapter() {
  return new MgbAdapter();
}

describe('MgbAdapter', () => {
  describe('matches()', () => {
    it('matches "swan..." prefix', () => {
      const adapter = makeAdapter();
      expect(adapter.matches(mockPeripheral('swan123'))).toBe(true);
      expect(adapter.matches(mockPeripheral('Swan ABC'))).toBe(true);
    });

    it('matches "icomon" exact', () => {
      const adapter = makeAdapter();
      expect(adapter.matches(mockPeripheral('icomon'))).toBe(true);
    });

    it('matches "yg" exact', () => {
      const adapter = makeAdapter();
      expect(adapter.matches(mockPeripheral('yg'))).toBe(true);
    });

    it('matches by service UUID "ffb0"', () => {
      const adapter = makeAdapter();
      expect(adapter.matches(mockPeripheral('Unknown', ['ffb0']))).toBe(true);
    });

    it('matches case-insensitive', () => {
      const adapter = makeAdapter();
      expect(adapter.matches(mockPeripheral('SWAN123'))).toBe(true);
      expect(adapter.matches(mockPeripheral('ICOMON'))).toBe(true);
      expect(adapter.matches(mockPeripheral('YG'))).toBe(true);
    });

    it('does not match unrelated name without service UUID', () => {
      const adapter = makeAdapter();
      expect(adapter.matches(mockPeripheral('Random Scale'))).toBe(false);
    });
  });

  describe('parseNotification()', () => {
    it('parses Frame1 (weight + fat)', () => {
      const adapter = makeAdapter();
      const buf = Buffer.alloc(15);
      buf[0] = 0xac;
      buf[1] = 0x02;
      buf[2] = 0xff;
      buf.writeUInt16BE(800, 9); // weight = 800 / 10 = 80.0 kg
      buf.writeUInt16BE(225, 13); // fat = 225 / 10 = 22.5%

      const reading = adapter.parseNotification(buf);
      expect(reading).not.toBeNull();
      expect(reading!.weight).toBe(80);
    });

    it('parses Frame1 with 0x03 variant', () => {
      const adapter = makeAdapter();
      const buf = Buffer.alloc(15);
      buf[0] = 0xac;
      buf[1] = 0x03; // variant
      buf[2] = 0xff;
      buf.writeUInt16BE(800, 9);
      buf.writeUInt16BE(225, 13);

      const reading = adapter.parseNotification(buf);
      expect(reading).not.toBeNull();
      expect(reading!.weight).toBe(80);
    });

    it('parses Frame2 (muscle/bone/water) after Frame1', () => {
      const adapter = makeAdapter();

      // Frame1
      const f1 = Buffer.alloc(15);
      f1[0] = 0xac;
      f1[1] = 0x02;
      f1[2] = 0xff;
      f1.writeUInt16BE(800, 9);
      f1.writeUInt16BE(225, 13);
      adapter.parseNotification(f1);

      // Frame2
      const f2 = Buffer.alloc(10);
      f2[0] = 0x01;
      f2[1] = 0x00;
      f2.writeUInt16LE(400, 2); // muscle = 40.0%
      f2.writeUInt16LE(35, 6); // bone = 3.5 kg
      f2.writeUInt16LE(550, 8); // water = 55.0%

      const reading = adapter.parseNotification(f2);
      expect(reading).not.toBeNull();
      expect(reading!.weight).toBe(80);
    });

    it('returns null for too-short buffer', () => {
      const adapter = makeAdapter();
      expect(adapter.parseNotification(Buffer.alloc(5))).toBeNull();
    });

    it('returns null when no weight received yet', () => {
      const adapter = makeAdapter();
      const f2 = Buffer.alloc(10);
      f2[0] = 0x01;
      f2[1] = 0x00;
      f2.writeUInt16LE(400, 2);
      f2.writeUInt16LE(35, 6);
      f2.writeUInt16LE(550, 8);
      expect(adapter.parseNotification(f2)).toBeNull();
    });
  });

  describe('isComplete()', () => {
    it('returns true when weight > 0 and cachedFat > 0', () => {
      const adapter = makeAdapter();

      const f1 = Buffer.alloc(15);
      f1[0] = 0xac;
      f1[1] = 0x02;
      f1[2] = 0xff;
      f1.writeUInt16BE(800, 9);
      f1.writeUInt16BE(225, 13);
      adapter.parseNotification(f1);

      expect(adapter.isComplete({ weight: 80, impedance: 0 })).toBe(true);
    });

    it('returns false when only Frame2 received (no fat)', () => {
      const adapter = makeAdapter();
      expect(adapter.isComplete({ weight: 80, impedance: 0 })).toBe(false);
    });

    it('returns false when weight is 0', () => {
      const adapter = makeAdapter();
      expect(adapter.isComplete({ weight: 0, impedance: 0 })).toBe(false);
    });
  });

  describe('computeMetrics()', () => {
    it('returns valid GarminPayload', () => {
      const adapter = makeAdapter();

      const f1 = Buffer.alloc(15);
      f1[0] = 0xac;
      f1[1] = 0x02;
      f1[2] = 0xff;
      f1.writeUInt16BE(800, 9);
      f1.writeUInt16BE(225, 13);
      adapter.parseNotification(f1);

      const f2 = Buffer.alloc(10);
      f2[0] = 0x01;
      f2[1] = 0x00;
      f2.writeUInt16LE(400, 2);
      f2.writeUInt16LE(35, 6);
      f2.writeUInt16LE(550, 8);
      adapter.parseNotification(f2);

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
