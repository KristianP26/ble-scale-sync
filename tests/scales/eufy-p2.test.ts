import type { ConnectionContext } from '../../src/interfaces/scale-adapter.js';
import { describe, it, expect, vi } from 'vitest';
import { createCipheriv, createHash } from 'node:crypto';
import {
  EufyAuthHandler,
  EufyP2Adapter,
  buildSubContract,
  frameIntegrityProblems,
  parseEufyAdvertisement,
  parseWeightNotification,
} from '../../src/scales/eufy-p2.js';
import { xorChecksum } from '../../src/scales/body-comp-helpers.js';
import { bleLog } from '../../src/ble/types.js';
import type { BleDeviceInfo } from '../../src/interfaces/scale-adapter.js';
import { defaultProfile, assertPayloadRanges } from '../helpers/scale-test-utils.js';

const TEST_MAC = 'CF:E6:03:1D:09:F7';
const TEST_MAC_FLAT = 'CFE6031D09F7';
const IV = Buffer.from('0000000000000000', 'ascii');

/** Build a vendor advertisement payload (19 bytes) for a given weight + final flag. */
function makeVendor(weightKg: number, finalFlag = 0x00): Buffer {
  const buf = Buffer.alloc(19);
  // [0..5] MAC, [6] 0xCF, [7] HR, [8] flags, [9..10] weight LE, [15] final
  Buffer.from(TEST_MAC_FLAT, 'hex').copy(buf, 0);
  buf[6] = 0xcf;
  buf.writeUInt16LE(Math.round(weightKg * 100), 9);
  buf[15] = finalFlag;
  return buf;
}

/**
 * Build a 16-byte FFF2 weight notification. `validIntegrity` fills the length
 * byte and the trailing XOR the way real hardware does (#289); pass false to
 * build a frame that violates both, which must still parse.
 */
function makeNotification(
  weightKg: number,
  impedance: number,
  isFinal = true,
  validIntegrity = true,
): Buffer {
  const buf = Buffer.alloc(16);
  buf[0] = 0xcf;
  buf[2] = 0x00;
  buf.writeUInt16LE(Math.round(weightKg * 100), 6);
  buf[8] = impedance & 0xff;
  buf[9] = (impedance >> 8) & 0xff;
  buf[10] = (impedance >> 16) & 0xff;
  buf[12] = isFinal ? 0x00 : 0x01;
  if (validIntegrity) {
    buf[1] = 14;
    buf[15] = xorChecksum(buf, 2, 15);
  }
  return buf;
}

/** Emulate scale side: respond to C0 with a C1 carrying an AES-encrypted device UUID. */
function makeC1Frames(mac: string, deviceUuid: string): Buffer[] {
  const key = createHash('md5').update(mac.replace(/[:-]/g, '').toUpperCase(), 'utf8').digest();
  const cipher = createCipheriv('aes-128-cbc', key, IV);
  const encrypted = Buffer.concat([cipher.update(deviceUuid, 'utf8'), cipher.final()]);
  const base64Ascii = Buffer.from(encrypted.toString('base64'), 'ascii');
  const base64Hex = base64Ascii.toString('hex');
  return buildSubContract(base64Hex, 0xc1);
}

