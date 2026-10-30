import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  AUTH_FALLBACK_MS,
  HuaweiCh100Adapter,
  aesCtr,
  authToken,
  decodeRecord,
  huaweiMac,
  plainCommand,
  plainNotification,
  recordPlaintext,
  scaleFat,
  secondHalfPlaintext,
  sessionKey,
  trustedRecordTime,
  userInfoCommand,
  userInfoPlaintext,
  xorMac,
  type HuaweiPin,
} from '../../src/scales/huawei-ch100.js';
import { adapters } from '../../src/scales/index.js';
import { resolveAdapter } from '../../src/scales/resolve.js';
import { selectSessionAdapter } from '../../src/ble/session/runner.js';
import { uuid16 } from '../../src/scales/body-comp-helpers.js';
import { bleLog } from '../../src/ble/types.js';
import { replaySession } from '../helpers/replay/session.js';
import type { Trace, TraceStep } from '../helpers/replay/trace.js';
import {
  assertPayloadRanges,
  defaultProfile,
  makeConnectionContext,
} from '../helpers/scale-test-utils.js';
import type { ScaleReading } from '../../src/interfaces/scale-adapter.js';

const hex = (h: string): Buffer => Buffer.from(h.replace(/ /g, ''), 'hex');

/**
 * Captured bytes, with the MAC and token of the session they came from (D086:
 * only these back a claim about the protocol; frames re-encrypted for another
 * MAC are derived).
 *
 * CH100: the two frames of openScale's `HuaweiAhCh100HandlerTest.kt` (commit
 * 6613db58), "captured from real hardware ... checked against what the scale's
 * own display showed", with openScale's user 1 token.
 */
const OS_MAC = hex('5ccad3142bb3');
const OS_FRAME_1 = hex('bc110eabf78678303ba462fc93d1db4b348861');
const OS_FRAME_2 = hex('bc110eabf48679303ba462fc93dce84b3f8861');

/**
 * AH100 with the vendor app: oliexdev/openScale#547 (issue body),
 * V1 btsnoop_hci_20200202205551.cfa.txt, V2 btsnoop_hci_20200618132813.txt,
 * V3 btsnoop_hci_20200618134448.cfa.txt. The vendor app's AUTH carries its own
 * token for its user 118; the values are the app's (issue text, V1 by its BMI).
 */
const V_MAC = hex('0c95414f19ca');
const V_AUTH = hex('db08242ca10d2e0c907a');
const V_AUTH_OK = hex('bd02260db0');
const V_CLOCK_ANSWER = hex('bd0908e892475d14d72d9182');
const V1_LIVE = hex('bc110e63cbd5635d23860aad17e989735e8810');
const V1_SECOND = hex('bc118e568999ff4a038393e042c7517668c61f');
const V2_LIVE = hex('bc110e63e0d55b5d23860ebd0ecdbd70868810');
const V2_SECOND = hex('bc118e565c99ff4a038393e042c7517668c61f');
const V2_HISTORY_1 = hex('bc111063f5d54e5d23860ea815cfba736a8810');
const V3_LIVE = hex('bc110e6328d5435d23860ebd0efdbc708b8810');
const V3_SECOND = hex('bc118e56b099ff4a038393e042c7517668c61f');

const vToken = (): Buffer => xorMac(V_AUTH.subarray(3), V_MAC);
const vKey = (): Buffer => sessionKey(vToken(), V_MAC);

/**
 * Derived frames from tests/fixtures/huawei/ah100-547.ts (V2 re-encrypted for
 * the fake MAC and openScale's user 1 by a separate script).
 */
const ADDRESS = '06:A5:5A:C3:3C:96';
const MAC = hex('06a55ac33c96');
const WAKEUP = 'bd010001';
const AUTH_OK = 'bd02260780';
const USER_INFO_ANSWER = 'bd012021';
const LIVE_UID_1 = 'bc110e0403168f2490843c5229433947137cea';
const LIVE_UID_118 = 'bc110e7303168f2490843c5229433947137cea';
/** LIVE_UID_1 with the weight field set to 0 and to 0xFFFF, re-encrypted by the same script. */
const LIVE_WEIGHT_0 = 'bc110e046f158f2490843c5229433947137cea';
const LIVE_WEIGHT_FFFF = 'bc110e0490ea8f2490843c5229433947137cea';
const SECOND = 'bc118e4c8f41a716ec8b9114e96c894bcd2969';

