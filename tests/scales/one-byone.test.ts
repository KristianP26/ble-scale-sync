import { describe, it, expect, vi } from 'vitest';
import { OneByoneAdapter, OneByoneNewAdapter } from '../../src/scales/one-byone.js';
import {
  mockPeripheral,
  defaultProfile,
  makeConnectionContext,
  assertPayloadRanges,
} from '../helpers/scale-test-utils.js';
import { uuid16, WEIGHT_ONLY_HOLD_MS } from '../../src/scales/body-comp-helpers.js';
import { bleLog } from '../../src/ble/types.js';
import { hex, type Trace } from '../helpers/replay/trace.js';
import { replaySession } from '../helpers/replay/session.js';
import {
  session as c1,
  C1_STEP_ON,
  C1_534_FIRST_FRAME_MS,
  C1_SETTLING,
  C1_SETTLED,
  C1_FINAL_534,
  C1_CLOCK_ACK,
  C1_SOCKS,
  C1_EMPTY_MEASURING,
} from '../fixtures/onebyone/eufy-c1-534.js';

// ─── OneByoneAdapter ─────────────────────────────────────────────────────────

describe('OneByoneAdapter', () => {
  function makeAdapter() {
    return new OneByoneAdapter();
  }

  describe('matches()', () => {
    it.each(['t9146', 't9147', 't9120', 'health scale'])('matches "%s"', (name) => {
      const adapter = makeAdapter();
      expect(adapter.matches(mockPeripheral(name))).toBe(true);
    });

    it('matches name containing known substring', () => {
      const adapter = makeAdapter();
      expect(adapter.matches(mockPeripheral('My T9146 Scale'))).toBe(true);
    });

    it('matches case-insensitive', () => {
      const adapter = makeAdapter();
      expect(adapter.matches(mockPeripheral('T9146'))).toBe(true);
      expect(adapter.matches(mockPeripheral('Health Scale'))).toBe(true);
    });

    it('does not match Eufy T9148/T9149 (different protocol)', () => {
      const adapter = makeAdapter();
      expect(adapter.matches(mockPeripheral('eufy T9149'))).toBe(false);
      expect(adapter.matches(mockPeripheral('eufy T9148'))).toBe(false);
    });

    it('does not match unrelated name', () => {
      const adapter = makeAdapter();
      expect(adapter.matches(mockPeripheral('Random Scale'))).toBe(false);
    });

    it('matches post-discovery by 0xFFF4 characteristic when name absent (#177)', () => {
      const adapter = makeAdapter();
      const info = mockPeripheral('', [uuid16(0xfff0)], undefined, [
        uuid16(0xfff1),
        uuid16(0xfff4),
      ]);
      expect(adapter.matches(info)).toBe(true);
    });

    it('does not match nameless device with only 0xFFF0 service and no chars (#177)', () => {
      const adapter = makeAdapter();
      expect(adapter.matches(mockPeripheral('', [uuid16(0xfff0)]))).toBe(false);
    });

    it('rejects a nameless device exposing 0xFFF4 alongside 0xFFF2 (Eufy P2, review of #251/#258)', () => {
      const adapter = makeAdapter();
      // Eufy P2 exposes fff1 + fff2 + fff4; a real 1byone never has fff2, so the
      // nameless P2 must fall through to its own adapter, not be grabbed here.
      const info = mockPeripheral('', [uuid16(0xfff0)], undefined, [
        uuid16(0xfff1),
        uuid16(0xfff2),
        uuid16(0xfff4),
      ]);
      expect(adapter.matches(info)).toBe(false);
    });
  });

  describe('onConnected()', () => {
    it('sends FD 37 mode/unit command then clock sync', async () => {
      const adapter = makeAdapter();
      const writeFn = vi.fn().mockResolvedValue(undefined);

      const ctx = makeConnectionContext({
        write: writeFn,
        read: vi.fn(),
        subscribe: vi.fn(),
        profile: defaultProfile(),
      });

      await adapter.onConnected!(ctx);

      expect(writeFn).toHaveBeenCalledTimes(2);

      // Call 1: FD 37 mode/unit command with XOR checksum
      const [charUuid1, data1, withResponse1] = writeFn.mock.calls[0];
      expect(charUuid1).toBe(adapter.charWriteUuid);
      expect(withResponse1).toBe(true);
      expect(data1[0]).toBe(0xfd);
      expect(data1[1]).toBe(0x37);
      expect(data1.length).toBe(12); // 11 bytes + XOR checksum
      // Verify XOR checksum
      let xor = 0;
      for (let i = 0; i < 11; i++) xor ^= data1[i];
      expect(data1[11]).toBe(xor & 0xff);

      // Call 2: clock sync
      const [charUuid2, data2, withResponse2] = writeFn.mock.calls[1];
      expect(charUuid2).toBe(adapter.charWriteUuid);
      expect(withResponse2).toBe(true);
      expect(data2[0]).toBe(0xf1);
      expect(data2.length).toBe(8);
      // Year should be current year
      const year = (data2[1] << 8) | data2[2];
      expect(year).toBe(new Date().getFullYear());
    });
  });

  describe('parseNotification()', () => {
    it('parses 0xCF frame with weight and impedance', () => {
      const adapter = makeAdapter();
      const buf = Buffer.alloc(10);
      buf[0] = 0xcf;
      // impedance raw: (data[2]<<8) + data[1] = (0x01<<8) + 0xF4 = 500 → * 0.1 = 50.0
      buf[1] = 0xf4;
      buf[2] = 0x01;
      buf.writeUInt16LE(8000, 3); // weight = 8000 / 100 = 80.0 kg
      buf[9] = 0; // not invalid

      const reading = adapter.parseNotification(buf);
      expect(reading).not.toBeNull();
      expect(reading!.weight).toBe(80);
      expect(reading!.impedance).toBeCloseTo(50, 1);
    });

    it('impedance is 0 when byte[9] = 1', () => {
      const adapter = makeAdapter();
      const buf = Buffer.alloc(10);
      buf[0] = 0xcf;
      buf[1] = 0xf4;
      buf[2] = 0x01;
      buf.writeUInt16LE(8000, 3);
      buf[9] = 1; // impedance invalid

      const reading = adapter.parseNotification(buf);
      expect(reading).not.toBeNull();
      expect(reading!.impedance).toBe(0);
    });

    it('impedance is 0 when raw value is 0', () => {
      const adapter = makeAdapter();
      const buf = Buffer.alloc(10);
      buf[0] = 0xcf;
      buf[1] = 0x00;
      buf[2] = 0x00;
      buf.writeUInt16LE(8000, 3);
      buf[9] = 0;

      const reading = adapter.parseNotification(buf);
      expect(reading).not.toBeNull();
      expect(reading!.impedance).toBe(0);
    });

    it('returns null for wrong header', () => {
      const adapter = makeAdapter();
      const buf = Buffer.alloc(10);
      buf[0] = 0xce; // wrong
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

  describe('weight gate and hold (#284, #534)', () => {
    function cfFrame(weightKg: number, status = 1, rawImpedance = 0): Buffer {
      const buf = Buffer.alloc(11);
      buf[0] = 0xcf;
      buf.writeUInt16LE(rawImpedance, 1);
      buf.writeUInt16LE(Math.round(weightKg * 100), 3);
      buf[9] = status;
      return buf;
    }

    it('completes the first frame, and an unequal one before any weight has repeated', () => {
      const adapter = makeAdapter();
      const f1 = adapter.parseNotification(cfFrame(80.2))!;
      expect(adapter.isComplete(f1)).toBe(true); // arms the hold
      const f2 = adapter.parseNotification(cfFrame(80.0))!;
      expect(adapter.isComplete(f2)).toBe(true);
    });

    it('holds only a repeated weight once one has repeated', () => {
      const adapter = makeAdapter();
      adapter.parseNotification(cfFrame(80.0));
      expect(adapter.isComplete(adapter.parseNotification(cfFrame(80.0))!)).toBe(true);
      expect(adapter.isComplete(adapter.parseNotification(cfFrame(80.4))!)).toBe(false);
      expect(adapter.isComplete(adapter.parseNotification(cfFrame(79.9))!)).toBe(false);
      expect(adapter.isComplete(adapter.parseNotification(cfFrame(79.9))!)).toBe(true);
    });

    it('does not count a pair of 0 kg frames as a repeated weight', () => {
      const adapter = makeAdapter();
      for (let i = 0; i < 3; i++) adapter.parseNotification(cfFrame(0));
      expect(adapter.isComplete(adapter.parseNotification(cfFrame(70.1))!)).toBe(true);
      expect(adapter.isComplete(adapter.parseNotification(cfFrame(70.3))!)).toBe(true);
    });

    it('completes a frame with an impedance whatever the weight did', () => {
      const adapter = makeAdapter();
      adapter.parseNotification(cfFrame(80.0));
      adapter.parseNotification(cfFrame(80.0));
      const r = adapter.parseNotification(cfFrame(79.5, 0, 4610))!;
      expect(r.impedance).toBe(461);
      expect(adapter.isComplete(r)).toBe(true);
    });

    it('is final on an impedance only, not on a repeated weight', () => {
      const adapter = makeAdapter();
      adapter.parseNotification(cfFrame(80.0));
      const same = adapter.parseNotification(cfFrame(80.0))!;
      expect(adapter.isFinal!(same)).toBe(false);
      const withImpedance = adapter.parseNotification(cfFrame(80.0, 0, 4610))!;
      expect(adapter.isFinal!(withImpedance)).toBe(true);
    });

    it('is final on a frame with an impedance and the 0x36 lock status', () => {
      const adapter = makeAdapter();
      expect(adapter.isFinal!(adapter.parseNotification(cfFrame(80.0, 0x36, 4610))!)).toBe(true);
    });

    it('holds for 3 s from the first weight', () => {
      expect(makeAdapter().completionHoldMs).toBe(3000);
    });

    it('re-arms the whole gate on reconnect', async () => {
      const adapter = makeAdapter();
      const ctx = makeConnectionContext({
        write: async () => {},
        read: async () => Buffer.alloc(0),
        subscribe: async () => {},
        profile: defaultProfile(),
        deviceAddress: 'AA:BB:CC:DD:EE:FF',
      });

      adapter.parseNotification(cfFrame(80));
      adapter.parseNotification(cfFrame(80));
      adapter.parseNotification(cfFrame(80));
      expect(adapter.isCompositionPending()).toBe(true);

      await adapter.onConnected(ctx);
      expect(adapter.isCompositionPending()).toBe(false);
      adapter.parseNotification(cfFrame(80.5));
      expect(adapter.isComplete(adapter.parseNotification(cfFrame(80.9))!)).toBe(true);
    });
  });

  describe('isCompositionPending()', () => {
    const pendingAfter = (frame: Buffer | string): boolean => {
      const adapter = makeAdapter();
      adapter.parseNotification(typeof frame === 'string' ? hex(frame) : frame);
      return adapter.isCompositionPending();
    };

    it('is false before any frame', () => {
      expect(makeAdapter().isCompositionPending()).toBe(false);
    });

    it('is true on a weight with the measuring status', () => {
      expect(pendingAfter(C1_SETTLED)).toBe(true);
    });

    it('is false on the frame with the impedance and on a weight with status 0x00', () => {
      expect(pendingAfter(C1_FINAL_534)).toBe(false);
      expect(pendingAfter(C1_SOCKS)).toBe(false);
    });

    it('is false on a 0 kg frame that still says measuring', () => {
      expect(pendingAfter(C1_EMPTY_MEASURING)).toBe(false);
    });

    it('follows the status byte: 0x02 is measuring, 0x00 and 0x36 are locked', () => {
      const frame = (status: number): Buffer => {
        const b = hex(C1_SETTLED);
        b[9] = status;
        return b;
      };
      expect(pendingAfter(frame(0x01))).toBe(true);
      expect(pendingAfter(frame(0x02))).toBe(true);
      expect(pendingAfter(frame(0x00))).toBe(false);
      expect(pendingAfter(frame(0x36))).toBe(false);
    });

    it('clears when a frame ends the measurement after a measuring one', () => {
      const adapter = makeAdapter();
      adapter.parseNotification(hex(C1_SETTLED));
      expect(adapter.isCompositionPending()).toBe(true);
      adapter.parseNotification(hex(C1_FINAL_534));
      expect(adapter.isCompositionPending()).toBe(false);
    });

    it('ignores the clock ack and a short frame', () => {
      const adapter = makeAdapter();
      adapter.parseNotification(hex(C1_SETTLED));
      adapter.parseNotification(hex(C1_CLOCK_ACK));
      adapter.parseNotification(hex('cf000054'));
      expect(adapter.isCompositionPending()).toBe(true);
    });

    it('says why once per session when byte 9 is not a known status', async () => {
      const debug = vi.spyOn(bleLog, 'debug').mockImplementation(() => {});
      const lines = (): string[] =>
        debug.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('1byone'));
      const withStatus = (frame: string, status: number): Buffer => {
        const b = hex(frame);
        b[9] = status;
        return b;
      };
      try {
        const adapter = makeAdapter();
        adapter.parseNotification(withStatus(C1_EMPTY_MEASURING, 0x02));
        expect(lines()).toHaveLength(0); // no weight, nothing waits on the status

        const odd = withStatus(C1_SETTLED, 0x02);
        adapter.parseNotification(odd);
        adapter.parseNotification(odd);
        expect(lines()).toHaveLength(1);
        expect(lines()[0]).toContain('0x02');

        adapter.parseNotification(hex(C1_SETTLED));
        adapter.parseNotification(hex(C1_FINAL_534));
        adapter.parseNotification(withStatus(C1_SETTLED, 0x36));
        expect(lines()).toHaveLength(1);

        const ctx = makeConnectionContext({
          write: async () => {},
          read: async () => Buffer.alloc(0),
          subscribe: async () => {},
          profile: defaultProfile(),
          deviceAddress: 'AA:BB:CC:DD:EE:FF',
        });
        await adapter.onConnected(ctx);
        adapter.parseNotification(odd);
        expect(lines()).toHaveLength(2);
      } finally {
        debug.mockRestore();
      }
    });
  });

  describe('computeMetrics()', () => {
    it('returns valid BodyComposition', () => {
      const adapter = makeAdapter();
      const profile = defaultProfile();
      const payload = adapter.computeMetrics({ weight: 80, impedance: 500 }, profile);
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

// ─── OneByoneNewAdapter ──────────────────────────────────────────────────────

describe('OneByoneNewAdapter', () => {
  function makeAdapter() {
    return new OneByoneNewAdapter();
  }

  describe('matches()', () => {
    it('matches "1byone scale" exact', () => {
      const adapter = makeAdapter();
      expect(adapter.matches(mockPeripheral('1byone scale'))).toBe(true);
    });

    it('matches case-insensitive', () => {
      const adapter = makeAdapter();
      expect(adapter.matches(mockPeripheral('1BYONE SCALE'))).toBe(true);
    });

    it('does not match "1byone" without " scale"', () => {
      const adapter = makeAdapter();
      expect(adapter.matches(mockPeripheral('1byone'))).toBe(false);
    });

    it('does not match unrelated name', () => {
      const adapter = makeAdapter();
      expect(adapter.matches(mockPeripheral('Random Scale'))).toBe(false);
    });
  });

  describe('parseNotification()', () => {
    it('parses type 0x80 weight frame', () => {
      const adapter = makeAdapter();
      const buf = Buffer.alloc(6);
      buf[0] = 0xab;
      buf[1] = 0x2a;
      buf[2] = 0x80; // weight type
      // 24-bit BE at [3-5], mask 0x03FFFF / 1000
      // 80000 & 0x03FFFF = 80000, / 1000 = 80.0 kg
      const raw = 80000;
      buf[3] = (raw >> 16) & 0xff;
      buf[4] = (raw >> 8) & 0xff;
      buf[5] = raw & 0xff;

      const reading = adapter.parseNotification(buf);
      expect(reading).not.toBeNull();
      expect(reading!.weight).toBeCloseTo(80, 1);
    });

    it('parses type 0x01 impedance frame after weight', () => {
      const adapter = makeAdapter();

      // Weight first
      const wBuf = Buffer.alloc(6);
      wBuf[0] = 0xab;
      wBuf[1] = 0x2a;
      wBuf[2] = 0x80;
      const raw = 80000;
      wBuf[3] = (raw >> 16) & 0xff;
      wBuf[4] = (raw >> 8) & 0xff;
      wBuf[5] = raw & 0xff;
      adapter.parseNotification(wBuf);

      // Then impedance
      const iBuf = Buffer.alloc(6);
      iBuf[0] = 0xab;
      iBuf[1] = 0x2a;
      iBuf[2] = 0x01;
      iBuf.writeUInt16BE(500, 4); // impedance = 500

      const reading = adapter.parseNotification(iBuf);
      expect(reading).not.toBeNull();
      expect(reading!.impedance).toBe(500);
    });

    it('returns null for type 0x00 history frame', () => {
      const adapter = makeAdapter();
      const buf = Buffer.alloc(8);
      buf[0] = 0xab;
      buf[1] = 0x2a;
      buf[2] = 0x00;
      buf[7] = 0x80; // history marker
      expect(adapter.parseNotification(buf)).toBeNull();
    });

    it('returns null for wrong header', () => {
      const adapter = makeAdapter();
      const buf = Buffer.alloc(6);
      buf[0] = 0xab;
      buf[1] = 0x2b; // wrong
      expect(adapter.parseNotification(buf)).toBeNull();
    });

    it('returns null for too-short buffer', () => {
      const adapter = makeAdapter();
      expect(adapter.parseNotification(Buffer.alloc(2))).toBeNull();
    });
  });

  describe('isComplete()', () => {
    it('returns true when weight > 0 and impedance > 0', () => {
      const adapter = makeAdapter();
      expect(adapter.isComplete({ weight: 80, impedance: 500 })).toBe(true);
    });

    it('returns false when weight is 0', () => {
      const adapter = makeAdapter();
      expect(adapter.isComplete({ weight: 0, impedance: 500 })).toBe(false);
    });

    it('completes a final weight without impedance after a short hold (D-07, D028)', () => {
      // The 0x80 final weight of a weigh-in the scale could not analyse (socks,
      // a child) is never followed by a 0x01 impedance frame. It used to be
      // refused for good, so the session timed out and the weight was lost.
      const adapter = makeAdapter();
      const wBuf = Buffer.alloc(6);
      wBuf[0] = 0xab;
      wBuf[1] = 0x2a;
      wBuf[2] = 0x80;
      const raw = 80000;
      wBuf[3] = (raw >> 16) & 0xff;
      wBuf[4] = (raw >> 8) & 0xff;
      wBuf[5] = raw & 0xff;
      const reading = adapter.parseNotification(wBuf)!;

      expect(adapter.isComplete(reading)).toBe(true);
      expect(adapter.isFinal!(reading)).toBe(false);
      expect(adapter.completionHoldMs).toBe(WEIGHT_ONLY_HOLD_MS);
    });

    it('resolves at once when the impedance frame arrives', () => {
      const adapter = makeAdapter();
      expect(adapter.isFinal!({ weight: 80, impedance: 500 })).toBe(true);
      expect(adapter.isComplete({ weight: 80, impedance: 500 })).toBe(true);
    });
  });

  describe('computeMetrics()', () => {
    it('returns valid BodyComposition', () => {
      const adapter = makeAdapter();
      const profile = defaultProfile();
      const payload = adapter.computeMetrics({ weight: 80, impedance: 500 }, profile);
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

describe('Eufy C1 weigh-ins (#533, #534)', () => {
  const trace = (name: string): Trace => c1.traces[name];

  it('waits for the frame with the impedance instead of ending on two equal frames', async () => {
    const r = await replaySession(new OneByoneAdapter(), trace('eufy-c1-534-weigh-in'), c1);
    expect(r.settled).toEqual({ by: 'reading', atMs: C1_534_FIRST_FRAME_MS + 7988 });
    expect(r.reading).toEqual({ weight: 69.65, impedance: 461 });
    expect(r.payload?.impedance).toBe(461);
  });

  it('still takes an impedance that lands after the first 8 s', async () => {
    const late: Trace = {
      ...trace('eufy-c1-534-weigh-in'),
      provenance: 'derived',
      source: 'eufy-c1-534-weigh-in with the final frame 9000 ms after the first 0xCF frame',
      steps: trace('eufy-c1-534-weigh-in').steps.map((s) =>
        s.hex === C1_FINAL_534 ? { ...s, atMs: C1_534_FIRST_FRAME_MS + 9000 } : s,
      ),
    };
    const r = await replaySession(new OneByoneAdapter(), late, c1);
    expect(r.settled).toEqual({ by: 'reading', atMs: C1_534_FIRST_FRAME_MS + 9000 });
    expect(r.reading?.impedance).toBe(461);
  });

  it('resolves at once on a final frame that comes alone', async () => {
    const r = await replaySession(new OneByoneAdapter(), trace('eufy-c1-533-final-frame'), c1);
    expect(r.settled).toEqual({ by: 'reading', atMs: 500 });
    expect(r.reading).toEqual({ weight: 69.65, impedance: 458 });
  });

  it('exports the settled weight, not a step-off frame, when no impedance comes', async () => {
    const r = await replaySession(new OneByoneAdapter(), trace('eufy-c1-534-step-off'), c1);
    expect(r.settled).toEqual({ by: 'reading', atMs: C1_534_FIRST_FRAME_MS + 8000 });
    expect(r.reading).toEqual({ weight: 69.65, impedance: 0 });
  });

  it('decodes no impedance from the frames sent while measuring', () => {
    const a = new OneByoneAdapter();
    expect(a.parseNotification(hex(C1_STEP_ON))!.impedance).toBe(0);
    expect(a.parseNotification(hex(C1_SETTLING))!.impedance).toBe(0);
    expect(a.parseNotification(hex(C1_SETTLED))!.impedance).toBe(0);
  });

  it('completes a weight without impedance and status 0x00, which is not final and not pending', () => {
    const a = new OneByoneAdapter();
    a.parseNotification(hex(C1_SETTLED));
    const socks = a.parseNotification(hex(C1_SOCKS))!;
    expect(socks.impedance).toBe(0);
    expect(a.isComplete(socks)).toBe(true);
    expect(a.isFinal!(socks)).toBe(false);
    expect(a.isCompositionPending()).toBe(false);
  });
});

// #386: this adapter parses an impedance out of the scale's frames and used to
// hand buildPayload an empty comp, so the exported body fat was the Deurenberg
// BMI estimate and the impedance was published but ignored.
//
// At 80 kg / 183 cm / 30 / male the two answers are far apart, which is the
// point: 19.37 % from BMI alone, 25.06 % from a 500 ohm BIA reading.
describe('1byone / Eufy BIA from the parsed impedance (#386)', () => {
  const BMI_ONLY_FAT = 19.37;
  const BIA_FAT_AT_500 = 25.06;

  it('computes body fat from a plausible impedance instead of from BMI', () => {
    const payload = new OneByoneAdapter().computeMetrics(
      { weight: 80, impedance: 500 },
      defaultProfile(),
    );
    expect(payload.bodyFatPercent).toBeCloseTo(BIA_FAT_AT_500, 1);
    expect(payload.impedance).toBe(500);
  });

  it('moves every derived field with it, not just the fat percentage', () => {
    const payload = new OneByoneAdapter().computeMetrics(
      { weight: 80, impedance: 500 },
      defaultProfile(),
    );
    expect(payload.physiqueRating).toBe(2);
    expect(payload.visceralFat).toBe(12);
    expect(payload.waterPercent).toBeCloseTo(54.7, 2);
  });

  it('falls back to the BMI estimate when the impedance is not a body', () => {
    // 50 is what this adapter's own synthetic fixture produces from a raw
    // 500, because of the `* 0.1` it inherited from openScale. It is not a real
    // frame: the C1 frames of #533 and #534 decode inside the 150-1200 ohm band.
    for (const impedance of [1, 149, 1201, 65535]) {
      const payload = new OneByoneAdapter().computeMetrics(
        { weight: 80, impedance },
        defaultProfile(),
      );
      expect(payload.bodyFatPercent).toBeCloseTo(BMI_ONLY_FAT, 1);
    }
  });

  it('still falls back when no impedance was measured at all', () => {
    const payload = new OneByoneAdapter().computeMetrics(
      { weight: 80, impedance: 0 },
      defaultProfile(),
    );
    expect(payload.bodyFatPercent).toBeCloseTo(BMI_ONLY_FAT, 1);
  });
});

// #386: this adapter parses an impedance out of the scale's frames and used to
// hand buildPayload an empty comp, so the exported body fat was the Deurenberg
// BMI estimate and the impedance was published but ignored.
//
// At 80 kg / 183 cm / 30 / male the two answers are far apart, which is the
// point: 19.37 % from BMI alone, 25.06 % from a 500 ohm BIA reading.
describe('1byone Scale (new protocol) BIA from the parsed impedance (#386)', () => {
  const BMI_ONLY_FAT = 19.37;
  const BIA_FAT_AT_500 = 25.06;

  it('computes body fat from a plausible impedance instead of from BMI', () => {
    const payload = new OneByoneNewAdapter().computeMetrics(
      { weight: 80, impedance: 500 },
      defaultProfile(),
    );
    expect(payload.bodyFatPercent).toBeCloseTo(BIA_FAT_AT_500, 1);
    expect(payload.impedance).toBe(500);
  });

  it('moves every derived field with it, not just the fat percentage', () => {
    const payload = new OneByoneNewAdapter().computeMetrics(
      { weight: 80, impedance: 500 },
      defaultProfile(),
    );
    expect(payload.physiqueRating).toBe(2);
    expect(payload.visceralFat).toBe(12);
    expect(payload.waterPercent).toBeCloseTo(54.7, 2);
  });

  it('falls back to the BMI estimate when the impedance is not a body', () => {
    for (const impedance of [1, 149, 1201, 65535]) {
      const payload = new OneByoneNewAdapter().computeMetrics(
        { weight: 80, impedance },
        defaultProfile(),
      );
      expect(payload.bodyFatPercent).toBeCloseTo(BMI_ONLY_FAT, 1);
    }
  });

  it('still falls back when no impedance was measured at all', () => {
    const payload = new OneByoneNewAdapter().computeMetrics(
      { weight: 80, impedance: 0 },
      defaultProfile(),
    );
    expect(payload.bodyFatPercent).toBeCloseTo(BMI_ONLY_FAT, 1);
  });
});

describe('1byone / Eufy: the 0.1 factor and the band (#386)', () => {
  it('refuses a 50 ohm reading, which is what raw 500 decodes to here', () => {
    // Raw 500 in the synthetic frames decodes to 50.0, and a body does not read
    // 50 ohm. A real C1 frame decodes inside the band, so that fixture is not a
    // real frame. Either way 50 must not drive a body composition.
    const payload = new OneByoneAdapter().computeMetrics(
      { weight: 80, impedance: 50 },
      defaultProfile(),
    );
    expect(payload.bodyFatPercent).toBeCloseTo(19.37, 1);
    // The number is still published; it is only refused as a BIA input.
    expect(payload.impedance).toBe(50);
  });
});
