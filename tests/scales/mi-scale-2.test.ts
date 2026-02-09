import { describe, it, expect } from 'vitest';
import type { Peripheral } from '@abandonware/noble';
import { MiScale2Adapter } from '../../src/scales/mi-scale-2.js';
import {
  mockPeripheral,
  defaultProfile,
  assertPayloadRanges,
} from '../helpers/scale-test-utils.js';

function makeAdapter() {
  return new MiScale2Adapter();
}

function makeFrame(opts: {
  isLbs?: boolean;
  isCatty?: boolean;
  stable?: boolean;
  removed?: boolean;
  hasImpedance?: boolean;
  weightRaw?: number;
  impedanceRaw?: number;
}): Buffer {
  const buf = Buffer.alloc(13);
  let c0 = 0;
  let c1 = 0;

  if (opts.isLbs) c0 |= 0x01;
  if (opts.hasImpedance) c1 |= 0x02;
  if (opts.stable !== false) c1 |= 0x20; // stable by default
  if (opts.isCatty) c1 |= 0x40;
  if (opts.removed) c1 |= 0x80;

  buf[0] = c0;
  buf[1] = c1;
  // bytes 2-8: date/time (zeroed)
  buf.writeUInt16LE(opts.impedanceRaw ?? 0, 9);
  buf.writeUInt16LE(opts.weightRaw ?? 16000, 11); // 16000/200 = 80kg default

  return buf;
}

describe('MiScale2Adapter', () => {
  describe('matches()', () => {
    it('matches "MIBCS" prefix', () => {
      const adapter = makeAdapter();
      const p = mockPeripheral('MIBCS', []);
      expect(adapter.matches(p as Peripheral)).toBe(true);
    });

    it('matches "MIBFS" prefix', () => {
      const adapter = makeAdapter();
      const p = mockPeripheral('MIBFS', []);
      expect(adapter.matches(p as Peripheral)).toBe(true);
    });

    it('matches "Mi Scale" prefix', () => {
      const adapter = makeAdapter();
      const p = mockPeripheral('Mi Scale 2', []);
      expect(adapter.matches(p as Peripheral)).toBe(true);
    });

    it('matches "MI_SCALE" prefix (case-insensitive)', () => {
      const adapter = makeAdapter();
      const p = mockPeripheral('mi_scale', []);
      expect(adapter.matches(p as Peripheral)).toBe(true);
    });

    it('does not match unrelated name', () => {
      const adapter = makeAdapter();
      const p = mockPeripheral('Yunmai ISM', []);
      expect(adapter.matches(p as Peripheral)).toBe(false);
    });
  });

  describe('parseNotification()', () => {
    it('parses stable kg reading', () => {
      const adapter = makeAdapter();
      const buf = makeFrame({ weightRaw: 16000, hasImpedance: true, impedanceRaw: 500 });
      const reading = adapter.parseNotification(buf);

      expect(reading).not.toBeNull();
      expect(reading!.weight).toBe(80); // 16000 / 200
      expect(reading!.impedance).toBe(500);
    });

    it('converts lbs to kg', () => {
      const adapter = makeAdapter();
      // 176.37 lbs → ~80 kg
      const buf = makeFrame({
        isLbs: true,
        weightRaw: 17637,
        hasImpedance: true,
        impedanceRaw: 500,
      });
      const reading = adapter.parseNotification(buf);

      expect(reading).not.toBeNull();
      expect(reading!.weight).toBeCloseTo(80, 0);
    });

    it('converts catty to kg', () => {
      const adapter = makeAdapter();
      // 160 catty (raw 16000/100=160) → 160 * 0.5 = 80 kg
      const buf = makeFrame({
        isCatty: true,
        weightRaw: 16000,
        hasImpedance: true,
        impedanceRaw: 500,
      });
      const reading = adapter.parseNotification(buf);

      expect(reading).not.toBeNull();
      expect(reading!.weight).toBe(80); // 16000/100*0.5 = 80
    });

    it('returns null for non-stable reading', () => {
      const adapter = makeAdapter();
      const buf = makeFrame({ stable: false });
      expect(adapter.parseNotification(buf)).toBeNull();
    });

    it('returns null for removed reading', () => {
      const adapter = makeAdapter();
      const buf = makeFrame({ removed: true });
      expect(adapter.parseNotification(buf)).toBeNull();
    });

    it('returns null for wrong buffer length', () => {
      const adapter = makeAdapter();
      expect(adapter.parseNotification(Buffer.alloc(5))).toBeNull();
      expect(adapter.parseNotification(Buffer.alloc(14))).toBeNull();
    });

    it('returns impedance 0 when flag not set', () => {
      const adapter = makeAdapter();
      const buf = makeFrame({ hasImpedance: false, impedanceRaw: 500 });
      const reading = adapter.parseNotification(buf);

      expect(reading).not.toBeNull();
      expect(reading!.impedance).toBe(0);
    });
  });

  describe('isComplete()', () => {
    it('returns true when weight > 10 and impedance > 0', () => {
      const adapter = makeAdapter();
      expect(adapter.isComplete({ weight: 80, impedance: 500 })).toBe(true);
    });

    it('returns false when weight <= 10', () => {
      const adapter = makeAdapter();
      expect(adapter.isComplete({ weight: 5, impedance: 500 })).toBe(false);
    });

    it('returns false when impedance is 0', () => {
      const adapter = makeAdapter();
      expect(adapter.isComplete({ weight: 80, impedance: 0 })).toBe(false);
    });
  });

  describe('computeMetrics()', () => {
    it('returns all GarminPayload fields with values in range', () => {
      const adapter = makeAdapter();
      const profile = defaultProfile();
      const payload = adapter.computeMetrics({ weight: 80, impedance: 500 }, profile);

      expect(payload.weight).toBe(80);
      expect(payload.impedance).toBe(500);
      assertPayloadRanges(payload);
    });

    it('computes different results for female profile', () => {
      const adapter = makeAdapter();
      const male = defaultProfile();
      const female = defaultProfile({ gender: 'female', height: 165 });

      const malePayload = adapter.computeMetrics({ weight: 65, impedance: 450 }, male);
      const femalePayload = adapter.computeMetrics({ weight: 65, impedance: 450 }, female);

      // Body fat should differ between genders
      expect(malePayload.bodyFatPercent).not.toBe(femalePayload.bodyFatPercent);
      assertPayloadRanges(malePayload);
      assertPayloadRanges(femalePayload);
    });
  });
});
