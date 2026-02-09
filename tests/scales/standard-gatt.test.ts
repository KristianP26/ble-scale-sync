import { describe, it, expect } from 'vitest';
import type { Peripheral } from '@abandonware/noble';
import { StandardGattScaleAdapter } from '../../src/scales/standard-gatt.js';
import {
  mockPeripheral,
  defaultProfile,
  assertPayloadRanges,
} from '../helpers/scale-test-utils.js';

function makeAdapter() {
  return new StandardGattScaleAdapter();
}

describe('StandardGattScaleAdapter', () => {
  describe('matches()', () => {
    it('matches device with Body Composition Service UUID (181b)', () => {
      const adapter = makeAdapter();
      const p = mockPeripheral('Some Scale', ['181b']);
      expect(adapter.matches(p as Peripheral)).toBe(true);
    });

    it('matches device with Weight Scale Service UUID (181d)', () => {
      const adapter = makeAdapter();
      const p = mockPeripheral('Some Scale', ['181d']);
      expect(adapter.matches(p as Peripheral)).toBe(true);
    });

    it('matches known name "beurer"', () => {
      const adapter = makeAdapter();
      const p = mockPeripheral('Beurer BF950', []);
      expect(adapter.matches(p as Peripheral)).toBe(true);
    });

    it('matches full 128-bit BCS UUID', () => {
      const adapter = makeAdapter();
      const p = mockPeripheral('Unknown Scale', ['0000181b00001000800000805f9b34fb']);
      expect(adapter.matches(p as Peripheral)).toBe(true);
    });

    it('does not match excluded name "qn-scale"', () => {
      const adapter = makeAdapter();
      const p = mockPeripheral('QN-Scale', ['181b']);
      expect(adapter.matches(p as Peripheral)).toBe(false);
    });

    it('does not match excluded name "yunmai"', () => {
      const adapter = makeAdapter();
      const p = mockPeripheral('Yunmai ISM', ['181b']);
      expect(adapter.matches(p as Peripheral)).toBe(false);
    });

    it('does not match unknown device without service UUIDs', () => {
      const adapter = makeAdapter();
      const p = mockPeripheral('Unknown', []);
      expect(adapter.matches(p as Peripheral)).toBe(false);
    });
  });

  describe('parseNotification()', () => {
    it('parses minimal BCS frame (flags + body fat only)', () => {
      const adapter = makeAdapter();
      // Flags: 0x0000 (kg, no optional fields), body fat = 200 → 200*0.1=20%
      const buf = Buffer.alloc(4);
      buf.writeUInt16LE(0x0000, 0); // flags: kg, no optional fields
      buf.writeUInt16LE(200, 2); // body fat = 20.0%

      const reading = adapter.parseNotification(buf);
      expect(reading).not.toBeNull();
      // No weight or impedance in minimal frame
      expect(reading!.weight).toBe(0);
      expect(reading!.impedance).toBe(0);
    });

    it('parses frame with weight + impedance', () => {
      const adapter = makeAdapter();
      // Flags: weight(bit10) + impedance(bit9) = 0x0600
      const flags = 0x0400 | 0x0200; // weight + impedance
      const buf = Buffer.alloc(8);
      buf.writeUInt16LE(flags, 0);
      buf.writeUInt16LE(200, 2); // body fat = 20%
      buf.writeUInt16LE(5000, 4); // impedance = 5000*0.1 = 500 Ohm
      buf.writeUInt16LE(16000, 6); // weight = 16000*0.005 = 80 kg

      const reading = adapter.parseNotification(buf);
      expect(reading).not.toBeNull();
      expect(reading!.weight).toBe(80);
      expect(reading!.impedance).toBeCloseTo(500, 1);
    });

    it('converts lbs to kg', () => {
      const adapter = makeAdapter();
      // Flags: bit0=1 (lbs) + weight(bit10)
      const flags = 0x0001 | 0x0400;
      const buf = Buffer.alloc(6);
      buf.writeUInt16LE(flags, 0);
      buf.writeUInt16LE(200, 2); // body fat
      buf.writeUInt16LE(17637, 4); // weight: 17637 * 0.01 * 0.453592 = ~80 kg

      const reading = adapter.parseNotification(buf);
      expect(reading).not.toBeNull();
      expect(reading!.weight).toBeCloseTo(80, 0);
    });

    it('returns null for too-short buffer', () => {
      const adapter = makeAdapter();
      expect(adapter.parseNotification(Buffer.alloc(2))).toBeNull();
    });

    it('skips optional fields correctly (timestamp + user)', () => {
      const adapter = makeAdapter();
      // Flags: timestamp(bit1) + user(bit2) + weight(bit10) = 0x0406
      const flags = 0x0002 | 0x0004 | 0x0400;
      const buf = Buffer.alloc(14);
      buf.writeUInt16LE(flags, 0);
      buf.writeUInt16LE(250, 2); // body fat = 25%
      // 7 bytes timestamp
      buf.fill(0, 4, 11);
      // 1 byte user index
      buf[11] = 0x01;
      // weight
      buf.writeUInt16LE(16000, 12); // 80 kg

      const reading = adapter.parseNotification(buf);
      expect(reading).not.toBeNull();
      expect(reading!.weight).toBe(80);
    });
  });

  describe('isComplete()', () => {
    it('returns true when weight > 0', () => {
      const adapter = makeAdapter();
      expect(adapter.isComplete({ weight: 80, impedance: 0 })).toBe(true);
    });

    it('returns false when weight is 0', () => {
      const adapter = makeAdapter();
      expect(adapter.isComplete({ weight: 0, impedance: 500 })).toBe(false);
    });
  });

  describe('computeMetrics()', () => {
    it('uses BodyCompCalculator when impedance > 0', () => {
      const adapter = makeAdapter();
      // Trigger a parse to cache GATT data
      const flags = 0x0400 | 0x0200;
      const buf = Buffer.alloc(8);
      buf.writeUInt16LE(flags, 0);
      buf.writeUInt16LE(200, 2);
      buf.writeUInt16LE(5000, 4);
      buf.writeUInt16LE(16000, 6);
      adapter.parseNotification(buf);

      const profile = defaultProfile();
      const payload = adapter.computeMetrics({ weight: 80, impedance: 500 }, profile);

      expect(payload.weight).toBe(80);
      expect(payload.impedance).toBe(500);
      assertPayloadRanges(payload);
    });

    it('falls back to buildPayload when impedance is 0', () => {
      const adapter = makeAdapter();
      // Parse a frame to cache body fat
      const buf = Buffer.alloc(4);
      buf.writeUInt16LE(0x0000, 0);
      buf.writeUInt16LE(220, 2); // 22%
      adapter.parseNotification(buf);

      const profile = defaultProfile();
      const payload = adapter.computeMetrics({ weight: 80, impedance: 0 }, profile);

      expect(payload.weight).toBe(80);
      expect(payload.bodyFatPercent).toBe(22);
      assertPayloadRanges(payload);
    });
  });
});
