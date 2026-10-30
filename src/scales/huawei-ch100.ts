/*
 * Huawei CH100 / AH100 body fat scale (Chipsea CST34M97, vendor service 0xFAA0).
 *
 * Protocol ported from openScale (https://github.com/oliexdev/openScale),
 * `HuaweiAhCh100Handler.kt` at commit 39a0c5c (openScale PR #1374 by
 * danieldorigatti and PR #1450 by martinriedel), itself a port of the
 * `BluetoothHuaweiAH100.java` handler of openScale v2.5.4. Copyright (C) the
 * openScale contributors, licensed GPL-3.0-or-later; this project is GPL-3.0.
 * Checked against the public btsnoop captures of the vendor app in
 * oliexdev/openScale#547 and the CH100 frames in openScale's
 * `HuaweiAhCh100HandlerTest.kt`.
 *
 * Wire format (all multi-byte fields little-endian):
 *   host -> scale   `db <1 + n> <cmd> xorMac(payload)`; USER_INFO is
 *                   `dc 0e 09 xorMac(aesCtr(16 bytes))`
 *   scale -> host   `bd <len> <op> xorMac(payload + checksum)` (len 1: the
 *                   checksum alone, not XORed), checksum = len ^ op ^ payload;
 *                   a record is `bc 11 0e xorMac(aesCtr(16 bytes))`, its second
 *                   half `bc 11 8e aesCtr(16 bytes)` without the XOR.
 * xorMac XORs every byte with the scale's MAC (display order, index 0 for each
 * payload). The AES-128-CTR key is xorMac(token) followed by the last nine bytes
 * of a fixed key; the counter starts at a fixed IV for every frame.
 *
 * The session: wakeup -> AUTH with openScale's token for user 1 (once more on a
 * later wakeup while the scale has not answered it) -> USER_INFO with the
 * profile of users[0] -> the scale's live record -> ACK. No clock, unit, history
 * or heartbeat (D086).
 */
import { createCipheriv } from 'node:crypto';
import type {
  AckProtocol,
  BleDeviceInfo,
  BodyComposition,
  ConnectionContext,
  GattWiring,
  Gender,
  ScaleAdapterCore,
  ScaleReading,
  UserProfile,
} from '../interfaces/scale-adapter.js';
import {
  buildPayload,
  compositionRejection,
  noEstimateNote,
  uuid16,
  type ScaleBodyComp,
} from './body-comp-helpers.js';
import { matchesDescriptor, ownAddressBytes, type MatchDescriptor } from './match-descriptor.js';
import { bleLog, errMsg } from '../ble/types.js';

const NAME = 'Huawei CH100/AH100';

const CHR_WRITE = uuid16(0xfaa1);
const CHR_NOTIFY = uuid16(0xfaa2);

const INITIAL_KEY = Buffer.from('3da2784afb87b12a980fde3456732156', 'hex');
const INITIAL_IV = Buffer.from('4ef764322fda7632123deb8790fea219', 'hex');

const FRAME_PLAIN = 0xdb;
const FRAME_ENCRYPTED = 0xdc;
const NOTIFY_ENCRYPTED = 0xbc;
const NOTIFY_PLAIN = 0xbd;

const CMD_USER_INFO = 0x09;
const CMD_FAT_RESULT_ACK = 0x13;
const CMD_AUTH = 0x24;

const OP_WAKEUP = 0x00;
const OP_LIVE_RECORD = 0x0e;
const OP_USER_INFO_ANSWER = 0x20;
const OP_AUTH_RESULT = 0x26;

/** The user slot this host authenticates as: openScale's, so a scale bound by it accepts us. */
export const CH100_USER_ID = 1;

/**
 * USER_INFO declares 14 bytes and carries 16: the two-byte trailer is not
 * counted, by the vendor app (`43 4d`) and openScale (`1c e2`) alike. A CH100
 * accepted openScale's trailer.
 */
const USER_INFO_DECLARED_LEN = 0x0e;
const USER_INFO_TRAILER = [0x1c, 0xe2];

