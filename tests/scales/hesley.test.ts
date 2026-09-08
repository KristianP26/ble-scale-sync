import { describe, it, expect, beforeEach } from 'vitest';
import { HesleyScaleAdapter } from '../../src/scales/hesley.js';
import {
  defaultProfile,
  expectMatches,
  parseOk,
  expectValidMetrics,
} from '../helpers/scale-test-utils.js';

describe('HesleyScaleAdapter', () => {
  let adapter: HesleyScaleAdapter;
  beforeEach(() => {
    adapter = new HesleyScaleAdapter();
  });

  it('matches() resolves "yunchen" (case-insensitive), not siblings/unrelated', () => {
    expectMatches(adapter, {
      yes: ['yunchen', 'YunChen', 'YUNCHEN'],
      no: ['hesley', 'Random Scale'],
    });
  });

  describe('parseNotification()', () => {
    function frame(): Buffer {
      const buf = Buffer.alloc(14);
      buf.writeUInt16BE(8000, 2); // weight = 8000 / 100 = 80.0 kg
      buf.writeUInt16BE(225, 4); // fat = 22.5%
      buf.writeUInt16BE(550, 8); // water = 55.0%
      buf.writeUInt16BE(400, 10); // muscle = 40.0%
      buf.writeUInt16BE(35, 12); // bone = 3.5 kg
      return buf;
    }

    it('parses valid frame with weight and body comp', () => {
      parseOk(adapter, frame(), { weight: 80, impedance: 0 });
    });

    it('returns null for too-short buffer', () => {
      expect(adapter.parseNotification(Buffer.alloc(13))).toBeNull();
    });

    it('returns null when weight is zero', () => {
      const buf = Buffer.alloc(14);
      buf.writeUInt16BE(0, 2);
      expect(adapter.parseNotification(buf)).toBeNull();
    });
  });

  describe('isComplete()', () => {
    it('returns true when weight > 0', () => {
      expect(adapter.isComplete({ weight: 80, impedance: 0 })).toBe(true);
    });

    it('returns false when weight is 0', () => {
      expect(adapter.isComplete({ weight: 0, impedance: 0 })).toBe(false);
    });
  });

  describe('computeMetrics()', () => {
    it('returns valid BodyComposition with cached body comp', () => {
      const buf = Buffer.alloc(14);
      buf.writeUInt16BE(8000, 2);
      buf.writeUInt16BE(225, 4);
      buf.writeUInt16BE(550, 8);
      buf.writeUInt16BE(400, 10);
      buf.writeUInt16BE(35, 12);
      adapter.parseNotification(buf);

      expectValidMetrics(adapter, { weight: 80, impedance: 0 });
    });

    it('returns zero weight in payload for zero weight input', () => {
      const payload = adapter.computeMetrics({ weight: 0, impedance: 0 }, defaultProfile());
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

describe('HesleyScaleAdapter session boundary (#394)', () => {
  function compFrame(fatTenths: number): Buffer {
    const buf = Buffer.alloc(14);
    buf.writeUInt16BE(8000, 2);
    buf.writeUInt16BE(fatTenths, 4);
    buf.writeUInt16BE(550, 8);
    buf.writeUInt16BE(400, 10);
    buf.writeUInt16BE(35, 12);
    return buf;
  }

  it('keeps the completed reading composition when the NEXT session starts first', () => {
    const a = new HesleyScaleAdapter();
    const reading = a.parseNotification(compFrame(225))!;
    a.onSessionStart();
    const payload = a.computeMetrics(reading, defaultProfile());
    expect(payload.bodyFatPercent).toBeCloseTo(22.5, 1);
  });

  it('does not hand a hand-built reading the previous session composition', () => {
    const a = new HesleyScaleAdapter();
    a.parseNotification(compFrame(225));
    a.onSessionStart();
    // No frame this session: the live cache is all computeMetrics can fall back
    // on, and it must no longer hold 22.5 %.
    const payload = a.computeMetrics({ weight: 80, impedance: 0 }, defaultProfile());
    expect(payload.bodyFatPercent).not.toBeCloseTo(22.5, 1);
  });
});
