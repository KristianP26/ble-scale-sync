/**
 * Pure frame builders and decoders for the QN family.
 *
 * Every one of these is byte-pinned by tests against a real capture, so they
 * are the safest thing in the adapter to change and the most dangerous thing to
 * "consolidate". See the note on buildA2Frame in particular.
 */

import type { Gender } from '../../interfaces/scale-adapter.js';

/**
 * Build the extended-dialect measurement trigger for a weight anchor in kg.
 *
 * Clamped to the u16 the field can hold, so a nonsense config value degrades to
 * a wrong anchor rather than a malformed frame.
 */
export function buildMeasurementTrigger(weightKg: number): number[] {
  return buildA2Frame(Math.round(weightKg * 100));
}

/**
 * Build an A2 frame around a raw u16 payload.
 *
 * Separate from `buildMeasurementTrigger` because the live acknowledgement
 * echoes the scale's OWN raw weight bytes back verbatim, which is independent
 * of `weightScaleFactor`; only the pre-stream anchor has to convert from kg.
 */
// DO NOT merge this with the ready-time A2 the handshake builds inline. That
// frame is `a2 06 01 32 <age>`, the identical shape, and buildA2Frame((0x32 <<
// 8) | age) would emit the same bytes for every age the clamp accepts. They are
// deliberately different frames whose payloads the scale reads differently, and
// the comment on TRIGGER_WEIGHT_FALLBACK_KG in constants.ts says why.
export function buildA2Frame(raw: number): number[] {
  const v = Math.min(0xffff, Math.max(0, Math.round(raw)));
  const cmd = [0xa2, 0x06, 0x01, (v >> 8) & 0xff, v & 0xff, 0x00];
  cmd[5] = cmd.slice(0, 5).reduce((a, b) => a + b, 0) & 0xff;
  return cmd;
}

/**
 * The extra byte the vendor app's 0x20 time sync carries and ours does not.
 *
 * From the Arboleaf CS10E HCI capture in #331, next to the reporter's own log
 * of this app in the same session:
 *
 *   vendor app       20 09 ff f3 b3 22 32 08 2a     9 bytes
 *   ble-scale-sync   20 08 ff a1 aa 22 32 c6        8 bytes
 *
 * Both close under the family's sum-of-preceding-bytes checksum (0x2a and 0xc6),
 * `[1]` is the total frame length in both, and `[3..6]` little-endian is seconds
 * since 2000-01-01 in both, 2386 s apart on the capture day. So the timestamp
 * field, its position and the checksum rule are identical and the entire
 * difference is this one byte before the checksum.
 *
 * WHAT IT MEANS IS NOT DECODED. That is why `ble.qn_time_sync_long` is off by
 * default: a wrong value here is silent in exactly the way `qn_protocol_byte`
 * is, and every QN scale in the registry reads today on the 8-byte form.
 *
 * The app's 0x13 config frame is likewise one byte longer than ours. That one
 * lives in `buildConfig` below, behind its own switch for the same reason: two
 * frames moving at once makes a reporter's result unreadable.
 */
const TIME_SYNC_TRAILER = 0x08;

/**
 * 0x13 config frame trailer, the two bytes the vendor app has where this app
 * has one.
 *
 * Two independent captures of the 10-byte form, against our 9-byte one:
 *
 *   app (#235 GE CS 10 G)   13 0a ff 01 10 00 00 02 00 2f
 *   hedoric capture (#235)  13 0a ff 01 10 00 00 00 fa 27
 *   ble-scale-sync          13 09 ff 01 10 00 00 00    2c
 *
 * All three close under the family's sum-of-preceding-bytes checksum (0x2f,
 * 0x27, 0x2c), which is what makes the transcription trustworthy rather than a
 * miscount. `[1]` is the total frame length in all three, and bytes `[0..6]`
 * are identical, so the entire difference is the pair at `[7..8]`.
 *
 * WHAT THOSE TWO BYTES MEAN IS NOT DECODED, and the captures disagree on their
 * value (`02 00` vs `00 fa`), which rules out a constant. The app's own pair is
 * replayed here because it is the only one paired with a session that went on
 * to stream weight. Opt-in and off by default for the same reason as
 * `qn_a4_prelude`: every QN scale in the registry reads today on the 9-byte
 * form, and a wrong value here fails silently.
 */