describe('EufyAuthHandler', () => {
  it('derives AES key from MAC via MD5', () => {
    const h = new EufyAuthHandler(TEST_MAC);
    const expected = createHash('md5').update(TEST_MAC_FLAT, 'utf8').digest();
    expect(h.key.equals(expected)).toBe(true);
  });

  it('rejects invalid MAC', () => {
    expect(() => new EufyAuthHandler('not-a-mac')).toThrow(/invalid MAC/);
  });

  it('generates a 15-char client uuid by default', () => {
    const h = new EufyAuthHandler(TEST_MAC);
    expect(h.clientUuid).toHaveLength(15);
  });

  it('builds C0 frames with correct header and XOR checksum', () => {
    const h = new EufyAuthHandler(TEST_MAC, 'abcdef123456789');
    const frames = h.buildC0();
    expect(frames).toHaveLength(2);
    // Each frame: C0 <numSegs=2> <segIdx> <totalBytes=24> <15 payload> <XOR>
    expect(frames[0][0]).toBe(0xc0);
    expect(frames[0][1]).toBe(0x02);
    expect(frames[0][2]).toBe(0x00);
    expect(frames[0][3]).toBe(0x18);
    expect(frames[1][2]).toBe(0x01);
    // XOR of all preceding bytes == last byte
    for (const frame of frames) {
      const body = frame.subarray(0, frame.length - 1);
      let xor = 0;
      for (const b of body) xor ^= b;
      expect(frame[frame.length - 1]).toBe(xor);
    }
  });

  it('completes full C0/C1/C2/C3 handshake', () => {
    const h = new EufyAuthHandler(TEST_MAC, 'abcdef123456789');
    const c0 = h.buildC0();
    expect(c0.length).toBeGreaterThan(0);

    // Scale responds with C1 carrying an AES-encrypted device UUID
    const c1Frames = makeC1Frames(TEST_MAC, 'DEVICEUUID12345');
    let c1Done = false;
    for (const f of c1Frames) c1Done = h.handleC1(f) || c1Done;
    expect(c1Done).toBe(true);
    expect(h.deviceUuidOrNull).toBe('DEVICEUUID12345');

    const c2 = h.buildC2();
    expect(c2.length).toBeGreaterThan(0);
    expect(c2[0][0]).toBe(0xc2);

    const c3 = Buffer.from([0xc3, 0x01, 0x00, 0x01, 0x00, 0xc3]);
    expect(h.handleC3(c3)).toBe(true);
    expect(h.isAuthenticated).toBe(true);

    const c3Fail = Buffer.from([0xc3, 0x01, 0x00, 0x01, 0x01, 0xc2]);
    const h2 = new EufyAuthHandler(TEST_MAC);
    h2.handleC3(c3Fail);
    expect(h2.isAuthenticated).toBe(false);
  });

  it('buildC2 before C1 throws', () => {
    const h = new EufyAuthHandler(TEST_MAC);
    expect(() => h.buildC2()).toThrow(/before C1/);
  });
});

describe('buildSubContract', () => {
  it('fragments at 15 bytes of base64 ASCII per segment', () => {
    // 44-char base64 -> 88 hex chars -> 3 segments (30+30+28)
    const dataHex = Buffer.from('A'.repeat(44), 'ascii').toString('hex');
    const frames = buildSubContract(dataHex, 0xc2);
    expect(frames).toHaveLength(3);
    expect(frames[0][1]).toBe(3);
    expect(frames[0][3]).toBe(44);
    expect(frames.map((f) => f[2])).toEqual([0, 1, 2]);
  });

  it('single-segment payload when short', () => {
    const dataHex = Buffer.from('ABCDE', 'ascii').toString('hex');
    const frames = buildSubContract(dataHex, 0xc0);
    expect(frames).toHaveLength(1);
    expect(frames[0][3]).toBe(5);
  });
});

describe('parseWeightNotification', () => {
  it('parses final weight; impedance is weight-only (bytes 8..10 are not a usable resistance, #289)', () => {
    const buf = makeNotification(83.45, 543);
    expect(parseWeightNotification(buf)).toEqual({ weight: 83.45, impedance: 0 });
  });

  it('returns null for non-final frame', () => {
    expect(parseWeightNotification(makeNotification(83.45, 543, false))).toBeNull();
  });

  it('returns null for wrong signature bytes', () => {
    const buf = makeNotification(83.45, 543);
    buf[0] = 0xee;
    expect(parseWeightNotification(buf)).toBeNull();
  });

  it('returns null for wrong length', () => {
    expect(parseWeightNotification(Buffer.alloc(10))).toBeNull();
  });

  it('returns null for out-of-range weight', () => {
    const buf = makeNotification(0.5, 400);
    expect(parseWeightNotification(buf)).toBeNull();
  });
});

describe('parseEufyAdvertisement', () => {
  it('parses final weight from 19-byte vendor payload', () => {
    const buf = makeVendor(75.2);
    expect(parseEufyAdvertisement(buf)).toEqual({ weight: 75.2, impedance: 0 });
  });

  it('returns null when not final', () => {
    expect(parseEufyAdvertisement(makeVendor(75.2, 0x02))).toBeNull();
  });

  it('returns null without 0xCF signature', () => {
    const buf = makeVendor(75.2);
    buf[6] = 0x00;
    expect(parseEufyAdvertisement(buf)).toBeNull();
  });
});

