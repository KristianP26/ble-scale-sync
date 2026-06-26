import { describe, it, expect, vi } from 'vitest';
import { RenphoMsc04Adapter } from '../../src/scales/renpho-msc04.js';
import type { ConnectionContext } from '../../src/interfaces/scale-adapter.js';
import {
  mockPeripheral,
  defaultProfile,
  assertPayloadRanges,
} from '../helpers/scale-test-utils.js';

function makeAdapter() {
  return new RenphoMsc04Adapter();
}

/** Build a well-formed 55-AA checksum (sum of all bytes before last & 0xFF). */
function applyChecksum(buf: Buffer): Buffer {
  let sum = 0;
  for (let i = 0; i < buf.length - 1; i++) sum = (sum + buf[i]) & 0xff;
  buf[buf.length - 1] = sum;
  return buf;
}

/**
 * Build a valid R-MSC04 measurement frame.
 *
 * @param weightX100  weight × 100 (e.g. 7805 for 78.05 kg)
 * @param impedanceX10 raw BIA impedance × 10 (e.g. 1813 for 181.3 Ω)
 * @param cmd  0x25 (short) or 0x26 (long)
 * @param overrides  optional per-field overrides (LE uint16 × 100 for pct fields)
 */
function makeMeasFrame(
  weightX100: number,
  impedanceX10: number,
  cmd = 0x25,
  overrides: {
    bodyFatX100?: number;
    bmiX100?: number;
    skelMuscleX10?: number; // LE uint16
    boneMassX100?: number; // BE uint16
    visceralFat?: number;
  } = {},
): Buffer {
  const bodyStart = cmd === 0x26 ? 8 : 4;
  const payloadLen = cmd === 0x26 ? 40 : 36;

  const payload = Buffer.alloc(payloadLen, 0);

  // user_id = 1, seq = 0
  payload[0] = 0x01;

  // body fields
  payload.writeUInt16BE(weightX100, bodyStart + 0);
  payload[bodyStart + 2] = 0x0a; // padding
  payload.writeUInt16LE(impedanceX10, bodyStart + 8);
  payload.writeUInt16LE(overrides.bodyFatX100 ?? 1967, bodyStart + 10);
  payload.writeUInt16LE(overrides.bmiX100 ?? 2406, bodyStart + 14);
  payload.writeUInt16LE(overrides.skelMuscleX10 ?? 428, bodyStart + 22);
  payload.writeUInt16BE(overrides.boneMassX100 ?? 190, bodyStart + 24);
  payload[payloadLen - 1] = overrides.visceralFat ?? 5;

  // Full frame: 55 AA cmd 00 payloadLen payload checksum
  const frame = Buffer.alloc(5 + payloadLen + 1);
  frame[0] = 0x55;
  frame[1] = 0xaa;
  frame[2] = cmd;
  frame[3] = 0x00;
  frame[4] = payloadLen;
  payload.copy(frame, 5);
  return applyChecksum(frame);
}

function makeMockCtx(): { ctx: ConnectionContext; write: ReturnType<typeof vi.fn> } {
  const write = vi.fn().mockResolvedValue(undefined);
  return {
    ctx: {
      write,
      read: vi.fn().mockResolvedValue(Buffer.alloc(0)),
      subscribe: vi.fn().mockResolvedValue(undefined),
      profile: defaultProfile(),
      deviceAddress: '60:30:F2:73:6A:7B',
      availableChars: new Set<string>(),
    } satisfies ConnectionContext,
    write,
  };
}

// Real captured bytes from R-MSC04 HCI trace (session 5, cmd 0x25):
// weight=78.05 kg, fat=19.67%, muscle=42.8 kg, bone=1.90 kg, visceral=5
const REAL_FRAME_S5 = Buffer.from(
  '55aa2500240511000 01e7d0a0085 0a0b0a1507af077800660903090106d906ac0100be010b01ce00059d'.replace(
    /\s/g,
    '',
  ),
  'hex',
);

// Real captured bytes (session 1, cmd 0x26):
// weight=78.80 kg, fat=19.88%, muscle=44.0 kg, bone=1.94 kg, visceral=5
const REAL_FRAME_S1 = Buffer.from(
  '55aa260028011100188 8c600001ec80a0084 09eb0a1207c407860066 08ec08fd06e206b80100c2010d01cb000548'.replace(
    /\s/g,
    '',
  ),
  'hex',
);