const CONFIG_TRAILER = [0x02, 0x00] as const;

/** The single byte at `[7]` the 9-byte form has where the 10-byte form has two. */
const CONFIG_TAIL_SHORT = [0x00] as const;

/**
 * Build the 0x13 config frame.
 *
 * `unitFlag` is 0x01 kg / 0x02 lb per openScale's QNHandler, and 0x08 stone as
 * implemented in the reverse-engineered ESF-24 driver (etekcity_esf551_ble).
 * openScale sends 0x02 for stone too, but on a QN-S500 set to kg by hand, 0x08
 * switched the display to st/lb (#429), so the scale honours it as stone.
 * Honouring the display unit is what keeps a read from flipping the scale's
 * display (#269).
 *
 * Exported so a test can pin both forms against the captured frames byte for
 * byte, the way `buildTimeSync` is.
 */
export function buildConfig(protocolType: number, unitFlag: number, long = false): number[] {
  const body = [
    0x13,
    long ? 0x0a : 0x09,
    protocolType,
    unitFlag,
    0x10,
    0x00,
    0x00,
    ...(long ? CONFIG_TRAILER : CONFIG_TAIL_SHORT),
  ];
  return [...body, body.reduce((a, b) => a + b, 0) & 0xff];
}

/**
 * Build the 0x20 time-sync frame.
 *
 * Exported so a test can pin it against the captured frame byte for byte
 * without having to control the handshake's wall clock.
 */
export function buildTimeSync(protocolType: number, seconds: number, long = false): number[] {
  const s = seconds >>> 0;
  const body = [
    0x20,
    long ? 0x09 : 0x08,
    protocolType,
    s & 0xff,
    (s >> 8) & 0xff,
    (s >> 16) & 0xff,
    (s >>> 24) & 0xff,
  ];
  if (long) body.push(TIME_SYNC_TRAILER);
  return [...body, body.reduce((a, b) => a + b, 0) & 0xff];
}

/**
 * The family's trailing checksum: the sum of every byte but the last, mod 256.
 * Pure helper; the captured 0xB4/0xB1 frames and the 19-byte dialect's
 * weigh-in frames all close under it.
 */
export function hasValidSumChecksum(data: Buffer | readonly number[]): boolean {
  if (data.length < 2) return false;
  let sum = 0;
  for (let i = 0; i < data.length - 1; i++) sum = (sum + data[i]) & 0xff;
  return sum === data[data.length - 1];
}

/** One 0x23 stored record, as decodeStoredRecord reads it. */
export interface StoredRecord {
  /** kg */
  weight: number;
  /** Scale-epoch seconds (2000-01-01) the record was written at. */
  recordSeconds: number;
  /** Raw resistance at 50 kHz, as the frame carries it. */
  r50: number;
  /** Raw resistance at 500 kHz, as the frame carries it. */
  r500: number;
}

/**
 * Decode a 0x23 stored record in the layout of the long-frame scales (#461):
 *
 *   [3]       record count, [4] record index, [5] user slot (0xf0 = none)
 *   [6..9]    time written, LE u32, seconds since 2000-01-01
 *   [10..11]  weight, BE u16, /100 kg
 *   [12..13]  R50, BE u16
 *   [14..15]  R500, BE u16
 *
 * This is the layout the vendor's published Android SDK (qnsdkX 2.37.2) reads
 * for these scales, and three real records agree: #213 (504/502), #75
 * (507/505) and #461 (4303/4301). openScale reads both resistances
 * little-endian one byte later, which lands on the right R50 only because
 * R50 and R500 share their high byte; its R500 is the low byte of R500 and a
 * zero (246, 249 and 205 on those records). Classic scales use a different
 * layout and are not read through this. Null below 16 bytes.
 */
