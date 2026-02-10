import { describe, it, expect } from 'vitest';
import { HoffenAdapter } from '../../src/scales/hoffen.js';
import {
  mockPeripheral,
  defaultProfile,
  assertPayloadRanges,
} from '../helpers/scale-test-utils.js';

function makeAdapter() {
  return new HoffenAdapter();
}

describe('HoffenAdapter', () => {
  describe('matches()', () => {
    it('matches "hoffen bs-8107" exact', () => {
      const adapter = makeAdapter();
      expect(adapter.matches(mockPeripheral('hoffen bs-8107'))).toBe(true);
    });

    it('matches case-insensitive', () => {
      const adapter = makeAdapter();
      expect(adapter.matches(mockPeripheral('Hoffen BS-8107'))).toBe(true);
      expect(adapter.matches(mockPeripheral('HOFFEN BS-8107'))).toBe(true);
    });

    it('does not match "hoffen" without model', () => {
      const adapter = makeAdapter();
      expect(adapter.matches(mockPeripheral('hoffen'))).toBe(false);
    });

    it('does not match unrelated name', () => {
      const adapter = makeAdapter();
      expect(adapter.matches(mockPeripheral('Random Scale'))).toBe(false);
    });
  });

  describe('parseNotification()', () => {
    it('parses weight-only frame (no BIA contact)', () => {
      const adapter = makeAdapter();
      const buf = Buffer.alloc(8);
      buf[0] = 0xfa; // magic
      buf.writeUInt16LE(800, 3); // weight = 800 / 10 = 80.0 kg
      buf[5] = 0x01; // no BIA contact (not 0x00)

      const reading = adapter.parseNotification(buf);
      expect(reading).not.toBeNull();
      expect(reading!.weight).toBe(80);
      expect(reading!.impedance).toBe(0);
    });

    it('parses frame with BIA contact (body comp data)', () => {
      const adapter = makeAdapter();
      const buf = Buffer.alloc(19);
      buf[0] = 0xfa; // magic
      buf.writeUInt16LE(800, 3); // weight = 80.0 kg
      buf[5] = 0x00; // BIA contact
      buf.writeUInt16LE(225, 6); // fat = 22.5%
      buf.writeUInt16LE(550, 8); // water = 55.0%
      buf.writeUInt16LE(400, 10); // muscle = 40.0%
      buf[14] = 35; // bone = 3.5 kg
      buf.writeUInt16LE(80, 17); // visceral fat = 8.0

      const reading = adapter.parseNotification(buf);
      expect(reading).not.toBeNull();
      expect(reading!.weight).toBe(80);
    });

    it('returns null for wrong magic', () => {
      const adapter = makeAdapter();
      const buf = Buffer.alloc(8);
      buf[0] = 0xfb; // wrong magic
      buf.writeUInt16LE(800, 3);
      expect(adapter.parseNotification(buf)).toBeNull();
    });

    it('returns null for too-short buffer', () => {
      const adapter = makeAdapter();
      expect(adapter.parseNotification(Buffer.alloc(4))).toBeNull();
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
    it('returns valid GarminPayload with cached body comp', () => {
      const adapter = makeAdapter();

      const buf = Buffer.alloc(19);
      buf[0] = 0xfa;
      buf.writeUInt16LE(800, 3);
      buf[5] = 0x00;
      buf.writeUInt16LE(225, 6); // fat 22.5%
      buf.writeUInt16LE(550, 8); // water 55%
      buf.writeUInt16LE(400, 10); // muscle 40%
      buf[14] = 35; // bone 3.5
      buf.writeUInt16LE(80, 17); // visceral 8.0
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