const AUTH_FRAME = 'db082417876987698607';
const ACK_FRAME = 'db021306';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('Huawei CH100/AH100 wire primitives', () => {
  it("openScale's token for user 1 XORs to zero (OST EXPECTED_AUTH_TOKEN)", () => {
    const t = authToken(1);
    expect(t.toString('hex')).toBe('11223344551001');
    expect(t.reduce((x, b) => x ^ b, 0)).toBe(0);
  });

  it("derives openScale's session key layout (OST EXPECTED_MAGIC_KEY)", () => {
    const key = sessionKey(authToken(1), hex('5ccad3087b4f'));
    expect(key.toString('hex')).toBe('4de8e04c2e5f5d2a980fde3456732156');
  });

  it('reads a MAC with or without separators and refuses a CoreBluetooth UUID', () => {
    expect(huaweiMac(ADDRESS)).toEqual(MAC);
    expect(huaweiMac('06A55AC33C96')).toEqual(MAC);
    expect(huaweiMac('6F1C2E3A000040008000000000000001')).toBeNull();
    expect(huaweiMac('')).toBeNull();
  });

  it("the vendor app's AUTH carries a token for its user 118 that XORs to zero (V1-V3)", () => {
    const t = vToken();
    expect(t[6]).toBe(118);
    expect(t.reduce((x, b) => x ^ b, 0)).toBe(0);
    expect(plainCommand(0x24, t, V_MAC)).toEqual(V_AUTH);
  });

  it('XORs every payload from the first MAC byte (ACK of #503 for the fake MAC)', () => {
    expect(plainCommand(0x13, Buffer.from([0x00]), MAC).toString('hex')).toBe(ACK_FRAME);
    expect(plainCommand(0x24, authToken(1), MAC).toString('hex')).toBe(AUTH_FRAME);
  });
});

describe('Huawei CH100/AH100 records (captured)', () => {
  it('decodes the CH100 frames of openScale to the values its display showed', () => {
    const key = sessionKey(authToken(1), OS_MAC);
    const a = decodeRecord(recordPlaintext(OS_FRAME_1, key, OS_MAC));
    expect(a).toMatchObject({ uid: 1, weightKg: 126.6, fatPercent: 33.8, impedance: 306 });
    expect(a).toMatchObject({ year: 2026, month: 8, day: 10, hour: 10, minute: 1, second: 38 });
    const b = decodeRecord(recordPlaintext(OS_FRAME_2, key, OS_MAC));
    expect(b).toMatchObject({ uid: 1, weightKg: 126.5, fatPercent: 33.9, impedance: 313 });
    expect(b).toMatchObject({ hour: 10, minute: 12, second: 21 });
  });

  it('decodes the live records of the vendor app sessions (V1-V3)', () => {
    const key = vKey();
    expect(decodeRecord(recordPlaintext(V1_LIVE, key, V_MAC))).toMatchObject({
      uid: 118,
      weightKg: 83.9,
      fatPercent: 22.1,
      impedance: 429,
    });
    expect(decodeRecord(recordPlaintext(V2_LIVE, key, V_MAC))).toEqual({
      uid: 118,
      weightKg: 87.6,
      fatPercent: 22.9,
      year: 2020,
      month: 6,
      day: 18,
      hour: 13,
      minute: 29,
      second: 40,
      weekday: 4,
      impedance: 373,
    });
    expect(decodeRecord(recordPlaintext(V3_LIVE, key, V_MAC))).toMatchObject({
      uid: 118,
      weightKg: 93.2,
      fatPercent: 25.3,
      impedance: 376,
    });
  });

  it('decodes a stored record (0x10) of V2 with the same layout', () => {
    expect(decodeRecord(recordPlaintext(V2_HISTORY_1, vKey(), V_MAC))).toMatchObject({
      uid: 118,
      weightKg: 88.9,
      fatPercent: 24,
      year: 2020,
      month: 6,
      day: 7,
    });
  });

  it('the second half is AES-CTR from the IV alone: 2 bytes and 14 times 0x0E (V1-V3)', () => {
    const key = vKey();
    const fill = '0e'.repeat(14);
    expect(secondHalfPlaintext(V1_SECOND, key).toString('hex')).toBe(`4f90${fill}`);
    expect(secondHalfPlaintext(V2_SECOND, key).toString('hex')).toBe(`4f45${fill}`);
    expect(secondHalfPlaintext(V3_SECOND, key).toString('hex')).toBe(`4fa9${fill}`);
  });

  it('checks the XOR checksum of plain notifications, which a wrong MAC breaks (V2)', () => {
    expect(plainNotification(V_AUTH_OK, V_MAC)).toEqual({
      op: 0x26,
      payload: Buffer.from([0x01]),
      checksumOk: true,
    });
    expect(plainNotification(V_CLOCK_ANSWER, V_MAC)).toEqual({
      op: 0x08,
      payload: hex('e40706120d1d2104'),
      checksumOk: true,
    });
    expect(plainNotification(hex('bd012021'), V_MAC)).toEqual({
      op: 0x20,
      payload: Buffer.alloc(0),
      checksumOk: true,
    });
    expect(plainNotification(V_AUTH_OK, MAC)?.checksumOk).toBe(false);
  });
});

