import { describe, it, expect, vi } from 'vitest';
import { HoffenAdapter } from '../../src/scales/hoffen.js';
import type { ConnectionContext } from '../../src/interfaces/scale-adapter.js';
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

  describe('onConnected()', () => {
    it('sends CMD_SEND_USER with real profile data', async () => {
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

      // [0xFA, 0x85, 0x03, gender, age, height, xor]
      expect(data[0]).toBe(0xfa);
      expect(data[1]).toBe(0x85);
      expect(data[2]).toBe(0x03);
      expect(data[3]).toBe(0x00); // male
      expect(data[4]).toBe(30); // age
      expect(data[5]).toBe(183); // height
      expect(data.length).toBe(7); // includes XOR checksum
    });

    it('sends female gender code for female profile', async () => {
      const adapter = makeAdapter();
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
      expect(data[3]).toBe(0x01); // female
      expect(data[4]).toBe(25);
      expect(data[5]).toBe(165);
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
