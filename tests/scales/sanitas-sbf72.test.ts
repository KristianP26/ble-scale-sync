import { describe, it, expect } from 'vitest';
import { SanitasSbf72Adapter } from '../../src/scales/sanitas-sbf72.js';
import {
  mockPeripheral,
  defaultProfile,
  assertPayloadRanges,
} from '../helpers/scale-test-utils.js';

function makeAdapter() {
  return new SanitasSbf72Adapter();
}

/**
 * Build a BCS Body Composition Measurement (0x2A9C) frame.
 * @param opts Configuration for which fields to include.
 */
function makeBcsFrame(opts: {
  isLbs?: boolean;
  bodyFatPct: number;
  timestamp?: boolean;
  user?: boolean;
  bmr?: boolean;
  musclePct?: number;
  muscleMass?: boolean;
  fatFreeMass?: boolean;
  softLean?: boolean;
  waterMassKg?: number;
  impedance?: number;
  weightKg?: number;
  height?: boolean;
}): Buffer {
  let flags = 0;
  if (opts.isLbs) flags |= 0x0001;
  if (opts.timestamp) flags |= 0x0002;
  if (opts.user) flags |= 0x0004;
  if (opts.bmr) flags |= 0x0008;
  if (opts.musclePct != null) flags |= 0x0010;
  if (opts.muscleMass) flags |= 0x0020;
  if (opts.fatFreeMass) flags |= 0x0040;
  if (opts.softLean) flags |= 0x0080;
  if (opts.waterMassKg != null) flags |= 0x0100;
  if (opts.impedance != null) flags |= 0x0200;
  if (opts.weightKg != null) flags |= 0x0400;
  if (opts.height) flags |= 0x0800;

  const parts: number[] = [];
  // flags LE
  parts.push(flags & 0xff, (flags >> 8) & 0xff);

  // body fat % (mandatory) — value / 0.1
  const fatRaw = Math.round(opts.bodyFatPct / 0.1);
  parts.push(fatRaw & 0xff, (fatRaw >> 8) & 0xff);

  if (opts.timestamp) {
    // 7 bytes timestamp (zeros)
    for (let i = 0; i < 7; i++) parts.push(0);
  }
  if (opts.user) parts.push(0x01);
  if (opts.bmr) parts.push(0x00, 0x00);

  if (opts.musclePct != null) {
    const raw = Math.round(opts.musclePct / 0.1);
    parts.push(raw & 0xff, (raw >> 8) & 0xff);
  }
  if (opts.muscleMass) parts.push(0x00, 0x00);
  if (opts.fatFreeMass) parts.push(0x00, 0x00);
  if (opts.softLean) parts.push(0x00, 0x00);

  if (opts.waterMassKg != null) {
    const massMultiplier = opts.isLbs ? 0.01 : 0.005;
    const raw = Math.round(opts.waterMassKg / massMultiplier);
    parts.push(raw & 0xff, (raw >> 8) & 0xff);
  }
  if (opts.impedance != null) {
    const raw = Math.round(opts.impedance / 0.1);
    parts.push(raw & 0xff, (raw >> 8) & 0xff);
  }
  if (opts.weightKg != null) {
    const massMultiplier = opts.isLbs ? 0.01 : 0.005;
    const raw = Math.round(opts.weightKg / massMultiplier);
    parts.push(raw & 0xff, (raw >> 8) & 0xff);
  }
  if (opts.height) parts.push(0x00, 0x00);

  return Buffer.from(parts);
}

describe('SanitasSbf72Adapter', () => {
  describe('matches()', () => {
    it.each(['sbf72', 'sbf73', 'bf915'])('matches "%s" substring', (name) => {
      const adapter = makeAdapter();
      expect(adapter.matches(mockPeripheral(name))).toBe(true);
    });

    it('matches name containing known substring', () => {
      const adapter = makeAdapter();
      expect(adapter.matches(mockPeripheral('Sanitas SBF72 Pro'))).toBe(true);
    });

    it('matches case-insensitive', () => {
      const adapter = makeAdapter();
      expect(adapter.matches(mockPeripheral('SBF72'))).toBe(true);
      expect(adapter.matches(mockPeripheral('BF915'))).toBe(true);
    });

    it('does not match unrelated name', () => {
      const adapter = makeAdapter();
      expect(adapter.matches(mockPeripheral('Random Scale'))).toBe(false);
    });
  });

  describe('parseNotification()', () => {
    it('parses BCS frame with weight and fat', () => {
      const adapter = makeAdapter();
      const buf = makeBcsFrame({
        bodyFatPct: 22.5,
        weightKg: 80,
      });

      const reading = adapter.parseNotification(buf);
      expect(reading).not.toBeNull();
      expect(reading!.weight).toBeCloseTo(80, 0);
    });

    it('parses BCS frame with all optional fields', () => {
      const adapter = makeAdapter();
      const buf = makeBcsFrame({
        bodyFatPct: 22.5,
        timestamp: true,
        user: true,
        bmr: true,
        musclePct: 40,
        muscleMass: true,
        fatFreeMass: true,
        softLean: true,
        waterMassKg: 44,
        impedance: 500,
        weightKg: 80,
        height: true,
      });

      const reading = adapter.parseNotification(buf);
      expect(reading).not.toBeNull();
      expect(reading!.weight).toBeCloseTo(80, 0);
      expect(reading!.impedance).toBeCloseTo(500, 0);
    });

    it('returns null for too-short buffer', () => {
      const adapter = makeAdapter();
      expect(adapter.parseNotification(Buffer.alloc(3))).toBeNull();
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
    it('returns valid GarminPayload with cached fat and water', () => {
      const adapter = makeAdapter();
      const buf = makeBcsFrame({
        bodyFatPct: 22.5,
        musclePct: 40,
        waterMassKg: 44,
        weightKg: 80,
      });
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