/** A record is 16 bytes after the 3-byte header. */
const RECORD_LEN = 16;

/**
 * How long onConnected waits for the scale's wakeup before it sends AUTH
 * anyway. The wakeup comes within about 0.5 s of the subscribe on every capture;
 * a transport that subscribed before onConnected can lose it.
 */
export const AUTH_FALLBACK_MS = 1000;

/** The scale clock dates a record only when it is set and agrees with the host's (D053). */
const CLOCK_TOLERANCE_MS = 2 * 60 * 1000;
const MIN_TRUSTED_YEAR = 2015;

const MAX_WEIGHT_KG = 250;

// ─── Wire primitives (pure, exported for tests) ─────────────────────────────

/** The six MAC bytes in display order, or null when the address is not a MAC (macOS: a UUID). */
export function huaweiMac(address: string | undefined): Buffer | null {
  const hex = ownAddressBytes(address);
  return hex ? Buffer.from(hex, 'hex') : null;
}

/** XOR every byte with the MAC, the index starting at 0 for this payload. Self-inverse. */
export function xorMac(data: Buffer, mac: Buffer): Buffer {
  return Buffer.from(data.map((b, i) => b ^ mac[i % mac.length]));
}

/** openScale's 7-byte token for a user slot: `11 22 33 44 55 <x> <uid>`, XOR of all bytes 0. */
export function authToken(uid: number): Buffer {
  const t = Buffer.from([0x11, 0x22, 0x33, 0x44, 0x55, 0x00, uid & 0xff]);
  t[5] = t.reduce((x, b) => x ^ b, 0);
  return t;
}

/** The session's AES-128 key: the token as it goes on the wire, then INITIAL_KEY[7..15]. */
export function sessionKey(token: Buffer, mac: Buffer): Buffer {
  return Buffer.concat([xorMac(token, mac), INITIAL_KEY.subarray(7)]);
}

/** AES-128-CTR from the fixed IV; encrypting and decrypting are the same operation. */
export function aesCtr(data: Buffer, key: Buffer): Buffer {
  const c = createCipheriv('aes-128-ctr', key, INITIAL_IV);
  return Buffer.concat([c.update(data), c.final()]);
}

/** A host -> scale plain command: `db <1 + n> <cmd> xorMac(payload)`. */
export function plainCommand(cmd: number, payload: Buffer, mac: Buffer): Buffer {
  return Buffer.concat([Buffer.from([FRAME_PLAIN, payload.length + 1, cmd]), xorMac(payload, mac)]);
}

/** The encrypted USER_INFO frame for a 16-byte plaintext. */
export function userInfoCommand(plain: Buffer, key: Buffer, mac: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from([FRAME_ENCRYPTED, USER_INFO_DECLARED_LEN, CMD_USER_INFO]),
    xorMac(aesCtr(plain, key), mac),
  ]);
}

/** What USER_INFO tells the scale about the person, before it is encrypted. */
export interface SentProfile {
  gender: Gender;
  /** Whole years, as compared with the matched user's profile. */
  age: number;
  /** Whole centimetres, as sent. */
  height: number;
}

/**
 * The 16-byte USER_INFO plaintext: token, age with the female bit (bit 7, from
 * openScale, not confirmed on a capture), height in cm, 0, weight in 0.1 kg,
 * `ff ff` (impedance unknown) and the trailer.
 */
export function userInfoPlaintext(token: Buffer, sent: SentProfile, weightKg: number): Buffer {
  const age = Math.max(0, Math.min(127, sent.age)) | (sent.gender === 'female' ? 0x80 : 0);
  const tenths = Math.max(1, Math.min(0xffff, Math.round(weightKg * 10)));
  return Buffer.concat([
    token,
    Buffer.from([age, sent.height, 0x00, tenths & 0xff, tenths >> 8, 0xff, 0xff]),
    Buffer.from(USER_INFO_TRAILER),
  ]);
}

