import { describe, it, expect } from 'vitest';
import { SoehnleScaleAdapter } from '../../src/scales/soehnle.js';
import {
  mockPeripheral,
  defaultProfile,
  assertPayloadRanges,
} from '../helpers/scale-test-utils.js';

function makeAdapter() {
  return new SoehnleScaleAdapter();
}

describe('SoehnleScaleAdapter', () => {
  describe('matches()', () => {
    it.each(['shape200', 'shape100', 'shape50', 'style100'])('matches "%s" prefix', (name) => {
      const adapter = makeAdapter();
      expect(adapter.matches(mockPeripheral(name))).toBe(true);
    });

    it('matches with suffix after known prefix', () => {
      const adapter = makeAdapter();
      expect(adapter.matches(mockPeripheral('shape200-abc'))).toBe(true);
    });

    it('matches case-insensitive', () => {
      const adapter = makeAdapter();
      expect(adapter.matches(mockPeripheral('Shape200'))).toBe(true);
      expect(adapter.matches(mockPeripheral('STYLE100'))).toBe(true);
    });

    it('does not match "shape" without number suffix', () => {
      const adapter = makeAdapter();
      expect(adapter.matches(mockPeripheral('shape'))).toBe(false);
    });

    it('does not match unrelated name', () => {
      const adapter = makeAdapter();
      expect(adapter.matches(mockPeripheral('Random Scale'))).toBe(false);
    });
  });

  describe('parseNotification()', () => {
    it('parses type 0x09 frame with weight and impedance', () => {
      const adapter = makeAdapter();
      const buf = Buffer.alloc(15);
      buf[0] = 0x09; // frame type
      buf[1] = 1; // user index
      // [2-8] timestamp
      buf.writeUInt16BE(800, 9); // weight = 800 / 10 = 80.0 kg
      buf.writeUInt16BE(300, 11); // impedance 5kHz
      buf.writeUInt16BE(450, 13); // impedance 50kHz

      const reading = adapter.parseNotification(buf);
      expect(reading).not.toBeNull();
      expect(reading!.weight).toBe(80);
      expect(reading!.impedance).toBe(450); // 50kHz preferred
    });

    it('returns null for wrong frame type', () => {
      const adapter = makeAdapter();
      const buf = Buffer.alloc(15);
      buf[0] = 0x05; // wrong type
      buf.writeUInt16BE(800, 9);
      buf.writeUInt16BE(450, 13);
      expect(adapter.parseNotification(buf)).toBeNull();
    });

    it('returns null for too-short buffer', () => {
      const adapter = makeAdapter();
      expect(adapter.parseNotification(Buffer.alloc(14))).toBeNull();
    });

    it('returns null when weight is zero', () => {
      const adapter = makeAdapter();
      const buf = Buffer.alloc(15);
      buf[0] = 0x09;
      buf.writeUInt16BE(0, 9); // weight = 0
      buf.writeUInt16BE(450, 13);
      expect(adapter.parseNotification(buf)).toBeNull();
    });
  });

  describe('isComplete()', () => {
    it('returns true when weight > 0 and impedance > 0', () => {
      const adapter = makeAdapter();
      expect(adapter.isComplete({ weight: 80, impedance: 450 })).toBe(true);
    });

    it('returns false when weight is 0', () => {
      const adapter = makeAdapter();
      expect(adapter.isComplete({ weight: 0, impedance: 450 })).toBe(false);
    });

    it('returns false when impedance is 0', () => {
      const adapter = makeAdapter();
      expect(adapter.isComplete({ weight: 80, impedance: 0 })).toBe(false);
    });
  });

  describe('computeMetrics()', () => {
    it('returns valid GarminPayload', () => {
      const adapter = makeAdapter();
      const profile = defaultProfile();
      const payload = adapter.computeMetrics({ weight: 80, impedance: 450 }, profile);
      expect(payload.weight).toBe(80);
      expect(payload.impedance).toBe(450);
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
