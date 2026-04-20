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

  describe('unlockCommand', () => {
    it('returns 0xF7 for BF700/BF800 type', () => {
      const adapter = makeAdapter();
      adapter.matches(mockPeripheral('bf-700'));
      expect(adapter.unlockCommand[0]).toBe(0xf7);
    });

    it('returns 0xE7 for BF710/Sanitas type', () => {
      const adapter = makeAdapter();
      adapter.matches(mockPeripheral('beurer bf710'));
      expect(adapter.unlockCommand[0]).toBe(0xe7);
    });

    it('returns 0xE7 for SBF70', () => {
      const adapter = makeAdapter();
      adapter.matches(mockPeripheral('sanitas sbf70'));
      expect(adapter.unlockCommand[0]).toBe(0xe7);
    });

    it('returns 0xE7 for aicdscale1', () => {
      const adapter = makeAdapter();
      adapter.matches(mockPeripheral('aicdscale1'));
      expect(adapter.unlockCommand[0]).toBe(0xe7);
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

    it('returns null when weight exceeds 300 kg', () => {
      const adapter = makeAdapter();
      const buf = Buffer.alloc(6);
      buf.writeUInt16BE(6100, 4); // 6100 * 50 / 1000 = 305 kg
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

  describe('SBF70 / BF710 variant (issue #112)', () => {
    function sbf70Adapter() {
      const adapter = makeAdapter();
      adapter.matches(mockPeripheral('SANITAS SBF70'));
      return adapter;
    }

    it('parses 5-byte 0x58 frame with weight at bytes [3-4] BE', () => {
      const adapter = sbf70Adapter();
      // Real captured frame from issue #112: [E7 58 01 08 5E]
      const frame = Buffer.from([0xe7, 0x58, 0x01, 0x08, 0x5e]);
      const reading = adapter.parseNotification(frame);
      expect(reading).not.toBeNull();
      // 0x085E = 2142 * 50/1000 = 107.1 kg
      expect(reading!.weight).toBeCloseTo(107.1, 2);
      expect(reading!.impedance).toBe(0);
    });

    it('ignores frames that do not start with 0xE7', () => {
      const adapter = sbf70Adapter();
      const frame = Buffer.from([0xf7, 0x58, 0x01, 0x08, 0x5e]);
      expect(adapter.parseNotification(frame)).toBeNull();
    });

    it('ignores 0x59 finalize frame for unregistered user (all composition zero)', () => {
      const adapter = sbf70Adapter();
      // Real captured frame from issue #112
      const frame = Buffer.from([
        0xe7, 0x59, 0x03, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x65,
      ]);
      expect(adapter.parseNotification(frame)).toBeNull();
    });

    it('requires 3 consecutive readings within 0.3 kg for completion', () => {
      const adapter = sbf70Adapter();
      // First bogus frame from issue #112 capture
      const f0 = Buffer.from([0xe7, 0x58, 0x01, 0x01, 0x2b]); // 14.95 kg
      const f1 = Buffer.from([0xe7, 0x58, 0x01, 0x08, 0x5e]); // 107.1 kg
      const f2 = Buffer.from([0xe7, 0x58, 0x01, 0x08, 0x5f]); // 107.15 kg
      const f3 = Buffer.from([0xe7, 0x58, 0x01, 0x08, 0x5e]); // 107.1 kg

      const r0 = adapter.parseNotification(f0);
      expect(r0).not.toBeNull();
      expect(adapter.isComplete(r0!)).toBe(false); // only 1 reading buffered

      const r1 = adapter.parseNotification(f1);
      expect(adapter.isComplete(r1!)).toBe(false); // still drifting (14.95 vs 107.1)

      const r2 = adapter.parseNotification(f2);
      expect(adapter.isComplete(r2!)).toBe(false); // drift not yet cleared from buffer

      const r3 = adapter.parseNotification(f3);
      // Buffer now holds [107.1, 107.15, 107.1]: range 0.05 kg <= 0.3 kg
      expect(adapter.isComplete(r3!)).toBe(true);
      expect(r3!.weight).toBeCloseTo(107.1, 2);
    });

    it('rejects out-of-range weight in SBF70 frame', () => {
      const adapter = sbf70Adapter();
      // 0xFFFF * 50 / 1000 = 3276.75 kg -> too high
      const frame = Buffer.from([0xe7, 0x58, 0x01, 0xff, 0xff]);
      expect(adapter.parseNotification(frame)).toBeNull();
    });

    it('rejects zero weight in SBF70 frame', () => {
      const adapter = sbf70Adapter();
      const frame = Buffer.from([0xe7, 0x58, 0x00, 0x00, 0x00]);
      expect(adapter.parseNotification(frame)).toBeNull();
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
