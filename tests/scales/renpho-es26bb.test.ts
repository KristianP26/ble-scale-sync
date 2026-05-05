import { describe, it, expect, vi } from 'vitest';
import { RenphoEs26bbAdapter } from '../../src/scales/renpho-es26bb.js';
import type { ConnectionContext } from '../../src/interfaces/scale-adapter.js';
import {
  mockPeripheral,
  defaultProfile,
  assertPayloadRanges,
} from '../helpers/scale-test-utils.js';

function makeAdapter() {
  return new RenphoEs26bbAdapter();
}

/** Append sum-checksum to a buffer at its last byte. */
function withChecksum(buf: Buffer): Buffer {
  let sum = 0;
  for (let i = 0; i < buf.length - 1; i++) sum = (sum + buf[i]) & 0xff;
  buf[buf.length - 1] = sum;
  return buf;
}

/** Build a valid live (0x14) final-frame: 12 bytes, type 0x01, weight & impedance, trailing checksum. */
function makeLiveFrame(weightX100: number, impedance: number, type = 0x01): Buffer {
  const buf = Buffer.alloc(13);
  buf[2] = 0x14;
  buf[5] = type;
  buf.writeUInt32BE(weightX100, 6);
  buf.writeUInt16BE(impedance, 10);
  return withChecksum(buf);
}

/** Build a valid offline (0x15) frame: 16 bytes incl. checksum, weight & impedance & secondsAgo. */
function makeOfflineFrame(weightX100: number, impedance: number, secondsAgo = 0): Buffer {
  const buf = Buffer.alloc(16);
  buf[2] = 0x15;
  buf.writeUInt32BE(weightX100, 5);
  buf.writeUInt16BE(impedance, 9);
  buf.writeUInt32BE(secondsAgo, 11);
  return withChecksum(buf);
}

function makeMockCtx(): { ctx: ConnectionContext; write: ReturnType<typeof vi.fn> } {
  const write = vi.fn().mockResolvedValue(undefined);
  return {
    ctx: {
      write,
      read: vi.fn().mockResolvedValue(Buffer.alloc(0)),
      subscribe: vi.fn().mockResolvedValue(undefined),
      profile: defaultProfile(),
      deviceAddress: 'AA:BB:CC:DD:EE:FF',
    },
    write,
  };
}

