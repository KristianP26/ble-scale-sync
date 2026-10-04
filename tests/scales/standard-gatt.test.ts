import { describe, it, expect, vi } from 'vitest';
// Side-effect import: building the registry registers it with the exclusion
// derivation, so StandardGattScaleAdapter.matches() excludes names that more
// specific adapters claim even when this file is run in isolation (#245).
import '../../src/scales/index.js';
import { StandardGattScaleAdapter } from '../../src/scales/standard-gatt.js';
import { uuid16 } from '../../src/scales/body-comp-helpers.js';
import { isHistoricalReading } from '../../src/interfaces/reading-time.js';
import type { MultiCharNotify } from '../../src/interfaces/scale-adapter.js';
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
      expect(adapter.matches(p)).toBe(true);
    });

    it('matches device with Weight Scale Service UUID (181d)', () => {
      const adapter = makeAdapter();
      const p = mockPeripheral('Some Scale', ['181d']);
      expect(adapter.matches(p)).toBe(true);
    });

    // Uses a model the Beurer consent adapter does not claim. Specific Beurer
    // models (BF720/BF105/BF500/BF788/BF950) are SIG consent+bond scales routed
    // to BeurerBf720Adapter, and derived-excludes strips their name tokens from
    // this fallback on purpose (#229/#255).
    it('matches known name "beurer"', () => {
      const adapter = makeAdapter();
      const p = mockPeripheral('Beurer BF600', []);
      expect(adapter.matches(p)).toBe(true);
    });

    it('matches full 128-bit BCS UUID', () => {
      const adapter = makeAdapter();
      const p = mockPeripheral('Unknown Scale', ['0000181b00001000800000805f9b34fb']);
      expect(adapter.matches(p)).toBe(true);
    });

    it('does not match excluded name "qn-scale"', () => {
      const adapter = makeAdapter();
      const p = mockPeripheral('QN-Scale', ['181b']);
      expect(adapter.matches(p)).toBe(false);
    });

    it('does not match excluded name "yunmai"', () => {
      const adapter = makeAdapter();
      const p = mockPeripheral('Yunmai ISM', ['181b']);
      expect(adapter.matches(p)).toBe(false);
    });

    it('does not match unknown device without service UUIDs', () => {
      const adapter = makeAdapter();
      const p = mockPeripheral('Unknown', []);
      expect(adapter.matches(p)).toBe(false);
    });

    // The descriptor is informational (custom, priority 0), but it is what a
    // reader takes as the adapter's name claims, and it once missed the names
    // matches() gained in #409.
    it('declares in match.names every name that matches() claims by name alone (#409)', () => {
      const adapter = makeAdapter();
      for (const name of ['bf1000', 'sbf76', 'sbf77']) {
        expect(adapter.matches(mockPeripheral(name.toUpperCase(), []))).toBe(true);
        expect(adapter.match.names?.includes).toContain(name);
      }
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

// #394: adapters are shared singletons and computeMetrics() runs LATER than the
// parse that produced the reading. On the mqtt-proxy and esphome-proxy watchers
// the loop awaits processReading() - network exports included - while the
// watcher is free to open the NEXT session, so onSessionStart() for session N+1
// can land BEFORE computeMetrics() for session N. Reading the live cache there
// hands the completed reading somebody else's composition.
//
// Each test below interleaves the two in exactly that order. Asserting only on
// the payload of an uninterrupted session would pass with or without the fix.

describe('StandardGattScaleAdapter session boundary (#394)', () => {
  function bcsFrame(fatTenths: number): Buffer {
    // Flags: weight(bit10). Body fat is mandatory and sits right after flags.
    const buf = Buffer.alloc(6);
    buf.writeUInt16LE(0x0400, 0);
    buf.writeUInt16LE(fatTenths, 2);
    buf.writeUInt16LE(16000, 4); // 80 kg
    return buf;
  }

  it('keeps the completed reading composition when the NEXT session starts first', () => {
    const a = makeAdapter();
    const reading = a.parseNotification(bcsFrame(220))!;
    expect(reading.weight).toBe(80);
    a.onSessionStart();
    const payload = a.computeMetrics(reading, defaultProfile());
    expect(payload.bodyFatPercent).toBe(22);
  });

  it('does not hand a hand-built reading the previous session composition', () => {
    const a = makeAdapter();
    a.parseNotification(bcsFrame(220));
    a.onSessionStart();
    const payload = a.computeMetrics({ weight: 80, impedance: 0 }, defaultProfile());
    expect(payload.bodyFatPercent).not.toBe(22);
  });
});

// Review C-02, C-05, C-09. Frames from the #168 openScale HCI snoop of a SIG
// scale (the same bytes beurer-bf720.test.ts and sig-wss.test.ts decode):
// 0x2A9D 79.96 kg, stamped 2026-05-12 18:53:54, user 1; 0x2A9C flags 0x0398,
// fat 19.4 %, impedance 452 ohm and NO weight field.
describe('StandardGattScaleAdapter: 0x2A9D and the SIG time stamp', () => {
  const WSS = Buffer.from('0e783eea07050c12353601ee002607', 'hex');
  const BCS = Buffer.from('9803c200df1a9701cc2fca21a811', 'hex');
  const CHR_WSS = uuid16(0x2a9d);
  const CHR_BCS = uuid16(0x2a9c);

  /** The multi-char parser; asserted rather than called blind. */
  function charParser(a: StandardGattScaleAdapter) {
    const fn = (a as Partial<MultiCharNotify>).parseCharNotification;
    expect(fn).toBeTypeOf('function');
    return fn!.bind(a);
  }

  function atCaptureTime(fn: () => void): void {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 4, 12, 18, 54, 0));
    try {
      fn();
    } finally {
      vi.useRealTimers();
    }
  }

  it('subscribes Weight Measurement 0x2A9D as well as 0x2A9C', () => {
    const notify = (makeAdapter().characteristics ?? [])
      .filter((b) => b.type === 'notify')
      .map((b) => b.uuid);
    expect(notify).toContain(CHR_WSS);
    expect(notify).toContain(CHR_BCS);
  });

  it('reads the weight of a Weight Scale only device from 0x2A9D', () => {
    atCaptureTime(() => {
      const a = makeAdapter();
      const reading = charParser(a)(CHR_WSS, WSS);
      expect(reading!.weight).toBeCloseTo(79.96, 2);
      expect(a.isComplete(reading!)).toBe(true);
      // Not final: a 0x2A9C may still follow, so the session holds for it.
      expect(a.isFinal(reading!)).toBe(false);
    });
  });

  it('completes a weigh-in whose weight is in 0x2A9D and fat in 0x2A9C', () => {
    atCaptureTime(() => {
      const a = makeAdapter();
      const parse = charParser(a);
      parse(CHR_WSS, WSS);
      const reading = parse(CHR_BCS, BCS);
      expect(reading!.weight).toBeCloseTo(79.96, 2);
      expect(reading!.impedance).toBeCloseTo(452, 1);
      expect(a.isFinal(reading!)).toBe(true);
      expect(a.computeMetrics(reading!, defaultProfile()).bodyFatPercent).toBeCloseTo(19.4, 1);
    });
  });

  it('carries the SIG time stamp and user slot, so a stored record is history', () => {
    // Real clock: the capture's May stamp is months old, i.e. a stored record.
    const a = makeAdapter();
    const parse = charParser(a);
    const reading = parse(CHR_WSS, WSS);
    expect(reading!.timestamp).toEqual(new Date(2026, 4, 12, 18, 53, 54));
    expect(reading!.userIndex).toBe(1);
    expect(isHistoricalReading(reading!)).toBe(true);

    // The record is already in the session's history buffer when its 0x2A9C
    // arrives, so the composition joins it there instead of a second export.
    expect(parse(CHR_BCS, BCS)).toBeNull();
    expect(reading!.impedance).toBeCloseTo(452, 1);
    expect(a.computeMetrics(reading!, defaultProfile()).bodyFatPercent).toBeCloseTo(19.4, 1);
  });

  // C-09: the scale measured 19.4 % at 452 ohm. Our BIA estimate from the same
  // impedance is a different number and used to replace it.
  it('exports the body fat the scale measured, not a BIA estimate over it', () => {
    const a = makeAdapter();
    a.parseNotification(BCS);
    const payload = a.computeMetrics({ weight: 79.96, impedance: 452 }, defaultProfile());
    expect(payload.bodyFatPercent).toBeCloseTo(19.4, 1);
  });
});
