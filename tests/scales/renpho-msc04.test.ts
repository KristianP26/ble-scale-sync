import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  RenphoMsc04Adapter,
  assertAllowedWrite,
  buildClockFrame,
  buildGuestProfileFrame,
} from '../../src/scales/renpho-msc04.js';
import { adapters } from '../../src/scales/index.js';
import { resolveAdapter } from '../../src/scales/resolve.js';
import { uuid16, buildPayload } from '../../src/scales/body-comp-helpers.js';
import { bleLog } from '../../src/ble/types.js';
import type {
  ConnectionContext,
  ScaleReading,
  UserProfile,
} from '../../src/interfaces/scale-adapter.js';
import {
  mockPeripheral,
  defaultProfile,
  assertPayloadRanges,
} from '../helpers/scale-test-utils.js';

const LIVE = Buffer.from('55aa210005010000255da8', 'hex'); // cmd 0x21 -> 95.65
const FINAL = Buffer.from('55aa240006011100002553b3', 'hex'); // cmd 0x24 -> 95.55
// The start command adapters before #434 sent at connect.
const OLD_START = '55aa9000040100000094';

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

  describe('onConnected() guard', () => {
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
        expect(lines).toContain(
          'Renpho R-MSC04: status seq 2, state 0x09 (weight locked), 0 stored records, ' +
            '[7] 01, [9] 50',
        );
        expect(lines).toContain(
          'Renpho R-MSC04: status seq 3, state 0x11 (measurement complete), 0 stored records, ' +
            '[7] 01, [9] 50',
        );
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

    describe('buildAck() status acknowledgements', () => {
      // Each pair is a status the scale sent and the app's reply, both from the
      // #117 capture (second connection).
      const PAIRS: Array<[string, string]> = [
        ['55aa200005000101005076', '55aab000020001b2'],
        ['55aa200005020901005080', '55aab000020201b4'],
        ['55aa200005031101005089', '55aab000020301b5'],
      ];

      it.each(PAIRS)('acks status %s with the app bytes %s, written with response', (s, a) => {
        const adapter = makeAdapter();
        expect(Buffer.from(adapter.buildAck(Buffer.from(s, 'hex'))!).toString('hex')).toBe(a);
        expect(adapter.ackWithResponse).toBe(true);
      });

      it('acks nothing else: weight frames, record and history fragments, a bad status', () => {
        const adapter = makeAdapter();
        const others = [
          LIVE,
          FINAL,
          ...RECORD,
          ...HIST,
          // Derived: capture status with its checksum 76 -> 77.
          Buffer.from('55aa200005000101005077', 'hex'),
        ];
        for (const f of others) expect(adapter.buildAck(f)).toBeNull();
      });
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

// ─── Connect handshake: b2 guest profile + b3 clock (#434, D038) ─────────────

// Byte for byte from @joelr's capture on #117 (first connection, 2026-07-03):
// the app's b3 at Unix 0x6a478eb1 with the zone 600 minutes east of UTC. The
// same frame is public verbatim in his r-msc04-bridge. No captured b2 is used
// anywhere: every one of them carries a person's height and weight.
const CAPTURE_CLOCK_B3 = '55aab3000b000701016a478eb102580010';

/** The capture's clock, at UTC+10 as the capture was. */
function captureClock(): Date {
  const d = new Date(0x6a478eb1 * 1000);
  d.getTimezoneOffset = () => -600;
  return d;
}

function clockAt(offset: number): () => Date {
  return () => {
    const d = captureClock();
    d.getTimezoneOffset = () => offset;
    return d;
  };
}

// Made up, NOT from any capture (the same profile as the ES-CS20M tests).
const MADE_UP_PROFILE: UserProfile = {
  gender: 'female',
  birthDate: '1990-06-15',
  age: 36,
  height: 168,
  lastKnownWeight: 65.5,
  isAthlete: false,
};
// seq 00, slot 09, 0x0690 = 168.0 cm, 0x1996 = 65.50 kg, a9 ff 02.
const MADE_UP_B2 = '55aab20009000906901996a9ff02b2';

/** `bytes` followed by their 55AA checksum. */
function withSum(bytes: number[]): Buffer {
  return Buffer.from([...bytes, bytes.reduce((a, b) => a + b, 0) & 0xff]);
}

/** A 55AA frame with a correct checksum, for the allow-list tests. */
function frame55aa(cmd: number, payload: number[]): Buffer {
  return withSum([0x55, 0xaa, cmd, payload.length >> 8, payload.length & 0xff, ...payload]);
}

interface Written {
  char: string;
  hex: string;
  withResponse: boolean | undefined;
}

function handshakeCtx(
  profile: UserProfile = MADE_UP_PROFILE,
  write?: (data: Buffer) => Promise<void>,
): { ctx: ConnectionContext; written: Written[] } {
  const written: Written[] = [];
  const ctx: ConnectionContext = {
    profile,
    deviceAddress: 'AA',
    availableChars: new Set([uuid16(0x2a10), uuid16(0x2a11), uuid16(0x2a12)]),
    write: async (char, data, withResponse) => {
      const buf = Buffer.from(data);
      written.push({ char, hex: buf.toString('hex'), withResponse });
      if (write) await write(buf);
    },
    read: async () => Buffer.alloc(0),
    subscribe: async () => {},
  };
  return { ctx, written };
}

async function connectedAdapter(
  now: () => Date = captureClock,
  profile: UserProfile = MADE_UP_PROFILE,
): Promise<{ adapter: RenphoMsc04Adapter; written: Written[] }> {
  const adapter = new RenphoMsc04Adapter(now);
  const { ctx, written } = handshakeCtx(profile);
  adapter.onSessionStart();
  await adapter.onConnected(ctx);
  return { adapter, written };
}

function spyAllLevels() {
  return [
    vi.spyOn(bleLog, 'debug').mockImplementation(() => {}),
    vi.spyOn(bleLog, 'info').mockImplementation(() => {}),
    vi.spyOn(bleLog, 'warn').mockImplementation(() => {}),
    vi.spyOn(bleLog, 'error').mockImplementation(() => {}),
  ];
}

function logged(spies: ReturnType<typeof spyAllLevels>): string[] {
  return spies.flatMap((s) => s.mock.calls.map((c) => String(c[0])));
}

describe('RenphoMsc04Adapter connect handshake (#434, D038)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('writes the guest b2 then the b3 clock to 0x2A11, both with response, and no start command', async () => {
    const { written } = await connectedAdapter();
    expect(written.map((w) => w.hex)).toEqual([
      MADE_UP_B2,
      // The capture's b3 with seq 01 (and so checksum + 1).
      '55aab3000b010701016a478eb102580011',
    ]);
    expect(written.every((w) => w.withResponse === true)).toBe(true);
    expect(written.every((w) => w.char === uuid16(0x2a11))).toBe(true);
    expect(written.some((w) => w.hex === OLD_START || w.hex.slice(4, 6) === '90')).toBe(false);
  });

  it('builds the captured b3 byte for byte from the capture clock', () => {
    expect(buildClockFrame(0, captureClock()).toString('hex')).toBe(CAPTURE_CLOCK_B3);
    expect(buildClockFrame(1, captureClock()).toString('hex')).toBe(
      '55aab3000b010701016a478eb102580011',
    );
  });

  it('builds the guest b2 from the profile height and last weight', () => {
    expect(buildGuestProfileFrame(0, MADE_UP_PROFILE).toString('hex')).toBe(MADE_UP_B2);
  });

  it('falls back to 170.0 cm and 70.00 kg, and the fallback passes the allow-list', () => {
    for (const height of [0, Number.NaN, 300]) {
      const f = buildGuestProfileFrame(0, { ...MADE_UP_PROFILE, height });
      expect(f.readUInt16BE(7)).toBe(1700);
      expect(() => assertAllowedWrite(f)).not.toThrow();
    }
    for (const lastKnownWeight of [undefined, 0, 400]) {
      const f = buildGuestProfileFrame(0, { ...MADE_UP_PROFILE, lastKnownWeight });
      expect(f.readUInt16BE(9)).toBe(7000);
      expect(() => assertAllowedWrite(f)).not.toThrow();
    }
    // 180 cm without a weight: 0x0708, 0x1b58.
    const noWeight = { ...MADE_UP_PROFILE, height: 180, lastKnownWeight: undefined };
    expect(buildGuestProfileFrame(0, noWeight).toString('hex')).toBe(
      '55aab20009000907081b58a9ff02ef',
    );
  });

  it('sends the zone in minutes east of UTC, and a zone west of UTC as 0', () => {
    const zone = (offset: number): string =>
      buildClockFrame(0, clockAt(offset)()).subarray(13, 15).toString('hex');
    expect(zone(-600)).toBe('0258');
    expect(zone(0)).toBe('0000');
    expect(zone(-330)).toBe('014a');
    expect(zone(300)).toBe('0000');
  });

  it('logs the unsendable west zone once per adapter instance', async () => {
    const debug = vi.spyOn(bleLog, 'debug').mockImplementation(() => {});
    const westLines = (): number =>
      debug.mock.calls.filter((c) => String(c[0]).includes('west of UTC')).length;
    const adapter = new RenphoMsc04Adapter(clockAt(300));
    for (let i = 0; i < 2; i++) {
      adapter.onSessionStart();
      await adapter.onConnected(handshakeCtx().ctx);
    }
    expect(westLines()).toBe(1);
    // A fresh instance logs it again: the latch is not module state.
    const other = new RenphoMsc04Adapter(clockAt(300));
    other.onSessionStart();
    await other.onConnected(handshakeCtx().ctx);
    expect(westLines()).toBe(2);
  });

  describe('assertAllowedWrite()', () => {
    const b2 = (p: number[]): Buffer => frame55aa(0xb2, p);
    const b3 = (p: number[]): Buffer => frame55aa(0xb3, p);
    const GOOD_B2 = [0x00, 0x09, 0x06, 0x90, 0x19, 0x96, 0xa9, 0xff, 0x02];
    const GOOD_B3 = [0x00, 0x07, 0x01, 0x01, 0x6a, 0x47, 0x8e, 0xb1, 0x02, 0x58, 0x00];
    const withByte = (p: number[], i: number, v: number): number[] =>
      p.map((b, j) => (j === i ? v : b));

    it('accepts the built b2 and b3 and the captured b3', () => {
      expect(() => assertAllowedWrite(b2(GOOD_B2))).not.toThrow();
      expect(() => assertAllowedWrite(b3(GOOD_B3))).not.toThrow();
      expect(() => assertAllowedWrite(Buffer.from(CAPTURE_CLOCK_B3, 'hex'))).not.toThrow();
    });

    const refused: Array<[string, Buffer]> = [
      ['the old start command', Buffer.from(OLD_START, 'hex')],
      ['b2 in a registered slot (01)', b2(withByte(GOOD_B2, 1, 0x01))],
      ['b2 with another [11]', b2(withByte(GOOD_B2, 6, 0xa8))],
      ['b2 with another [12]', b2(withByte(GOOD_B2, 7, 0x03))],
      ['b2 with another [13]', b2(withByte(GOOD_B2, 8, 0x03))],
      ['b2 with a height below 50.0 cm', b2([0, 9, 0x01, 0xf3, 0x19, 0x96, 0xa9, 0xff, 0x02])],
      ['b2 with a height above 250.0 cm', b2([0, 9, 0x09, 0xc5, 0x19, 0x96, 0xa9, 0xff, 0x02])],
      ['b2 with a weight of 0', b2([0, 9, 0x06, 0x90, 0x00, 0x00, 0xa9, 0xff, 0x02])],
      ['b2 with a weight above 300 kg', b2([0, 9, 0x06, 0x90, 0x75, 0x31, 0xa9, 0xff, 0x02])],
      ['b2 with a longer payload', b2([...GOOD_B2, 0x00])],
      ['b3 with another constant', b3(withByte(GOOD_B3, 1, 0x08))],
      ['b3 with a zone above 840 minutes', b3(withByte(withByte(GOOD_B3, 8, 0x03), 9, 0x49))],
      ['b3 with a non-zero last byte', b3(withByte(GOOD_B3, 10, 0x01))],
      ['a b0 ack (acks go through buildAck)', Buffer.from('55aab000020001b2', 'hex')],
      ['b6', frame55aa(0xb6, [0x01, 0x01])],
      ['b7', frame55aa(0xb7, [0x00, 0x09, 0x41])],
      ['b8', frame55aa(0xb8, [0x00, 0x09, 0x01])],
      ['a bad checksum', Buffer.from(MADE_UP_B2.slice(0, -2) + 'b3', 'hex')],
      [
        'a length field longer than the frame',
        Buffer.from('55aab2000a' + MADE_UP_B2.slice(10), 'hex'),
      ],
      ['a second frame behind an allowed one', Buffer.from(MADE_UP_B2 + CAPTURE_CLOCK_B3, 'hex')],
      [
        'bytes behind the frame, even under a checksum over all of them',
        withSum([...Buffer.from(MADE_UP_B2, 'hex'), 0x00]),
      ],
      ['a frame without the 55AA header', Buffer.from('56' + MADE_UP_B2.slice(2), 'hex')],
    ];

    it.each(refused)('refuses %s', (_what, f) => {
      expect(() => assertAllowedWrite(f)).toThrow(/refusing/);
    });
  });

  it('never logs the b2 frame or the height and weight in it', async () => {
    const spies = spyAllLevels();
    const { adapter } = await connectedAdapter();
    adapter.parseCharNotification(IND, FINAL);
    const r = feed(adapter, RECORD)!;
    adapter.computeMetrics(r, MADE_UP_PROFILE);
    adapter.onSessionEnd();

    const lines = logged(spies);
    expect(lines.some((l) => l.includes('guest profile'))).toBe(true);
    expect(lines.some((l) => l.includes('55aab3000b01'))).toBe(true);
    for (const l of lines) {
      expect(l).not.toContain(MADE_UP_B2);
      expect(l).not.toContain('55aab2');
      expect(l).not.toContain('0690');
      expect(l).not.toContain('1996');
      expect(l).not.toMatch(/\b168(\.0)?\b/);
      expect(l).not.toMatch(/\b65\.5/);
    }
  });

  it('carries on with b3 when the b2 write fails, and logs the failure without bytes', async () => {
    const warn = vi.spyOn(bleLog, 'warn').mockImplementation(() => {});
    vi.spyOn(bleLog, 'debug').mockImplementation(() => {});
    const adapter = new RenphoMsc04Adapter(captureClock);
    const { ctx, written } = handshakeCtx(MADE_UP_PROFILE, async (buf) => {
      if (buf[2] === 0xb2) throw new Error('GATT write failed');
    });
    adapter.onSessionStart();
    await expect(adapter.onConnected(ctx)).resolves.toBeUndefined();
    expect(written.map((w) => w.hex.slice(4, 6))).toEqual(['b2', 'b3']);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('guest profile (b2) not sent');
    expect(String(warn.mock.calls[0][0])).not.toContain('55aa');
  });

  it('neither writes b3 nor warns for a session that ended during the b2 write', async () => {
    const warn = vi.spyOn(bleLog, 'warn').mockImplementation(() => {});
    vi.spyOn(bleLog, 'debug').mockImplementation(() => {});
    let drop!: (e: Error) => void;
    const adapter = new RenphoMsc04Adapter(captureClock);
    const { ctx, written } = handshakeCtx(MADE_UP_PROFILE, (buf) =>
      buf[2] === 0xb2
        ? new Promise<void>((_resolve, reject) => (drop = reject))
        : Promise.resolve(),
    );
    adapter.onSessionStart();
    const connecting = adapter.onConnected(ctx);
    adapter.onSessionEnd();
    // The link went down: the transport fails the write after the session ended.
    drop(new Error('Not connected'));
    await connecting;
    expect(written.map((w) => w.hex.slice(4, 6))).toEqual(['b2']);
    expect(warn).not.toHaveBeenCalled();
  });

  it("does not export the scale's figures from a session with our guest b2", async () => {
    const info = vi.spyOn(bleLog, 'info').mockImplementation(() => {});
    vi.spyOn(bleLog, 'debug').mockImplementation(() => {});
    const { adapter } = await connectedAdapter();
    adapter.parseCharNotification(IND, FINAL);
    const r = feed(adapter, RECORD)!;
    expect(adapter.isFinal(r)).toBe(true);
    // PROFILE_187 passes the D022 height gate, so only the guest rule stops it.
    expect(adapter.computeMetrics(r, PROFILE_187)).toEqual(buildPayload(95.55, 0, {}, PROFILE_187));
    const infoLines = info.mock.calls.map((c) => String(c[0]));
    expect(infoLines.some((l) => l.includes('not exported'))).toBe(true);
  });

  it('keeps the guest rule pinned to the reading when a session without b2 follows', async () => {
    vi.spyOn(bleLog, 'info').mockImplementation(() => {});
    vi.spyOn(bleLog, 'debug').mockImplementation(() => {});
    const { adapter } = await connectedAdapter();
    adapter.parseCharNotification(IND, FINAL);
    const r1 = feed(adapter, RECORD)!;
    adapter.onSessionEnd();
    // Session 2 without our b2 (no onConnected): its record is exported (D022).
    adapter.onSessionStart();
    adapter.parseCharNotification(IND, FINAL);
    const r2 = feed(adapter, RECORD)!;
    expect(adapter.computeMetrics(r2, PROFILE_187).bodyFatPercent).toBe(23.7);
    expect(adapter.computeMetrics(r1, PROFILE_187)).toEqual(
      buildPayload(95.55, 0, {}, PROFILE_187),
    );
  });
});

// ─── Handshake diagnostics (#434) ────────────────────────────────────────────

// #117 capture (@joelr, public): the scale's replies to the app's b3 and b2,
// and two status frames of the first connection. Byte for byte.
const A_REPLY_B3_SEQ0 = '55aa2300030007012d';
const A_REPLY_B2_SEQ1 = '55aa220002010125';
const A_REPLY_B3_SEQ4 = '55aa23000304070131';
const A_REPLY_B2_SEQ5 = '55aa220002050129';
const A_STATUS_STORED_3 = '55aa20000500050103507d'; // state 0x05, 3 stored records
const A_STATUS_ENDING = '55aa20000504040100507d'; // state 0x04, 0 stored records
// #434 (vossitch, public DEBUG logs): status frames.
const C_STATUS_MEASURING = '55aa20000500010101466d'; // 1 stored record
const C_STATUS_NOT_MEASURING_2 = '55aa200005000501024672'; // 2 stored records
const C_STATUS_MEASURING_2 = '55aa20000500010102466e';
const C_STATUS_LOCKED = '55aa200005010901014676';

describe('RenphoMsc04Adapter handshake diagnostics (#434)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  function debugLines() {
    const debug = vi.spyOn(bleLog, 'debug').mockImplementation(() => {});
    return (): string[] => debug.mock.calls.map((c) => String(c[0]));
  }

  it('logs the replies to b2 and b3 with their seq, and acks none of them', () => {
    const lines = debugLines();
    const adapter = makeAdapter();
    for (const f of [A_REPLY_B3_SEQ0, A_REPLY_B2_SEQ1, A_REPLY_B3_SEQ4, A_REPLY_B2_SEQ5]) {
      expect(adapter.parseCharNotification(IND, Buffer.from(f, 'hex'))).toBeNull();
      expect(adapter.buildAck(Buffer.from(f, 'hex'))).toBeNull();
    }
    expect(lines()).toEqual([
      'Renpho R-MSC04: scale answered b3 (seq 0) with 0701',
      'Renpho R-MSC04: scale answered b2 (seq 1) with 01',
      'Renpho R-MSC04: scale answered b3 (seq 4) with 0701',
      'Renpho R-MSC04: scale answered b2 (seq 5) with 01',
    ]);
  });

  it('logs the state, the stored record count and the raw [7] and [9] of each status', () => {
    const lines = debugLines();
    const adapter = makeAdapter();
    for (const f of [
      A_STATUS_STORED_3,
      A_STATUS_ENDING,
      C_STATUS_MEASURING,
      C_STATUS_NOT_MEASURING_2,
    ]) {
      expect(adapter.parseCharNotification(IND, Buffer.from(f, 'hex'))).toBeNull();
    }
    expect(lines()).toEqual([
      'Renpho R-MSC04: status seq 0, state 0x05 (not measuring), 3 stored records, [7] 01, [9] 50',
      'Renpho R-MSC04: status seq 4, state 0x04 (scale is ending the session), 0 stored records, ' +
        '[7] 01, [9] 50',
      'Renpho R-MSC04: status seq 0, state 0x01 (measuring), 1 stored record, [7] 01, [9] 46',
      'Renpho R-MSC04: status seq 0, state 0x05 (not measuring), 2 stored records, [7] 01, [9] 46',
    ]);
  });

  it('logs the seq of each replayed stored record', () => {
    const lines = debugLines();
    feed(makeAdapter(), HIST);
    expect(lines()).toContain('Renpho R-MSC04: stored history record seq 1 ignored (1453 s old)');
  });

  it('says whether the record was computed for the height we sent, never the height', async () => {
    const lines = debugLines();
    // The capture's record implies 187.1 cm.
    const ours = await connectedAdapter(captureClock, { ...MADE_UP_PROFILE, height: 187 });
    ours.adapter.parseCharNotification(IND, FINAL);
    feed(ours.adapter, RECORD);
    const other = await connectedAdapter(captureClock, MADE_UP_PROFILE);
    other.adapter.parseCharNotification(IND, FINAL);
    feed(other.adapter, RECORD);
    const verdicts = lines().filter((l) => l.includes('BMI height'));
    expect(verdicts).toEqual([
      "Renpho R-MSC04: the record's BMI height matches the height we sent (within 1 cm)",
      "Renpho R-MSC04: the record's BMI height does not match the height we sent (within 1 cm)",
    ]);
  });

  it('logs one summary line when the session ends', async () => {
    vi.useFakeTimers();
    const lines = debugLines();
    const { adapter } = await connectedAdapter();
    const at = (ms: number, f: string): void => {
      vi.advanceTimersByTime(ms);
      adapter.parseCharNotification(IND, Buffer.from(f, 'hex'));
    };
    // The b2 reply but no b3 reply, then the measurement.
    at(50, A_REPLY_B2_SEQ1);
    at(50, C_STATUS_MEASURING_2);
    at(2000, '55aa240006011100001fdb35');
    at(1100, C_STATUS_LOCKED);
    vi.advanceTimersByTime(2300);
    adapter.onSessionEnd();
    // Only once: a second end of the same session has no handshake to report.
    adapter.onSessionStart();
    adapter.onSessionEnd();

    const summaries = lines().filter((l) => l.includes('session ended'));
    expect(summaries).toEqual([
      'Renpho R-MSC04: session ended 5.5 s after the handshake started (writes full: ' +
        'b2 answered, b3 not answered; first status 0x01 with 2 stored records; ' +
        'last status 0x09 at 3.2 s; 0x24 yes; stored records replayed 0; ' +
        'composition record no; last frame 2.3 s before the end)',
    ]);
  });

  it('reports a failed write as failed in the summary', async () => {
    vi.spyOn(bleLog, 'warn').mockImplementation(() => {});
    const lines = debugLines();
    const adapter = new RenphoMsc04Adapter(captureClock);
    const { ctx } = handshakeCtx(MADE_UP_PROFILE, async (buf) => {
      if (buf[2] === 0xb3) throw new Error('GATT write failed');
    });
    adapter.onSessionStart();
    await adapter.onConnected(ctx);
    adapter.onSessionEnd();
    const summary = lines().find((l) => l.includes('session ended'));
    expect(summary).toContain('writes full: b2 not answered, b3 failed; no status;');
    expect(summary).toContain('composition record no; no frames)');
  });

  it('reports a write still waiting for its response at the end as pending, not failed', async () => {
    const lines = debugLines();
    let release!: () => void;
    const adapter = new RenphoMsc04Adapter(captureClock);
    const { ctx } = handshakeCtx(MADE_UP_PROFILE, (buf) =>
      buf[2] === 0xb2 ? new Promise<void>((resolve) => (release = resolve)) : Promise.resolve(),
    );
    adapter.onSessionStart();
    const connecting = adapter.onConnected(ctx);
    adapter.onSessionEnd();
    const summary = lines().find((l) => l.includes('session ended'));
    expect(summary).toContain('writes full: b2 pending; no status;');
    release();
    await connecting;
  });
});

