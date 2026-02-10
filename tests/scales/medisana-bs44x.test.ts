import { describe, it, expect, vi } from 'vitest';
import { MedisanaBs44xAdapter } from '../../src/scales/medisana-bs44x.js';
import type { ConnectionContext } from '../../src/interfaces/scale-adapter.js';
import {
  mockPeripheral,
  defaultProfile,
  assertPayloadRanges,
} from '../helpers/scale-test-utils.js';

function makeAdapter() {
  return new MedisanaBs44xAdapter();
}

describe('MedisanaBs44xAdapter', () => {
  describe('matches()', () => {
    it.each(['013197', '013198', '0202b6'])('matches exact name "%s"', (name) => {
      const adapter = makeAdapter();
      expect(adapter.matches(mockPeripheral(name))).toBe(true);
    });

    it('matches "0203b..." prefix', () => {
      const adapter = makeAdapter();
      expect(adapter.matches(mockPeripheral('0203b123'))).toBe(true);
      expect(adapter.matches(mockPeripheral('0203bABC'))).toBe(true);
    });

    it('matches by service UUID "78b2"', () => {
      const adapter = makeAdapter();
      expect(adapter.matches(mockPeripheral('Unknown', ['78b2']))).toBe(true);
    });

    it('matches case-insensitive name', () => {
      const adapter = makeAdapter();
      expect(adapter.matches(mockPeripheral('013197'))).toBe(true);
      expect(adapter.matches(mockPeripheral('0203B123'))).toBe(true);
    });

    it('does not match unrelated name', () => {
      const adapter = makeAdapter();
      expect(adapter.matches(mockPeripheral('Random Scale'))).toBe(false);
    });

    it('does not match unrelated UUID', () => {
      const adapter = makeAdapter();
      expect(adapter.matches(mockPeripheral('Unknown', ['1234']))).toBe(false);
    });
  });

  describe('onConnected()', () => {
    it('sends time sync with real Unix timestamp', async () => {
      const adapter = makeAdapter();
      const writeFn = vi.fn().mockResolvedValue(undefined);

      const ctx: ConnectionContext = {
        write: writeFn,
        read: vi.fn(),
        subscribe: vi.fn(),
        profile: defaultProfile(),
      };

      const before = Math.floor(Date.now() / 1000);
      await adapter.onConnected!(ctx);
      const after = Math.floor(Date.now() / 1000);

      expect(writeFn).toHaveBeenCalledOnce();
      const [charUuid, data, withResponse] = writeFn.mock.calls[0];
      expect(charUuid).toBe(adapter.charWriteUuid);
      expect(withResponse).toBe(true);

      expect(data[0]).toBe(0x02);
      // Verify the timestamp is within the expected range
      const buf = Buffer.from(data);
      const ts = buf.readUInt32LE(1);
      expect(ts).toBeGreaterThanOrEqual(before);
      expect(ts).toBeLessThanOrEqual(after);
    });
  });

  describe('parseNotification()', () => {
    it('parses weight frame (< 16 bytes)', () => {
      const adapter = makeAdapter();
      const buf = Buffer.alloc(4);
      buf.writeUInt16LE(8000, 1); // weight = 8000 / 100 = 80.0 kg

      const reading = adapter.parseNotification(buf);
      expect(reading).not.toBeNull();
      expect(reading!.weight).toBe(80);
    });

    it('parses feature frame (>= 16 bytes)', () => {
      const adapter = makeAdapter();
      // First send weight
      const wBuf = Buffer.alloc(4);
      wBuf.writeUInt16LE(8000, 1);
      adapter.parseNotification(wBuf);

      // Then feature frame
      const fBuf = Buffer.alloc(16);
      fBuf.writeUInt16LE(225, 8); // fat = (225 & 0x0FFF) / 10 = 22.5%
      fBuf.writeUInt16LE(550, 10); // water = 55.0%
      fBuf.writeUInt16LE(400, 12); // muscle = 40.0%
      fBuf.writeUInt16LE(35, 14); // bone = 3.5 kg

      const reading = adapter.parseNotification(fBuf);
      expect(reading).not.toBeNull();
      expect(reading!.weight).toBe(80);
    });

    it('returns null for too-short buffer', () => {
      const adapter = makeAdapter();
      expect(adapter.parseNotification(Buffer.alloc(2))).toBeNull();
    });

    it('returns null when no weight received yet (feature frame first)', () => {
      const adapter = makeAdapter();
      const buf = Buffer.alloc(16);
      buf.writeUInt16LE(225, 8);
      expect(adapter.parseNotification(buf)).toBeNull();
    });
  });

  describe('isComplete()', () => {
    it('returns true when weight > 0 and cachedFat > 0', () => {
      const adapter = makeAdapter();

      // Weight frame
      const wBuf = Buffer.alloc(4);
      wBuf.writeUInt16LE(8000, 1);
      adapter.parseNotification(wBuf);

      // Feature frame
      const fBuf = Buffer.alloc(16);
      fBuf.writeUInt16LE(225, 8);
      fBuf.writeUInt16LE(550, 10);
      fBuf.writeUInt16LE(400, 12);
      fBuf.writeUInt16LE(35, 14);
      adapter.parseNotification(fBuf);

      expect(adapter.isComplete({ weight: 80, impedance: 0 })).toBe(true);
    });

    it('returns false when only weight received (no feature frame)', () => {
      const adapter = makeAdapter();

      const wBuf = Buffer.alloc(4);
      wBuf.writeUInt16LE(8000, 1);
      adapter.parseNotification(wBuf);

      expect(adapter.isComplete({ weight: 80, impedance: 0 })).toBe(false);
    });

    it('returns false when weight is 0', () => {
      const adapter = makeAdapter();
      expect(adapter.isComplete({ weight: 0, impedance: 0 })).toBe(false);
    });
  });

  describe('computeMetrics()', () => {
    it('returns valid GarminPayload with cached comp', () => {
      const adapter = makeAdapter();

      const wBuf = Buffer.alloc(4);
      wBuf.writeUInt16LE(8000, 1);
      adapter.parseNotification(wBuf);

      const fBuf = Buffer.alloc(16);
      fBuf.writeUInt16LE(225, 8);
      fBuf.writeUInt16LE(550, 10);
      fBuf.writeUInt16LE(400, 12);
      fBuf.writeUInt16LE(35, 14);
      adapter.parseNotification(fBuf);

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
