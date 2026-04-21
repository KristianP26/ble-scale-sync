import { describe, it, expect } from 'vitest';
import { createCipheriv, createHash } from 'node:crypto';
import {
  EufyAuthHandler,
  EufyP2Adapter,
  buildSubContract,
  parseEufyAdvertisement,
  parseWeightNotification,
} from '../../src/scales/eufy-p2.js';
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

/** Build a 16-byte FFF2 weight notification. */
function makeNotification(weightKg: number, impedance: number, isFinal = true): Buffer {
  const buf = Buffer.alloc(16);
  buf[0] = 0xcf;
  buf[2] = 0x00;
  buf.writeUInt16LE(Math.round(weightKg * 100), 6);
  buf[8] = impedance & 0xff;
  buf[9] = (impedance >> 8) & 0xff;
  buf[10] = (impedance >> 16) & 0xff;
  buf[12] = isFinal ? 0x00 : 0x01;
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
  it('parses final weight + impedance', () => {
    const buf = makeNotification(83.45, 543);
    expect(parseWeightNotification(buf)).toEqual({ weight: 83.45, impedance: 543 });
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
});
