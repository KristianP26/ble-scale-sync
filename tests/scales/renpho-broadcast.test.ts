import { describe, it, expect } from 'vitest';
import { RenphoBroadcastAdapter } from '../../src/scales/renpho-broadcast.js';
import { defaultProfile, assertPayloadRanges } from '../helpers/scale-test-utils.js';
import type { BleDeviceInfo } from '../../src/interfaces/scale-adapter.js';

function makeAdapter() {
  return new RenphoBroadcastAdapter();
}

/** Build a fake AABB broadcast buffer with the given weight and stability. */
function makeBroadcast(weightKg: number, stable: boolean): Buffer {
  const buf = Buffer.alloc(23);
  buf[0] = 0xaa;
  buf[1] = 0xbb;
  buf[15] = stable ? 0x23 : 0x04;
  buf.writeUInt16LE(Math.round(weightKg * 100), 17);
  return buf;
}

function mockBroadcastDevice(data: Buffer): BleDeviceInfo {
  return {
    localName: 'QN-Scale',
    serviceUuids: [],
    manufacturerData: { id: 0xffff, data },
  };
}

describe('RenphoBroadcastAdapter', () => {
  describe('matches()', () => {
    it('matches AABB header with company ID 0xFFFF', () => {
      const adapter = makeAdapter();
      expect(adapter.matches(mockBroadcastDevice(makeBroadcast(70, true)))).toBe(true);
    });

    it('rejects without manufacturer data', () => {
      const adapter = makeAdapter();
      expect(adapter.matches({ localName: 'QN-Scale', serviceUuids: [] })).toBe(false);
    });

    it('rejects wrong company ID', () => {
      const adapter = makeAdapter();
      const dev: BleDeviceInfo = {
        localName: 'QN-Scale',
        serviceUuids: [],
        manufacturerData: { id: 0x0001, data: makeBroadcast(70, true) },
      };
      expect(adapter.matches(dev)).toBe(false);
    });

    it('rejects buffer without AABB magic', () => {
      const adapter = makeAdapter();
      const buf = Buffer.alloc(23);
      expect(adapter.matches(mockBroadcastDevice(buf))).toBe(false);
    });

    it('rejects too-short buffer', () => {
      const adapter = makeAdapter();
      const buf = Buffer.alloc(10);
      buf[0] = 0xaa;
      buf[1] = 0xbb;
      expect(adapter.matches(mockBroadcastDevice(buf))).toBe(false);
    });
  });

  describe('parseBroadcast()', () => {
    it('parses stable reading', () => {
      const adapter = makeAdapter();
      const reading = adapter.parseBroadcast(makeBroadcast(72.5, true));
      expect(reading).not.toBeNull();
      expect(reading!.weight).toBe(72.5);
      expect(reading!.impedance).toBe(0);
    });

    it('returns null for unstable reading', () => {
      const adapter = makeAdapter();
      expect(adapter.parseBroadcast(makeBroadcast(72.5, false))).toBeNull();
    });

    it('returns null for zero weight', () => {
      const adapter = makeAdapter();
      expect(adapter.parseBroadcast(makeBroadcast(0, true))).toBeNull();
    });

    it('returns null for too-short buffer', () => {
      const adapter = makeAdapter();
      expect(adapter.parseBroadcast(Buffer.alloc(10))).toBeNull();
    });

    it('returns null for wrong magic header', () => {
      const adapter = makeAdapter();
      const buf = makeBroadcast(70, true);
      buf[0] = 0x00;
      expect(adapter.parseBroadcast(buf)).toBeNull();
    });
  });

  describe('isComplete()', () => {
    it('returns true when weight > 0', () => {
      const adapter = makeAdapter();
      expect(adapter.isComplete({ weight: 72.5, impedance: 0 })).toBe(true);
    });

    it('returns false when weight is 0', () => {
      const adapter = makeAdapter();
      expect(adapter.isComplete({ weight: 0, impedance: 0 })).toBe(false);
    });
  });

  describe('computeMetrics()', () => {
    it('returns valid BodyComposition with estimation', () => {
      const adapter = makeAdapter();
      const profile = defaultProfile();
      const payload = adapter.computeMetrics({ weight: 75, impedance: 0 }, profile);
      expect(payload.weight).toBe(75);
      expect(payload.impedance).toBe(0);
      assertPayloadRanges(payload);
    });
  });
});