// ─── BLE_RMSC04_HANDSHAKE diagnostic switch (#434) ───────────────────────────

describe('RenphoMsc04Adapter BLE_RMSC04_HANDSHAKE (#434)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  async function writesWith(value: string | undefined): Promise<string[]> {
    if (value === undefined) vi.stubEnv('BLE_RMSC04_HANDSHAKE', undefined);
    else vi.stubEnv('BLE_RMSC04_HANDSHAKE', value);
    const { written } = await connectedAdapter();
    return written.map((w) => w.hex);
  }

  it('writes b2 and b3 when unset or full', async () => {
    vi.spyOn(bleLog, 'debug').mockImplementation(() => {});
    const full = [MADE_UP_B2, '55aab3000b010701016a478eb102580011'];
    expect(await writesWith(undefined)).toEqual(full);
    expect(await writesWith('full')).toEqual(full);
  });

  it('writes only the b3 clock, as seq 0, for time (case-insensitive)', async () => {
    vi.spyOn(bleLog, 'debug').mockImplementation(() => {});
    expect(await writesWith('time')).toEqual([CAPTURE_CLOCK_B3]);
    expect(await writesWith('TIME')).toEqual([CAPTURE_CLOCK_B3]);
  });

  it('writes nothing for none, and still acks the status frames', async () => {
    vi.spyOn(bleLog, 'debug').mockImplementation(() => {});
    vi.stubEnv('BLE_RMSC04_HANDSHAKE', 'none');
    const { adapter, written } = await connectedAdapter();
    expect(written).toEqual([]);
    expect(adapter.buildAck(Buffer.from(A_STATUS_STORED_3, 'hex'))).not.toBeNull();
  });

  it('treats an empty value as unset, without a warning', async () => {
    vi.spyOn(bleLog, 'debug').mockImplementation(() => {});
    const warn = vi.spyOn(bleLog, 'warn').mockImplementation(() => {});
    expect(await writesWith('')).toEqual([MADE_UP_B2, '55aab3000b010701016a478eb102580011']);
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns once per unknown value and adapter instance, and writes full', async () => {
    vi.spyOn(bleLog, 'debug').mockImplementation(() => {});
    const warn = vi.spyOn(bleLog, 'warn').mockImplementation(() => {});
    vi.stubEnv('BLE_RMSC04_HANDSHAKE', 'bogus');
    const adapter = new RenphoMsc04Adapter(captureClock);
    for (let i = 0; i < 2; i++) {
      const { ctx, written } = handshakeCtx();
      adapter.onSessionStart();
      await adapter.onConnected(ctx);
      expect(written.map((w) => w.hex.slice(4, 6))).toEqual(['b2', 'b3']);
    }
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('BLE_RMSC04_HANDSHAKE="bogus"');
  });

  it("exports the scale's figures from a time session through the height gate (D022)", async () => {
    vi.spyOn(bleLog, 'debug').mockImplementation(() => {});
    vi.spyOn(bleLog, 'info').mockImplementation(() => {});
    vi.stubEnv('BLE_RMSC04_HANDSHAKE', 'time');
    const { adapter } = await connectedAdapter();
    adapter.parseCharNotification(IND, FINAL);
    const r = feed(adapter, RECORD)!;
    expect(adapter.computeMetrics(r, PROFILE_187).bodyFatPercent).toBe(23.7);
  });

  it('names the mode in the summary', async () => {
    const debug = vi.spyOn(bleLog, 'debug').mockImplementation(() => {});
    vi.stubEnv('BLE_RMSC04_HANDSHAKE', 'none');
    const { adapter } = await connectedAdapter();
    adapter.onSessionEnd();
    const lines = debug.mock.calls.map((c) => String(c[0]));
    expect(lines).toContain('Renpho R-MSC04: connect writes none');
    expect(lines.find((l) => l.includes('session ended'))).toContain('(writes none; no status;');
  });
});