describe('RenphoMsc04Adapter', () => {
  // ─── matches() ────────────────────────────────────────────────────────────

  describe('matches()', () => {
    it('matches exact name "r-msc04" (lower)', () => {
      expect(makeAdapter().matches(mockPeripheral('r-msc04'))).toBe(true);
    });

    it('matches case-insensitive name', () => {
      expect(makeAdapter().matches(mockPeripheral('R-MSC04'))).toBe(true);
    });

    it('matches by manufacturer id 0x1A10 when no name', () => {
      expect(
        makeAdapter().matches({
          localName: '',
          serviceUuids: [],
          manufacturerData: { id: 0x1a10, data: Buffer.alloc(0) },
        }),
      ).toBe(true);
    });

    it('does not match unrelated name', () => {
      expect(makeAdapter().matches(mockPeripheral('es-26bb-b'))).toBe(false);
    });

    it('does not match wrong manufacturer id', () => {
      expect(
        makeAdapter().matches({
          localName: '',
          serviceUuids: [],
          manufacturerData: { id: 0x004c, data: Buffer.alloc(0) },
        }),
      ).toBe(false);
    });
  });

  // ─── parseNotification() — synthetic frames ────────────────────────────────

  describe('parseNotification() — cmd 0x25 (short form)', () => {
    it('parses weight and impedance', () => {
      const frame = makeMeasFrame(7805, 1813, 0x25);
      const r = makeAdapter().parseNotification(frame);
      expect(r).not.toBeNull();
      expect(r!.weight).toBeCloseTo(78.05, 2);
      expect(r!.impedance).toBeCloseTo(181.3, 1);
    });

    it('returns null for invalid checksum', () => {
      const frame = makeMeasFrame(7805, 1813, 0x25);
      frame[frame.length - 1] ^= 0xff; // corrupt
      expect(makeAdapter().parseNotification(frame)).toBeNull();
    });

    it('returns null when weight is zero', () => {
      expect(makeAdapter().parseNotification(makeMeasFrame(0, 1813))).toBeNull();
    });

    it('returns null for too-short buffer', () => {
      expect(makeAdapter().parseNotification(Buffer.alloc(10))).toBeNull();
    });

    it('returns null for wrong magic bytes', () => {
      const frame = makeMeasFrame(7805, 1813);
      frame[0] = 0x00;
      expect(makeAdapter().parseNotification(frame)).toBeNull();
    });

    it('returns null for unrelated 55-AA command (e.g. status 0x90)', () => {
      const buf = Buffer.alloc(12, 0);
      buf[0] = 0x55;
      buf[1] = 0xaa;
      buf[2] = 0x90; // start response, not a measurement
      buf[4] = 6;
      applyChecksum(buf);
      expect(makeAdapter().parseNotification(buf)).toBeNull();
    });
  });

  describe('parseNotification() — cmd 0x26 (long form)', () => {
    it('parses weight and impedance', () => {
      const frame = makeMeasFrame(7880, 1810, 0x26);
      const r = makeAdapter().parseNotification(frame);
      expect(r).not.toBeNull();
      expect(r!.weight).toBeCloseTo(78.8, 2);
      expect(r!.impedance).toBeCloseTo(181.0, 1);
    });
  });

  // ─── real captured frames ─────────────────────────────────────────────────

  describe('parseNotification() — real captured frames', () => {
    it('decodes session-5 frame (cmd 0x25, 78.05 kg)', () => {
      const r = makeAdapter().parseNotification(REAL_FRAME_S5);
      expect(r).not.toBeNull();
      expect(r!.weight).toBeCloseTo(78.05, 2);
      expect(r!.impedance).toBeCloseTo(181.3, 1);
    });

    it('decodes session-1 frame (cmd 0x26, 78.80 kg)', () => {
      const r = makeAdapter().parseNotification(REAL_FRAME_S1);
      expect(r).not.toBeNull();
      expect(r!.weight).toBeCloseTo(78.8, 2);
      expect(r!.impedance).toBeCloseTo(181.0, 1);
    });
  });

  // ─── offline ack ─────────────────────────────────────────────────────────

  describe('offline ack', () => {
    it('sends ack after parsing a measurement frame', async () => {
      const adapter = makeAdapter();
      const { ctx, write } = makeMockCtx();
      await adapter.onConnected(ctx);
      write.mockClear();

      const r = adapter.parseNotification(makeMeasFrame(7805, 1813));
      expect(r).not.toBeNull();

      await Promise.resolve();
      expect(write).toHaveBeenCalledTimes(1);
      const [, data, withResponse] = write.mock.calls[0];
      expect(Array.from(data as number[])).toEqual([0x55, 0xaa, 0x95, 0x00, 0x01, 0x01, 0x96]);
      expect(withResponse).toBe(true);
    });

    it('does not throw when ack write fails', async () => {
      const adapter = makeAdapter();
      const write = vi.fn().mockRejectedValue(new Error('disconnected'));
      const ctx: ConnectionContext = {
        write,
        read: vi.fn().mockResolvedValue(Buffer.alloc(0)),
        subscribe: vi.fn().mockResolvedValue(undefined),
        profile: defaultProfile(),
        deviceAddress: '60:30:F2:73:6A:7B',
        availableChars: new Set<string>(),
      };
      await adapter.onConnected(ctx).catch(() => {});
      write.mockClear();
      adapter.parseNotification(makeMeasFrame(7805, 1813));
      await Promise.resolve();
      await Promise.resolve();
      // Should not throw even though write rejected
    });

    it('does not ack when no ctx (parser called before onConnected)', async () => {
      const adapter = makeAdapter();
      const r = adapter.parseNotification(makeMeasFrame(7805, 1813));
      expect(r).not.toBeNull();
      // No ctx → no write; just ensure it does not throw
    });
  });

  // ─── onConnected() ────────────────────────────────────────────────────────

  describe('onConnected()', () => {
    it('sends START_CMD to control characteristic', async () => {
      const adapter = makeAdapter();
      const { ctx, write } = makeMockCtx();
      await adapter.onConnected(ctx);

      const startCall = write.mock.calls.find(([uuid]) => uuid === adapter.charWriteUuid);
      expect(startCall).toBeDefined();
      expect(Array.from(startCall![1] as number[])).toEqual([
        0x55, 0xaa, 0x90, 0x00, 0x04, 0x01, 0x00, 0x00, 0x00, 0x94,
      ]);
      expect(startCall![2]).toBe(false); // write without response
    });

    it('survives start-cmd write failure without throwing', async () => {
      const adapter = makeAdapter();
      const ctx: ConnectionContext = {
        write: vi.fn().mockRejectedValue(new Error('timeout')),
        read: vi.fn().mockResolvedValue(Buffer.alloc(0)),
        subscribe: vi.fn().mockResolvedValue(undefined),
        profile: defaultProfile(),
        deviceAddress: '60:30:F2:73:6A:7B',
        availableChars: new Set<string>(),
      };
      await expect(adapter.onConnected(ctx)).resolves.toBeUndefined();
    });

    it('subscribes to status char when available', async () => {
      const adapter = makeAdapter();
      const subscribe = vi.fn().mockResolvedValue(undefined);
      const statusNorm = adapter.charNotifyUuid; // just for ref; we set the set manually
      const statusCharNorm = '00002a1000001000800000805f9b34fb'; // uuid16(0x2a10) normalised
      const ctx: ConnectionContext = {
        write: vi.fn().mockResolvedValue(undefined),
        read: vi.fn().mockResolvedValue(Buffer.alloc(0)),
        subscribe,
        profile: defaultProfile(),
        deviceAddress: '60:30:F2:73:6A:7B',
        availableChars: new Set<string>([statusCharNorm]),
      };
      await adapter.onConnected(ctx);
      expect(subscribe).toHaveBeenCalledTimes(1);
      void statusNorm; // suppress unused-variable lint
    });

    it('skips status subscribe when char not in availableChars', async () => {
      const adapter = makeAdapter();
      const subscribe = vi.fn().mockResolvedValue(undefined);
      const ctx: ConnectionContext = {
        write: vi.fn().mockResolvedValue(undefined),
        read: vi.fn().mockResolvedValue(Buffer.alloc(0)),
        subscribe,
        profile: defaultProfile(),
        deviceAddress: '60:30:F2:73:6A:7B',
        availableChars: new Set<string>(), // empty
      };
      await adapter.onConnected(ctx);
      expect(subscribe).not.toHaveBeenCalled();
    });
  });

  // ─── isComplete() ────────────────────────────────────────────────────────

  describe('isComplete()', () => {
    it('returns true for weight > 10 and impedance > 0', () => {
      expect(makeAdapter().isComplete({ weight: 78, impedance: 181 })).toBe(true);
    });

    it('returns false when weight <= 10', () => {
      expect(makeAdapter().isComplete({ weight: 5, impedance: 181 })).toBe(false);
    });

    it('returns false when impedance is 0', () => {
      expect(makeAdapter().isComplete({ weight: 78, impedance: 0 })).toBe(false);
    });
  });

  // ─── computeMetrics() ────────────────────────────────────────────────────

  describe('computeMetrics()', () => {
    it('returns valid BodyComposition after a parsed frame', () => {
      const adapter = makeAdapter();
      adapter.parseNotification(makeMeasFrame(7805, 1813));
      const payload = adapter.computeMetrics({ weight: 78.05, impedance: 181.3 }, defaultProfile());
      expect(payload.weight).toBeCloseTo(78.05, 2);
      assertPayloadRanges(payload);
    });

    it('uses scale-provided body-fat and visceral-fat', () => {
      const adapter = makeAdapter();
      // fat=19.67%, visceral=5
      adapter.parseNotification(
        makeMeasFrame(7805, 1813, 0x25, { bodyFatX100: 1967, visceralFat: 5 }),
      );
      const payload = adapter.computeMetrics({ weight: 78.05, impedance: 181.3 }, defaultProfile());
      expect(payload.bodyFatPercent).toBeCloseTo(19.67, 1);
      expect(payload.visceralFat).toBe(5);
    });

    it('uses scale-provided bone mass', () => {
      const adapter = makeAdapter();
      adapter.parseNotification(makeMeasFrame(7805, 1813, 0x25, { boneMassX100: 190 }));
      const payload = adapter.computeMetrics({ weight: 78.05, impedance: 181.3 }, defaultProfile());
      expect(payload.boneMass).toBeCloseTo(1.9, 1);
    });

    it('falls back gracefully when no prior frame was parsed', () => {
      // computeMetrics without a prior parseNotification should not throw
      const adapter = makeAdapter();
      const payload = adapter.computeMetrics({ weight: 78, impedance: 181 }, defaultProfile());
      expect(payload.weight).toBe(78);
      assertPayloadRanges(payload);
    });
  });
});
