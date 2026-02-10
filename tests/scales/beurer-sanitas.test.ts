import { describe, it, expect } from 'vitest';
import { BeurerSanitasScaleAdapter } from '../../src/scales/beurer-sanitas.js';
import {
  mockPeripheral,
  defaultProfile,
  assertPayloadRanges,
} from '../helpers/scale-test-utils.js';

function makeAdapter() {
  return new BeurerSanitasScaleAdapter();
}

describe('BeurerSanitasScaleAdapter', () => {
  describe('matches()', () => {
    it.each([
      'bf-700',
      'beurer bf700',
      'bf-800',
      'beurer bf800',
      'rt-libra-b',
      'rt-libra-w',
      'libra-b',
      'libra-w',
      'bf700',
      'beurer bf710',
      'sanitas sbf70',
      'sbf75',
      'aicdscale1',
    ])('matches "%s"', (name) => {
      const adapter = makeAdapter();
      expect(adapter.matches(mockPeripheral(name))).toBe(true);
    });

    it('matches case-insensitive', () => {
      const adapter = makeAdapter();
      expect(adapter.matches(mockPeripheral('BF-700'))).toBe(true);
      expect(adapter.matches(mockPeripheral('BEURER BF700'))).toBe(true);
    });

    it('does not match unrelated name', () => {
      const adapter = makeAdapter();
      expect(adapter.matches(mockPeripheral('Random Scale'))).toBe(false);
    });
  });

  describe('parseNotification()', () => {
    it('parses weight-only frame (6 bytes)', () => {
      const adapter = makeAdapter();
      const buf = Buffer.alloc(6);
      // [0-3] timestamp
      buf.writeUInt16BE(1600, 4); // 1600 * 50 / 1000 = 80 kg
      const reading = adapter.parseNotification(buf);
      expect(reading).not.toBeNull();
      expect(reading!.weight).toBe(80);
      expect(reading!.impedance).toBe(0);
    });

    it('parses full composition frame (16 bytes)', () => {
      const adapter = makeAdapter();
      const buf = Buffer.alloc(16);
      buf.writeUInt16BE(1600, 4); // weight = 80 kg
      buf.writeUInt16BE(500, 6); // impedance = 500
      buf.writeUInt16BE(225, 8); // fat = 22.5%
      buf.writeUInt16BE(550, 10); // water = 55.0%
      buf.writeUInt16BE(400, 12); // muscle = 40.0%
      buf.writeUInt16BE(60, 14); // bone = 60 * 50 / 1000 = 3.0 kg

      const reading = adapter.parseNotification(buf);
      expect(reading).not.toBeNull();
      expect(reading!.weight).toBe(80);
      expect(reading!.impedance).toBe(500);
    });

    it('returns null for too-short buffer', () => {
      const adapter = makeAdapter();
      expect(adapter.parseNotification(Buffer.alloc(5))).toBeNull();
    });

    it('returns null when weight is zero', () => {
      const adapter = makeAdapter();
      const buf = Buffer.alloc(6);
      buf.writeUInt16BE(0, 4); // weight = 0
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
    it('returns payload with cached body comp from full frame', () => {
      const adapter = makeAdapter();
      const buf = Buffer.alloc(16);
      buf.writeUInt16BE(1600, 4); // 80 kg
      buf.writeUInt16BE(500, 6); // impedance
      buf.writeUInt16BE(225, 8); // fat 22.5%
      buf.writeUInt16BE(550, 10); // water 55%
      buf.writeUInt16BE(400, 12); // muscle 40%
      buf.writeUInt16BE(60, 14); // bone 3.0 kg

      adapter.parseNotification(buf);
      const profile = defaultProfile();
      const payload = adapter.computeMetrics({ weight: 80, impedance: 500 }, profile);
      expect(payload.weight).toBe(80);
      assertPayloadRanges(payload);
    });

    it('returns payload without cached comp (weight-only frame)', () => {
      const adapter = makeAdapter();
      const buf = Buffer.alloc(6);
      buf.writeUInt16BE(1600, 4); // 80 kg
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
