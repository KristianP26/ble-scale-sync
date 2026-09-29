import { describe, it, expect, vi } from 'vitest';
import { RenphoMsc04Adapter } from '../../src/scales/renpho-msc04.js';
import { adapters } from '../../src/scales/index.js';
import { resolveAdapter } from '../../src/scales/resolve.js';
import { uuid16, buildPayload } from '../../src/scales/body-comp-helpers.js';
import { bleLog } from '../../src/ble/types.js';
import type { ConnectionContext, ScaleReading } from '../../src/interfaces/scale-adapter.js';
import {
  mockPeripheral,
  defaultProfile,
  assertPayloadRanges,
} from '../helpers/scale-test-utils.js';

const LIVE = Buffer.from('55aa210005010000255da8', 'hex'); // cmd 0x21 -> 95.65
const FINAL = Buffer.from('55aa240006011100002553b3', 'hex'); // cmd 0x24 -> 95.55
const START = [0x55, 0xaa, 0x90, 0x00, 0x04, 0x01, 0x00, 0x00, 0x00, 0x94];

// ─── Composition record fixtures (#434) ──────────────────────────────────────
// Byte-for-byte from @joelr's PacketLogger capture on #117 (2026-07-08), second
// connection. The 0x24 FINAL above (95.55 kg) arrived at 20:28:14.253, these
// three indications on 0x2A12 at 20:28:30.183 / .274 / .363. Joined they form
//   55aa 25 0024 04 11 00002553 0a | 00de 0c20 0bef 08e4 092a |
//   00ae 0ac1 0a90 07e1 0825 | 01 | 00ed 0111 01b7 0008 | ea
// = 95.55 kg, fat 23.7 %, BMI 27.3, skeletal muscle 43.9 %, visceral 8.
const REC_1 = Buffer.from('ad040255aa2500240411000025530a00de0c200b', 'hex');
const REC_2 = Buffer.from('ae0401ef08e4092a00ae0ac10a9007e108250100', 'hex');
const REC_3 = Buffer.from('af0400ed011101b70008ea', 'hex');
const RECORD = [REC_1, REC_2, REC_3];

// First connection of the same capture: a stored 0x26 history record (age
// 0x000005ad = 1453 s at [7..10], weight 95.85 kg), which the app acks with b6.
const HIST = [
  Buffer.from('ad010255aa2600280111000005ad000025710a00', 'hex'),
  Buffer.from('ae0101e10c2f0bee090e095000b10acb0a8f0800', 'hex'),
  Buffer.from('af010008430100f0011201b500086a', 'hex'),
];

// Capture, second connection: a live 0x21 frame (95.60 kg) and status frames.
const LIVE_9560 = Buffer.from('55aa2100050100002558a3', 'hex');
const STATUS_LOCKED = Buffer.from('55aa200005020901005080', 'hex'); // state 0x09
const STATUS_DONE = Buffer.from('55aa200005031101005089', 'hex'); // state 0x11

// #434 (vossitch, DEBUG log): settled 0x24 at 81.55 kg.
const FINAL_8155 = Buffer.from('55aa240006011100001fdb35', 'hex');

// The scale computed the capture's record for a 187.0 cm profile: the app wrote
// 0x074e = 1870 in its b2 frame, and 95.55 / 1.87^2 = 27.3, the record's BMI.
const PROFILE_187 = defaultProfile({ height: 187 });

const IND = uuid16(0x2a12);

function feed(adapter: RenphoMsc04Adapter, frames: Buffer[]): ScaleReading | null {
  let last: ScaleReading | null = null;
  for (const f of frames) last = adapter.parseCharNotification(IND, f);
  return last;
}

function makeAdapter() {
  return new RenphoMsc04Adapter();
}