describe('Huawei CH100/AH100 USER_INFO', () => {
  const sent = { gender: 'male' as const, age: 30, height: 183 };

  it('lays out token, age, height, 0, weight, ff ff and the trailer', () => {
    const p = userInfoPlaintext(authToken(1), sent, 73.7);
    expect(p.toString('hex')).toBe('112233445510011eb700e102ffff1ce2');
    const female = userInfoPlaintext(authToken(1), { ...sent, gender: 'female' }, 73.7);
    expect(female[7]).toBe(0x9e);
  });

  it('declares 14 bytes, encrypts the 16 and XORs them with the MAC', () => {
    const key = sessionKey(authToken(1), MAC);
    const plain = userInfoPlaintext(authToken(1), sent, 73.7);
    const f = userInfoCommand(plain, key, MAC);
    expect(f.subarray(0, 3).toString('hex')).toBe('dc0e09');
    expect(f.length).toBe(19);
    expect(aesCtr(xorMac(f.subarray(3), MAC), key)).toEqual(plain);
  });
});

describe('Huawei CH100/AH100 matching', () => {
  const a = new HuaweiCh100Adapter();

  it('claims CH100 and AH100 by their exact names only', () => {
    expect(a.matches({ localName: 'CH100', serviceUuids: [] })).toBe(true);
    expect(a.matches({ localName: 'AH100', serviceUuids: [] })).toBe(true);
    expect(a.matches({ localName: 'CH100S', serviceUuids: [] })).toBe(false);
    expect(a.matches({ localName: '', serviceUuids: [uuid16(0xfaa0), uuid16(0x181b)] })).toBe(
      false,
    );
  });

  it('a named CH100 with 0x181B resolves here, not to Mi Scale 2', () => {
    const info = { localName: 'CH100', serviceUuids: [uuid16(0x181b)] };
    expect(resolveAdapter(info, adapters)?.name).toBe('Huawei CH100/AH100');
  });

  it('the mqtt-proxy notify-char fallback does not hand a nameless BF950 (FAA2) to it', () => {
    const info = { localName: '', serviceUuids: [uuid16(0x181b), uuid16(0x181d)] };
    const discovery = {
      serviceUuids: [uuid16(0x181b), uuid16(0x181d), uuid16(0xfaa0)],
      characteristicUuids: [uuid16(0x2a9d), uuid16(0x2a2f), uuid16(0xfaa1), uuid16(0xfaa2)],
    };
    const picked = selectSessionAdapter(info, discovery, adapters, { byNotifyChar: true });
    expect(picked?.name).not.toBe('Huawei CH100/AH100');
    // A nameless unit with only the vendor service still lands here.
    const faaOnly = { characteristicUuids: [uuid16(0xfaa1), uuid16(0xfaa2)] };
    const own = selectSessionAdapter({ localName: '', serviceUuids: [] }, faaOnly, adapters, {
      byNotifyChar: true,
    });
    expect(own?.name).toBe('Huawei CH100/AH100');
  });
});

