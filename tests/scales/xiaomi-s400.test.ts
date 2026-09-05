import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createCipheriv } from 'node:crypto';
import {
  XiaomiS400Adapter,
  decodeS400Measurement,
  OBJ_S400_MEASUREMENT,
  S400_PIDS,
} from '../../src/scales/xiaomi-s400.js';
import { macFrameOrderFromAddress } from '../../src/scales/mibeacon.js';
import { computeMiScaleComposition } from '../../src/scales/mi-scale-2.js';
import { bleLog } from '../../src/ble/types.js';
import { expectValidMetrics } from '../helpers/scale-test-utils.js';

// Synthetic frames are built below with a dummy key. The four frames in the
// "reference vectors" block are the public fixtures from the Apache-2.0
// xiaomi-ble test-suite (https://github.com/Bluetooth-Devices/xiaomi-ble, tests/test_parser.py,
// test_Xiaomi_Scale_S400_*), reused here so this decoder is provably
// byte-compatible with Home Assistant's.
const DUMMY_KEY = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex');
const MAC_FRAME = Buffer.from('530870aceA1c'.toLowerCase(), 'hex'); // 1C:EA:AC:70:08:53 reversed
const PID = 0x3bd5;

interface Fields {
  profile?: number;
  kg?: number;
  hr?: number;
  ohm?: number;
  ts?: number;
}

/** Build the 9-byte 0x6e16 value with the S400 bit packing. */
function measurementValue({ profile = 1, kg = 0, hr = 0, ohm = 0, ts = 1_700_000_000 }: Fields) {
  const mass = Math.round(kg * 10) & 0x7ff;
  const hrRaw = hr > 0 ? (hr - 50) & 0x7f : 0;
  const z = Math.round(ohm * 10) & 0x3fff;
  const packed = (mass | (hrRaw << 11) | (z << 18)) >>> 0;
  const v = Buffer.alloc(9);
  v[0] = profile;
  v.writeUInt32LE(packed, 1);
  v.writeUInt32LE(ts, 5);
  return v;
}

function measurementObject(f: Fields): Buffer {
  const v = measurementValue(f);
  return Buffer.concat([
    Buffer.from([OBJ_S400_MEASUREMENT & 0xff, OBJ_S400_MEASUREMENT >> 8, v.length]),
    v,
  ]);
}

/**
 * Encrypt an object list into a full FE95 frame. `includeMac` selects the
 * MAC-included variant (FC 0x5958) over the S400's MAC-omitted one (FC 0x5948).
 */
function encryptFrame(
  obj: Buffer,
  key: Buffer,
  macFrame: Buffer,
  { cnt = 0x0a, includeMac = false, pid = PID } = {},
): Buffer {
  const fc = Buffer.from([includeMac ? 0x58 : 0x48, 0x59]);
  const pidBuf = Buffer.from([pid & 0xff, pid >> 8]);
  const ext = Buffer.from([0x00, 0x00, 0x00]);
  const nonce = Buffer.concat([macFrame, Buffer.from([pidBuf[0], pidBuf[1], cnt]), ext]);
  const cipher = createCipheriv('aes-128-ccm', key, nonce, { authTagLength: 4 });
  cipher.setAAD(Buffer.from([0x11]), { plaintextLength: obj.length });
  const enc = Buffer.concat([cipher.update(obj), cipher.final()]);
  const parts = [fc, pidBuf, Buffer.from([cnt])];
  if (includeMac) parts.push(macFrame);
  parts.push(enc, ext, cipher.getAuthTag());
  return Buffer.concat(parts);
}

/** The unencrypted idle beacon: FC 0x5a30, MAC + capability byte, no object. */
const IDLE_BEACON = Buffer.concat([
  Buffer.from([0x30, 0x5a, PID & 0xff, PID >> 8, 0x00]),
  MAC_FRAME,
  Buffer.from([0x08]),
]);

function configured(scaleMac?: string): XiaomiS400Adapter {
  const a = new XiaomiS400Adapter();
  a.configure({ bindKey: DUMMY_KEY.toString('hex'), scaleMac });
  return a;
}

