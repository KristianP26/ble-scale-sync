import { describe, it, expect } from 'vitest';
import { TrisaAdapter } from '../../src/scales/trisa.js';
import {
  mockPeripheral,
  defaultProfile,
  assertPayloadRanges,
} from '../helpers/scale-test-utils.js';

function makeAdapter() {
  return new TrisaAdapter();
}

/**
 * Encode weight as base-10 float: 24-bit LE mantissa + int8 exponent.
 * weight = mantissa * 10^exponent
 */
function encodeFloat(mantissa: number, exponent: number): Buffer {
  const buf = Buffer.alloc(4);
  buf[0] = mantissa & 0xff;
  buf[1] = (mantissa >> 8) & 0xff;
  buf[2] = (mantissa >> 16) & 0xff;
  buf.writeInt8(exponent, 3);
  return buf;
}

describe('TrisaAdapter', () => {
  describe('matches()', () => {
    it('matches "01257B..." prefix', () => {
      const adapter = makeAdapter();
      expect(adapter.matches(mockPeripheral('01257B001122'))).toBe(true);
    });

    it('matches "11257B..." prefix', () => {
      const adapter = makeAdapter();
      expect(adapter.matches(mockPeripheral('11257BAABBCC'))).toBe(true);
    });

    it('matches case-insensitive', () => {
      const adapter = makeAdapter();
      expect(adapter.matches(mockPeripheral('01257b001122'))).toBe(true);
      expect(adapter.matches(mockPeripheral('11257b001122'))).toBe(true);
    });

    it('does not match "01257A..."', () => {
      const adapter = makeAdapter();
      expect(adapter.matches(mockPeripheral('01257A001122'))).toBe(false);
    });

    it('does not match unrelated name', () => {
      const adapter = makeAdapter();
      expect(adapter.matches(mockPeripheral('Random Scale'))).toBe(false);
    });
  });

  describe('parseNotification()', () => {
    it('parses weight-only frame (no optional fields)', () => {
      const adapter = makeAdapter();
      const flags = 0x00; // no timestamp, no r1, no r2
      const weightFloat = encodeFloat(8000, -2); // 8000 * 10^-2 = 80.0 kg
      const buf = Buffer.concat([Buffer.from([flags]), weightFloat]);

      const reading = adapter.parseNotification(buf);
      expect(reading).not.toBeNull();
      expect(reading!.weight).toBeCloseTo(80, 1);
      expect(reading!.impedance).toBe(0);
    });

    it('parses frame with timestamp + r1 + r2 (r2 >= 410)', () => {
      const adapter = makeAdapter();
      const flags = 0x07; // all: timestamp, r1, r2
      const weightFloat = encodeFloat(8000, -2); // 80.0 kg
      const timestamp = Buffer.alloc(7);
      const r1Float = encodeFloat(5000, -1); // r1 = 500.0
      const r2Float = encodeFloat(5000, -1); // r2 = 500.0 → >= 410 → 0.3*(500-400) = 30.0

      const buf = Buffer.concat([Buffer.from([flags]), weightFloat, timestamp, r1Float, r2Float]);

      const reading = adapter.parseNotification(buf);
      expect(reading).not.toBeNull();
      expect(reading!.weight).toBeCloseTo(80, 1);
      expect(reading!.impedance).toBeCloseTo(30, 1);
    });

    it('parses frame with r2 < 410 → impedance = 3.0', () => {
      const adapter = makeAdapter();
      const flags = 0x04; // only r2 (no timestamp, no r1)
      const weightFloat = encodeFloat(8000, -2); // 80.0 kg
      const r2Float = encodeFloat(4000, -1); // r2 = 400.0 → < 410 → impedance = 3.0

      const buf = Buffer.concat([Buffer.from([flags]), weightFloat, r2Float]);

      const reading = adapter.parseNotification(buf);
      expect(reading).not.toBeNull();
      expect(reading!.impedance).toBe(3.0);
    });

    it('returns null for too-short buffer', () => {
      const adapter = makeAdapter();
      expect(adapter.parseNotification(Buffer.alloc(4))).toBeNull();
    });

    it('returns null for timestamp-only frame with zero mantissa', () => {
      const adapter = makeAdapter();
      const flags = 0x01; // only timestamp
      const weightFloat = encodeFloat(0, 0); // mantissa = 0
      const timestamp = Buffer.alloc(7);

      const buf = Buffer.concat([Buffer.from([flags]), weightFloat, timestamp]);
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
    it('returns valid GarminPayload', () => {
      const adapter = makeAdapter();
      const profile = defaultProfile();
      const payload = adapter.computeMetrics({ weight: 80, impedance: 30 }, profile);
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
