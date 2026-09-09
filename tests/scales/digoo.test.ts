import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DigooScaleAdapter } from '../../src/scales/digoo.js';
import type { ConnectionContext } from '../../src/interfaces/scale-adapter.js';
import {
  defaultProfile,
  expectMatches,
  parseOk,
  expectValidMetrics,
} from '../helpers/scale-test-utils.js';

/** Full Digoo frame: weight + control byte (bit0 stable, bit1 allValues) + body comp. */
function frame(control: number, weight = 8000): Buffer {
  const buf = Buffer.alloc(19);
  buf.writeUInt16BE(weight, 3); // weight / 100
  buf[5] = control;
  buf.writeUInt16BE(225, 6); // fat = 22.5%
  buf[10] = 80; // visceral = 8.0
  buf.writeUInt16BE(550, 11); // water = 55.0%
  buf.writeUInt16BE(400, 16); // muscle = 40.0%
  buf[18] = 35; // bone = 3.5 kg
  return buf;
}

describe('DigooScaleAdapter', () => {
  let adapter: DigooScaleAdapter;
  beforeEach(() => {
    adapter = new DigooScaleAdapter();
  });

  it('matches() resolves "mengii" (case-insensitive), not siblings/unrelated', () => {
    expectMatches(adapter, {
      yes: ['mengii', 'Mengii', 'MENGII'],
      no: ['digoo', 'Random Scale'],
    });
  });

  describe('parseNotification()', () => {
    it('parses frame with stable + allValues', () => {
      parseOk(adapter, frame(0x03), { weight: 80 });
    });

    it('parses frame without allValues (weight only)', () => {
      parseOk(adapter, frame(0x01), { weight: 80 }); // stable only, no allValues
    });

    it('returns null for too-short buffer', () => {
      expect(adapter.parseNotification(Buffer.alloc(18))).toBeNull();
    });

    it('returns null when weight is zero', () => {
      expect(adapter.parseNotification(frame(0x03, 0))).toBeNull();
    });
  });

  describe('isComplete()', () => {
    it('returns true when weight > 0 and stable and allValues', () => {
      adapter.parseNotification(frame(0x03)); // stable + allValues
      expect(adapter.isComplete({ weight: 80, impedance: 0 })).toBe(true);
    });

    it('returns false when not stable', () => {
      adapter.parseNotification(frame(0x02)); // allValues but not stable
      expect(adapter.isComplete({ weight: 80, impedance: 0 })).toBe(false);
    });

    it('returns false when not allValues', () => {
      const buf = Buffer.alloc(19);
      buf.writeUInt16BE(8000, 3);
      buf[5] = 0x01; // stable but no allValues
      adapter.parseNotification(buf);
      expect(adapter.isComplete({ weight: 80, impedance: 0 })).toBe(false);
    });

    it('returns false when weight is 0', () => {
      expect(adapter.isComplete({ weight: 0, impedance: 0 })).toBe(false);
    });
  });

  describe('onConnected()', () => {
    it('sends user config command with profile data', async () => {
      const writeFn = vi.fn().mockResolvedValue(undefined);
      const profile = defaultProfile({ gender: 'male', height: 183, age: 30 });

      const ctx: ConnectionContext = {
        write: writeFn,
        read: vi.fn(),
        subscribe: vi.fn(),
        profile,
      };

      await adapter.onConnected!(ctx);

      expect(writeFn).toHaveBeenCalledOnce();
      const [charUuid, data, withResponse] = writeFn.mock.calls[0];
      expect(charUuid).toBe(adapter.charWriteUuid);
      expect(withResponse).toBe(false);

      // Verify format: [0x09, 0x10, 0x12, 0x11, 0x0D, 0x01, height, age, gender, unit, ...]
      expect(data[0]).toBe(0x09);
      expect(data[5]).toBe(0x01);
      expect(data[6]).toBe(183); // height
      expect(data[7]).toBe(30); // age
      expect(data[8]).toBe(0x00); // male
      expect(data.length).toBe(16); // 15 bytes + checksum
    });

    it('sends female gender code for female profile', async () => {
      const writeFn = vi.fn().mockResolvedValue(undefined);
      const profile = defaultProfile({ gender: 'female', height: 165, age: 25 });

      const ctx: ConnectionContext = {
        write: writeFn,
        read: vi.fn(),
        subscribe: vi.fn(),
        profile,
      };

      await adapter.onConnected!(ctx);

      const data = writeFn.mock.calls[0][1];
      expect(data[6]).toBe(165);
      expect(data[7]).toBe(25);
      expect(data[8]).toBe(0x01); // female
    });
  });

  describe('computeMetrics()', () => {
    it('returns valid BodyComposition with cached body comp', () => {
      adapter.parseNotification(frame(0x03));
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

describe('DigooScaleAdapter session boundary (#394)', () => {
  it('keeps the completed reading composition when the NEXT session starts first', () => {
    const a = new DigooScaleAdapter();
    const reading = a.parseNotification(frame(0x03))!;
    expect(a.isComplete(reading)).toBe(true);
    a.onSessionStart();
    const payload = a.computeMetrics(reading, defaultProfile());
    expect(payload.bodyFatPercent).toBeCloseTo(22.5, 1);
  });

  it('does not hand a hand-built reading the previous session composition', () => {
    const a = new DigooScaleAdapter();
    a.parseNotification(frame(0x03));
    a.onSessionStart();
    // No frame this session, so the live cache is all computeMetrics can fall
    // back on. stable/allValues are deliberately NOT asserted here: parse
    // rewrites both on every frame, so a test on those would pass either way.
    const payload = a.computeMetrics({ weight: 80, impedance: 0 }, defaultProfile());
    expect(payload.bodyFatPercent).not.toBeCloseTo(22.5, 1);
  });
});