describe('decodeS400Measurement', () => {
  it('unpacks weight, heart rate and impedance from the packed word', () => {
    const m = decodeS400Measurement(measurementValue({ profile: 2, kg: 82.4, hr: 71, ohm: 512.3 }));
    expect(m).toEqual({
      kind: 'weight',
      profileId: 2,
      weight: 82.4,
      impedance: 512.3,
      heartRate: 71,
      timestamp: 1_700_000_000,
    });
  });

  it('reports a heart rate of 0 / 127 raw as absent', () => {
    expect(decodeS400Measurement(measurementValue({ kg: 70 }))?.heartRate).toBeNull();
    // raw 127 is the "no reading" sentinel (would decode to 177 bpm)
    expect(decodeS400Measurement(measurementValue({ kg: 70, hr: 177 }))?.heartRate).toBeNull();
  });

  it('classifies the impedance-only frame and the all-zero reset', () => {
    expect(decodeS400Measurement(measurementValue({ ohm: 497.6 }))?.kind).toBe('impedance-high');
    expect(decodeS400Measurement(measurementValue({}))?.kind).toBe('reset');
  });

  it('rejects a short value', () => {
    expect(decodeS400Measurement(Buffer.alloc(8))).toBeNull();
  });
});

describe('XiaomiS400Adapter.matches', () => {
  const adapter = new XiaomiS400Adapter();

  it('matches an FE95 advertisement carrying an S400 product id', () => {
    for (const pid of S400_PIDS) {
      const sd = Buffer.from([0x30, 0x5a, pid & 0xff, pid >> 8, 0x00, 0, 0, 0, 0, 0, 0, 0x08]);
      expect(
        adapter.matches({
          localName: '',
          serviceUuids: [],
          serviceData: [{ uuid: 'fe95', data: sd }],
        }),
      ).toBe(true);
    }
  });

  it('matches by the advertised name', () => {
    expect(
      adapter.matches({ localName: 'Xiaomi Scale S400 0853', serviceUuids: [], serviceData: [] }),
    ).toBe(true);
  });

  it('does not match the S800 product id or other Xiaomi scales', () => {
    const s800 = Buffer.from([0x58, 0x59, 0xe2, 0x51, 0x5b, 0, 0, 0, 0, 0, 0]);
    expect(
      adapter.matches({
        localName: '',
        serviceUuids: [],
        serviceData: [{ uuid: 'fe95', data: s800 }],
      }),
    ).toBe(false);
    expect(adapter.matches({ localName: 'MIBFS', serviceUuids: [] })).toBe(false);
    expect(adapter.matches({ localName: 'Mijia Scale S800 A1AB', serviceUuids: [] })).toBe(false);
    expect(adapter.matches({ localName: 'QN-Scale', serviceUuids: ['fff0'] })).toBe(false);
  });
});