/** A plain scale -> host notification, de-obfuscated. */
export interface PlainNotification {
  op: number;
  payload: Buffer;
  /** False usually means the MAC is wrong: the checksum is XORed with it too. */
  checksumOk: boolean;
}

/** Decode `bd <len> <op> ...`, or null when the frame is not one or is short. */
export function plainNotification(frame: Buffer, mac: Buffer): PlainNotification | null {
  if (frame.length < 4 || frame[0] !== NOTIFY_PLAIN) return null;
  const len = frame[1];
  if (len < 1 || frame.length < 3 + len) return null;
  const op = frame[2];
  const raw = frame.subarray(3, 3 + len);
  const tail = len > 1 ? xorMac(raw, mac) : raw;
  const payload = Buffer.from(tail.subarray(0, len - 1));
  const expected = payload.reduce((x, b) => x ^ b, len ^ op);
  return { op, payload, checksumOk: tail[len - 1] === expected };
}

/** The 16 plaintext bytes of a record's first half (`bc .. 0e` or `bc .. 10`). */
export function recordPlaintext(frame: Buffer, key: Buffer, mac: Buffer): Buffer {
  return aesCtr(xorMac(frame.subarray(3, 3 + RECORD_LEN), mac), key);
}

/** The 16 plaintext bytes of a record's second half (`bc .. 8e` / `bc .. 90`): CTR, no XOR. */
export function secondHalfPlaintext(frame: Buffer, key: Buffer): Buffer {
  return aesCtr(frame.subarray(3, 3 + RECORD_LEN), key);
}

export interface HuaweiRecord {
  /** The scale's user slot the record is for. */
  uid: number;
  weightKg: number;
  fatPercent: number;
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** Day of the week, Monday 1 to Sunday 7. */
  weekday: number;
  /** Raw [13..14]; its unit is not confirmed (PROTOCOLS.md). */
  impedance: number;
}

/** Decode a record's 16 plaintext bytes. */
export function decodeRecord(p: Buffer): HuaweiRecord {
  return {
    uid: p[0],
    weightKg: p.readUInt16LE(1) / 10,
    fatPercent: p.readUInt16LE(3) / 10,
    year: p.readUInt16LE(5),
    month: p[7],
    day: p[8],
    hour: p[9],
    minute: p[10],
    second: p[11],
    weekday: p[12],
    impedance: p.readUInt16LE(13),
  };
}

/**
 * The record's time on the host's clock, when the scale's clock can be trusted:
 * set (year 2015 or later) and within 2 minutes of the host (D053). A live
 * record is this weigh-in, so a clock that is off or never set (a CH100 that
 * only openScale or we talk to keeps the year 2000) would make it look like
 * history; it is then dated on receipt.
 */
export function trustedRecordTime(rec: HuaweiRecord, nowMs: number): Date | undefined {
  if (rec.year < MIN_TRUSTED_YEAR || rec.month < 1 || rec.month > 12 || rec.day < 1) {
    return undefined;
  }
  const t = new Date(rec.year, rec.month - 1, rec.day, rec.hour, rec.minute, rec.second);
  if (Number.isNaN(t.getTime()) || t.getDate() !== rec.day) return undefined;
  return Math.abs(t.getTime() - nowMs) <= CLOCK_TOLERANCE_MS ? t : undefined;
}

// ─── Body composition gate (D086) ──────────────────────────────────────────

/** What computeMetrics needs from the session, pinned to the reading (D077). */
export interface HuaweiPin {
  /** The scale's body fat, %; 0 when it reported none. */
  fat: number;
  /** The record's user slot. */
  slot: number;
  /** The profile our USER_INFO carried, if the scale answered it (0x20) before the record. */
  sent: SentProfile | null;
}

function sentProfileOf(profile: UserProfile): SentProfile {
  return {
    gender: profile.gender,
    age: Math.trunc(profile.age),
    height: Math.max(1, Math.min(255, Math.round(profile.height))),
  };
}

function sameProfile(sent: SentProfile, profile: UserProfile): boolean {
  return (
    sent.gender === profile.gender &&
    sent.age === Math.trunc(profile.age) &&
    sent.height === Math.round(profile.height)
  );
}