describe('EufyP2Adapter', () => {
  it('matches by device name', () => {
    const adapter = new EufyP2Adapter();
    const p: BleDeviceInfo = { localName: 'eufy T9149', serviceUuids: [] };
    expect(adapter.matches(p)).toBe(true);
  });

  it('matches T9148', () => {
    const adapter = new EufyP2Adapter();
    const p: BleDeviceInfo = { localName: 'eufy T9148', serviceUuids: [] };
    expect(adapter.matches(p)).toBe(true);
  });

  it('matches passive via company ID 0xFF48 + 0xCF signature', () => {
    const adapter = new EufyP2Adapter();
    const p: BleDeviceInfo = {
      localName: '',
      serviceUuids: [],
      manufacturerData: { id: 0xff48, data: makeVendor(80) },
    };
    expect(adapter.matches(p)).toBe(true);
  });

  it('does not match QN scale names', () => {
    const adapter = new EufyP2Adapter();
    const p: BleDeviceInfo = { localName: 'QN-Scale', serviceUuids: ['fff0'] };
    expect(adapter.matches(p)).toBe(false);
  });

  it('parseBroadcast produces valid ScaleReading', () => {
    const adapter = new EufyP2Adapter();
    const reading = adapter.parseBroadcast!(makeVendor(72.5));
    expect(reading).toEqual({ weight: 72.5, impedance: 0 });
    expect(adapter.isComplete(reading!)).toBe(true);
  });

  it('computeMetrics returns a well-formed payload with BIA impedance', () => {
    const adapter = new EufyP2Adapter();
    const payload = adapter.computeMetrics({ weight: 83.45, impedance: 543 }, defaultProfile());
    expect(payload.weight).toBe(83.45);
    expect(payload.impedance).toBe(543);
    assertPayloadRanges(payload);
  });

  it('computeMetrics without impedance falls back to Deurenberg BMI formula', () => {
    const adapter = new EufyP2Adapter();
    const payload = adapter.computeMetrics({ weight: 72.5, impedance: 0 }, defaultProfile());
    expect(payload.impedance).toBe(0);
    assertPayloadRanges(payload);
  });

  it('rejects FFF2 weight frames when onConnected had no deviceAddress (no stale auth)', async () => {
    const adapter = new EufyP2Adapter();

    // First session: authenticate fully so adapter holds a live EufyAuthHandler.
    const writes: Buffer[] = [];
    const ctx = {
      write: async (_uuid: string, data: Buffer | number[]) => {
        writes.push(Buffer.isBuffer(data) ? data : Buffer.from(data));
      },
      read: async () => Buffer.alloc(0),
      subscribe: async () => {},
      profile: defaultProfile(),
      deviceAddress: TEST_MAC_FLAT,
    };
    await adapter.onConnected(ctx);
    const c1 = makeC1Frames(TEST_MAC, 'DEVICEUUID12345');
    for (const f of c1) adapter.parseCharNotification!('fff4', f);
    adapter.parseCharNotification!('fff4', Buffer.from([0xc3, 0x01, 0x00, 0x01, 0x00, 0xc3]));
    expect(adapter.parseCharNotification!('fff2', makeNotification(75, 500))).not.toBeNull();

    // Second session without a MAC: adapter must NOT keep the old auth.
    // onSessionStart runs first in the real handler and is what drops `auth`.
    adapter.onSessionStart();
    await adapter.onConnected({ ...ctx, deviceAddress: '' });
    expect(adapter.parseCharNotification!('fff2', makeNotification(75, 500))).toBeNull();
  });

  describe('weight-stability gate (#284)', () => {
    it('holds until two consecutive final frames report the same weight', () => {
      const adapter = new EufyP2Adapter();

      const f1 = adapter.parseNotification(makeNotification(80.1, 520))!;
      expect(adapter.isComplete(f1)).toBe(true); // permissive: arms the hold
      expect(adapter.isFinal!(f1)).toBe(false); // not settled yet

      const f2 = adapter.parseNotification(makeNotification(80.0, 520))!;
      expect(adapter.isFinal!(f2)).toBe(false); // weight still changing

      const f3 = adapter.parseNotification(makeNotification(80.0, 520))!;
      expect(adapter.isFinal!(f3)).toBe(true); // stable
    });

    it('keeps isComplete permissive so a lone final frame is still a resolvable fallback', () => {
      const adapter = new EufyP2Adapter();
      // A single final frame that never repeats: isComplete true (so shared.ts
      // holds it and can resolve it on disconnect), isFinal false (not settled).
      const only = adapter.parseNotification(makeNotification(80, 520))!;
      expect(adapter.isComplete(only)).toBe(true);
      expect(adapter.isFinal!(only)).toBe(false);
      expect(adapter.completionHoldMs).toBeGreaterThan(0);
    });

    it('re-arms stability per connection', async () => {
      const adapter = new EufyP2Adapter();
      const ctx = {
        write: async () => {},
        read: async () => Buffer.alloc(0),
        subscribe: async () => {},
        profile: defaultProfile(),
        deviceAddress: '',
      };

      adapter.parseNotification(makeNotification(80, 500));
      const stable = adapter.parseNotification(makeNotification(80, 500))!;
      expect(adapter.isFinal!(stable)).toBe(true);

      adapter.onSessionStart(); // resets stability even without a MAC
      await adapter.onConnected(ctx);
      const afterReset = adapter.parseNotification(makeNotification(80, 500))!;
      expect(adapter.isFinal!(afterReset)).toBe(false); // previous weight cleared
    });
  });
});