/** A replayed session of the derived V2 frames, with steps replaced as a test needs. */
function trace(steps: TraceStep[]): Trace {
  return {
    provenance: 'derived',
    source: 'tests/fixtures/huawei/ah100-547.ts frames',
    advert: { localName: 'CH100', address: ADDRESS, serviceUuids: [] },
    steps,
  };
}
const rx = (atMs: number, h: string): TraceStep => ({ atMs, dir: 'rx', hex: h });

describe('Huawei CH100/AH100 session', () => {
  it('wakeup -> AUTH, accepted -> one USER_INFO, record -> reading and ACK', async () => {
    const r = await replaySession(
      new HuaweiCh100Adapter(),
      trace([rx(457, WAKEUP), rx(1222, AUTH_OK), rx(2663, USER_INFO_ANSWER), rx(9743, LIVE_UID_1)]),
    );
    expect(r.writes.map((w) => [w.atMs, w.hex.slice(0, 6), w.withResponse])).toEqual([
      [457, AUTH_FRAME.slice(0, 6), true],
      [1222, 'dc0e09', true],
      [9743, ACK_FRAME.slice(0, 6), true],
    ]);
    expect(r.writes[0].hex).toBe(AUTH_FRAME);
    expect(r.writes[2].hex).toBe(ACK_FRAME);
    expect(r.reading).toMatchObject({ weight: 87.6, impedance: 373 });
    expect(r.reading?.timestamp).toBeUndefined();
  });

  it('pins no sent profile when the scale did not answer USER_INFO before the record', async () => {
    vi.spyOn(bleLog, 'info').mockImplementation(() => {});
    const r = await replaySession(
      new HuaweiCh100Adapter(),
      trace([rx(457, WAKEUP), rx(1222, AUTH_OK), rx(9743, LIVE_UID_1)]),
    );
    expect((r.reading?.scaleComposition as HuaweiPin).sent).toBeNull();
    expect(r.payload?.bodyFatPercent).not.toBe(22.9);
  });

  it('does not count a 0x20 that came before USER_INFO went out as its answer', async () => {
    vi.spyOn(bleLog, 'info').mockImplementation(() => {});
    const r = await replaySession(
      new HuaweiCh100Adapter(),
      trace([rx(457, WAKEUP), rx(600, USER_INFO_ANSWER), rx(1222, AUTH_OK), rx(9743, LIVE_UID_1)]),
    );
    expect(r.writes.filter((w) => w.hex.startsWith('dc'))).toHaveLength(1);
    expect((r.reading?.scaleComposition as HuaweiPin).sent).toBeNull();
  });

  it("does not resend USER_INFO on the scale's 0x20 answers", async () => {
    const r = await replaySession(
      new HuaweiCh100Adapter(),
      trace([
        rx(457, WAKEUP),
        rx(1222, AUTH_OK),
        rx(2663, USER_INFO_ANSWER),
        rx(2800, USER_INFO_ANSWER),
        rx(9743, LIVE_UID_1),
      ]),
    );
    expect(r.writes.filter((w) => w.hex.startsWith('dc'))).toHaveLength(1);
  });

  it('takes the record when second halves come before it, as on a CH100', async () => {
    const r = await replaySession(
      new HuaweiCh100Adapter(),
      trace([
        rx(457, WAKEUP),
        rx(1222, AUTH_OK),
        rx(2663, USER_INFO_ANSWER),
        rx(9700, SECOND),
        rx(9710, SECOND),
        rx(9743, LIVE_UID_1),
      ]),
    );
    expect(r.reading).toMatchObject({ weight: 87.6 });
    expect(r.writes.at(-1)?.hex).toBe(ACK_FRAME);
  });

  it('neither imports nor ACKs a record for another user slot', async () => {
    const r = await replaySession(
      new HuaweiCh100Adapter(),
      trace([
        rx(457, WAKEUP),
        rx(1222, AUTH_OK),
        rx(2663, USER_INFO_ANSWER),
        rx(9743, LIVE_UID_118),
      ]),
    );
    expect(r.reading).toBeNull();
    expect(r.writes.some((w) => w.hex === ACK_FRAME)).toBe(false);
  });

  it.each([
    ['0', LIVE_WEIGHT_0],
    ['0xFFFF', LIVE_WEIGHT_FFFF],
  ])('neither imports nor ACKs a record with the weight field %s', async (_, live) => {
    const r = await replaySession(
      new HuaweiCh100Adapter(),
      trace([rx(457, WAKEUP), rx(1222, AUTH_OK), rx(2663, USER_INFO_ANSWER), rx(9743, live)]),
    );
    expect(r.reading).toBeNull();
    expect(r.writes.some((w) => w.hex === ACK_FRAME)).toBe(false);
  });

  it('neither imports nor ACKs a record before the scale accepted this host', async () => {
    const r = await replaySession(
      new HuaweiCh100Adapter(),
      trace([rx(457, WAKEUP), rx(9743, LIVE_UID_1)]),
    );
    expect(r.reading).toBeNull();
    expect(r.writes.map((w) => w.hex)).toEqual([AUTH_FRAME]);
  });

  it('sends AUTH after the fallback wait and once more on the late wakeups', async () => {
    const r = await replaySession(
      new HuaweiCh100Adapter(),
      trace([
        rx(AUTH_FALLBACK_MS + 500, WAKEUP),
        rx(AUTH_FALLBACK_MS + 600, WAKEUP),
        rx(AUTH_FALLBACK_MS + 800, AUTH_OK),
      ]),
    );
    expect(r.writes.map((w) => [w.atMs, w.hex])).toEqual([
      [AUTH_FALLBACK_MS, AUTH_FRAME],
      [AUTH_FALLBACK_MS + 500, AUTH_FRAME],
      [AUTH_FALLBACK_MS + 800, expect.stringMatching(/^dc0e09/)],
    ]);
  });

  it('does not send AUTH again on a wakeup after the scale answered it', async () => {
    vi.spyOn(bleLog, 'error').mockImplementation(() => {});
    const refused = Buffer.concat([hex('bd0226'), xorMac(hex('0024'), MAC)]).toString('hex');
    const r = await replaySession(
      new HuaweiCh100Adapter(),
      trace([rx(AUTH_FALLBACK_MS + 300, refused), rx(AUTH_FALLBACK_MS + 500, WAKEUP)]),
    );
    expect(r.writes.map((w) => w.hex)).toEqual([AUTH_FRAME]);
    const ok = await replaySession(
      new HuaweiCh100Adapter(),
      trace([rx(457, WAKEUP), rx(1222, AUTH_OK), rx(1447, WAKEUP)]),
    );
    expect(ok.writes.filter((w) => w.hex === AUTH_FRAME)).toHaveLength(1);
  });

  it('a refused AUTH logs an error with the binding hint and sends nothing else', async () => {
    const error = vi.spyOn(bleLog, 'error').mockImplementation(() => {});
    // The refusal: payload 00, checksum 02 ^ 26 = 24, XORed with the fake MAC.
    const refused = Buffer.concat([hex('bd0226'), xorMac(hex('0024'), MAC)]).toString('hex');
    const r = await replaySession(
      new HuaweiCh100Adapter(),
      trace([rx(457, WAKEUP), rx(600, refused)]),
    );
    expect(r.writes.map((w) => w.hex)).toEqual([AUTH_FRAME]);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('bind the scale once with openScale'),
    );
  });

  it('a garbled AUTH answer warns and nothing else is sent', async () => {
    const warn = vi.spyOn(bleLog, 'warn').mockImplementation(() => {});
    const r = await replaySession(
      new HuaweiCh100Adapter(),
      trace([rx(457, WAKEUP), rx(600, V_AUTH_OK.toString('hex'))]),
    );
    expect(r.writes.map((w) => w.hex)).toEqual([AUTH_FRAME]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('does not decode'));
  });

  it('answers a wakeup that came before onConnected once the context is there', async () => {
    const a = new HuaweiCh100Adapter();
    const ctx = makeConnectionContext({ deviceAddress: '06A55AC33C96' });
    a.onSessionStart();
    a.parseNotification(hex(WAKEUP));
    a.onConnected(ctx);
    expect(vi.mocked(ctx.write).mock.calls.map((c) => Buffer.from(c[1]).toString('hex'))).toEqual([
      AUTH_FRAME,
    ]);
    a.onSessionEnd();
  });

  it('throws on a CoreBluetooth UUID and writes nothing', () => {
    const a = new HuaweiCh100Adapter();
    const ctx = makeConnectionContext({ deviceAddress: '6F1C2E3A000040008000000000000001' });
    a.onSessionStart();
    expect(() => a.onConnected(ctx)).toThrow(/no Bluetooth address/);
    expect(ctx.write).not.toHaveBeenCalled();
  });

  it('sends the weight of the profile when config has one', async () => {
    const r = await replaySession(
      new HuaweiCh100Adapter(),
      trace([rx(457, WAKEUP), rx(1222, AUTH_OK)]),
      { profile: defaultProfile({ lastKnownWeight: 88 }) },
    );
    const f = hex(r.writes[1].hex);
    const plain = aesCtr(xorMac(f.subarray(3), MAC), sessionKey(authToken(1), MAC));
    expect(plain.readUInt16LE(10)).toBe(880);
  });
});