describe('RenphoMsc04Adapter', () => {
  describe('matches() and registry resolution (#117/#265)', () => {
    it('matches the exact "R-MSC04" name (case-insensitive)', () => {
      expect(makeAdapter().matches(mockPeripheral('R-MSC04'))).toBe(true);
      expect(makeAdapter().matches(mockPeripheral('r-msc04'))).toBe(true);
    });

    it('does not match ES-CS20M or unrelated names', () => {
      expect(makeAdapter().matches(mockPeripheral('es-cs20m'))).toBe(false);
      expect(makeAdapter().matches(mockPeripheral('Random Scale'))).toBe(false);
    });

    it('resolves a named R-MSC04 to this adapter, not ES-CS20M (priority 235 > 130)', () => {
      // A real R-MSC04 advertises service 0x1A10, which ES-CS20M also claims.
      const info = mockPeripheral('R-MSC04', [uuid16(0x1a10)]);
      expect(resolveAdapter(info)?.name).toBe('Renpho R-MSC04');
      // Array-order first match (what registry-collision.test asserts) also wins.
      expect(adapters.filter((a) => a.matches(info))[0]?.name).toBe('Renpho R-MSC04');
    });

    it('does NOT claim a nameless 0x1A10 device (leaves it to ES-CS20M)', () => {
      const info = mockPeripheral('', [uuid16(0x1a10)]);
      expect(makeAdapter().matches(info)).toBe(false);
      expect(resolveAdapter(info)?.name).toBe('ES-CS20M');
    });
  });

  describe('onConnected() start command', () => {
    it('writes the 55AA start command to 0x2A11 without response', async () => {
      const writes: Array<{ uuid: string; data: number[] | Buffer; withResponse?: boolean }> = [];
      const ctx = {
        profile: defaultProfile(),
        deviceAddress: 'AA',
        availableChars: new Set<string>([uuid16(0x2a11)]),
        write: vi.fn(async (uuid: string, data: number[] | Buffer, withResponse?: boolean) => {
          writes.push({ uuid, data, withResponse });
        }),
        read: vi.fn(),
        subscribe: vi.fn(),
      } as unknown as ConnectionContext;

      await makeAdapter().onConnected(ctx);

      expect(writes).toHaveLength(1);
      expect(writes[0].uuid).toBe(uuid16(0x2a11));
      expect([...(writes[0].data as number[])]).toEqual(START);
      expect(writes[0].withResponse).toBe(false);
    });

    it('throws a clear error when the write char was not discovered', async () => {
      const ctx = {
        profile: defaultProfile(),
        deviceAddress: 'AA',
        availableChars: new Set<string>(),
        write: vi.fn(),
        read: vi.fn(),
        subscribe: vi.fn(),
      } as unknown as ConnectionContext;
      await expect(makeAdapter().onConnected(ctx)).rejects.toThrow(/not discovered/);
    });

    it('resets finalReceived on reconnect (shared singleton)', async () => {
      const adapter = makeAdapter();
      adapter.parseCharNotification(uuid16(0x2a12), FINAL);
      expect(adapter.isComplete({ weight: 95.55, impedance: 0 })).toBe(true);
      const ctx = {
        profile: defaultProfile(),
        deviceAddress: 'AA',
        availableChars: new Set<string>([uuid16(0x2a11)]),
        write: vi.fn(),
        read: vi.fn(),
        subscribe: vi.fn(),
      } as unknown as ConnectionContext;
      // Handler order: onSessionStart before anything is subscribed, then
      // onConnected once the init sequence runs (src/ble/shared.ts).
      adapter.onSessionStart();
      await adapter.onConnected(ctx);
      expect(adapter.isComplete({ weight: 95.55, impedance: 0 })).toBe(false);
    });
  });

  describe('parseCharNotification() framing + weight', () => {
    it('parses a cmd 0x21 live frame -> 95.65 kg (progress, not complete)', () => {
      const adapter = makeAdapter();
      const r = adapter.parseCharNotification(uuid16(0x2a10), LIVE);
      expect(r).not.toBeNull();
      expect(r!.weight).toBeCloseTo(95.65, 2);
      expect(r!.impedance).toBe(0);
      expect(adapter.isComplete(r!)).toBe(false);
    });

    it('parses a cmd 0x24 final frame -> 95.55 kg and completes the reading', () => {
      const adapter = makeAdapter();
      const r = adapter.parseCharNotification(uuid16(0x2a12), FINAL);
      expect(r).not.toBeNull();
      expect(r!.weight).toBeCloseTo(95.55, 2);
      expect(r!.impedance).toBe(0);
      expect(adapter.isComplete(r!)).toBe(true);
    });

    it('rejects a frame with a bad checksum (no final latched)', () => {
      const adapter = makeAdapter();
      const bad = Buffer.from('55aa240006011100002553b4', 'hex'); // b4 != b3
      expect(adapter.parseCharNotification(uuid16(0x2a12), bad)).toBeNull();
      expect(adapter.isComplete({ weight: 95.55, impedance: 0 })).toBe(false);
    });

    it('rejects a frame without the 55AA header', () => {
      const adapter = makeAdapter();
      const bad = Buffer.from('56aa240006011100002553b4', 'hex');
      expect(adapter.parseCharNotification(uuid16(0x2a10), bad)).toBeNull();
    });

    it('rejects a truncated frame (declared length exceeds buffer)', () => {
      const adapter = makeAdapter();
      const t = Buffer.from('55aa24000601', 'hex'); // len says 6, only 1 payload byte present
      expect(adapter.parseCharNotification(uuid16(0x2a10), t)).toBeNull();
    });

    it('ignores an out-of-scope command with a valid checksum (e.g. 0x26)', () => {
      const adapter = makeAdapter();
      const body = Buffer.from('55aa26000212346d', 'hex'); // cmd 0x26, checksum ok
      expect(adapter.parseCharNotification(uuid16(0x2a10), body)).toBeNull();
      expect(adapter.isComplete({ weight: 95.55, impedance: 0 })).toBe(false);
    });

    it('legacy parseNotification() decodes the same frame', () => {
      const adapter = makeAdapter();
      expect(adapter.parseNotification(LIVE)!.weight).toBeCloseTo(95.65, 2);
    });
  });

  describe('isComplete() gating', () => {
    it('is false after only live frames, true after the final frame', () => {
      const adapter = makeAdapter();
      adapter.parseCharNotification(uuid16(0x2a10), LIVE);
      expect(adapter.isComplete({ weight: 95.65, impedance: 0 })).toBe(false);
      adapter.parseCharNotification(uuid16(0x2a12), FINAL);
      expect(adapter.isComplete({ weight: 95.55, impedance: 0 })).toBe(true);
    });

    it('is false when weight is 0 even after the final frame', () => {
      const adapter = makeAdapter();
      adapter.parseCharNotification(uuid16(0x2a12), FINAL);
      expect(adapter.isComplete({ weight: 0, impedance: 0 })).toBe(false);
    });
  });

  describe('computeMetrics()', () => {
    it('returns a weight-only payload (impedance 0) that passes range checks', () => {
      const payload = makeAdapter().computeMetrics(
        { weight: 95.55, impedance: 0 },
        defaultProfile(),
      );
      expect(payload.weight).toBeCloseTo(95.55, 2);
      expect(payload.impedance).toBe(0);
      assertPayloadRanges(payload);
    });
  });

  // ─── Composition record (#434) ─────────────────────────────────────────────

  describe('0x25 composition record (#434)', () => {
    function settled(final = FINAL): RenphoMsc04Adapter {
      const adapter = makeAdapter();
      adapter.onSessionStart();
      adapter.parseCharNotification(IND, final);
      return adapter;
    }

    it('reassembles the three captured fragments into a final reading at the settled weight', () => {
      const adapter = settled();
      expect(adapter.parseCharNotification(IND, REC_1)).toBeNull();
      expect(adapter.parseCharNotification(IND, REC_2)).toBeNull();
      const r = adapter.parseCharNotification(IND, REC_3);
      expect(r).toEqual({ weight: 95.55, impedance: 0 });
      expect(adapter.isComplete(r!)).toBe(true);
      expect(adapter.isFinal(r!)).toBe(true);
    });

    it("exports the scale's body fat and visceral fat, and muscle mass as lean minus bone", () => {
      const adapter = settled();
      const r = feed(adapter, RECORD)!;
      const payload = adapter.computeMetrics(r, PROFILE_187);
      expect(payload.bodyFatPercent).toBe(23.7);
      expect(payload.visceralFat).toBe(8);
      expect(payload.impedance).toBe(0);
      expect(payload).toEqual(buildPayload(95.55, 0, { fat: 23.7, visceralFat: 8 }, PROFILE_187));
      // Not the scale's skeletal muscle percentage of body weight (#253).
      expect(Math.abs(payload.muscleMass - 0.439 * 95.55)).toBeGreaterThan(20);
      assertPayloadRanges(payload);
    });

    it('logs the segment impedances, BMI and skeletal muscle at debug level', () => {
      const debug = vi.spyOn(bleLog, 'debug').mockImplementation(() => {});
      try {
        feed(settled(), RECORD);
        const line = debug.mock.calls.map((c) => String(c[0])).find((m) => m.includes('20 kHz'));
        expect(line).toContain('20 kHz 22.2 / 310.4 / 305.5 / 227.6 / 234.6 ohm');
        expect(line).toContain('100 kHz 17.4 / 275.3 / 270.4 / 201.7 / 208.5 ohm');
        expect(line).toContain('BMI 27.3');
        expect(line).toContain('skeletal muscle 43.9 %');
      } finally {
        debug.mockRestore();
      }
    });

    it('holds for 30 s: the 0x24 weight alone is complete, not final, and weight-only', () => {
      const adapter = makeAdapter();
      expect(adapter.completionHoldMs).toBe(30_000);
      adapter.onSessionStart();
      const r = adapter.parseCharNotification(IND, FINAL)!;
      expect(adapter.isComplete(r)).toBe(true);
      expect(adapter.isFinal(r)).toBe(false);
      expect(adapter.computeMetrics(r, PROFILE_187)).toEqual(
        buildPayload(95.55, 0, {}, PROFILE_187),
      );
    });

    it('drops a record with a bad checksum (derived: last byte ea -> eb)', () => {
      const bad = Buffer.from('af0400ed011101b70008eb', 'hex');
      expect(feed(settled(), [REC_1, REC_2, bad])).toBeNull();
    });

    it('drops a record with a missing middle fragment', () => {
      expect(feed(settled(), [REC_1, REC_3])).toBeNull();
    });

    it('drops a chain whose next fragment carries another seq (derived: seq 04 -> 05)', () => {
      const adapter = settled();
      const otherSeq = Buffer.from('ae0501ef08e4092a00ae0ac10a9007e108250100', 'hex');
      expect(feed(adapter, [REC_1, otherSeq, REC_3])).toBeNull();
      // The complete record still lands afterwards.
      expect(feed(adapter, RECORD)).not.toBeNull();
    });

    it('drops a chain whose next fragment has an out-of-order marker (derived: ae -> b0)', () => {
      const wrongMarker = Buffer.from('b00401ef08e4092a00ae0ac10a9007e108250100', 'hex');
      expect(feed(settled(), [REC_1, wrongMarker, REC_3])).toBeNull();
    });

    // Two gates reject this (no settled weight yet, and so no weight to match);
    // removing either one alone leaves the test green.
    it('ignores a record that arrives before the settled weight', () => {
      const adapter = makeAdapter();
      adapter.onSessionStart();
      expect(feed(adapter, RECORD)).toBeNull();
      const r = adapter.parseCharNotification(IND, FINAL)!;
      expect(adapter.isFinal(r)).toBe(false);
    });

    it('ignores a record whose weight is not the settled weight', () => {
      const adapter = settled(FINAL_8155);
      expect(feed(adapter, RECORD)).toBeNull();
    });

    it('treats a record without body fat as final, but uses the estimate (derived)', () => {
      // Derived from REC_3: fat 00ed -> 0000, checksum ea -> fd.
      const noFat = Buffer.from('af040000011101b70008fd', 'hex');
      const adapter = settled();
      const r = feed(adapter, [REC_1, REC_2, noFat])!;
      expect(adapter.isFinal(r)).toBe(true);
      expect(adapter.computeMetrics(r, PROFILE_187)).toEqual(
        buildPayload(95.55, 0, {}, PROFILE_187),
      );
    });

    it('never uses a stored 0x26 history record', () => {
      const adapter = settled();
      for (const f of HIST) expect(adapter.parseCharNotification(IND, f)).toBeNull();
    });

    it('drops a half-received record when the next session starts', () => {
      const adapter = settled();
      feed(adapter, [REC_1, REC_2]);
      adapter.onSessionStart();
      adapter.parseCharNotification(IND, FINAL);
      expect(adapter.parseCharNotification(IND, REC_3)).toBeNull();
    });

    it('ignores live frames after the settled weight, so stepping off cannot replace it', () => {
      const adapter = makeAdapter();
      adapter.onSessionStart();
      expect(adapter.parseCharNotification(uuid16(0x2a10), LIVE_9560)!.weight).toBe(95.6);
      adapter.parseCharNotification(IND, FINAL);
      expect(adapter.parseCharNotification(uuid16(0x2a10), LIVE_9560)).toBeNull();
    });

    it('logs status frames and returns nothing for them', () => {
      const debug = vi.spyOn(bleLog, 'debug').mockImplementation(() => {});
      try {
        const adapter = makeAdapter();
        expect(adapter.parseCharNotification(IND, STATUS_LOCKED)).toBeNull();
        expect(adapter.parseCharNotification(IND, STATUS_DONE)).toBeNull();
        const lines = debug.mock.calls.map((c) => String(c[0]));
        expect(lines).toContain('Renpho R-MSC04: status seq 2, state 0x09 (weight locked)');
        expect(lines).toContain('Renpho R-MSC04: status seq 3, state 0x11 (measurement complete)');
      } finally {
        debug.mockRestore();
      }
    });

    it("uses the estimate when the scale's profile height is not the user's", () => {
      const adapter = settled();
      const r = feed(adapter, RECORD)!;
      // 95.55 kg at BMI 27.3 is a 187.1 cm profile: 4.1 cm from 183, 0.9 from 188.
      const short = defaultProfile({ height: 183 });
      expect(adapter.computeMetrics(r, short)).toEqual(buildPayload(95.55, 0, {}, short));
      const tall = defaultProfile({ height: 188 });
      expect(adapter.computeMetrics(r, tall).bodyFatPercent).toBe(23.7);
    });

    it('keeps the record pinned to its reading when the next session starts', () => {
      const adapter = settled();
      const r = feed(adapter, RECORD)!;
      adapter.onSessionStart();
      expect(adapter.isFinal(r)).toBe(true);
      expect(adapter.computeMetrics(r, PROFILE_187).bodyFatPercent).toBe(23.7);
    });
  });
});