// ─── SegmentReassembler integrity (via handleC1 which uses it) ─────────────

describe('SegmentReassembler', () => {
  it('rejects C1 segment with a tampered XOR checksum', () => {
    const h = new EufyAuthHandler(TEST_MAC, 'abcdef123456789');
    const c1Frames = makeC1Frames(TEST_MAC, 'DEVICEUUID12345');
    // Corrupt the last byte (XOR) on the first segment
    const bad = Buffer.from(c1Frames[0]);
    bad[bad.length - 1] ^= 0xff;
    expect(h.handleC1(bad)).toBe(false);
    // A valid follow-up frame for segment 0 should still work
    expect(h.handleC1(c1Frames[0])).toBe(c1Frames.length === 1);
  });

  it('rejects C1 reassembly when total length does not match advertised', () => {
    const h = new EufyAuthHandler(TEST_MAC, 'abcdef123456789');
    const c1Frames = makeC1Frames(TEST_MAC, 'DEVICEUUID12345');
    if (c1Frames.length < 2) return; // only meaningful with multi-segment

    // Mutate frame[3] (totalBytes) on first segment so reassembled length mismatches
    const tampered = Buffer.from(c1Frames[0]);
    tampered[3] = (tampered[3] + 1) & 0xff;
    // Recompute XOR so the segment itself passes the checksum
    let x = 0;
    for (let i = 0; i < tampered.length - 1; i++) x ^= tampered[i];
    tampered[tampered.length - 1] = x;

    expect(h.handleC1(tampered)).toBe(false);
    // Feed remaining untouched segments; the final one should drop on length mismatch
    for (let i = 1; i < c1Frames.length; i++) {
      expect(h.handleC1(c1Frames[i])).toBe(false);
    }
  });
});

/**
 * Three real P2 Pro FFF2 frames supplied in #289, each with the body fat the
 * Eufy app reported for the same weigh-in. They pin the frame layout and the
 * impedance decode (#289).
 */
const REAL_FRAMES = [
  {
    bytes: [0xcf, 0x0e, 0x00, 0xcf, 0x08, 0x11, 0x56, 0x22, 0x08, 0x03, 0x88, 0, 0, 0, 0, 0x21],
    weight: 87.9,
    appFat: 30.1,
  },
  {
    bytes: [0xcf, 0x0e, 0x00, 0xcf, 0x72, 0x10, 0x2e, 0x22, 0xee, 0xe7, 0x10, 0, 0, 0, 0, 0xb8],
    weight: 87.5,
    appFat: 29.5,
  },
  {
    bytes: [0xcf, 0x0e, 0x00, 0xcf, 0x4a, 0x10, 0x3d, 0x22, 0x39, 0x34, 0x29, 0, 0, 0, 0, 0xae],
    weight: 87.65,
    appFat: 29.8,
  },
].map((f) => ({ ...f, buf: Buffer.from(f.bytes) }));

