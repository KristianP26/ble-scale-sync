import { describe, it, expect, vi } from 'vitest';
import { SanitasSbf72Adapter } from '../../src/scales/sanitas-sbf72.js';
import { uuid16 } from '../../src/scales/body-comp-helpers.js';
import { isHistoricalReading } from '../../src/interfaces/reading-time.js';
import type { MultiCharNotify } from '../../src/interfaces/scale-adapter.js';
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
    it.each(['sbf72', 'sbf73'])('matches "%s" substring', (name) => {
      const adapter = makeAdapter();
      expect(adapter.matches(mockPeripheral(name))).toBe(true);
    });

    // Review C-07: a BF915 needs the bond, the per-device consent code and the
    // user slot of the Beurer SIG adapter (#335, #417). This adapter has none of
    // them, so it must not claim the name.
    it('does not claim a Beurer BF915', () => {
      expect(makeAdapter().matches(mockPeripheral('BF915'))).toBe(false);
    });

    it('matches name containing known substring', () => {
      const adapter = makeAdapter();
      expect(adapter.matches(mockPeripheral('Sanitas SBF72 Pro'))).toBe(true);
    });

    it('matches case-insensitive', () => {
      const adapter = makeAdapter();
      expect(adapter.matches(mockPeripheral('SBF72'))).toBe(true);
      expect(adapter.matches(mockPeripheral('sbf73'))).toBe(true);
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
    it('returns valid BodyComposition with cached fat and water', () => {
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

// #394: adapters are shared singletons and computeMetrics() runs LATER than the
// parse that produced the reading. On the mqtt-proxy and esphome-proxy watchers
// the loop awaits processReading() - network exports included - while the
// watcher is free to open the NEXT session, so onSessionStart() for session N+1
// can land BEFORE computeMetrics() for session N. Reading the live cache there
// hands the completed reading somebody else's composition.
//
// Each test below interleaves the two in exactly that order. Asserting only on
// the payload of an uninterrupted session would pass with or without the fix.

describe('SanitasSbf72Adapter session boundary (#394)', () => {
  it('keeps the completed reading composition when the NEXT session starts first', () => {
    const a = makeAdapter();
    const reading = a.parseNotification(makeBcsFrame({ bodyFatPct: 22, weightKg: 80 }))!;
    a.onSessionStart();
    const payload = a.computeMetrics(reading, defaultProfile());
    expect(payload.bodyFatPercent).toBe(22);
  });

  it('does not hand a hand-built reading the previous session composition', () => {
    const a = makeAdapter();
    a.parseNotification(makeBcsFrame({ bodyFatPct: 22, weightKg: 80 }));
    a.onSessionStart();
    const payload = a.computeMetrics({ weight: 80, impedance: 0 }, defaultProfile());
    expect(payload.bodyFatPercent).not.toBe(22);
  });
});

// Review C-02, C-05: openScale's handler for this scale subscribes 0x2A9D too,
// and the weight is mandatory only there. Frames from the #168 HCI snoop of a
// SIG scale: 0x2A9D 79.96 kg stamped 2026-05-12 18:53:54 for user 1, 0x2A9C
// with fat 19.4 % and 452 ohm and no weight field. No SBF72 capture exists.
describe('SanitasSbf72Adapter: 0x2A9D and the SIG time stamp', () => {
  const WSS = Buffer.from('0e783eea07050c12353601ee002607', 'hex');
  const BCS = Buffer.from('9803c200df1a9701cc2fca21a811', 'hex');
  const CHR_WSS = uuid16(0x2a9d);
  const CHR_BCS = uuid16(0x2a9c);

  function charParser(a: SanitasSbf72Adapter) {
    const fn = (a as Partial<MultiCharNotify>).parseCharNotification;
    expect(fn).toBeTypeOf('function');
    return fn!.bind(a);
  }

  it('subscribes 0x2A9D as an optional binding next to the required 0x2A9C', () => {
    const notify = (makeAdapter().characteristics ?? []).filter((b) => b.type === 'notify');
    expect(notify.find((b) => b.uuid === CHR_WSS)?.optional).toBe(true);
    expect(notify.find((b) => b.uuid === CHR_BCS)?.optional).toBeFalsy();
  });

  it('completes a weigh-in whose weight is only in 0x2A9D', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 4, 12, 18, 54, 0));
    try {
      const a = makeAdapter();
      const parse = charParser(a);
      parse(CHR_WSS, WSS);
      const reading = parse(CHR_BCS, BCS);
      expect(reading!.weight).toBeCloseTo(79.96, 2);
      expect(a.isComplete(reading!)).toBe(true);
      expect(a.computeMetrics(reading!, defaultProfile()).bodyFatPercent).toBeCloseTo(19.4, 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the SIG time stamp, so a stored record is not exported as today', () => {
    const reading = charParser(makeAdapter())(CHR_WSS, WSS);
    expect(reading!.timestamp).toEqual(new Date(2026, 4, 12, 18, 53, 54));
    expect(isHistoricalReading(reading!)).toBe(true);
  });
});