describe('RenphoEs26bbAdapter', () => {
  describe('matches()', () => {
    it('matches "es-26bb-b" exact', () => {
      expect(makeAdapter().matches(mockPeripheral('es-26bb-b'))).toBe(true);
    });

    it('matches case-insensitive', () => {
      expect(makeAdapter().matches(mockPeripheral('ES-26BB-B'))).toBe(true);
    });

    it('does not match "es-26bb" without "-b"', () => {
      expect(makeAdapter().matches(mockPeripheral('es-26bb'))).toBe(false);
    });

    it('does not match unrelated name', () => {
      expect(makeAdapter().matches(mockPeripheral('Random Scale'))).toBe(false);
    });
  });

  describe('parseNotification()', () => {
    it('parses 0x14 final live frame (type 0x01)', () => {
      const reading = makeAdapter().parseNotification(makeLiveFrame(8000, 500, 0x01));
      expect(reading).toEqual({ weight: 80, impedance: 500 });
    });

    it('parses 0x14 final live frame (type 0x11)', () => {
      const reading = makeAdapter().parseNotification(makeLiveFrame(7500, 480, 0x11));
      expect(reading).toEqual({ weight: 75, impedance: 480 });
    });

    it('drops 0x14 non-final live frame', () => {
      const reading = makeAdapter().parseNotification(makeLiveFrame(8000, 500, 0x00));
      expect(reading).toBeNull();
    });

    it('parses 0x15 offline frame', () => {
      const reading = makeAdapter().parseNotification(makeOfflineFrame(7500, 480, 3600));
      expect(reading).toEqual({ weight: 75, impedance: 480 });
    });

    it('drops frame with invalid checksum', () => {
      const buf = makeLiveFrame(8000, 500);
      buf[buf.length - 1] = 0x00; // corrupt checksum
      expect(makeAdapter().parseNotification(buf)).toBeNull();
    });

    it('returns null for unknown action', () => {
      const buf = Buffer.alloc(12);
      buf[2] = 0x20;
      withChecksum(buf);
      expect(makeAdapter().parseNotification(buf)).toBeNull();
    });

    it('returns null for too-short buffer', () => {
      expect(makeAdapter().parseNotification(Buffer.alloc(5))).toBeNull();
    });

    it('returns null when weight is zero on live frame', () => {
      expect(makeAdapter().parseNotification(makeLiveFrame(0, 500))).toBeNull();
    });

    it('returns null when weight is zero on offline frame', () => {
      expect(makeAdapter().parseNotification(makeOfflineFrame(0, 480))).toBeNull();
    });
  });

  describe('onConnected() + offline ack', () => {
    it('sends START_CMD on connect via control char', async () => {
      const adapter = makeAdapter();
      const { ctx, write } = makeMockCtx();
      await adapter.onConnected(ctx);
      expect(write).toHaveBeenCalledTimes(1);
      const [charUuid, data, withResponse] = write.mock.calls[0];
      expect(charUuid).toBe(adapter.charWriteUuid);
      expect(Array.from(data as number[])).toEqual([
        0x55, 0xaa, 0x90, 0x00, 0x04, 0x01, 0x00, 0x00, 0x00, 0x94,
      ]);
      expect(withResponse).toBe(false);
    });

    it('fires offline ack when 0x15 frame is parsed', async () => {
      const adapter = makeAdapter();
      const { ctx, write } = makeMockCtx();
      await adapter.onConnected(ctx);
      write.mockClear();

      const reading = adapter.parseNotification(makeOfflineFrame(7500, 480, 60));
      expect(reading).toEqual({ weight: 75, impedance: 480 });

      // Ack is fire-and-forget; flush microtasks.
      await Promise.resolve();
      expect(write).toHaveBeenCalledTimes(1);
      const [charUuid, data, withResponse] = write.mock.calls[0];
      expect(charUuid).toBe(adapter.charWriteUuid);
      expect(Array.from(data as number[])).toEqual([0x55, 0xaa, 0x95, 0x00, 0x01, 0x01, 0x96]);
      expect(withResponse).toBe(true);
    });

    it('does NOT fire ack on 0x14 live frame', async () => {
      const adapter = makeAdapter();
      const { ctx, write } = makeMockCtx();
      await adapter.onConnected(ctx);
      write.mockClear();

      adapter.parseNotification(makeLiveFrame(8000, 500));
      await Promise.resolve();
      expect(write).not.toHaveBeenCalled();
    });

    it('survives ack write failure without throwing', async () => {
      const adapter = makeAdapter();
      const write = vi.fn().mockRejectedValue(new Error('disconnected'));
      const ctx: ConnectionContext = {
        write,
        read: vi.fn().mockResolvedValue(Buffer.alloc(0)),
        subscribe: vi.fn().mockResolvedValue(undefined),
        profile: defaultProfile(),
        deviceAddress: 'AA:BB:CC:DD:EE:FF',
      };
      // First call (start cmd) also rejects but onConnected swallows it.
      await expect(adapter.onConnected(ctx)).resolves.toBeUndefined();
      write.mockClear();

      const reading = adapter.parseNotification(makeOfflineFrame(7500, 480));
      expect(reading).toEqual({ weight: 75, impedance: 480 });
      await Promise.resolve();
      await Promise.resolve();
      expect(write).toHaveBeenCalledTimes(1);
    });

    it('does not write ack when no ctx (parser called without onConnected)', async () => {
      const adapter = makeAdapter();
      // parseNotification before onConnected — must not throw, must return reading.
      const reading = adapter.parseNotification(makeOfflineFrame(7500, 480));
      expect(reading).toEqual({ weight: 75, impedance: 480 });
    });
  });

  describe('isComplete()', () => {
    it('returns true when weight > 10 and impedance > 0', () => {
      expect(makeAdapter().isComplete({ weight: 80, impedance: 500 })).toBe(true);
    });

    it('returns false when weight <= 10', () => {
      expect(makeAdapter().isComplete({ weight: 10, impedance: 500 })).toBe(false);
    });

    it('returns false when impedance is 0', () => {
      expect(makeAdapter().isComplete({ weight: 80, impedance: 0 })).toBe(false);
    });
  });

  describe('computeMetrics()', () => {
    it('returns valid BodyComposition', () => {
      const payload = makeAdapter().computeMetrics(
        { weight: 80, impedance: 500 },
        defaultProfile(),
      );
      expect(payload.weight).toBe(80);
      expect(payload.impedance).toBe(500);
      assertPayloadRanges(payload);
    });

    it('returns zero weight in payload for zero weight input', () => {
      const payload = makeAdapter().computeMetrics({ weight: 0, impedance: 0 }, defaultProfile());
      expect(payload.weight).toBe(0);
    });
  });
});