describe('#289 real P2 Pro frames', () => {
  it('every fixture is a 16-byte frame', () => {
    for (const f of REAL_FRAMES) expect(f.buf.length).toBe(16);
  });

  it('decodes the app-reported weight and the impedance at [4..5] / 10', () => {
    for (const f of REAL_FRAMES) {
      expect(parseWeightNotification(f.buf)).toEqual({
        weight: f.weight,
        impedance: f.buf.readUInt16LE(4) / 10,
      });
    }
  });

  it('byte [1] is the payload length', () => {
    for (const f of REAL_FRAMES) expect(f.buf[1]).toBe(f.buf.length - 2);
  });

  it('byte [15] is the XOR over bytes [2..14]', () => {
    for (const f of REAL_FRAMES) expect(xorChecksum(f.buf, 2, 15)).toBe(f.buf[15]);
  });

  it('reports no integrity problems for real frames', () => {
    for (const f of REAL_FRAMES) expect(frameIntegrityProblems(f.buf)).toEqual([]);
  });

  // The frames below are the ones that settled the #289 decode. Bytes [4..5]
  // and [8..10] are both zero exactly when the vendor app reported no body fat,
  // so one of them carries the BIA payload; what picks [4..5] is the direction
  // between the two people. Person 1 (88.00 kg, app 30.4 %) must have the LOWER
  // resistance of the two, and [4..5] says so (470 vs 677 ohm) while every
  // reading of [8..10] makes person 1 the larger by 2.4x to 3.8x.
  const BIA_FRAMES = {
    person1: Buffer.from([
      0xcf, 0x0e, 0x00, 0xcf, 0x5c, 0x12, 0x60, 0x22, 0x11, 0x13, 0xf1, 0, 0, 0, 0, 0x30,
    ]),
    person2: Buffer.from([
      0xcf, 0x0e, 0x00, 0xcf, 0x72, 0x1a, 0xbd, 0x1a, 0x06, 0x05, 0x62, 0, 0, 0, 0, 0x61,
    ]),
    socksOn: Buffer.from([
      0xcf, 0x0e, 0x00, 0xcf, 0x00, 0x00, 0x60, 0x22, 0, 0, 0, 0, 0, 0, 0, 0x8d,
    ]),
    shod: Buffer.from([0xcf, 0x0e, 0x00, 0xcf, 0x00, 0x00, 0xd6, 0x1a, 0, 0, 0, 0, 0, 0, 0, 0x03]),
  };

  it('decodes impedance from the two sessions where the app reported body fat', () => {
    expect(parseWeightNotification(BIA_FRAMES.person1)).toEqual({ weight: 88, impedance: 470 });
    expect(parseWeightNotification(BIA_FRAMES.person2)).toEqual({ weight: 68.45, impedance: 677 });
  });

  it('reports impedance 0 for the sessions where the app reported none', () => {
    expect(parseWeightNotification(BIA_FRAMES.socksOn)).toEqual({ weight: 88, impedance: 0 });
    expect(parseWeightNotification(BIA_FRAMES.shod)).toEqual({ weight: 68.7, impedance: 0 });
  });

  it('person 1 measures the lower resistance, which is what rules out [8..10]', () => {
    const r1 = BIA_FRAMES.person1.readUInt16LE(4);
    const r2 = BIA_FRAMES.person2.readUInt16LE(4);
    expect(r1).toBeLessThan(r2);
    // Every reading of [8..10] has the opposite (wrong) ordering.
    expect(BIA_FRAMES.person1.readUInt16LE(8)).toBeGreaterThan(BIA_FRAMES.person2.readUInt16LE(8));
  });

  it('drops an out-of-range resistance rather than publishing a clamped body fat', () => {
    const buf = Buffer.from(BIA_FRAMES.person1);
    buf.writeUInt16LE(20000, 4); // 2000 ohm, above the accepted band
    buf[15] = xorChecksum(buf, 2, 15);
    expect(parseWeightNotification(buf)).toEqual({ weight: 88, impedance: 0 });
  });

  // The BIA result and the settled weight need not arrive in the same frame, and
  // the #284 stability gate resolves on two consecutive equal-weight final
  // frames. Without the latch, the second frame would export weight-only.
  it('carries a measured impedance across later zero-BIA frames in the session', () => {
    const adapter = new EufyP2Adapter();
    expect(adapter.parseNotification(BIA_FRAMES.person1)?.impedance).toBe(470);
    const later = Buffer.from(BIA_FRAMES.person1);
    later.writeUInt16LE(0, 4);
    later[15] = xorChecksum(later, 2, 15);
    expect(adapter.parseNotification(later)).toEqual({ weight: 88, impedance: 470 });
  });

  it('does not carry the impedance onto a different body', () => {
    const adapter = new EufyP2Adapter();
    expect(adapter.parseNotification(BIA_FRAMES.person1)?.impedance).toBe(470);
    // Person 2 steps on during the same connection with no BIA of their own.
    const other = Buffer.from(BIA_FRAMES.person2);
    other.writeUInt16LE(0, 4);
    other[15] = xorChecksum(other, 2, 15);
    expect(adapter.parseNotification(other)).toEqual({ weight: 68.45, impedance: 0 });
  });

  it('clears the latched impedance when a new session starts', async () => {
    const adapter = new EufyP2Adapter();
    expect(adapter.parseNotification(BIA_FRAMES.person1)?.impedance).toBe(470);

    // A fresh connection must not inherit it: adapters are shared singletons.
    adapter.onSessionStart!();
    await adapter.onConnected!({
      profile: { height: 180, age: 30, gender: 'male', isAthlete: false },
      deviceAddress: '',
      availableChars: new Set<string>(),
      write: async () => {},
      read: async () => Buffer.alloc(0),
      subscribe: async () => {},
    } as unknown as ConnectionContext).catch(() => {});

    const zeroBia = Buffer.from(BIA_FRAMES.person1);
    zeroBia.writeUInt16LE(0, 4);
    zeroBia[15] = xorChecksum(zeroBia, 2, 15);
    expect(adapter.parseNotification(zeroBia)).toEqual({ weight: 88, impedance: 0 });
  });

  it('drops the impedance (but keeps the weight) when the frame fails its XOR', () => {
    const buf = Buffer.from(BIA_FRAMES.person1);
    buf[15] = 0xff;
    expect(frameIntegrityProblems(buf).join()).toContain('xor');
    expect(parseWeightNotification(buf)).toEqual({ weight: 88, impedance: 0 });
  });
});

