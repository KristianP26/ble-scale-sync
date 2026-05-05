import { describe, it, expect, vi } from 'vitest';
import { AdeA2Adapter } from '../../src/scales/ade-a2.js';
import type { ConnectionContext } from '../../src/interfaces/scale-adapter.js';
import { mockPeripheral, defaultProfile } from '../helpers/scale-test-utils.js';

function makeAdapter() {
  return new AdeA2Adapter();
}

function uuid16(code: number): string {
  return `0000${code.toString(16).padStart(4, '0')}00001000800000805f9b34fb`;
}

function ctxWithWrite(): { ctx: ConnectionContext; writeFn: ReturnType<typeof vi.fn> } {
  const writeFn = vi.fn().mockResolvedValue(undefined);
  const ctx: ConnectionContext = {
    write: writeFn,
    read: vi.fn(),
    subscribe: vi.fn(),
    profile: defaultProfile(),
    deviceAddress: '',
    availableChars: new Set<string>(),
  };
  return { ctx, writeFn };
}

describe('AdeA2Adapter (experimental scaffolding)', () => {
  describe('matches()', () => {
    it('always returns false until BLE name prefix is confirmed', () => {
      // The class ships disabled by default — see file-level JSDoc and #159.
      // This test guards the safety property: nothing else in the registry
      // can accidentally start matching real devices on the back of this
      // unfinished work.
      const adapter = makeAdapter();
      expect(adapter.matches(mockPeripheral('AnyName'))).toBe(false);
      expect(adapter.matches(mockPeripheral('01257B001122'))).toBe(false);
      expect(adapter.matches(mockPeripheral('ADE BA1400'))).toBe(false);
    });
  });

  describe('onConnected() time sync', () => {
    it('writes opcode 0x02 + 4-byte LE seconds-since-2010', async () => {
      const adapter = makeAdapter();
      const { ctx, writeFn } = ctxWithWrite();

      await adapter.onConnected(ctx);

      expect(writeFn).toHaveBeenCalledOnce();
      const [charUuid, data, withResponse] = writeFn.mock.calls[0];
      expect(charUuid).toBe(adapter.charWriteUuid);
      expect(withResponse).toBe(true);
      expect(data[0]).toBe(0x02);
      expect(data.length).toBe(5);

      const EPOCH_2010 = 1262304000;
      const expected = Math.floor(Date.now() / 1000) - EPOCH_2010;
      const ts = Buffer.from(data.slice(1)).readUInt32LE(0);
      expect(Math.abs(ts - expected)).toBeLessThan(5);
    });
  });

  describe('challenge-response (inherited from VBaseA2PairingProtocol)', () => {
    it('stores password and replies with XOR(challenge, password)', async () => {
      const adapter = makeAdapter();
      const { ctx, writeFn } = ctxWithWrite();
      await adapter.onConnected(ctx);
      writeFn.mockClear();

      const upload = uuid16(0x8a82);
      adapter.parseCharNotification(upload, Buffer.from([0xa0, 0x11, 0x22, 0x33]));
      adapter.parseCharNotification(upload, Buffer.from([0xa1, 0xaa, 0xbb, 0xcc]));

      expect(writeFn).toHaveBeenCalledOnce();
      const [, data] = writeFn.mock.calls[0];
      expect(data[0]).toBe(0xa1);
      expect(data[1]).toBe(0xaa ^ 0x11);
      expect(data[2]).toBe(0xbb ^ 0x22);
      expect(data[3]).toBe(0xcc ^ 0x33);
    });

    it('does nothing when challenge arrives before password', async () => {
      const adapter = makeAdapter();
      const { ctx, writeFn } = ctxWithWrite();
      await adapter.onConnected(ctx);
      writeFn.mockClear();

      const upload = uuid16(0x8a82);
      adapter.parseCharNotification(upload, Buffer.from([0xa1, 0xaa, 0xbb, 0xcc]));

      expect(writeFn).not.toHaveBeenCalled();
    });
  });

  describe('parseMeasurement', () => {
    it('returns null until the encoding is decoded against a real frame', () => {
      const adapter = makeAdapter();
      // Any synthetic input — placeholder parser must not fabricate readings.
      expect(adapter.parseNotification(Buffer.from([0x00, 0x10, 0x27, 0x00, 0xfe]))).toBeNull();
    });
  });
});
