import { describe, it, expect } from 'vitest';
import { InlifeScaleAdapter } from '../../src/scales/inlife.js';
import {
  mockPeripheral,
  defaultProfile,
  assertPayloadRanges,
} from '../helpers/scale-test-utils.js';

function makeAdapter() {
  return new InlifeScaleAdapter();
}

describe('InlifeScaleAdapter', () => {
  describe('matches()', () => {
    it.each(['000fatscale01', '000fatscale02', '042fatscale01'])(
      'matches known name "%s"',
      (name) => {
        const adapter = makeAdapter();
        expect(adapter.matches(mockPeripheral(name))).toBe(true);
      },
    );

    it('matches by service UUID "fff0"', () => {
      const adapter = makeAdapter();
      expect(adapter.matches(mockPeripheral('Unknown', ['fff0']))).toBe(true);
    });

    it('matches case-insensitive name', () => {
      const adapter = makeAdapter();
      expect(adapter.matches(mockPeripheral('000FatScale01'))).toBe(true);
    });

    it('does not match unrelated name without service UUID', () => {
      const adapter = makeAdapter();
      expect(adapter.matches(mockPeripheral('Random Scale'))).toBe(false);
    });
  });

  describe('parseNotification()', () => {
    it('parses impedance-mode frame (mode 0x80)', () => {
      const adapter = makeAdapter();
      const buf = Buffer.alloc(14);
      buf[0] = 0x02; // marker
      buf.writeUInt16BE(800, 2); // weight = 800 / 10 = 80.0 kg
      buf.writeUInt32BE(500, 4); // impedance = 500
      buf[11] = 0x80; // impedance mode

      const reading = adapter.parseNotification(buf);
      expect(reading).not.toBeNull();
      expect(reading!.weight).toBe(80);
      expect(reading!.impedance).toBe(500);
    });

    it('parses impedance-mode frame (mode 0x81)', () => {
      const adapter = makeAdapter();
      const buf = Buffer.alloc(14);
      buf[0] = 0x02;
      buf.writeUInt16BE(750, 2); // 75.0 kg
      buf.writeUInt32BE(480, 4);
      buf[11] = 0x81;

      const reading = adapter.parseNotification(buf);
      expect(reading).not.toBeNull();
      expect(reading!.weight).toBe(75);
      expect(reading!.impedance).toBe(480);
    });

    it('parses legacy-mode frame (visceral fat)', () => {
      const adapter = makeAdapter();
      const buf = Buffer.alloc(14);
      buf[0] = 0x02;
      buf.writeUInt16BE(800, 2);
      // Legacy mode: visceral at [7-8] BE / 10
      buf.writeUInt16BE(80, 7); // visceral = 8.0
      buf[11] = 0x00; // legacy mode

      const reading = adapter.parseNotification(buf);
      expect(reading).not.toBeNull();
      expect(reading!.weight).toBe(80);
      expect(reading!.impedance).toBe(0); // no impedance in legacy mode
    });

    it('returns null for wrong marker', () => {
      const adapter = makeAdapter();
      const buf = Buffer.alloc(14);
      buf[0] = 0x03; // wrong
      expect(adapter.parseNotification(buf)).toBeNull();
    });

    it('returns null for too-short buffer', () => {
      const adapter = makeAdapter();
      expect(adapter.parseNotification(Buffer.alloc(13))).toBeNull();
    });

    it('returns null when weight is zero', () => {
      const adapter = makeAdapter();
      const buf = Buffer.alloc(14);
      buf[0] = 0x02;
      buf.writeUInt16BE(0, 2);
      buf[11] = 0x80;
      expect(adapter.parseNotification(buf)).toBeNull();
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
    it('returns valid GarminPayload with impedance', () => {
      const adapter = makeAdapter();
      const profile = defaultProfile();
      const payload = adapter.computeMetrics({ weight: 80, impedance: 500 }, profile);
      expect(payload.weight).toBe(80);
      assertPayloadRanges(payload);
    });

    it('returns valid GarminPayload with cached visceral (legacy mode)', () => {
      const adapter = makeAdapter();
      const buf = Buffer.alloc(14);
      buf[0] = 0x02;
      buf.writeUInt16BE(800, 2);
      buf.writeUInt16BE(80, 7);
      buf[11] = 0x00;
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
