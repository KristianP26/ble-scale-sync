import { describe, it, expect } from 'vitest';
import { HesleyScaleAdapter } from '../../src/scales/hesley.js';
import {
  mockPeripheral,
  defaultProfile,
  assertPayloadRanges,
} from '../helpers/scale-test-utils.js';

function makeAdapter() {
  return new HesleyScaleAdapter();
}

describe('HesleyScaleAdapter', () => {
  describe('matches()', () => {
    it('matches "yunchen" exact', () => {
      const adapter = makeAdapter();
      expect(adapter.matches(mockPeripheral('yunchen'))).toBe(true);
    });

    it('matches case-insensitive', () => {
      const adapter = makeAdapter();
      expect(adapter.matches(mockPeripheral('YunChen'))).toBe(true);
      expect(adapter.matches(mockPeripheral('YUNCHEN'))).toBe(true);
    });

    it('does not match "hesley"', () => {
      const adapter = makeAdapter();
      expect(adapter.matches(mockPeripheral('hesley'))).toBe(false);
    });

    it('does not match unrelated name', () => {
      const adapter = makeAdapter();
      expect(adapter.matches(mockPeripheral('Random Scale'))).toBe(false);
    });
  });

  describe('parseNotification()', () => {
    it('parses valid frame with weight and body comp', () => {
      const adapter = makeAdapter();
      const buf = Buffer.alloc(14);
      buf.writeUInt16BE(8000, 2); // weight = 8000 / 100 = 80.0 kg
      buf.writeUInt16BE(225, 4); // fat = 22.5%
      buf.writeUInt16BE(550, 8); // water = 55.0%
      buf.writeUInt16BE(400, 10); // muscle = 40.0%
      buf.writeUInt16BE(35, 12); // bone = 3.5 kg

      const reading = adapter.parseNotification(buf);
      expect(reading).not.toBeNull();
      expect(reading!.weight).toBe(80);
      expect(reading!.impedance).toBe(0);
    });

    it('returns null for too-short buffer', () => {
      const adapter = makeAdapter();
      expect(adapter.parseNotification(Buffer.alloc(13))).toBeNull();
    });

    it('returns null when weight is zero', () => {
      const adapter = makeAdapter();
      const buf = Buffer.alloc(14);
      buf.writeUInt16BE(0, 2);
      expect(adapter.parseNotification(buf)).toBeNull();
    });
  });

  describe('isComplete()', () => {
    it('returns true when weight > 0', () => {
      const adapter = makeAdapter();
      expect(adapter.isComplete({ weight: 80, impedance: 0 })).toBe(true);
    });

    it('returns false when weight is 0', () => {
      const adapter = makeAdapter();
      expect(adapter.isComplete({ weight: 0, impedance: 0 })).toBe(false);
    });
  });

  describe('computeMetrics()', () => {
    it('returns valid GarminPayload with cached body comp', () => {
      const adapter = makeAdapter();
      const buf = Buffer.alloc(14);
      buf.writeUInt16BE(8000, 2);
      buf.writeUInt16BE(225, 4);
      buf.writeUInt16BE(550, 8);
      buf.writeUInt16BE(400, 10);
      buf.writeUInt16BE(35, 12);
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
