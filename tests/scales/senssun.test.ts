import { describe, it, expect } from 'vitest';
import { SenssunAdapter } from '../../src/scales/senssun.js';
import {
  mockPeripheral,
  defaultProfile,
  assertPayloadRanges,
} from '../helpers/scale-test-utils.js';

function makeAdapter() {
  return new SenssunAdapter();
}

describe('SenssunAdapter', () => {
  describe('matches()', () => {
    it('matches "senssun fat" exact', () => {
      const adapter = makeAdapter();
      expect(adapter.matches(mockPeripheral('senssun fat'))).toBe(true);
    });

    it('matches case-insensitive', () => {
      const adapter = makeAdapter();
      expect(adapter.matches(mockPeripheral('Senssun Fat'))).toBe(true);
      expect(adapter.matches(mockPeripheral('SENSSUN FAT'))).toBe(true);
    });

    it('does not match "senssun" without " fat"', () => {
      const adapter = makeAdapter();
      expect(adapter.matches(mockPeripheral('senssun'))).toBe(false);
    });

    it('does not match unrelated name', () => {
      const adapter = makeAdapter();
      expect(adapter.matches(mockPeripheral('Random Scale'))).toBe(false);
    });
  });

  describe('parseNotification()', () => {
    it('parses 0xA5 weight frame', () => {
      const adapter = makeAdapter();
      const buf = Buffer.alloc(6);
      buf[0] = 0xa5;
      buf.writeUInt16BE(800, 1); // 800 / 10 = 80.0 kg
      buf[5] = 0xaa; // stable

      const reading = adapter.parseNotification(buf);
      expect(reading).not.toBeNull();
      expect(reading!.weight).toBe(80);
    });

    it('parses 0xB0 fat/water frame after weight', () => {
      const adapter = makeAdapter();

      // First send weight frame
      const weightBuf = Buffer.alloc(6);
      weightBuf[0] = 0xa5;
      weightBuf.writeUInt16BE(800, 1);
      weightBuf[5] = 0xaa;
      adapter.parseNotification(weightBuf);

      // Then fat/water frame
      const fatBuf = Buffer.alloc(5);
      fatBuf[0] = 0xb0;
      fatBuf.writeUInt16BE(225, 1); // fat = 22.5%
      fatBuf.writeUInt16BE(550, 3); // water = 55.0%

      const reading = adapter.parseNotification(fatBuf);
      expect(reading).not.toBeNull();
      expect(reading!.weight).toBe(80);
    });

    it('parses 0xC0 muscle/bone frame', () => {
      const adapter = makeAdapter();

      const weightBuf = Buffer.alloc(6);
      weightBuf[0] = 0xa5;
      weightBuf.writeUInt16BE(800, 1);
      weightBuf[5] = 0xaa;
      adapter.parseNotification(weightBuf);

      const muscleBuf = Buffer.alloc(5);
      muscleBuf[0] = 0xc0;
      muscleBuf.writeUInt16BE(400, 1); // muscle = 40.0%
      muscleBuf.writeUInt16BE(35, 3); // bone = 3.5 kg

      const reading = adapter.parseNotification(muscleBuf);
      expect(reading).not.toBeNull();
    });

    it('parses 0xD0 BMR frame (tracked but returns weight)', () => {
      const adapter = makeAdapter();

      const weightBuf = Buffer.alloc(6);
      weightBuf[0] = 0xa5;
      weightBuf.writeUInt16BE(800, 1);
      weightBuf[5] = 0xaa;
      adapter.parseNotification(weightBuf);

      const bmrBuf = Buffer.alloc(3);
      bmrBuf[0] = 0xd0;

      const reading = adapter.parseNotification(bmrBuf);
      expect(reading).not.toBeNull();
    });

    it('strips leading 0xFF padding', () => {
      const adapter = makeAdapter();
      const buf = Buffer.from([0xff, 0xff, 0xa5, 0x03, 0x20, 0x00, 0x00, 0xaa]);
      // After stripping 2x 0xFF: 0xA5, weight BE at [1-2] = 0x0320 = 800 / 10 = 80.0 kg
      const reading = adapter.parseNotification(buf);
      expect(reading).not.toBeNull();
      expect(reading!.weight).toBe(80);
    });

    it('returns null for all-0xFF buffer', () => {
      const adapter = makeAdapter();
      expect(adapter.parseNotification(Buffer.from([0xff, 0xff, 0xff]))).toBeNull();
    });

    it('returns null for too-short buffer', () => {
      const adapter = makeAdapter();
      expect(adapter.parseNotification(Buffer.alloc(1))).toBeNull();
    });

    it('returns null when no weight frame received yet', () => {
      const adapter = makeAdapter();
      const fatBuf = Buffer.alloc(5);
      fatBuf[0] = 0xb0;
      fatBuf.writeUInt16BE(225, 1);
      fatBuf.writeUInt16BE(550, 3);
      expect(adapter.parseNotification(fatBuf)).toBeNull();
    });
  });

  describe('isComplete()', () => {
    it('returns true when all 4 frame types received', () => {
      const adapter = makeAdapter();

      // Weight frame
      const w = Buffer.alloc(6);
      w[0] = 0xa5;
      w.writeUInt16BE(800, 1);
      w[5] = 0xaa;
      adapter.parseNotification(w);

      // Fat/water frame
      const f = Buffer.alloc(5);
      f[0] = 0xb0;
      f.writeUInt16BE(225, 1);
      f.writeUInt16BE(550, 3);
      adapter.parseNotification(f);

      // Muscle/bone frame
      const m = Buffer.alloc(5);
      m[0] = 0xc0;
      m.writeUInt16BE(400, 1);
      m.writeUInt16BE(35, 3);
      adapter.parseNotification(m);

      // BMR frame
      const b = Buffer.alloc(3);
      b[0] = 0xd0;
      adapter.parseNotification(b);

      expect(adapter.isComplete({ weight: 80, impedance: 0 })).toBe(true);
    });

    it('returns false when not all frames received', () => {
      const adapter = makeAdapter();

      const w = Buffer.alloc(6);
      w[0] = 0xa5;
      w.writeUInt16BE(800, 1);
      w[5] = 0xaa;
      adapter.parseNotification(w);

      expect(adapter.isComplete({ weight: 80, impedance: 0 })).toBe(false);
    });

    it('returns false when weight is 0', () => {
      const adapter = makeAdapter();
      expect(adapter.isComplete({ weight: 0, impedance: 0 })).toBe(false);
    });
  });

  describe('computeMetrics()', () => {
    it('returns valid GarminPayload with cached body comp', () => {
      const adapter = makeAdapter();

      // Send all 4 frames to populate cached values
      const w = Buffer.alloc(6);
      w[0] = 0xa5;
      w.writeUInt16BE(800, 1);
      w[5] = 0xaa;
      adapter.parseNotification(w);

      const f = Buffer.alloc(5);
      f[0] = 0xb0;
      f.writeUInt16BE(225, 1); // fat = 22.5%
      f.writeUInt16BE(550, 3); // water = 55.0%
      adapter.parseNotification(f);

      const m = Buffer.alloc(5);
      m[0] = 0xc0;
      m.writeUInt16BE(400, 1); // muscle = 40.0%
      m.writeUInt16BE(35, 3); // bone = 3.5 kg
      adapter.parseNotification(m);

      const b = Buffer.alloc(3);
      b[0] = 0xd0;
      adapter.parseNotification(b);

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
