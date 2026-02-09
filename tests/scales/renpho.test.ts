import { describe, it, expect } from 'vitest';
import type { Peripheral } from '@abandonware/noble';
import { RenphoScaleAdapter } from '../../src/scales/renpho.js';
import {
  mockPeripheral,
  defaultProfile,
  assertPayloadRanges,
} from '../helpers/scale-test-utils.js';

function makeAdapter() {
  return new RenphoScaleAdapter();
}

describe('RenphoScaleAdapter', () => {
  describe('matches()', () => {
    it('matches "renpho" name without QN service UUIDs', () => {
      const adapter = makeAdapter();
      const p = mockPeripheral('Renpho Scale', []);
      expect(adapter.matches(p as Peripheral)).toBe(true);
    });

    it('matches "renpho-scale" without QN UUIDs', () => {
      const adapter = makeAdapter();
      const p = mockPeripheral('renpho-scale', []);
      expect(adapter.matches(p as Peripheral)).toBe(true);
    });

    it('rejects "renpho" with QN service UUID FFE0', () => {
      const adapter = makeAdapter();
      const p = mockPeripheral('Renpho Scale', ['ffe0']);
      expect(adapter.matches(p as Peripheral)).toBe(false);
    });

    it('rejects "renpho" with QN service UUID FFF0', () => {
      const adapter = makeAdapter();
      const p = mockPeripheral('Renpho Scale', ['fff0']);
      expect(adapter.matches(p as Peripheral)).toBe(false);
    });

    it('rejects "renpho" with full 128-bit QN UUID', () => {
      const adapter = makeAdapter();
      const p = mockPeripheral('Renpho Scale', ['0000ffe000001000800000805f9b34fb']);
      expect(adapter.matches(p as Peripheral)).toBe(false);
    });

    it('does not match unrelated name', () => {
      const adapter = makeAdapter();
      const p = mockPeripheral('Yunmai ISM', []);
      expect(adapter.matches(p as Peripheral)).toBe(false);
    });

    it('case-insensitive name match', () => {
      const adapter = makeAdapter();
      const p = mockPeripheral('RENPHO', []);
      expect(adapter.matches(p as Peripheral)).toBe(true);
    });
  });

  describe('parseNotification()', () => {
    it('parses valid frame with marker 0x2E', () => {
      const adapter = makeAdapter();
      const buf = Buffer.alloc(3);
      buf[0] = 0x2e; // valid marker
      buf.writeUInt16LE(1600, 1); // 1600 / 20 = 80 kg

      const reading = adapter.parseNotification(buf);
      expect(reading).not.toBeNull();
      expect(reading!.weight).toBe(80);
      expect(reading!.impedance).toBe(0); // no impedance
    });

    it('returns null for wrong marker byte', () => {
      const adapter = makeAdapter();
      const buf = Buffer.alloc(3);
      buf[0] = 0x10; // wrong marker
      buf.writeUInt16LE(1600, 1);

      expect(adapter.parseNotification(buf)).toBeNull();
    });

    it('returns null for too-short buffer', () => {
      const adapter = makeAdapter();
      expect(adapter.parseNotification(Buffer.alloc(2))).toBeNull();
    });

    it('returns null for zero weight', () => {
      const adapter = makeAdapter();
      const buf = Buffer.alloc(3);
      buf[0] = 0x2e;
      buf.writeUInt16LE(0, 1);

      expect(adapter.parseNotification(buf)).toBeNull();
    });

    it('handles various weight values', () => {
      const adapter = makeAdapter();
      // 60 kg = 1200 raw
      const buf = Buffer.alloc(3);
      buf[0] = 0x2e;
      buf.writeUInt16LE(1200, 1);

      const reading = adapter.parseNotification(buf);
      expect(reading).not.toBeNull();
      expect(reading!.weight).toBe(60);
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
    it('returns all GarminPayload fields using estimation (no impedance)', () => {
      const adapter = makeAdapter();
      const profile = defaultProfile();
      const payload = adapter.computeMetrics({ weight: 80, impedance: 0 }, profile);

      expect(payload.weight).toBe(80);
      expect(payload.impedance).toBe(0);
      assertPayloadRanges(payload);
    });

    it('computes different results for different profiles', () => {
      const adapter = makeAdapter();
      const male = defaultProfile();
      const female = defaultProfile({ gender: 'female', height: 165 });

      const m = adapter.computeMetrics({ weight: 70, impedance: 0 }, male);
      const f = adapter.computeMetrics({ weight: 70, impedance: 0 }, female);

      expect(m.bodyFatPercent).not.toBe(f.bodyFatPercent);
      assertPayloadRanges(m);
      assertPayloadRanges(f);
    });
  });
});
