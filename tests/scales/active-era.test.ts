import { describe, it, expect } from 'vitest';
import { ActiveEraAdapter } from '../../src/scales/active-era.js';
import {
  mockPeripheral,
  defaultProfile,
  assertPayloadRanges,
} from '../helpers/scale-test-utils.js';

function makeAdapter() {
  return new ActiveEraAdapter();
}

describe('ActiveEraAdapter', () => {
  describe('matches()', () => {
    it('matches "ae bs-06" name', () => {
      const adapter = makeAdapter();
      expect(adapter.matches(mockPeripheral('ae bs-06'))).toBe(true);
      expect(adapter.matches(mockPeripheral('AE BS-06 Pro'))).toBe(true);
    });

    it('does not match by service UUID alone (removed to avoid MGB collision)', () => {
      const adapter = makeAdapter();
      expect(adapter.matches(mockPeripheral('Unknown', ['ffb0']))).toBe(false);
    });

    it('matches case-insensitive', () => {
      const adapter = makeAdapter();
      expect(adapter.matches(mockPeripheral('AE BS-06'))).toBe(true);
    });

    it('does not match unrelated name without service UUID', () => {
      const adapter = makeAdapter();
      expect(adapter.matches(mockPeripheral('Random Scale'))).toBe(false);
    });
  });

  describe('parseNotification()', () => {
    it('parses 0xD5 weight frame', () => {
      const adapter = makeAdapter();
      const buf = Buffer.alloc(20);
      buf[0] = 0xac; // magic
      // weight: 24-bit BE at [3-5], mask 0x3FFFF / 1000
      // 80000 = 0x013880, & 0x3FFFF = 0x13880 = 80000 / 1000 = 80.0 kg
      const raw = 80000;
      buf[3] = (raw >> 16) & 0xff;
      buf[4] = (raw >> 8) & 0xff;
      buf[5] = raw & 0xff;
      buf[18] = 0xd5; // weight frame type

      const reading = adapter.parseNotification(buf);
      expect(reading).not.toBeNull();
      expect(reading!.weight).toBeCloseTo(80, 1);
      expect(reading!.impedance).toBe(0);
    });

    it('parses 0xD6 impedance frame after weight', () => {
      const adapter = makeAdapter();

      // First weight frame
      const wBuf = Buffer.alloc(20);
      wBuf[0] = 0xac;
      const raw = 80000;
      wBuf[3] = (raw >> 16) & 0xff;
      wBuf[4] = (raw >> 8) & 0xff;
      wBuf[5] = raw & 0xff;
      wBuf[18] = 0xd5;
      adapter.parseNotification(wBuf);

      // Then impedance frame
      const iBuf = Buffer.alloc(20);
      iBuf[0] = 0xac;
      iBuf.writeUInt16BE(500, 4); // impedance = 500
      iBuf[18] = 0xd6;

      const reading = adapter.parseNotification(iBuf);
      expect(reading).not.toBeNull();
      expect(reading!.weight).toBeCloseTo(80, 1);
      expect(reading!.impedance).toBe(500);
    });

    it('applies impedance correction when >= 1500', () => {
      const adapter = makeAdapter();

      // Weight frame
      const wBuf = Buffer.alloc(20);
      wBuf[0] = 0xac;
      const raw = 80000;
      wBuf[3] = (raw >> 16) & 0xff;
      wBuf[4] = (raw >> 8) & 0xff;
      wBuf[5] = raw & 0xff;
      wBuf[18] = 0xd5;
      adapter.parseNotification(wBuf);

      // Impedance frame with value >= 1500
      const iBuf = Buffer.alloc(20);
      iBuf[0] = 0xac;
      iBuf.writeUInt16BE(1600, 4); // >= 1500 → correction
      iBuf[18] = 0xd6;

      const reading = adapter.parseNotification(iBuf);
      expect(reading).not.toBeNull();
      // corrected: (1600 - 1000 + 80 * 10 * -0.4) / 0.6 / 10
      const expected = (1600 - 1000 + 80 * 10 * -0.4) / 0.6 / 10;
      expect(reading!.impedance).toBeCloseTo(expected, 1);
    });

    it('returns null for wrong magic', () => {
      const adapter = makeAdapter();
      const buf = Buffer.alloc(20);
      buf[0] = 0xab; // wrong magic
      buf[18] = 0xd5;
      expect(adapter.parseNotification(buf)).toBeNull();
    });

    it('returns null for too-short buffer', () => {
      const adapter = makeAdapter();
      expect(adapter.parseNotification(Buffer.alloc(19))).toBeNull();
    });

    it('returns null when no weight frame received yet', () => {
      const adapter = makeAdapter();
      const buf = Buffer.alloc(20);
      buf[0] = 0xac;
      buf.writeUInt16BE(500, 4);
      buf[18] = 0xd6; // impedance without prior weight
      expect(adapter.parseNotification(buf)).toBeNull();
    });
  });

  describe('isComplete()', () => {
    it('returns true when weight > 0 and impedance > 0', () => {
      const adapter = makeAdapter();
      expect(adapter.isComplete({ weight: 80, impedance: 500 })).toBe(true);
    });

    it('returns false when weight is 0', () => {
      const adapter = makeAdapter();
      expect(adapter.isComplete({ weight: 0, impedance: 500 })).toBe(false);
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
      const payload = adapter.computeMetrics({ weight: 80, impedance: 500 }, profile);
      expect(payload.weight).toBe(80);
      expect(payload.impedance).toBe(500);
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
