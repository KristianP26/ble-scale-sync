import { describe, it, expect, vi } from 'vitest';
import { ExingtechY1Adapter } from '../../src/scales/exingtech-y1.js';
import type { ConnectionContext } from '../../src/interfaces/scale-adapter.js';
import {
  mockPeripheral,
  defaultProfile,
  assertPayloadRanges,
} from '../helpers/scale-test-utils.js';

function makeAdapter() {
  return new ExingtechY1Adapter();
}

describe('ExingtechY1Adapter', () => {
  describe('matches()', () => {
    it('matches "vscale" name', () => {
      const adapter = makeAdapter();
      expect(adapter.matches(mockPeripheral('vscale'))).toBe(true);
    });

    it('matches by custom 128-bit service UUID', () => {
      const adapter = makeAdapter();
      expect(
        adapter.matches(mockPeripheral('Unknown', ['f433bd80-75b8-11e2-97d9-0002a5d5c51b'])),
      ).toBe(true);
    });

    it('matches case-insensitive', () => {
      const adapter = makeAdapter();
      expect(adapter.matches(mockPeripheral('VScale'))).toBe(true);
    });

    it('does not match unrelated name without service UUID', () => {
      const adapter = makeAdapter();
      expect(adapter.matches(mockPeripheral('Random Scale'))).toBe(false);
    });
  });

  describe('parseNotification()', () => {
    it('parses frame with body comp (complete, [6] != 0xFF)', () => {
      const adapter = makeAdapter();
      const buf = Buffer.alloc(15);
      buf.writeUInt16BE(800, 4); // weight = 800 / 10 = 80.0 kg
      buf.writeUInt16BE(225, 6); // fat = 22.5%
      buf.writeUInt16BE(550, 8); // water = 55.0%
      buf.writeUInt16BE(35, 10); // bone = 3.5 kg
      buf.writeUInt16BE(400, 12); // muscle = 40.0%
      buf[14] = 8; // visceral fat rating

      const reading = adapter.parseNotification(buf);
      expect(reading).not.toBeNull();
      expect(reading!.weight).toBe(80);
      expect(reading!.impedance).toBe(0);
    });

    it('parses incomplete frame ([6] == 0xFF)', () => {
      const adapter = makeAdapter();
      const buf = Buffer.alloc(15);
      buf.writeUInt16BE(800, 4);
      buf[6] = 0xff; // incomplete

      const reading = adapter.parseNotification(buf);
      expect(reading).not.toBeNull();
      expect(reading!.weight).toBe(80);
    });

    it('returns null for too-short buffer', () => {
      const adapter = makeAdapter();
      expect(adapter.parseNotification(Buffer.alloc(14))).toBeNull();
    });

    it('returns null when weight is zero', () => {
      const adapter = makeAdapter();
      const buf = Buffer.alloc(15);
      buf.writeUInt16BE(0, 4);
      expect(adapter.parseNotification(buf)).toBeNull();
    });
  });

  describe('isComplete()', () => {
    it('returns true when weight > 0 and cachedFat > 0', () => {
      const adapter = makeAdapter();
      const buf = Buffer.alloc(15);
      buf.writeUInt16BE(800, 4);
      buf.writeUInt16BE(225, 6); // fat = 22.5%
      buf.writeUInt16BE(550, 8);
      buf.writeUInt16BE(35, 10);
      buf.writeUInt16BE(400, 12);
      buf[14] = 8;
      adapter.parseNotification(buf);

      expect(adapter.isComplete({ weight: 80, impedance: 0 })).toBe(true);
    });

    it('returns false when fat is not set (incomplete frame)', () => {
      const adapter = makeAdapter();
      const buf = Buffer.alloc(15);
      buf.writeUInt16BE(800, 4);
      buf[6] = 0xff; // incomplete → fat = undefined
      adapter.parseNotification(buf);

      expect(adapter.isComplete({ weight: 80, impedance: 0 })).toBe(false);
    });

    it('returns false when weight is 0', () => {
      const adapter = makeAdapter();
      expect(adapter.isComplete({ weight: 0, impedance: 0 })).toBe(false);
    });
  });

  describe('onConnected()', () => {
    it('sends user config with real profile data', async () => {
      const adapter = makeAdapter();
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

      // [0x10, userId, sex, age, height]
      expect(data[0]).toBe(0x10);
      expect(data[1]).toBe(0x01); // userId
      expect(data[2]).toBe(0x00); // male
      expect(data[3]).toBe(30); // age
      expect(data[4]).toBe(183); // height
    });
  });

  describe('computeMetrics()', () => {
    it('returns valid GarminPayload with cached body comp', () => {
      const adapter = makeAdapter();
      const buf = Buffer.alloc(15);
      buf.writeUInt16BE(800, 4);
      buf.writeUInt16BE(225, 6);
      buf.writeUInt16BE(550, 8);
      buf.writeUInt16BE(35, 10);
      buf.writeUInt16BE(400, 12);
      buf[14] = 8;
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