describe('Huawei CH100/AH100 body fat gate (D086)', () => {
  const profile = defaultProfile();
  const sent = { gender: profile.gender, age: profile.age, height: profile.height };
  const pin = (over: Partial<HuaweiPin> = {}): HuaweiPin => ({ fat: 22.9, slot: 1, sent, ...over });
  const reading = (p: HuaweiPin): ScaleReading => ({
    weight: 87.6,
    impedance: 373,
    scaleComposition: p,
  });
  const a = new HuaweiCh100Adapter();

  it("uses the scale's fat for the user whose profile it was sent", () => {
    vi.spyOn(bleLog, 'info').mockImplementation(() => {});
    const out = a.computeMetrics(reading(pin()), profile);
    expect(out.bodyFatPercent).toBe(22.9);
    expect(out.impedance).toBe(373);
    assertPayloadRanges(out);
  });

  it.each([
    ['another sex', defaultProfile({ gender: 'female' })],
    ['another age', defaultProfile({ age: 31 })],
    ['another height', defaultProfile({ height: 175 })],
  ])('estimates for a user of %s', (_, other) => {
    vi.spyOn(bleLog, 'info').mockImplementation(() => {});
    expect(scaleFat(pin(), other)).toEqual({});
    expect(a.computeMetrics(reading(pin()), other).bodyFatPercent).not.toBe(22.9);
  });

  it('estimates without a confirmed profile, for another slot and without fat', () => {
    const info = vi.spyOn(bleLog, 'info').mockImplementation(() => {});
    expect(scaleFat(pin({ sent: null }), profile)).toEqual({});
    expect(scaleFat(pin({ slot: 2 }), profile)).toEqual({});
    expect(scaleFat(pin({ fat: 0 }), profile)).toEqual({});
    expect(scaleFat(undefined, profile)).toEqual({});
    expect(info).toHaveBeenCalledWith(expect.stringContaining('using the estimate'));
  });

  it('never runs the shared BIA on a fat value out of range', () => {
    vi.spyOn(bleLog, 'info').mockImplementation(() => {});
    expect(scaleFat(pin({ fat: 80 }), profile)).toEqual({});
  });

  it('exports no body composition when the user turned the estimate off', () => {
    const info = vi.spyOn(bleLog, 'info').mockImplementation(() => {});
    const off = defaultProfile({ estimateBodyComposition: false, gender: 'female' });
    const out = a.computeMetrics(reading(pin()), off);
    expect(out.bodyFatPercent).toBeNull();
    expect(info).toHaveBeenCalledWith(expect.stringContaining('estimate_body_composition is off'));
  });
});

describe('Huawei CH100/AH100 record time (D027, D053)', () => {
  const rec = decodeRecord(recordPlaintext(V2_LIVE, vKey(), V_MAC));
  const at = new Date(2020, 5, 18, 13, 29, 40).getTime();

  it("dates the record by the scale's clock when it agrees with the host's", () => {
    expect(trustedRecordTime(rec, at + 60_000)?.getTime()).toBe(at);
  });

  it('drops a clock that is off by more than 2 minutes or never set', () => {
    expect(trustedRecordTime(rec, at + 3 * 60_000)).toBeUndefined();
    // The host's clock agrees to the second, so only the year rejects it.
    const unset = { ...rec, year: 2000 };
    expect(trustedRecordTime(unset, new Date(2000, 5, 18, 13, 29, 40).getTime())).toBeUndefined();
  });
});