export function decodeStoredRecord(data: Buffer): StoredRecord | null {
  if (data.length < 16) return null;
  return {
    weight: data.readUInt16BE(10) / 100,
    recordSeconds: data.readUInt32LE(6),
    r50: data.readUInt16BE(12),
    r500: data.readUInt16BE(14),
  };
}

/** Exchange bits `i` and `j` of a byte. */
function swapBits(b: number, i: number, j: number): number {
  return ((b >> i) & 1) === ((b >> j) & 1) ? b : b ^ ((1 << i) | (1 << j));
}

/** One byte of a scrambled resistance: bits 3 and 5, then 0 and 4, exchanged. */
function unscrambleByte(b: number): number {
  return swapBits(swapBits(b & 0xff, 3, 5), 0, 4);
}

/**
 * Unscramble a u16 resistance from a scale whose advertisement flags its
 * resistance as scrambled (see SCRAMBLE_FLAG_BIT in constants.ts, #461). Each
 * byte is unscrambled on its own, so this is the same as unscrambling the two
 * frame bytes and reading them big-endian. Its own inverse.
 *
 *   0x10cf (4303) -> 0x01f6 (502)
 */
export function decryptQnResistance(raw: number): number {
  return (unscrambleByte(raw >> 8) << 8) | unscrambleByte(raw);
}

/** Age openScale's constant A00D #2 profile frame carries. */
export const OPENSCALE_PROFILE_AGE = 33;
/** Height in mm openScale's constant A00D #2 profile frame carries. */
export const OPENSCALE_PROFILE_HEIGHT_MM = 1720;

/**
 * Build the A00D #2 user profile frame from an age, a height in cm and a sex.
 *
 *   a0 0d 02 01 03 e8 <sex> <age> <height mm, u16 BE> 04 02 <cs>
 *
 * Two vendor-app captures send this shape with the app user's configured age
 * at [7] and height in millimetres at [8..9], from different apps and scales:
 *
 *   GE app (20-byte scale)       a0 0d 02 01 03 e8 00 1a 07 8a 04 02 4c
 *   Arboleaf app (19-byte scale) a0 0d 02 01 03 e8 00 33 07 1c 04 02 f7
 *
 * Both app users are men, and [6] is `00` in both. Per the vendor's published
 * SDK, [6] is the sex (0 male, 1 female), [3] the user slot, [4..5] a user key,
 * [10] the body-fat algorithm and [11] a regional grade; `03 e8` and `04 02`
 * are sent as captured. Before #331 [6] was always `00`, so the scale stored
 * and computed every woman's profile as a man's. openScale sends the same
 * shape with constants (age 33, 1720 mm, `00 08` at [4..5]), and the one
 * captured 19-byte scale answers that with `a1 06 02 01 00` where the app gets
 * `a1 06 02 01 01` (#331).
 */
export function buildUserProfileFrame(
  age: number,
  heightCm: number,
  gender: Gender = 'male',
): number[] {
  const a = Number.isFinite(age)
    ? Math.min(0xff, Math.max(1, Math.round(age)))
    : OPENSCALE_PROFILE_AGE;
  const mm = Number.isFinite(heightCm)
    ? Math.min(0xffff, Math.max(0, Math.round(heightCm * 10)))
    : OPENSCALE_PROFILE_HEIGHT_MM;
  const cmd = [
    0xa0,
    0x0d,
    0x02,
    0x01,
    0x03,
    0xe8,
    gender === 'female' ? 0x01 : 0x00,
    a,
    (mm >> 8) & 0xff,
    mm & 0xff,
    0x04,
    0x02,
  ];
  return [...cmd, cmd.reduce((s, b) => s + b, 0) & 0xff];
}