/**
 * The scale's body fat when it was computed for the user this weigh-in belongs
 * to, else {} (the estimate), with one info line saying which. The scale
 * computes the fat from the profile we sent it, so it counts only for a user
 * with that sex, age and height. No line carries a profile value.
 */
export function scaleFat(pin: HuaweiPin | undefined, profile: UserProfile): ScaleBodyComp {
  let why: string | null = null;
  if (!pin || !(pin.fat > 0)) why = 'the scale reported no body fat';
  else if (pin.slot !== CH100_USER_ID) why = 'the record is for another user slot on the scale';
  else if (compositionRejection({ fat: pin.fat }) !== null) {
    why = "the scale's body fat is out of range";
  } else if (!pin.sent) {
    why = 'the scale did not confirm the profile we sent before the weigh-in';
  } else if (!sameProfile(pin.sent, profile)) {
    why =
      'the weigh-in was matched to a user whose sex, age or height is not the profile ' +
      'sent to the scale';
  }
  if (!pin || why !== null) {
    bleLog.info(
      `${NAME}: the scale's body fat is not used for this weigh-in: ${why}; ` +
        `${noEstimateNote(profile) ?? 'using the estimate'} (#503)`,
    );
    return {};
  }
  bleLog.info(`${NAME}: using the scale's body fat, computed for the profile sent to it (#503)`);
  return { fat: pin.fat };
}

// ─── Adapter ────────────────────────────────────────────────────────────────

/** One weigh-in's state, replaced whole in onSessionStart (#394, SCALES.md). */
class HuaweiSession {
  mac: Buffer | null = null;
  token = authToken(CH100_USER_ID);
  key: Buffer | null = null;
  wakeupSeen = false;
  authSent = false;
  /** The one extra AUTH a later wakeup may trigger went out. */
  authResent = false;
  /** The scale answered AUTH (0x26), whatever the answer. */
  authAnswered = false;
  authorised = false;
  /** The profile our USER_INFO carried, once it went out. */
  userInfo: SentProfile | null = null;
  /** The scale answered our USER_INFO (0x20) before the record. */
  userInfoAnswered = false;
  authFallback: ReturnType<typeof setTimeout> | null = null;
  readonly logged = new Set<string>();

  dispose(): void {
    if (this.authFallback) clearTimeout(this.authFallback);
    this.authFallback = null;
  }
}

/**
 * Huawei CH100 and AH100 (#503). Claimed by its exact advertised name only: the
 * FAA0 service is shared with other Chipsea scales (the Beurer BF950 exposes
 * FAA1/FAA2), and CH100S speaks another protocol.
 */
export class HuaweiCh100Adapter implements ScaleAdapterCore, GattWiring, AckProtocol {
  readonly name = NAME;
  readonly match: MatchDescriptor = {
    // Above Mi Scale 2 (210), which claims every 0x181B advertiser: a CH100
    // exposes the SIG body composition service too (registry-check invariant).
    priority: 218,
    names: { exact: ['ch100', 'ah100'] },
  };
  readonly charNotifyUuid = CHR_NOTIFY;
  readonly charWriteUuid = CHR_WRITE;

  private s = new HuaweiSession();
  /** Link lifetime: set in onConnected, dropped in onSessionEnd. */
  private ctx: ConnectionContext | null = null;

  matches(device: BleDeviceInfo): boolean {
    return matchesDescriptor(device, this.match);
  }

  onSessionStart(): void {
    this.s.dispose();
    this.s = new HuaweiSession();
  }

  onSessionEnd(): void {
    this.s.dispose();
    this.ctx = null;
  }

