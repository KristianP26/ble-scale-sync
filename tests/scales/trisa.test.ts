import { describe, it, expect, vi } from 'vitest';
import { TrisaAdapter } from '../../src/scales/trisa.js';
import type { ConnectionContext } from '../../src/interfaces/scale-adapter.js';
import {
  mockPeripheral,
  defaultProfile,
  assertPayloadRanges,
} from '../helpers/scale-test-utils.js';

function makeAdapter() {
  return new TrisaAdapter();
}

function uuid16(code: number): string {
  return `0000${code.toString(16).padStart(4, '0')}00001000800000805f9b34fb`;
}

const TRISA_CHARS = new Set<string>([uuid16(0x8a21), uuid16(0x8a82), uuid16(0x8a81)]);

// 0x8A20 is exposed by ADE BA 1600 firmware but the adapter does not bind to
// it. Included here so the test ctx mirrors what the real scale advertises
// post-discovery.
const ADE_CHARS = new Set<string>([
  uuid16(0x8a24),
  uuid16(0x8a22),
  uuid16(0x8a20),
  uuid16(0x8a82),
  uuid16(0x8a81),
]);

function ctxWithChars(
  available: ReadonlySet<string>,
  writeFn = vi.fn().mockResolvedValue(undefined),
): { ctx: ConnectionContext; writeFn: ReturnType<typeof vi.fn> } {
  const ctx: ConnectionContext = {
    write: writeFn,
    read: vi.fn(),
    subscribe: vi.fn(),
    profile: defaultProfile(),
    deviceAddress: '',
    availableChars: available,
  };
  return { ctx, writeFn };
}

/**
 * Encode weight as base-10 float: 24-bit LE mantissa + int8 exponent.
 * weight = mantissa * 10^exponent
 */
function encodeFloat(mantissa: number, exponent: number): Buffer {
  const buf = Buffer.alloc(4);
  buf[0] = mantissa & 0xff;
  buf[1] = (mantissa >> 8) & 0xff;
  buf[2] = (mantissa >> 16) & 0xff;
  buf.writeInt8(exponent, 3);
  return buf;
}