describe('#289 frame integrity is observed, never enforced', () => {
  it('still parses a frame with a corrupt XOR', () => {
    const buf = makeNotification(80, 500, true, false);
    buf[1] = 14;
    buf[15] = 0xff; // deliberately wrong
    expect(frameIntegrityProblems(buf).join()).toContain('xor');
    expect(parseWeightNotification(buf)).toEqual({ weight: 80, impedance: 0 });
  });

  it('still parses a frame with a wrong length byte', () => {
    const buf = makeNotification(80, 500, true, false);
    buf[15] = xorChecksum(buf, 2, 15);
    expect(frameIntegrityProblems(buf).join()).toContain('length byte');
    expect(parseWeightNotification(buf)).toEqual({ weight: 80, impedance: 0 });
  });

  it('ignores buffers that are not 16-byte CF frames', () => {
    expect(frameIntegrityProblems(Buffer.alloc(8))).toEqual([]);
    expect(frameIntegrityProblems(Buffer.alloc(16))).toEqual([]);
  });

  it('logs the mismatch once per session, not once per frame', () => {
    const debugSpy = vi.spyOn(bleLog, 'debug').mockImplementation(() => {});
    const adapter = new EufyP2Adapter();
    const bad = makeNotification(80, 500, true, false);

    adapter.parseNotification(bad);
    adapter.parseNotification(bad);

    const hits = debugSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((m) => m.includes('frame integrity mismatch'));
    expect(hits).toHaveLength(1);
    debugSpy.mockRestore();
  });
});
