import { describe, it, expect } from 'vitest';
import { RenphoEs26bbAdapter } from '../../src/scales/renpho-es26bb.js';
import {
  mockPeripheral,
  defaultProfile,
  assertPayloadRanges,
} from '../helpers/scale-test-utils.js';

function makeAdapter() {
  return new RenphoEs26bbAdapter();
}

describe('RenphoEs26bbAdapter', () => {
  describe('matches()', () => {
    it('matches "es-26bb-b" exact', () => {
      const adapter = makeAdapter();
      expect(adapter.matches(mockPeripheral('es-26bb-b'))).toBe(true);
    });

    it('matches case-insensitive', () => {
      const adapter = makeAdapter();
      expect(adapter.matches(mockPeripheral('ES-26BB-B'))).toBe(true);
    });

    it('does not match "es-26bb" without "-b"', () => {
      const adapter = makeAdapter();
      expect(adapter.matches(mockPeripheral('es-26bb'))).toBe(false);
    });

    it('does not match unrelated name', () => {
      const adapter = makeAdapter();
      expect(adapter.matches(mockPeripheral('Random Scale'))).toBe(false);
    });
  });

  describe('parseNotification()', () => {
    it('parses action 0x14 live frame', () => {
      const adapter = makeAdapter();
      const buf = Buffer.alloc(12);
      buf[2] = 0x14; // action = live
      buf.writeUInt32BE(8000, 6); // weight = 8000 / 100 = 80.0 kg
      buf.writeUInt16BE(500, 10); // impedance = 500

      const reading = adapter.parseNotification(buf);
      expect(reading).not.toBeNull();
      expect(reading!.weight).toBe(80);
      expect(reading!.impedance).toBe(500);
    });

    it('parses action 0x15 offline frame', () => {
      const adapter = makeAdapter();
      const buf = Buffer.alloc(12);
      buf[2] = 0x15; // action = offline
      buf.writeUInt32BE(7500, 5); // weight = 7500 / 100 = 75.0 kg
      buf.writeUInt16BE(480, 9); // impedance = 480

      const reading = adapter.parseNotification(buf);
      expect(reading).not.toBeNull();
      expect(reading!.weight).toBe(75);
      expect(reading!.impedance).toBe(480);
    });

    it('returns null for unknown action', () => {
      const adapter = makeAdapter();
      const buf = Buffer.alloc(12);
      buf[2] = 0x20; // unknown action
      expect(adapter.parseNotification(buf)).toBeNull();
    });

    it('returns null for too-short buffer', () => {
      const adapter = makeAdapter();
      expect(adapter.parseNotification(Buffer.alloc(5))).toBeNull();
    });

    it('returns null when weight is zero', () => {
      const adapter = makeAdapter();
      const buf = Buffer.alloc(12);
      buf[2] = 0x14;
      buf.writeUInt32BE(0, 6); // weight = 0
      buf.writeUInt16BE(500, 10);
      expect(adapter.parseNotification(buf)).toBeNull();
    });
  });

  describe('isComplete()', () => {
    it('returns true when weight > 10 and impedance > 0', () => {
      const adapter = makeAdapter();
      expect(adapter.isComplete({ weight: 80, impedance: 500 })).toBe(true);
    });

    it('returns false when weight <= 10', () => {
      const adapter = makeAdapter();
      expect(adapter.isComplete({ weight: 10, impedance: 500 })).toBe(false);
    });

    it('returns false when impedance is 0', () => {
      const adapter = makeAdapter();
      expect(adapter.isComplete({ weight: 80, impedance: 0 })).toBe(false);
    });
  });

  describe('computeMetrics()', () => {
    it('returns valid GarminPayload', () => {
      const adapter = makeAdapter();
      const profile = defaultProfile();
      const payload = adapter.computeMetrics({ weight: 80, impedance: 500 }, profile);
      expect(payload.weight).toBe(80);
      expect(payload.impedance).toBe(500);
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