describe('XiaomiS400Adapter.parseServiceData', () => {
  beforeEach(() => {
    vi.spyOn(bleLog, 'info').mockImplementation(() => {});
    vi.spyOn(bleLog, 'warn').mockImplementation(() => {});
    vi.spyOn(bleLog, 'debug').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('decrypts a MAC-omitted weight frame using the MAC cached from the idle beacon', () => {
    const a = configured();
    expect(a.parseServiceData('fe95', IDLE_BEACON)).toBeNull();
    const frame = encryptFrame(
      measurementObject({ kg: 82.4, hr: 71, ohm: 512.3 }),
      DUMMY_KEY,
      MAC_FRAME,
    );
    expect(a.parseServiceData('fe95', frame)).toEqual({ weight: 82.4, impedance: 512.3 });
  });

  it('falls back to ble.scale_mac when no idle beacon was seen', () => {
    const a = configured('1C:EA:AC:70:08:53');
    const frame = encryptFrame(measurementObject({ kg: 82.4, ohm: 512.3 }), DUMMY_KEY, MAC_FRAME);
    expect(a.parseServiceData('fe95', frame)).toEqual({ weight: 82.4, impedance: 512.3 });
  });

  // The class comment calls ble.scale_mac the fallback; this pins the code to
  // that, so a typo in the config cannot beat a MAC actually seen on air.
  it('prefers the MAC seen on air over a wrong one in the config', () => {
    const a = configured('AA:BB:CC:DD:EE:FF');
    expect(a.parseServiceData('fe95', IDLE_BEACON)).toBeNull();
    const frame = encryptFrame(measurementObject({ kg: 82.4, ohm: 512.3 }), DUMMY_KEY, MAC_FRAME);
    expect(a.parseServiceData('fe95', frame)).toEqual({ weight: 82.4, impedance: 512.3 });
  });

  it('returns null and warns once when the MAC is unknown', () => {
    const a = configured();
    const frame = encryptFrame(measurementObject({ kg: 82.4 }), DUMMY_KEY, MAC_FRAME);
    expect(a.parseServiceData('fe95', frame)).toBeNull();
    expect(a.parseServiceData('fe95', frame)).toBeNull();
    expect(bleLog.warn).toHaveBeenCalledTimes(1);
    expect(vi.mocked(bleLog.warn).mock.calls[0][0]).toMatch(/scale_mac/);
  });

  it('returns null and warns once when no bind key is configured', () => {
    const a = new XiaomiS400Adapter();
    a.configure({ scaleMac: '1C:EA:AC:70:08:53' });
    const frame = encryptFrame(measurementObject({ kg: 82.4 }), DUMMY_KEY, MAC_FRAME);
    expect(a.parseServiceData('fe95', frame)).toBeNull();
    expect(a.parseServiceData('fe95', frame)).toBeNull();
    expect(bleLog.warn).toHaveBeenCalledTimes(1);
    expect(vi.mocked(bleLog.warn).mock.calls[0][0]).toMatch(/bind_key/);
  });

  it('returns null and warns when the key or MAC is wrong (tag mismatch)', () => {
    const a = configured('AA:BB:CC:DD:EE:FF');
    const frame = encryptFrame(measurementObject({ kg: 82.4 }), DUMMY_KEY, MAC_FRAME);
    expect(a.parseServiceData('fe95', frame)).toBeNull();
    expect(bleLog.warn).toHaveBeenCalledTimes(1);
    expect(vi.mocked(bleLog.warn).mock.calls[0][0]).toMatch(/failed to decrypt/);
  });

  it('also decrypts the MAC-included frame variant', () => {
    const a = configured();
    const frame = encryptFrame(measurementObject({ kg: 60 }), DUMMY_KEY, MAC_FRAME, {
      includeMac: true,
    });
    expect(a.parseServiceData('fe95', frame)).toEqual({ weight: 60, impedance: 0 });
  });

  it('yields a weight-only reading for a socks weigh-in', () => {
    const a = configured('1C:EA:AC:70:08:53');
    const frame = encryptFrame(measurementObject({ kg: 74.7 }), DUMMY_KEY, MAC_FRAME);
    const r = a.parseServiceData('fe95', frame);
    expect(r).toEqual({ weight: 74.7, impedance: 0 });
    expect(a.isComplete(r!)).toBe(true);
  });

  it('ignores the 250 kHz impedance frame and the step-off frame', () => {
    const a = configured('1C:EA:AC:70:08:53');
    const high = encryptFrame(measurementObject({ ohm: 497.6 }), DUMMY_KEY, MAC_FRAME, {
      cnt: 0x0b,
    });
    const reset = encryptFrame(measurementObject({}), DUMMY_KEY, MAC_FRAME, { cnt: 0x0c });
    expect(a.parseServiceData('fe95', high)).toBeNull();
    expect(a.parseServiceData('fe95', reset)).toBeNull();
    expect(bleLog.info).not.toHaveBeenCalled();
  });

  it('logs a weight frame once even when the advert repeats', () => {
    const a = configured('1C:EA:AC:70:08:53');
    const frame = encryptFrame(
      measurementObject({ kg: 82.4, hr: 71, ohm: 512.3 }),
      DUMMY_KEY,
      MAC_FRAME,
    );
    a.parseServiceData('fe95', frame);
    a.parseServiceData('fe95', frame);
    expect(bleLog.info).toHaveBeenCalledTimes(1);
    expect(vi.mocked(bleLog.info).mock.calls[0][0]).toMatch(/82\.4 kg.*512\.3 ohm.*71 bpm/);
  });

  it('rejects an implausible weight', () => {
    const a = configured('1C:EA:AC:70:08:53');
    const frame = encryptFrame(measurementObject({ kg: 3.2 }), DUMMY_KEY, MAC_FRAME);
    expect(a.parseServiceData('fe95', frame)).toBeNull();
  });

  it('ignores other service UUIDs and other product ids', () => {
    const a = configured('1C:EA:AC:70:08:53');
    const frame = encryptFrame(measurementObject({ kg: 82.4 }), DUMMY_KEY, MAC_FRAME);
    expect(a.parseServiceData('181b', frame)).toBeNull();
    const s800 = encryptFrame(measurementObject({ kg: 82.4 }), DUMMY_KEY, MAC_FRAME, {
      pid: 0x51e2,
    });
    expect(a.parseServiceData('fe95', s800)).toBeNull();
  });

  it('parses an unencrypted object frame too', () => {
    const a = new XiaomiS400Adapter();
    const obj = measurementObject({ kg: 55.5, ohm: 600 });
    const frame = Buffer.concat([
      Buffer.from([0x50, 0x59, PID & 0xff, PID >> 8, 0x01]),
      MAC_FRAME,
      obj,
    ]);
    expect(a.parseServiceData('fe95', frame)).toEqual({ weight: 55.5, impedance: 600 });
  });
});

describe('XiaomiS400Adapter reference vectors (xiaomi-ble test-suite)', () => {
  beforeEach(() => {
    vi.spyOn(bleLog, 'info').mockImplementation(() => {});
    vi.spyOn(bleLog, 'debug').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('decodes the barefoot weigh-in: 69.9 kg, 543.2 ohm, 92 bpm, then 497.6 ohm high', () => {
    const a = new XiaomiS400Adapter();
    a.configure({ bindKey: '0728974d657a4b60964c1b1677f35f7c', scaleMac: '8C:D0:B2:F6:BE:EF' });
    const weight = Buffer.from('4859d53b0abc078ff2348c844138e930220000009e538599', 'hex');
    expect(a.parseServiceData('fe95', weight)).toEqual({ weight: 69.9, impedance: 543.2 });
    expect(vi.mocked(bleLog.info).mock.calls[0][0]).toMatch(
      /69\.9 kg.*543\.2 ohm.*92 bpm.*profile 1/,
    );
    const high = Buffer.from('4859d53b0bd6ef0b25db72785e7e2f46d6000000d8642df6', 'hex');
    expect(a.parseServiceData('fe95', high)).toBeNull();
    expect(vi.mocked(bleLog.debug).mock.calls.at(-1)?.[0]).toMatch(/250 kHz impedance 497\.6/);
  });

  it('decodes the socks weigh-in (74.7 kg, no impedance) and the step-off frame', () => {
    const a = new XiaomiS400Adapter();
    a.configure({ bindKey: '02d2900363ef629c736a4549677acbee', scaleMac: '04:AE:47:67:C6:7C' });
    const socks = Buffer.from('4859d53b71530438b5894b242c209908da000000479ecda3', 'hex');
    expect(a.parseServiceData('fe95', socks)).toEqual({ weight: 74.7, impedance: 0 });
    const reset = Buffer.from('4859d53b72036c6794355a19dbc864bfb3000000e4151dc8', 'hex');
    expect(a.parseServiceData('fe95', reset)).toBeNull();
    expect(vi.mocked(bleLog.debug).mock.calls.at(-1)?.[0]).toMatch(/stepped off/);
  });

  it('agrees with macFrameOrderFromAddress on the nonce MAC', () => {
    expect(macFrameOrderFromAddress('8C:D0:B2:F6:BE:EF')?.toString('hex')).toBe('efbef6b2d08c');
  });
});

describe('XiaomiS400Adapter metrics', () => {
  const adapter = new XiaomiS400Adapter();

  it('is broadcast-only', () => {
    expect(adapter.parseNotification()).toBeNull();
    expect(adapter.preferPassive).toBe(true);
    expect(adapter.normalizesWeight).toBe(true);
  });

  it('completes on a plausible weight regardless of impedance', () => {
    expect(adapter.isComplete({ weight: 74.7, impedance: 0 })).toBe(true);
    expect(adapter.isComplete({ weight: 69.9, impedance: 543.2 })).toBe(true);
    expect(adapter.isComplete({ weight: 5, impedance: 500 })).toBe(false);
  });

  it('computes body composition from real impedance with the Xiaomi formulas', () => {
    const profile = { height: 178, age: 30, gender: 'male' as const, isAthlete: false };
    const comp = adapter.computeMetrics({ weight: 69.9, impedance: 543.2 }, profile);
    const bmiOnly = adapter.computeMetrics({ weight: 69.9, impedance: 0 }, profile);
    expect(comp).toEqual(computeMiScaleComposition(69.9, 543.2, profile));
    expect(comp.weight).toBe(69.9);
    expect(comp.impedance).toBe(543.2);
    expect(comp.bodyFatPercent).not.toBe(bmiOnly.bodyFatPercent);
    expectValidMetrics(adapter, { weight: 69.9, impedance: 543.2 }, profile);
    expectValidMetrics(adapter, { weight: 74.7, impedance: 0 }, profile);
  });

  it('lands near the Mi Home app on a real S400 weigh-in', () => {
    // Mi Home report for the same frames: BMI 25.2, body fat 22.7 %, bone 3.6 kg,
    // skeletal muscle 35.5 kg, water 56.3 %, visceral 9. The app's dual-frequency
    // model is proprietary; this pins how close the 50 kHz Xiaomi formulas get.
    const profile = { height: 185, age: 25, gender: 'male' as const, isAthlete: false };
    const comp = adapter.computeMetrics({ weight: 86.1, impedance: 512.5 }, profile);
    expect(comp.bmi).toBeCloseTo(25.2, 1);
    expect(Math.abs(comp.bodyFatPercent - 22.7)).toBeLessThan(2.5);
    expect(Math.abs(comp.boneMass - 3.6)).toBeLessThan(0.5);
    expect(Math.abs(comp.muscleMass - 35.5)).toBeLessThan(2.5);
    expect(Math.abs(comp.waterPercent - 56.3)).toBeLessThan(5);
  });
});
