import { describe, it, expect } from 'vitest';
import { EsCs20mAdapter } from '../../src/scales/es-cs20m.js';
import {
  mockPeripheral,
  defaultProfile,
  assertPayloadRanges,
} from '../helpers/scale-test-utils.js';

function makeAdapter() {
  return new EsCs20mAdapter();
}

describe('EsCs20mAdapter', () => {
  describe('matches()', () => {
    it('matches "es-cs20m" substring', () => {
      const adapter = makeAdapter();
      expect(adapter.matches(mockPeripheral('es-cs20m'))).toBe(true);
      expect(adapter.matches(mockPeripheral('My ES-CS20M Scale'))).toBe(true);
    });

    it('matches case-insensitive', () => {
      const adapter = makeAdapter();
      expect(adapter.matches(mockPeripheral('ES-CS20M'))).toBe(true);
    });

    it('does not match "cs20" without "es-" prefix', () => {
      const adapter = makeAdapter();
      expect(adapter.matches(mockPeripheral('cs20'))).toBe(false);
    });

    it('does not match unrelated name', () => {
      const adapter = makeAdapter();
      expect(adapter.matches(mockPeripheral('Random Scale'))).toBe(false);
    });

    it('matches by vendor service UUID 0x1A10 (unnamed device)', () => {
      const adapter = makeAdapter();
      expect(adapter.matches(mockPeripheral('', ['1a10']))).toBe(true);
    });

    it('matches by full 128-bit vendor service UUID (dashless)', () => {
      const adapter = makeAdapter();
      expect(adapter.matches(mockPeripheral('', ['00001a1000001000800000805f9b34fb']))).toBe(true);
    });

    it('does not match unrelated service UUID', () => {
      const adapter = makeAdapter();
      expect(adapter.matches(mockPeripheral('', ['ffe0']))).toBe(false);
    });
  });

  describe('parseNotification()', () => {
    it('parses msgId 0x14 weight frame (stripped header)', () => {
      const adapter = makeAdapter();
      const buf = Buffer.alloc(12);
      buf[0] = 0x14; // msgId at [0] — stripped header
      buf[5] = 0x01; // stable
      buf.writeUInt16BE(8000, 8); // weight = 8000 / 100 = 80.0 kg
      buf.writeUInt16BE(500, 10); // resistance

      const reading = adapter.parseNotification(buf);
      expect(reading).not.toBeNull();
      expect(reading!.weight).toBe(80);
      expect(reading!.impedance).toBe(500);
    });

    it('parses msgId 0x14 with 55 AA header', () => {
      const adapter = makeAdapter();
      const buf = Buffer.alloc(14);
      buf[0] = 0x55; // header byte 1
      buf[1] = 0xaa; // header byte 2
      buf[2] = 0x14; // msgId at [2]
      buf[5] = 0x01; // stable
      buf.writeUInt16BE(8000, 8); // weight
      buf.writeUInt16BE(500, 10); // resistance

      const reading = adapter.parseNotification(buf);
      expect(reading).not.toBeNull();
      expect(reading!.weight).toBe(80);
      expect(reading!.impedance).toBe(500);
    });

    it('parses msgId 0x14 weight frame (not stable)', () => {
      const adapter = makeAdapter();
      const buf = Buffer.alloc(10);
      buf[0] = 0x14;
      buf[5] = 0x00; // not stable
      buf.writeUInt16BE(8000, 8);

      const reading = adapter.parseNotification(buf);
      expect(reading).not.toBeNull();
      expect(reading!.weight).toBe(80);
    });

    it('parses msgId 0x15 extended frame (returns null, stores resistance)', () => {
      const adapter = makeAdapter();
      const buf = Buffer.alloc(11);
      buf[0] = 0x15;
      buf.writeUInt16BE(500, 9); // resistance

      expect(adapter.parseNotification(buf)).toBeNull();
    });

    it('parses msgId 0x15 with 55 AA header', () => {
      const adapter = makeAdapter();
      const buf = Buffer.alloc(13);
      buf[0] = 0x55;
      buf[1] = 0xaa;
      buf[2] = 0x15; // msgId at [2]
      buf.writeUInt16BE(500, 9);

      expect(adapter.parseNotification(buf)).toBeNull();
    });

    it('uses resistance from 0x15 frame in subsequent 0x14 frame', () => {
      const adapter = makeAdapter();

      // Extended frame stores resistance
      const ext = Buffer.alloc(11);
      ext[0] = 0x15;
      ext.writeUInt16BE(500, 9);
      adapter.parseNotification(ext);

      // Weight frame without resistance
      const w = Buffer.alloc(10);
      w[0] = 0x14;
      w[5] = 0x01;
      w.writeUInt16BE(8000, 8);

      const reading = adapter.parseNotification(w);
      expect(reading).not.toBeNull();
      expect(reading!.impedance).toBe(500);
    });

    it('returns null for unknown msgId', () => {
      const adapter = makeAdapter();
      const buf = Buffer.alloc(12);
      buf[0] = 0x20; // unknown
      expect(adapter.parseNotification(buf)).toBeNull();
    });

    it('returns null for too-short buffer', () => {
      const adapter = makeAdapter();
      expect(adapter.parseNotification(Buffer.alloc(1))).toBeNull();
    });

    it('returns null for 0x14 frame shorter than 10 bytes', () => {
      const adapter = makeAdapter();
      const buf = Buffer.alloc(9);
      buf[0] = 0x14;
      expect(adapter.parseNotification(buf)).toBeNull();
    });

    it('rejects weight below 0.5 kg', () => {
      const adapter = makeAdapter();
      const buf = Buffer.alloc(10);
      buf[0] = 0x14;
      buf[5] = 0x01;
      buf.writeUInt16BE(10, 8); // 0.10 kg
      expect(adapter.parseNotification(buf)).toBeNull();
    });

    it('rejects weight above 300 kg', () => {
      const adapter = makeAdapter();
      const buf = Buffer.alloc(10);
      buf[0] = 0x14;
      buf[5] = 0x01;
      buf.writeUInt16BE(30100, 8); // 301.00 kg
      expect(adapter.parseNotification(buf)).toBeNull();
    });

    it('parses 0x11 STOP frame and returns accumulated reading', () => {
      const adapter = makeAdapter();

      // Weight frame first
      const w = Buffer.alloc(10);
      w[0] = 0x14;
      w[5] = 0x00; // not stable
      w.writeUInt16BE(7500, 8); // 75.00 kg
      adapter.parseNotification(w);

      // STOP frame
      const stop = Buffer.alloc(6);
      stop[0] = 0x11;
      stop[5] = 0x00; // STOP
      const reading = adapter.parseNotification(stop);
      expect(reading).not.toBeNull();
      expect(reading!.weight).toBe(75);
    });

    it('parses 0x11 STOP frame with 55 AA header', () => {
      const adapter = makeAdapter();

      const w = Buffer.alloc(10);
      w[0] = 0x14;
      w.writeUInt16BE(8000, 8);
      adapter.parseNotification(w);

      const stop = Buffer.alloc(8);
      stop[0] = 0x55;
      stop[1] = 0xaa;
      stop[2] = 0x11;
      stop[5] = 0x00;
      const reading = adapter.parseNotification(stop);
      expect(reading).not.toBeNull();
      expect(reading!.weight).toBe(80);
    });

    it('0x11 START frame resets state', () => {
      const adapter = makeAdapter();

      // Weight frame
      const w = Buffer.alloc(12);
      w[0] = 0x14;
      w[5] = 0x01;
      w.writeUInt16BE(8000, 8);
      w.writeUInt16BE(500, 10);
      adapter.parseNotification(w);

      // START frame resets
      const start = Buffer.alloc(6);
      start[0] = 0x11;
      start[5] = 0x01;
      adapter.parseNotification(start);

      // STOP with no weight accumulated returns null
      const stop = Buffer.alloc(6);
      stop[0] = 0x11;
      stop[5] = 0x00;
      expect(adapter.parseNotification(stop)).toBeNull();
    });

    it('0x11 STOP returns null when no weight accumulated', () => {
      const adapter = makeAdapter();
      const stop = Buffer.alloc(6);
      stop[0] = 0x11;
      stop[5] = 0x00;
      expect(adapter.parseNotification(stop)).toBeNull();
    });

    it('returns null for 0x11 frame shorter than 6 bytes', () => {
      const adapter = makeAdapter();
      const buf = Buffer.alloc(5);
      buf[0] = 0x11;
      expect(adapter.parseNotification(buf)).toBeNull();
    });
  });

  describe('isComplete()', () => {
    it('returns true when weight > 0 and stable flag set', () => {
      const adapter = makeAdapter();
      const buf = Buffer.alloc(10);
      buf[0] = 0x14;
      buf[5] = 0x01; // stable
      buf.writeUInt16BE(8000, 8);
      adapter.parseNotification(buf);

      expect(adapter.isComplete({ weight: 80, impedance: 0 })).toBe(true);
    });

    it('returns true when weight > 0 and STOP frame received', () => {
      const adapter = makeAdapter();

      // Weight frame without stable flag
      const w = Buffer.alloc(10);
      w[0] = 0x14;
      w[5] = 0x00;
      w.writeUInt16BE(8000, 8);
      adapter.parseNotification(w);

      expect(adapter.isComplete({ weight: 80, impedance: 0 })).toBe(false);

      // STOP frame
      const stop = Buffer.alloc(6);
      stop[0] = 0x11;
      stop[5] = 0x00;
      adapter.parseNotification(stop);

      expect(adapter.isComplete({ weight: 80, impedance: 0 })).toBe(true);
    });

    it('returns false when not stable and no STOP frame', () => {
      const adapter = makeAdapter();
      const buf = Buffer.alloc(10);
      buf[0] = 0x14;
      buf[5] = 0x00; // not stable
      buf.writeUInt16BE(8000, 8);
      adapter.parseNotification(buf);

      expect(adapter.isComplete({ weight: 80, impedance: 0 })).toBe(false);
    });

    it('returns false when weight is 0', () => {
      const adapter = makeAdapter();
      expect(adapter.isComplete({ weight: 0, impedance: 0 })).toBe(false);
    });
  });

  describe('computeMetrics()', () => {
    it('returns valid BodyComposition', () => {
      const adapter = makeAdapter();
      const profile = defaultProfile();
      const payload = adapter.computeMetrics({ weight: 80, impedance: 500 }, profile);
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