  onConnected(ctx: ConnectionContext): void {
    const mac = huaweiMac(ctx.deviceAddress);
    if (!mac) {
      // Every frame is keyed on the MAC, so nothing can be written without it.
      throw new Error(
        `${NAME}: this transport gives no Bluetooth address for the scale (macOS gives a ` +
          'CoreBluetooth UUID instead), and the scale encrypts everything with it. Read it ' +
          'from Linux or Windows, an ESPHome proxy or the ESP32 MQTT proxy (#503)',
      );
    }
    const s = this.s;
    this.ctx = ctx;
    s.mac = mac;
    s.key = sessionKey(s.token, mac);
    if (s.wakeupSeen) {
      this.sendAuth('the wakeup came before the session was ready');
      return;
    }
    s.authFallback = setTimeout(() => {
      s.authFallback = null;
      if (this.s !== s) return;
      this.sendAuth(`no wakeup within ${AUTH_FALLBACK_MS} ms`);
    }, AUTH_FALLBACK_MS);
  }

  parseNotification(data: Buffer): ScaleReading | null {
    const s = this.s;
    if (data.length < 3) return null;
    if (data[0] === NOTIFY_PLAIN) {
      this.onPlain(data);
      return null;
    }
    if (data[0] !== NOTIFY_ENCRYPTED) return null;
    const op = data[2];
    if (op !== OP_LIVE_RECORD) {
      this.once(`bc-${op}`, `${NAME}: frame bc op 0x${hex2(op)} not used`);
      return null;
    }
    const rec = this.importable(data, true);
    if (!rec) return null;
    const timestamp = trustedRecordTime(rec, Date.now());
    if (!timestamp) {
      this.once(
        'clock',
        `${NAME}: the scale's clock is unset or off from the host's, so the weigh-in is ` +
          'dated on receipt',
      );
    }
    const pin: HuaweiPin = {
      fat: rec.fatPercent,
      slot: rec.uid,
      sent: s.userInfoAnswered ? s.userInfo : null,
    };
    return {
      weight: rec.weightKg,
      impedance: rec.impedance,
      ...(timestamp ? { timestamp } : {}),
      scaleComposition: pin,
    };
  }

  /** ACK only the record we import (D050): the vendor app still gets every other one. */
  buildAck(data: Buffer): Buffer | null {
    const mac = this.s.mac;
    if (!mac || data[0] !== NOTIFY_ENCRYPTED || data[2] !== OP_LIVE_RECORD) return null;
    if (!this.importable(data, false)) return null;
    return plainCommand(CMD_FAT_RESULT_ACK, Buffer.from([0x00]), mac);
  }

  isComplete(reading: ScaleReading): boolean {
    return reading.weight > 0;
  }

  computeMetrics(reading: ScaleReading, profile: UserProfile): BodyComposition {
    const pin = reading.scaleComposition as HuaweiPin | undefined;
    return buildPayload(reading.weight, reading.impedance, scaleFat(pin, profile), profile);
  }

  /** The live record this session imports, or null; `log` says why not, once per reason. */
  private importable(data: Buffer, log: boolean): HuaweiRecord | null {
    const { mac, key } = this.s;
    const why = (reason: string): null => {
      if (log) this.once(`skip-${reason}`, `${NAME}: live record ignored: ${reason}`);
      return null;
    };
    if (data.length < 3 + RECORD_LEN) return why('the frame is short');
    if (!mac || !key || !this.s.authorised) return why('the scale has not accepted this host');
    const rec = decodeRecord(recordPlaintext(data, key, mac));
    if (rec.uid !== CH100_USER_ID) return why(`it is for user slot ${rec.uid}, not ours`);
    if (!(rec.weightKg > 0 && rec.weightKg <= MAX_WEIGHT_KG))
      return why('the weight is implausible');
    if (log) {
      bleLog.debug(
        `${NAME}: record for user ${rec.uid}: ${rec.weightKg.toFixed(1)} kg, ` +
          `${rec.fatPercent.toFixed(1)} % fat, [13..14] ${rec.impedance}`,
      );
    }
    return rec;
  }