describe('TrisaAdapter', () => {
  describe('matches()', () => {
    it('matches "01257B..." prefix', () => {
      const adapter = makeAdapter();
      expect(adapter.matches(mockPeripheral('01257B001122'))).toBe(true);
    });

    it('matches "11257B..." prefix', () => {
      const adapter = makeAdapter();
      expect(adapter.matches(mockPeripheral('11257BAABBCC'))).toBe(true);
    });

    it('matches case-insensitive', () => {
      const adapter = makeAdapter();
      expect(adapter.matches(mockPeripheral('01257b001122'))).toBe(true);
      expect(adapter.matches(mockPeripheral('11257b001122'))).toBe(true);
    });

    it('does not match "01257A..."', () => {
      const adapter = makeAdapter();
      expect(adapter.matches(mockPeripheral('01257A001122'))).toBe(false);
    });

    it('does not match unrelated name', () => {
      const adapter = makeAdapter();
      expect(adapter.matches(mockPeripheral('Random Scale'))).toBe(false);
    });
  });

  describe('onConnected()', () => {
    it('saves writeFn and sends time sync + broadcast (Trisa variant)', async () => {
      const adapter = makeAdapter();
      const { ctx, writeFn } = ctxWithChars(TRISA_CHARS);

      await adapter.onConnected!(ctx);

      // Should have 2 writes: time sync + broadcast
      expect(writeFn).toHaveBeenCalledTimes(2);

      // Call 1: time sync, opcode 0x02 + 4-byte LE timestamp
      const [charUuid1, data1, withResponse1] = writeFn.mock.calls[0];
      expect(charUuid1).toBe(adapter.charWriteUuid); // CHR_DOWNLOAD
      expect(withResponse1).toBe(true);
      expect(data1[0]).toBe(0x02);
      expect(data1.length).toBe(5);
      // Verify timestamp is roughly correct (seconds since 2010-01-01)
      const EPOCH_2010 = 1262304000;
      const expectedTs = Math.floor(Date.now() / 1000) - EPOCH_2010;
      const tsFromCmd = Buffer.from(data1.slice(1)).readUInt32LE(0);
      expect(Math.abs(tsFromCmd - expectedTs)).toBeLessThan(5);

      // Call 2: broadcast ID, Trisa uses 0x21
      const [charUuid2, data2, withResponse2] = writeFn.mock.calls[1];
      expect(charUuid2).toBe(adapter.charWriteUuid);
      expect(withResponse2).toBe(true);
      expect(data2).toEqual([0x21]);
    });

    it('uses 0x22 broadcast opcode on ADE variant', async () => {
      const adapter = makeAdapter();
      const { ctx, writeFn } = ctxWithChars(ADE_CHARS);

      await adapter.onConnected!(ctx);

      expect(writeFn).toHaveBeenCalledTimes(2);
      const [, data2] = writeFn.mock.calls[1];
      expect(data2).toEqual([0x22]);
    });

    it('writeFn is available for challenge-response after onConnected', async () => {
      const adapter = makeAdapter();
      const { ctx, writeFn } = ctxWithChars(TRISA_CHARS);

      await adapter.onConnected!(ctx);
      writeFn.mockClear();

      const uploadUuid = uuid16(0x8a82);

      // Password
      adapter.parseCharNotification!(uploadUuid, Buffer.from([0xa0, 0x11]));
      // Challenge
      adapter.parseCharNotification!(uploadUuid, Buffer.from([0xa1, 0xaa]));

      // Verify challenge-response still works
      expect(writeFn).toHaveBeenCalledOnce();
    });

    it('throws when neither 0x8A21 nor 0x8A24 is discovered (GATT race guard)', async () => {
      const adapter = makeAdapter();
      // Upload + download present but no measurement char: what a transient
      // GATT discovery race (BlueZ ServicesResolved firing early or noble
      // equivalent on Windows/macOS) could produce.
      const partial = new Set<string>([uuid16(0x8a82), uuid16(0x8a81)]);
      const { ctx } = ctxWithChars(partial);

      await expect(adapter.onConnected!(ctx)).rejects.toThrow(/measurement characteristic/i);
    });
  });

  describe('parseNotification()', () => {
    it('parses weight-only frame (no optional fields)', () => {
      const adapter = makeAdapter();
      const flags = 0x00; // no timestamp, no r1, no r2
      const weightFloat = encodeFloat(8000, -2); // 8000 * 10^-2 = 80.0 kg
      const buf = Buffer.concat([Buffer.from([flags]), weightFloat]);

      const reading = adapter.parseNotification(buf);
      expect(reading).not.toBeNull();
      expect(reading!.weight).toBeCloseTo(80, 1);
      expect(reading!.impedance).toBe(0);
    });

    it('parses frame with timestamp + r1 + r2 (r2 >= 410)', () => {
      const adapter = makeAdapter();
      const flags = 0x07; // all: timestamp, r1, r2
      const weightFloat = encodeFloat(8000, -2); // 80.0 kg
      const timestamp = Buffer.alloc(7);
      const r1Float = encodeFloat(5000, -1); // r1 = 500.0
      const r2Float = encodeFloat(5000, -1); // r2 = 500.0 → >= 410 → 0.3*(500-400) = 30.0

      const buf = Buffer.concat([Buffer.from([flags]), weightFloat, timestamp, r1Float, r2Float]);

      const reading = adapter.parseNotification(buf);
      expect(reading).not.toBeNull();
      expect(reading!.weight).toBeCloseTo(80, 1);
      expect(reading!.impedance).toBeCloseTo(30, 1);
    });

    it('parses frame with r2 < 410 → impedance = 3.0', () => {
      const adapter = makeAdapter();
      const flags = 0x04; // only r2 (no timestamp, no r1)
      const weightFloat = encodeFloat(8000, -2); // 80.0 kg
      const r2Float = encodeFloat(4000, -1); // r2 = 400.0 → < 410 → impedance = 3.0

      const buf = Buffer.concat([Buffer.from([flags]), weightFloat, r2Float]);

      const reading = adapter.parseNotification(buf);
      expect(reading).not.toBeNull();
      expect(reading!.impedance).toBe(3.0);
    });

    it('returns null for too-short buffer', () => {
      const adapter = makeAdapter();
      expect(adapter.parseNotification(Buffer.alloc(4))).toBeNull();
    });

    it('returns null for timestamp-only frame with zero mantissa', () => {
      const adapter = makeAdapter();
      const flags = 0x01; // only timestamp
      const weightFloat = encodeFloat(0, 0); // mantissa = 0
      const timestamp = Buffer.alloc(7);

      const buf = Buffer.concat([Buffer.from([flags]), weightFloat, timestamp]);
      expect(adapter.parseNotification(buf)).toBeNull();
    });
  });

  describe('characteristics', () => {
    it('declares Trisa + ADE chars with optional flags for variant detection', () => {
      const adapter = makeAdapter();
      expect(adapter.characteristics).toHaveLength(5);
      const meas21 = adapter.characteristics!.find((c) => c.uuid === uuid16(0x8a21));
      const meas24 = adapter.characteristics!.find((c) => c.uuid === uuid16(0x8a24));
      const bodyComp22 = adapter.characteristics!.find((c) => c.uuid === uuid16(0x8a22));
      const upload = adapter.characteristics!.find((c) => c.uuid === uuid16(0x8a82));
      const download = adapter.characteristics!.find((c) => c.uuid === uuid16(0x8a81));

      // Variant-specific chars must be optional
      expect(meas21?.optional).toBe(true);
      expect(meas24?.optional).toBe(true);
      expect(bodyComp22?.optional).toBe(true);
      // Shared chars are required
      expect(upload?.optional).toBeFalsy();
      expect(download?.optional).toBeFalsy();
      expect(upload?.type).toBe('notify');
      expect(download?.type).toBe('write');
    });
  });

  describe('challenge-response', () => {
    it('stores password and responds to challenge with XOR (Trisa variant)', async () => {
      const adapter = makeAdapter();
      const { ctx, writeFn } = ctxWithChars(TRISA_CHARS);
      await adapter.onConnected!(ctx);
      writeFn.mockClear(); // Clear the time sync + broadcast writes

      const uploadUuid = uuid16(0x8a82);

      // Step 1: Scale sends password on upload channel
      const password = Buffer.from([0xa0, 0x11, 0x22, 0x33]);
      adapter.parseCharNotification!(uploadUuid, password);

      // Step 2: Scale sends challenge on upload channel
      const challenge = Buffer.from([0xa1, 0xaa, 0xbb, 0xcc]);
      adapter.parseCharNotification!(uploadUuid, challenge);

      // Verify response was written
      expect(writeFn).toHaveBeenCalledOnce();
      const [charUuid, data, withResponse] = writeFn.mock.calls[0];
      expect(charUuid).toBe(uuid16(0x8a81));

      // Response = [0xA1, XOR(challenge, password)]
      expect(data[0]).toBe(0xa1);
      expect(data[1]).toBe(0xaa ^ 0x11);
      expect(data[2]).toBe(0xbb ^ 0x22);
      expect(data[3]).toBe(0xcc ^ 0x33);
      expect(withResponse).toBe(true);
    });

    it('echoes challenge bytes with opcode 0x20 on ADE variant', async () => {
      // fitvigo's BE1615 protocol replies with [0x20, LE32(savedPassword XOR
      // challengeInt)]. Because no 0xA0 password frame ever arrives on ADE,
      // savedPassword stays at zero and the response is just an echo of the
      // four challenge bytes with the opcode swapped from 0xA1 to 0x20.
      const adapter = makeAdapter();
      const { ctx, writeFn } = ctxWithChars(ADE_CHARS);
      await adapter.onConnected!(ctx);
      writeFn.mockClear();

      const uploadUuid = uuid16(0x8a82);
      // Reproduces the challenge captured in #138 (sttehh).
      adapter.parseCharNotification!(uploadUuid, Buffer.from([0xa1, 0x01, 0x00, 0xb8, 0x99]));

      expect(writeFn).toHaveBeenCalledOnce();
      const [charUuid, data, withResponse] = writeFn.mock.calls[0];
      expect(charUuid).toBe(uuid16(0x8a81));
      expect(Array.from(data as Buffer)).toEqual([0x20, 0x01, 0x00, 0xb8, 0x99]);
      expect(withResponse).toBe(true);
    });

    it('ignores ADE upload frames that are not 0xA1 challenges', async () => {
      const adapter = makeAdapter();
      const { ctx, writeFn } = ctxWithChars(ADE_CHARS);
      await adapter.onConnected!(ctx);
      writeFn.mockClear();

      const uploadUuid = uuid16(0x8a82);
      adapter.parseCharNotification!(uploadUuid, Buffer.from([0xa0, 0x11, 0x22, 0x33, 0x44]));

      expect(writeFn).not.toHaveBeenCalled();
    });

    it('ignores truncated ADE challenge frames', async () => {
      const adapter = makeAdapter();
      const { ctx, writeFn } = ctxWithChars(ADE_CHARS);
      await adapter.onConnected!(ctx);
      writeFn.mockClear();

      const uploadUuid = uuid16(0x8a82);
      // Only opcode + 3 bytes; algorithm needs 4.
      adapter.parseCharNotification!(uploadUuid, Buffer.from([0xa1, 0x01, 0x02, 0x03]));

      expect(writeFn).not.toHaveBeenCalled();
    });

    it('dispatches Trisa measurement (0x8A21) via parseCharNotification', () => {
      const adapter = makeAdapter();
      const flags = 0x00;
      const weightFloat = encodeFloat(8000, -2);
      const buf = Buffer.concat([Buffer.from([flags]), weightFloat]);

      const reading = adapter.parseCharNotification!(uuid16(0x8a21), buf);
      expect(reading).not.toBeNull();
      expect(reading!.weight).toBeCloseTo(80, 1);
    });

    it('dispatches ADE measurement (0x8A24) via parseCharNotification', () => {
      const adapter = makeAdapter();
      // Real frame from ADE BA 1600 capture (issue #138):
      // 1f 68 1f 00 fe ... → flags=0x1f, mantissa=0x001f68=8040, exp=-2 → 80.40 kg
      const buf = Buffer.from('1f681f00fe652ab21e000000006a1500ff011900', 'hex');

      const reading = adapter.parseCharNotification!(uuid16(0x8a24), buf);
      expect(reading).not.toBeNull();
      expect(reading!.weight).toBeCloseTo(80.4, 1);
    });

    it('returns null and only logs for ADE body-comp char (0x8A22)', () => {
      const adapter = makeAdapter();
      const buf = Buffer.from('6d652ab21e01caf07af252f11cf0', 'hex');
      expect(adapter.parseCharNotification!(uuid16(0x8a22), buf)).toBeNull();
    });

    it('returns impedance=0 on ADE measurement even when r2 flag is set', async () => {
      const adapter = makeAdapter();
      // Force variant=ade so the parser must skip the resistance walk.
      const { ctx } = ctxWithChars(ADE_CHARS);
      await adapter.onConnected!(ctx);

      // Frame would compute impedance=30 on Trisa (r2 = 500.0 → 0.3*(500-400)).
      // ADE branch must short-circuit to impedance=0 regardless of r2 flag.
      const flags = 0x04; // r2 only
      const weightFloat = encodeFloat(8000, -2); // 80.0 kg
      const r2Float = encodeFloat(5000, -1); // r2 = 500
      const buf = Buffer.concat([Buffer.from([flags]), weightFloat, r2Float]);

      const reading = adapter.parseCharNotification!(uuid16(0x8a24), buf);
      expect(reading).not.toBeNull();
      expect(reading!.weight).toBeCloseTo(80, 1);
      expect(reading!.impedance).toBe(0);
    });

    it('returns null for upload channel notifications', () => {
      const adapter = makeAdapter();
      const data = Buffer.from([0xa0, 0x11, 0x22]);
      expect(adapter.parseCharNotification!(uuid16(0x8a82), data)).toBeNull();
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
    it('returns valid BodyComposition', () => {
      const adapter = makeAdapter();
      const profile = defaultProfile();
      const payload = adapter.computeMetrics({ weight: 80, impedance: 30 }, profile);
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