  private onPlain(data: Buffer): void {
    const s = this.s;
    const op = data[2];
    if (op === OP_WAKEUP) {
      s.wakeupSeen = true;
      if (!this.ctx) return;
      if (!s.authSent) {
        this.sendAuth('wakeup');
      } else if (!s.authAnswered && !s.authResent) {
        // An AUTH sent before the scale woke up (the fallback) may have gone
        // unheard. openScale sends AUTH on every wakeup until authorised, and
        // the scale takes a second AUTH (V2); one more is enough.
        this.resendAuth();
      }
      return;
    }
    if (op === OP_USER_INFO_ANSWER) {
      // The scale answers every USER_INFO with 0x20. openScale resends the
      // profile on it, which only makes the scale answer again.
      if (s.userInfo) s.userInfoAnswered = true;
      this.once('0x20', `${NAME}: the scale answered the profile (0x20)`);
      return;
    }
    if (!s.mac) {
      this.once(
        `bd-${op}-early`,
        `${NAME}: frame bd op 0x${hex2(op)} before the session was ready`,
      );
      return;
    }
    const n = plainNotification(data, s.mac);
    if (!n) return;
    if (op !== OP_AUTH_RESULT) {
      this.once(`bd-${op}`, `${NAME}: frame bd op 0x${hex2(op)} not used`);
      return;
    }
    s.authAnswered = true;
    if (!n.checksumOk) {
      // The checksum is XORed with the MAC too, so a wrong address shows here.
      // Never answered with a bind: the scale would be bound to a wrong token.
      this.once(
        'auth-checksum',
        `${NAME}: the authentication answer does not decode with this scale's address; the ` +
          'transport may report a different address than the scale uses (#503)',
        'warn',
      );
      return;
    }
    if (n.payload[0] !== 0x01) {
      this.once(
        'auth-refused',
        `${NAME}: the scale refused this host. It accepts a host that was bound to its user 1 ` +
          'once, and ble-scale-sync never binds: bind the scale once with openScale as its ' +
          'first user (the same key), then weigh in again (#503)',
        'error',
      );
      return;
    }
    if (s.authorised) return;
    s.authorised = true;
    bleLog.debug(`${NAME}: the scale accepted this host as user ${CH100_USER_ID}`);
    this.sendUserInfo();
  }

  private sendAuth(why: string): void {
    const s = this.s;
    if (!s.mac) return;
    s.authSent = true;
    s.dispose();
    bleLog.debug(`${NAME}: sending AUTH as user ${CH100_USER_ID} (${why})`);
    this.send('AUTH', plainCommand(CMD_AUTH, s.token, s.mac));
  }

  private resendAuth(): void {
    const s = this.s;
    if (!s.mac) return;
    s.authResent = true;
    bleLog.debug(`${NAME}: sending AUTH again: a wakeup came and the scale has not answered`);
    this.send('AUTH', plainCommand(CMD_AUTH, s.token, s.mac));
  }

  private sendUserInfo(): void {
    const s = this.s;
    const ctx = this.ctx;
    if (!ctx || !s.mac || !s.key || s.userInfo) return;
    const profile = ctx.profile;
    const sent = sentProfileOf(profile);
    const weight = profile.lastKnownWeight ?? 22 * (profile.height / 100) ** 2;
    s.userInfo = sent;
    bleLog.debug(`${NAME}: sending USER_INFO with the profile of the first user`);
    this.send('USER_INFO', userInfoCommand(userInfoPlaintext(s.token, sent, weight), s.key, s.mac));
  }

  /** Fire and forget; the context is taken before the write (GOTCHAS #370). */
  private send(what: string, frame: Buffer): void {
    const ctx = this.ctx;
    if (!ctx) return;
    ctx.write(CHR_WRITE, frame, true).then(
      () => bleLog.debug(`${NAME}: ${what} written`),
      (e: unknown) => bleLog.warn(`${NAME}: ${what} write failed: ${errMsg(e)}`),
    );
  }

  private once(key: string, msg: string, level: 'debug' | 'warn' | 'error' = 'debug'): void {
    if (this.s.logged.has(key)) return;
    this.s.logged.add(key);
    bleLog[level](msg);
  }
}

function hex2(n: number): string {
  return n.toString(16).padStart(2, '0');
}
