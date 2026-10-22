import type {
  AckProtocol,
  AdapterRuntimeConfig,
  BleDeviceInfo,
  CharacteristicBinding,
  ConnectionContext,
  Gender,
  ScaleAdapterCore,
  GattWiring,
  HoldForComposition,
  MultiCharNotify,
  ScaleReading,
  UserProfile,
  BodyComposition,
} from '../interfaces/scale-adapter.js';
import { uuid16, buildPayload, type ScaleBodyComp } from './body-comp-helpers.js';
import { matchesDescriptor, type MatchDescriptor } from './match-descriptor.js';
import { bleLog, errMsg } from '../ble/types.js';
import { build55aaFrame, frameFault, sum8 } from './renpho-55aa.js';
import type { AdapterOptions } from '../config/resolve.js';
import type { RMSC04_BLE_OPTIONS } from './renpho-msc04-options.js';

// ─── Renpho R-MSC04 (55AA framed, vendor service 0x1A10) ────────────────────

const CHR_NOTIFY = uuid16(0x2a10); // live weight stream (cmd 0x21)
const CHR_WRITE = uuid16(0x2a11); // b2 profile, b3 clock and the b0 status acks (Write only)
const CHR_INDICATE = uuid16(0x2a12); // status, final weight, composition record

const HDR0 = 0x55;
const HDR1 = 0xaa;
const CMD_STATUS = 0x20; // measurement state on 0x2A12
const CMD_LIVE = 0x21; // live weight on 0x2A10
const CMD_FINAL = 0x24; // final weight on 0x2A12
const CMD_RECORD = 0x25; // composition record of this weigh-in, fragmented on 0x2A12
const CMD_HISTORY = 0x26; // stored record of an earlier weigh-in, same fragmenting

// Header (2) + cmd (1) + length (2) + checksum (1) = 6 non-payload bytes.
const FRAME_OVERHEAD = 6;

// Declared length of a 0x25 record (seq + 35 bytes), 42 bytes on the wire.
const RECORD_LEN = 0x24;

/**
 * How long the link stays open after the settled weight for the 0x25 record.
 * In the #117 capture the first fragment arrived 15.9 s after the 0x24 frame,
 * with up to 9.6 s of silence in between (#434).
 */
const COMPOSITION_HOLD_MS = 30_000;

/** A record whose weight differs from the settled weight by more is not this weigh-in. */
const RECORD_WEIGHT_TOLERANCE_KG = 0.5;

/**
 * The scale's body fat and BMI are presumably computed from the profile last
 * written to the scale: in the #117 capture the Renpho app writes a b2 profile
 * (height 187.0 cm) on every connection. In a session where we wrote our own
 * guest b2 the record is not exported unless ble.rmsc04_profile_byte is set,
 * and then only through its own gates (D079); otherwise the profile may be
 * another household member's. The BMI the scale reports gives the height it
 * used away; a larger gap than this to the user's configured height means the
 * scale's figures are not about this user.
 */
const PROFILE_HEIGHT_TOLERANCE_CM = 3;

/** A reassembled record is 42 (0x25) or 46 (0x26) bytes; anything past this is not one. */
const MAX_REASSEMBLED_BYTES = 64;

/** Application-level fragment header: marker (0xAD, 0xAE, 0xAF), seq, fragments remaining. */
const FRAGMENT_HEADER_LEN = 3;

/**
 * The 0x20 state right before the 0x25 record of this weigh-in: 135 ms before
 * it in the #117 capture, and the status just before it in a #434 session that
 * connected after the weight locked. Without a 0x24 it is what ties the record
 * to this weigh-in (D057).
 */
const STATE_COMPLETE = 0x11;

/**
 * 0x20 status [6]. 0x04 and 0x05 are named after what followed them, not from
 * a spec: in the #117 capture the scale sent 0x05 as the first status of a
 * connection with stored records and nobody on it, and disconnected 133 ms
 * after 0x04 once those records were synced; #434 logs show 0x05 after a
 * finished weigh-in and a disconnect within 0.1 s of 0x04.
 */
const STATUS_NAMES: Record<number, string> = {
  0x01: 'measuring',
  0x04: 'scale is ending the session',
  0x05: 'not measuring',
  0x09: 'weight locked',
  0x11: 'measurement complete',
};

/**
 * The scale's replies to our writes, `55 AA <cmd> <len> <seq> <result..>`,
 * with the seq of the write they answer (#117 capture: 0x22 for b2, 0x23 for
 * b3, 0x27/0x28 for the app's b7/b8, which we never send).
 */
const REPLY_TO: Record<number, number> = { 0x22: 0xb2, 0x23: 0xb3, 0x27: 0xb7, 0x28: 0xb8 };

/**
 * The scale's reply to a b2, `55 AA 22 00 02 <seq> <slot>`: the seq and the
 * slot of the b2 it answers (the #117 capture, an owner's DEBUG log on #434
 * and a private capture). It arrives on 0x2A12 like the 0x20 status, so the
 * transport keeps the two in order.
 */
const CMD_PROFILE_REPLY = 0x22;

/** What one session's summary line reports (#434). Times are Date.now() values. */
interface SessionDiagnostics {
  handshakeAt: number | null;
  mode: ConnectWrites;
  /** Outcome per written command, in write order: pending, sent, failed or refused. */
  writes: Map<number, string>;
  /** Commands the scale answered (b2, b3, ...). */
  answered: Set<number>;
  firstStatus: { state: number; stored: number } | null;
  lastStatus: { state: number; at: number } | null;
  replayed: number;
  record: 'no' | 'ignored' | 'used';
  lastFrameAt: number | null;
}

function freshDiagnostics(): SessionDiagnostics {
  return {
    handshakeAt: null,
    mode: 'full',
    writes: new Map(),
    answered: new Set(),
    firstStatus: null,
    lastStatus: null,
    replayed: 0,
    record: 'no',
    lastFrameAt: null,
  };
}

/** Milliseconds as seconds with one decimal. */
function secs(ms: number): string {
  return (ms / 1000).toFixed(1);
}

/**
 * How close the record's BMI must be to its weight over the height we sent
 * squared to count as computed for that height. The scale rounds BMI to 0.1,
 * and 1 cm moves it by more (about 0.29 at 95.55 kg and 187 cm): the #117
 * capture's record is 0.024 from the 187.0 cm the app sent. The same as the
 * QN BMI_MATCH_TOLERANCE (D048).
 */
const SENT_BMI_TOLERANCE = 0.1 + 1e-9;

/** What a validated 0x25 record carries. Impedances in ohm, segment order below. */
interface CompositionRecord {
  weight: number;
  fatPercent: number;
  bmi: number;
  skeletalMusclePercent: number;
  visceralFat: number;
  /** Trunk, left arm, right arm, left leg, right leg. */
  impedance20kHz: number[];
  impedance100kHz: number[];
}

/** Our b2 with ble.rmsc04_profile_byte in this session (D079). Compared, never logged. */
interface OwnProfile {
  seq: number;
  /** Null when the profile had no usable height and 170.0 cm went out. */
  heightTenths: number | null;
  gender: Gender;
  birthDate: string | undefined;
  age: number;
  /** The transport confirmed the write while this session still owned the link. */
  written: boolean;
}

/** Everything the D079 gate reads, copied onto the reading with the record (D077). */
interface OwnProfilePin {
  heightTenths: number | null;
  gender: Gender;
  birthDate: string | undefined;
  age: number;
  written: boolean;
  answeredBeforeComplete: boolean;
}

/** A record on the reading it completed, and whether our guest b2 went out in that session. */
interface PinnedRecord {
  rec: CompositionRecord;
  guestProfile: boolean;
  /** Set only when ble.rmsc04_profile_byte went out in this session's b2. */
  own?: OwnProfilePin;
}

/** Whether the record's BMI fits a height in 0.1 cm (see SENT_BMI_TOLERANCE). */
function fitsSentHeight(rec: CompositionRecord, tenths: number): boolean {
  const m = tenths / 1000;
  return Math.abs(rec.bmi - rec.weight / (m * m)) <= SENT_BMI_TOLERANCE;
}

function isBareFrame(data: Buffer): boolean {
  return data.length >= 2 && data[0] === HDR0 && data[1] === HDR1;
}

/**
 * Validate a 55AA frame's header, declared length and checksum. Returns the
 * command and the frame length the header declares, or null.
 */
function validateFrame(data: Buffer): { cmd: number; len: number; frameLen: number } | null {
  if (data.length < 5) return null; // need [0..4] to read the length field
  if (!isBareFrame(data)) return null;
  const len = data.readUInt16BE(3);
  const frameLen = len + FRAME_OVERHEAD;
  if (data.length < frameLen) return null; // truncated / declared-length mismatch
  if (sum8(data.subarray(0, frameLen - 1)) !== data[frameLen - 1]) return null; // bad checksum
  return { cmd: data[2], len, frameLen };
}

function hex(data: Buffer): string {
  return data.toString('hex');
}

function byteHex(b: number): string {
  return b.toString(16).padStart(2, '0');
}

/** The weight range a 0x21, 0x24 or 0x25 weight must fall in, in kg. */
function isPlausibleKg(kg: number): boolean {
  return Number.isFinite(kg) && kg >= 0.5 && kg <= 300;
}

// ─── Connect writes: b2 guest profile and b3 clock (#434, D038) ─────────────
//
// The two frames a working ESPHome client on #117 writes after connecting.
// The Renpho app writes them too, together with b7 (the user's first name)
// and b8 (settings, not decoded), which this adapter never sends.

const CMD_PROFILE = 0xb2;
const CMD_CLOCK = 0xb3;

/** b2 payload length: seq, slot, height (2), last weight (2), [11..13]. */
const PROFILE_LEN = 9;
/**
 * Slot 09, the one the ESPHome client writes. The app writes the user's
 * registered slot (01, 02) there. That 09 is a guest slot the scale does not
 * keep as a user is a hypothesis carried over from the ES-CS20M 0x96 form.
 */
const GUEST_SLOT = 0x09;
/**
 * b2 [11] verbatim from the ESPHome client. It is not decoded (most likely sex
 * and age). "0x80 | age" fits one private capture but not two profiles of
 * known age, so it stays a hypothesis; this is why the scale's figures from a
 * session with this byte are not exported. ble.rmsc04_profile_byte replaces it
 * with the user's own byte (D079).
 */
const GUEST_PROFILE_BYTE = 0xa9;
/** b2 [12..13] verbatim from the ESPHome client. */
const GUEST_TAIL = [0xff, 0x02];

/** b3 payload length: seq, constant (3), Unix seconds (4), zone minutes (2), 00. */
const CLOCK_LEN = 11;
/** b3 [6..8], the same in both app captures and both client implementations. */
const CLOCK_CONSTANT = [0x07, 0x01, 0x01];
/**
 * b3 [13..14] is the zone in minutes east of UTC (600 in both app captures,
 * taken at UTC+10). No capture west of UTC exists, so its encoding there is
 * unknown and such a zone is sent as 0.
 */
const MAX_ZONE_MINUTES = 840;

/**
 * Temporary diagnostic switch for #434, read from the environment (not
 * config.yaml) on every connect: `full` (default) writes b2 and b3, `time`
 * only b3, `none` nothing. The status acks are sent in every mode. It exists
 * to find the smallest set of writes the scale needs, and goes away or gets
 * documented once #434 has its answer.
 */
const HANDSHAKE_ENV = 'BLE_RMSC04_HANDSHAKE';

export type ConnectWrites = 'full' | 'time' | 'none';

/**
 * The writes BLE_RMSC04_HANDSHAKE asks for, case-insensitive. Unset or empty
 * is `full` (an empty value is how compose files leave a variable unset, D016);
 * any other value is null.
 */
export function rmsc04ConnectWrites(
  raw: string | undefined = process.env[HANDSHAKE_ENV],
): ConnectWrites | null {
  const value = (raw ?? '').trim().toLowerCase();
  if (value === '') return 'full';
  return value === 'full' || value === 'time' || value === 'none' ? value : null;
}

/** Height in 0.1 cm sent when the profile has none in range: 170.0 cm, as ES-CS20M. */
const FALLBACK_HEIGHT_TENTHS = 1700;
const MIN_HEIGHT_TENTHS = 500;
const MAX_HEIGHT_TENTHS = 2500;
/** Last weight in 0.01 kg sent when the profile has none: 70.00 kg. Never 0, as ES-CS20M. */
const FALLBACK_WEIGHT_CG = 7000;
const MIN_WEIGHT_CG = 50;
const MAX_WEIGHT_CG = 30000;

/** The profile height in 0.1 cm, or null when it is missing or out of range. */
function heightTenths(profile: UserProfile): number | null {
  const tenths = Math.round(profile.height * 10);
  return Number.isFinite(tenths) && tenths >= MIN_HEIGHT_TENTHS && tenths <= MAX_HEIGHT_TENTHS
    ? tenths
    : null;
}

/** The profile's last known weight in 0.01 kg, or null when it has none in range. */
function weightCg(profile: UserProfile): number | null {
  const kg = profile.lastKnownWeight;
  if (kg === undefined || !Number.isFinite(kg) || kg <= 0.5 || kg > 300) return null;
  return Math.round(kg * 100);
}

/** The host's zone in minutes east of UTC, or null when the b3 frame cannot carry it. */
function zoneMinutes(now: Date): number | null {
  // getTimezoneOffset is positive WEST of Greenwich.
  const east = -now.getTimezoneOffset();
  return Number.isInteger(east) && east >= 0 && east <= MAX_ZONE_MINUTES ? east : null;
}

/**
 * `b2` in the guest form: seq, slot 09, height in 0.1 cm and last weight in
 * 0.01 kg (both u16 BE), then `profileByte` (a9 by default) and ff 02. The seq
 * is echoed in the 0x22 reply.
 */
export function buildGuestProfileFrame(
  seq: number,
  profile: UserProfile,
  profileByte: number = GUEST_PROFILE_BYTE,
): Buffer {
  const height = heightTenths(profile) ?? FALLBACK_HEIGHT_TENTHS;
  const weight = weightCg(profile) ?? FALLBACK_WEIGHT_CG;
  return build55aaFrame(CMD_PROFILE, [
    seq & 0xff,
    GUEST_SLOT,
    (height >> 8) & 0xff,
    height & 0xff,
    (weight >> 8) & 0xff,
    weight & 0xff,
    profileByte & 0xff,
    ...GUEST_TAIL,
  ]);
}

/**
 * `b3`: seq, 07 01 01, Unix seconds (UTC) as u32 BE, the zone in minutes east
 * of UTC as u16 BE (0 west of UTC, see MAX_ZONE_MINUTES), 00. The seq is echoed
 * in the 0x23 reply.
 */
export function buildClockFrame(seq: number, now: Date): Buffer {
  const seconds = Math.floor(now.getTime() / 1000) >>> 0;
  const zone = zoneMinutes(now) ?? 0;
  return build55aaFrame(CMD_CLOCK, [
    seq & 0xff,
    ...CLOCK_CONSTANT,
    (seconds >>> 24) & 0xff,
    (seconds >>> 16) & 0xff,
    (seconds >>> 8) & 0xff,
    seconds & 0xff,
    (zone >> 8) & 0xff,
    zone & 0xff,
    0x00,
  ]);
}

/**
 * Throw unless `frame` is a b2 guest profile or a b3 clock this adapter is
 * allowed to send.
 *
 * The builders cannot produce anything else; this is the backstop for when one
 * of them changes. b2 in another slot would overwrite a user the Renpho app
 * owns, and b7 (name), b8 (settings) and b6 (deletes a stored record) are never
 * sent. The status acks go through buildAck, not through here. The length
 * field and checksum are checked too, so a second frame cannot ride along
 * behind an allowed one. A b2's [11] must be exactly `profileByte`, the byte
 * this session sends.
 */
export function assertAllowedWrite(frame: Buffer, profileByte: number = GUEST_PROFILE_BYTE): void {
  const refuse = (why: string): never => {
    throw new Error(`Renpho R-MSC04: refusing to write ${why}`);
  };
  const fault = frameFault(frame);
  if (fault) refuse(fault);
  const len = frame.readUInt16BE(3);
  const cmd = frame[2];
  const p = frame.subarray(5, frame.length - 1);
  switch (cmd) {
    case CMD_PROFILE: {
      const height = len === PROFILE_LEN ? p.readUInt16BE(2) : 0;
      const weight = len === PROFILE_LEN ? p.readUInt16BE(4) : 0;
      if (
        len !== PROFILE_LEN ||
        p[1] !== GUEST_SLOT ||
        height < MIN_HEIGHT_TENTHS ||
        height > MAX_HEIGHT_TENTHS ||
        weight < MIN_WEIGHT_CG ||
        weight > MAX_WEIGHT_CG ||
        p[6] !== profileByte ||
        GUEST_TAIL.some((b, i) => p[7 + i] !== b)
      ) {
        refuse('a b2 other than the guest form');
      }
      return;
    }
    case CMD_CLOCK:
      if (
        len !== CLOCK_LEN ||
        CLOCK_CONSTANT.some((b, i) => p[1 + i] !== b) ||
        p.readUInt16BE(8) > MAX_ZONE_MINUTES ||
        p[10] !== 0x00
      ) {
        refuse('a b3 other than the clock form');
      }
      return;
    default:
      refuse(`command 0x${cmd.toString(16).padStart(2, '0')}`);
  }
}

/**
 * Reassembles the 0x25/0x26 records the scale splits across several
 * indications (#117 capture): each fragment is
 *   marker(1) | seq(1) | remaining(1) | chunk
 * with markers 0xAD, 0xAE, 0xAF and `remaining` counting down to 0. The first
 * chunk opens a 55AA frame. A chain is kept only while every fragment follows
 * the previous one exactly (same seq, marker + 1, remaining - 1); anything
 * else drops it, and the checksum of the joined frame is checked by the caller.
 */
class FragmentReassembler {
  private chunks: Buffer[] = [];
  private size = 0;
  private seq = -1;
  private marker = -1;
  private remaining = -1;

  reset(): void {
    this.chunks = [];
    this.size = 0;
    this.seq = -1;
    this.marker = -1;
    this.remaining = -1;
  }

  /** Feed one fragment. Returns the joined frame once the last one arrives. */
  push(data: Buffer): Buffer | null {
    if (data.length <= FRAGMENT_HEADER_LEN) return null;
    const marker = data[0];
    const seq = data[1];
    const remaining = data[2];
    // Copied: a transport may reuse the buffer it handed us.
    const chunk = Buffer.from(data.subarray(FRAGMENT_HEADER_LEN));

    const continues =
      this.remaining > 0 &&
      seq === this.seq &&
      remaining === this.remaining - 1 &&
      marker === ((this.marker + 1) & 0xff);

    if (!continues) {
      if (this.remaining > 0) {
        bleLog.debug(
          `Renpho R-MSC04: fragment ${hex(data.subarray(0, FRAGMENT_HEADER_LEN))} does not ` +
            `continue record ${this.seq}, dropping the partial record`,
        );
      }
      this.reset();
      // Only a fragment that opens a 55AA frame can start a record.
      if (!isBareFrame(chunk)) return null;
      this.seq = seq;
    }

    this.marker = marker;
    this.remaining = remaining;
    this.chunks.push(chunk);
    this.size += chunk.length;
    if (this.size > MAX_REASSEMBLED_BYTES) {
      bleLog.debug('Renpho R-MSC04: reassembled record too long, dropping it');
      this.reset();
      return null;
    }
    if (remaining !== 0) return null;

    const frame = Buffer.concat(this.chunks);
    this.reset();
    return frame;
  }
}

/** The record's body fat, and its visceral fat when it is 1 to 59. */
function recordComposition(rec: CompositionRecord): ScaleBodyComp {
  const comp: ScaleBodyComp = { fat: rec.fatPercent };
  if (rec.visceralFat >= 1 && rec.visceralFat <= 59) comp.visceralFat = rec.visceralFat;
  return comp;
}

/** The weigh-in's user has the profile our b2 carried: height, sex, birth date and age. */
function sameProfile(own: OwnProfilePin, profile: UserProfile): boolean {
  return (
    own.heightTenths !== null &&
    own.heightTenths === heightTenths(profile) &&
    own.gender === profile.gender &&
    own.birthDate === profile.birthDate &&
    own.age === profile.age
  );
}

/**
 * The record's body fat and visceral fat from a session whose b2 carried
 * ble.rmsc04_profile_byte, or {} (the estimate) with one info line saying why
 * (D079). Reads only the record, the pin and the profile, never the session or
 * the option: by now both may belong to another session or a reload. No line
 * carries the byte, a height, a weight, an age or a difference.
 */
function ownProfileComposition(
  rec: CompositionRecord,
  own: OwnProfilePin,
  profile: UserProfile,
): ScaleBodyComp {
  let why: string | null = null;
  if (!(rec.fatPercent > 0)) why = 'the scale reported no body fat';
  else if (!(rec.bmi > 0)) why = 'the scale reported no BMI';
  else if (!own.written) {
    why = 'the profile frame with ble.rmsc04_profile_byte was not confirmed as written';
  } else if (!own.answeredBeforeComplete) {
    why =
      'the scale did not answer the profile frame before it first reported the measurement ' +
      'complete, or its last status before the record was not measurement complete';
  } else if (own.heightTenths === null) {
    why = "the first user's height is out of range, so the profile frame carried 170.0 cm";
  } else if (!sameProfile(own, profile)) {
    why =
      'the weigh-in was matched to a user whose height, sex, birth date or age is not the ' +
      'profile sent to the scale';
  } else if (!fitsSentHeight(rec, own.heightTenths)) {
    why = "the scale's BMI does not fit the height sent to it";
  }
  if (why !== null) {
    bleLog.info(
      "Renpho R-MSC04: the scale's body fat and visceral fat are not used for this weigh-in: " +
        `${why}; using the estimate (#434)`,
    );
    return {};
  }
  bleLog.info(
    "Renpho R-MSC04: using the scale's body fat and visceral fat, computed for the profile " +
      'sent with ble.rmsc04_profile_byte (#434)',
  );
  return recordComposition(rec);
}

/** Decode a validated 0x25 frame (42 bytes, all fields big-endian). */
function decodeRecord(f: Buffer): CompositionRecord {
  const tenths = (start: number, count: number): number[] =>
    Array.from({ length: count }, (_, i) => f.readUInt16BE(start + i * 2) / 10);
  return {
    weight: f.readUInt32BE(7) / 100,
    impedance20kHz: tenths(12, 5),
    impedance100kHz: tenths(22, 5),
    fatPercent: f.readUInt16BE(33) / 10,
    bmi: f.readUInt16BE(35) / 10,
    skeletalMusclePercent: f.readUInt16BE(37) / 10,
    visceralFat: f.readUInt16BE(39),
  };
}

/** One weigh-in's state, replaced whole in onSessionStart (#394, SCALES.md). */
class Msc04Session {
  finalReceived = false;
  finalWeight = 0;
  /** State of the latest 0x20 status in this session, or null before the first. */
  lastState: number | null = null;
  /** Stored records ([8]) the first full 0x20 status of this session reported, or null. */
  storedAtStart: number | null = null;
  reassembler = new FragmentReassembler();
  /** This session's context, so a write left over from a dead session never runs. */
  ctx: ConnectionContext | null = null;
  /** A b2 write was attempted in this session: the scale's figures are not exported. */
  guestProfileSent = false;
  /** The height in this session's b2, in 0.1 cm. Compared, never logged. */
  sentHeightTenths: number | null = null;
  /** Our b2 with ble.rmsc04_profile_byte, or null when it did not go out (D079). */
  own: OwnProfile | null = null;
  /** The scale answered our b2 with 0x22 (its seq, slot 09). */
  profileAnswered = false;
  /** A 0x11 status came before the scale answered our b2 (the D079 latch). */
  completeBeforeAnswer = false;
  /** The latest status is 0x11, and the answer to our b2 came before every 0x11 so far. */
  answeredBeforeComplete = false;
  diag = freshDiagnostics();
}

/**
 * Adapter for the Renpho R-MSC04 body-composition scale (#117, #265, #434;
 * sibling of the R-MSC02 in #230).
 *
 * The scale frames everything as
 *   55 AA | cmd(1) | length(2 BE) | payload(length) | checksum(1)
 * with checksum = (sum of every preceding byte) & 0xff. Live weight arrives as
 * cmd 0x21 on notify 0x2A10; the final settled weight arrives as cmd 0x24 on
 * indicate 0x2A12. For both, weight = last two payload bytes, big-endian, / 100.
 *
 * Right after connecting, the adapter writes a b2 guest profile and then a b3
 * clock, each as a Write Request (0x2A11 is Write only), and no start
 * command: neither app capture sends one, and with only the start command the
 * scale dropped every one of our connections about 5.5 s after it was made,
 * while it held the app for 49 s (#434, D038). The scale's 0x20 status frames
 * are acked with b0 as the iOS app does.
 *
 * Body composition is measured AFTER the weight settles. The scale reports
 * its progress as 0x20 status frames and then sends a 0x25 record, split
 * over three indications on 0x2A12 (#117 capture: 15.9 s after the 0x24
 * frame). So the 0x24 weight no longer ends the session: it is held for up
 * to COMPOSITION_HOLD_MS and resolves at once when a matching 0x25 record
 * lands, or weight-only when none does. A session that connects after the
 * weight locked never gets a 0x24 (#434); its 0x25 record is then the reading,
 * with the record's own weight, when the status right before it was 0x11 and
 * the session started with no stored records (D057). 0x26 records are stored
 * history of earlier weigh-ins and are never used.
 *
 * Of the record, only the scale's body fat and visceral fat are ever exported.
 * From a session in which we did NOT write our guest b2, only when the profile
 * the scale computed them for matches the user (see
 * PROFILE_HEIGHT_TOLERANCE_CM). From a session with our guest b2 (its [11] a9
 * is not decoded, so the scale may have computed them for the wrong sex or
 * age; D038), only when ble.rmsc04_profile_byte put the user's own byte there,
 * and then only through the gates of ownProfileComposition (D079): the record
 * has body fat and BMI, our b2 was written, the scale answered it before it
 * first reported the measurement complete, the weigh-in's user has the
 * profile we sent, and the BMI fits the height we sent. The segment
 * impedances are logged at debug level; no whole-body impedance is derived
 * from them, so the reading keeps impedance 0.
 *
 * Routing is by advertised name only (names.exact ['r-msc04']). The device also
 * exposes service 0x1A10, which ES-CS20M claims, so this adapter intentionally
 * does NOT claim 0x1A10: a nameless 0x1A10 device stays with ES-CS20M, while a
 * named R-MSC04 wins here on priority (235 > 130).
 */
export class RenphoMsc04Adapter
  implements ScaleAdapterCore, GattWiring, MultiCharNotify, HoldForComposition, AckProtocol
{
  readonly name = 'Renpho R-MSC04';
  readonly match: MatchDescriptor = {
    priority: 235,
    custom: true,
    names: { exact: ['r-msc04'] },
  };
  // Legacy single-char fallback (unused in multi-char mode).
  readonly charNotifyUuid = CHR_NOTIFY;
  readonly charWriteUuid = CHR_WRITE;
  readonly completionHoldMs = COMPOSITION_HOLD_MS;
  /**
   * The Renpho app writes its status acks as Write Requests, and the scale
   * answers each with a Write Response (#117 capture). That is the only mode
   * seen working for them, so the handler writes them with response.
   */
  readonly ackWithResponse = true;

  // 0x2A12 is physically an indicate characteristic. The shared subscribe loop
  // only auto-subscribes 'notify' bindings, and node-ble/noble enable
  // indications transparently, so declare it 'notify' (same pattern as
  // BeurerBf720 / RobiS9).
  readonly characteristics: CharacteristicBinding[] = [
    { uuid: CHR_WRITE, type: 'write' },
    { uuid: CHR_NOTIFY, type: 'notify' },
    { uuid: CHR_INDICATE, type: 'notify' },
  ];

  private s = new Msc04Session();

  /** Log the unsendable time zone once per adapter instance (one per process in production). */
  private zoneLogged = false;
  /** BLE_RMSC04_HANDSHAKE values already warned about, once per value and instance. */
  private readonly unknownHandshakeValues = new Set<string>();

  private readonly now: () => Date;

  /** ble.rmsc04_profile_byte, or null (process lifetime, D075). Never logged. */
  private profileByte: number | null = null;

  /** `now` is the clock the b3 frame carries; durations use Date.now(). */
  constructor(now: () => Date = () => new Date()) {
    this.now = now;
  }

  matches(device: BleDeviceInfo): boolean {
    return matchesDescriptor(device, this.match);
  }

  configure(opts: AdapterRuntimeConfig & AdapterOptions<typeof RMSC04_BLE_OPTIONS>): void {
    const v = opts.rmsc04ProfileByte;
    // The schema already checked it; this guards a direct caller. Never logged.
    this.profileByte =
      typeof v === 'string' && /^[0-9a-f]{2}$/i.test(v) ? Number.parseInt(v, 16) : null;
  }

  onSessionStart(): void {
    this.s = new Msc04Session();
  }

  async onConnected(ctx: ConnectionContext): Promise<void> {
    if (!ctx.availableChars.has(CHR_WRITE)) {
      throw new Error(
        `Renpho R-MSC04: write characteristic (${CHR_WRITE}) not discovered. ` +
          'Likely a transient GATT discovery race. Try again.',
      );
    }
    this.s.ctx = ctx;
    const mode = this.connectWrites();
    this.s.diag.handshakeAt = Date.now();
    this.s.diag.mode = mode;
    bleLog.debug(`Renpho R-MSC04: connect writes ${mode}`);
    if (mode === 'full') {
      await this.writeGuestProfile(ctx, 0);
      await this.writeClock(ctx, 1);
    } else if (mode === 'time') {
      await this.writeClock(ctx, 0);
    }
  }

  private connectWrites(): ConnectWrites {
    const raw = process.env[HANDSHAKE_ENV];
    const mode = rmsc04ConnectWrites(raw);
    if (mode) return mode;
    const value = (raw ?? '').trim();
    if (!this.unknownHandshakeValues.has(value)) {
      this.unknownHandshakeValues.add(value);
      bleLog.warn(
        `Renpho R-MSC04: ignoring ${HANDSHAKE_ENV}=${JSON.stringify(value)}, ` +
          'expected full, time or none; using full',
      );
    }
    return 'full';
  }

  onSessionEnd(): void {
    if (this.s.diag.handshakeAt !== null) this.logSummary(this.s.diag.handshakeAt);
    this.s.ctx = null;
  }

  /**
   * One line per session for #434: how long it lived after the handshake
   * started (about 0.65 s after the connect), which writes the scale answered,
   * what it reported, and how long it was silent before the end. Best effort:
   * onSessionEnd does not run on every transport path.
   */
  private logSummary(start: number): void {
    const d = this.s.diag;
    const end = Date.now();
    const writes = [...d.writes]
      .map(([cmd, outcome]) => {
        const state = d.answered.has(cmd)
          ? 'answered'
          : outcome === 'sent'
            ? 'not answered'
            : outcome;
        return `b${(cmd & 0x0f).toString(16)} ${state}`;
      })
      .join(', ');
    const first = d.firstStatus
      ? `first status 0x${byteHex(d.firstStatus.state)} with ${d.firstStatus.stored} stored records`
      : 'no status';
    const last = d.lastStatus
      ? `last status 0x${byteHex(d.lastStatus.state)} at ${secs(d.lastStatus.at - start)} s`
      : 'no last status';
    const lastFrame =
      d.lastFrameAt !== null
        ? `last frame ${secs(end - d.lastFrameAt)} s before the end`
        : 'no frames';
    bleLog.debug(
      `Renpho R-MSC04: session ended ${secs(end - start)} s after the handshake started ` +
        `(writes ${d.mode}${writes ? `: ${writes}` : ''}; ${first}; ${last}; ` +
        `0x24 ${this.s.finalReceived ? 'yes' : 'no'}; stored records replayed ${d.replayed}; ` +
        `composition record ${d.record}; ${lastFrame})`,
    );
  }

  /**
   * The guest b2. Neither the frame nor the height, weight or profile byte in it
   * ever reaches the log: they are the first user's.
   */
  private async writeGuestProfile(owner: ConnectionContext, seq: number): Promise<void> {
    const profile = owner.profile;
    if (heightTenths(profile) === null) {
      bleLog.debug('Renpho R-MSC04: no usable height for the guest profile, sending 170.0 cm');
    }
    if (weightCg(profile) === null) {
      bleLog.debug('Renpho R-MSC04: no usable last weight for the guest profile, sending 70.00 kg');
    }
    this.s.sentHeightTenths = heightTenths(profile) ?? FALLBACK_HEIGHT_TENTHS;
    const byte = this.profileByte;
    const own: OwnProfile | null =
      byte === null
        ? null
        : {
            seq,
            heightTenths: heightTenths(profile),
            gender: profile.gender,
            birthDate: profile.birthDate,
            age: profile.age,
            written: false,
          };
    // Set before the write: the 0x22 answer can arrive before the transport
    // confirms it. Held here, so a write that settles after this session ended
    // marks only its own session's object.
    this.s.own = own;
    const ok = await this.send(
      owner,
      CMD_PROFILE,
      () => buildGuestProfileFrame(seq, profile, byte ?? GUEST_PROFILE_BYTE),
      byte === null ? 'guest profile (b2)' : 'guest profile (b2) with ble.rmsc04_profile_byte',
      false,
      byte ?? GUEST_PROFILE_BYTE,
    );
    if (ok && own) own.written = true;
  }

  private async writeClock(owner: ConnectionContext, seq: number): Promise<void> {
    const now = this.now();
    if (zoneMinutes(now) === null && !this.zoneLogged) {
      this.zoneLogged = true;
      bleLog.debug(
        'Renpho R-MSC04: the host time zone is west of UTC or beyond UTC+14, ' +
          'which the clock frame cannot carry; sending the time as UTC',
      );
    }
    await this.send(owner, CMD_CLOCK, () => buildClockFrame(seq, now), 'clock (b3)', true);
  }

  /**
   * One checked Write Request. Never throws: a refused or failed write is
   * logged without its bytes, and the caller carries on with the next one.
   * True only when the write completed while `owner` still owned the session.
   */
  private async send(
    owner: ConnectionContext,
    cmd: number,
    frame: () => Buffer,
    label: string,
    logBytes: boolean,
    profileByte: number = GUEST_PROFILE_BYTE,
  ): Promise<boolean> {
    if (this.s.ctx !== owner) return false;
    const started = Date.now();
    const diag = this.s.diag;
    diag.writes.set(cmd, 'refused');
    try {
      const buf = frame();
      assertAllowedWrite(buf, profileByte);
      if (buf[2] === CMD_PROFILE) this.s.guestProfileSent = true;
      // Pending until the transport settles the write: when the link drops
      // first, the summary has to say the Write Response never came, not that
      // the write failed (#434).
      diag.writes.set(cmd, 'pending');
      await owner.write(CHR_WRITE, buf, true);
      diag.writes.set(cmd, 'sent');
      bleLog.debug(
        `Renpho R-MSC04: sent ${label}${logBytes ? ` [${hex(buf)}]` : ''} ` +
          `in ${Date.now() - started} ms`,
      );
      return this.s.ctx === owner;
    } catch (e: unknown) {
      if (diag.writes.get(cmd) === 'pending') diag.writes.set(cmd, 'failed');
      if (this.s.ctx === owner) bleLog.warn(`Renpho R-MSC04: ${label} not sent: ${errMsg(e)}`);
      return false;
    }
  }

  parseCharNotification(_charUuid: string, data: Buffer): ScaleReading | null {
    this.s.diag.lastFrameAt = Date.now();
    // Routed by content, not by characteristic: fragments carry no 55AA header.
    if (!isBareFrame(data)) {
      const record = this.s.reassembler.push(data);
      return record ? this.onRecord(record) : null;
    }

    const frame = validateFrame(data);
    if (!frame) return null;

    if (frame.cmd === CMD_STATUS) {
      this.onStatus(data, frame.len);
      return null;
    }
    if (REPLY_TO[frame.cmd] !== undefined) {
      if (frame.cmd === CMD_PROFILE_REPLY) this.noteProfileReply(data, frame.len);
      this.logReply(data, frame.cmd, frame.frameLen);
      return null;
    }
    if (frame.cmd !== CMD_LIVE && frame.cmd !== CMD_FINAL) return null; // out of scope

    // Once the weight has settled, live frames are the user stepping off. The
    // settled reading is being held for the composition record, and a held
    // reading is replaced by every later complete one, so these must not
    // reach it.
    if (frame.cmd === CMD_LIVE && this.s.finalReceived) return null;

    const weight = this.decodeWeight(data, frame.len, frame.frameLen);
    if (weight === null) return null;
    if (frame.cmd === CMD_FINAL) {
      this.s.finalReceived = true;
      this.s.finalWeight = weight;
    }
    return { weight, impedance: 0 };
  }

  /** Legacy single-char path (routes by frame content; the char UUID is irrelevant). */
  parseNotification(data: Buffer): ScaleReading | null {
    return this.parseCharNotification(CHR_NOTIFY, data);
  }

  /** Weight = the last two payload bytes big-endian / 100 (kg), or null. */
  private decodeWeight(data: Buffer, len: number, frameLen: number): number | null {
    if (len < 2) return null; // need at least the 2 weight bytes
    // Weight bytes are the two just before the checksum: frameLen - 3.
    const weight = data.readUInt16BE(frameLen - 3) / 100;
    if (!isPlausibleKg(weight)) return null;
    return weight;
  }

  /**
   * A 0x20 status: seq, state, then [7] (01 in every capture and log), [8]
   * the number of stored records the scale still holds (#117 capture: 03,
   * then exactly three 0x26 records, then 00) and [9] (0x50 in July, 0x46 in
   * September and October; the battery is a guess). The state and [8] are
   * also what the gate on a record without a 0x24 reads (D057).
   */
  private onStatus(data: Buffer, len: number): void {
    if (len < 2) return;
    const state = data[6];
    this.s.lastState = state;
    // A 0x11 before the scale answered our b2: that measurement finished before
    // our profile reached it, and a later 0x11 does not show it computed again.
    if (state === STATE_COMPLETE && !this.s.profileAnswered) this.s.completeBeforeAnswer = true;
    this.s.answeredBeforeComplete =
      state === STATE_COMPLETE && this.s.profileAnswered && !this.s.completeBeforeAnswer;
    const name = STATUS_NAMES[state] ?? 'unknown';
    let extra = '';
    if (len >= 5) {
      const stored = data[8];
      extra =
        `, ${stored} stored ${stored === 1 ? 'record' : 'records'}, ` +
        `[7] ${byteHex(data[7])}, [9] ${byteHex(data[9])}`;
      this.s.diag.firstStatus ??= { state, stored };
      this.s.storedAtStart ??= stored;
    }
    this.s.diag.lastStatus = { state, at: Date.now() };
    bleLog.debug(
      `Renpho R-MSC04: status seq ${data[5]}, state 0x${byteHex(state)} (${name})${extra}`,
    );
  }

  /** A 0x22 that answers our b2 with the byte: length 2, its seq, slot 09 (D079). */
  private noteProfileReply(data: Buffer, len: number): void {
    const own = this.s.own;
    if (own && len === 2 && data[5] === own.seq && data[6] === GUEST_SLOT) {
      this.s.profileAnswered = true;
    }
  }

  /** 0x22/0x23 (and 0x27/0x28): the scale answering a write, with its seq and result. */
  private logReply(data: Buffer, cmd: number, frameLen: number): void {
    const to = REPLY_TO[cmd];
    this.s.diag.answered.add(to);
    const result = hex(data.subarray(6, frameLen - 1));
    bleLog.debug(
      `Renpho R-MSC04: scale answered b${(to & 0x0f).toString(16)} (seq ${data[5]})` +
        `${result ? ` with ${result}` : ''}`,
    );
  }

  /** A reassembled 0x25/0x26 frame. Returns the completing reading, or null. */
  private onRecord(f: Buffer): ScaleReading | null {
    const frame = validateFrame(f);
    if (!frame || frame.frameLen !== f.length) {
      bleLog.debug(`Renpho R-MSC04: reassembled record failed validation: ${hex(f)}`);
      return null;
    }
    if (frame.cmd === CMD_HISTORY) {
      this.s.diag.replayed++;
      const age = frame.len >= 6 ? `${f.readUInt32BE(7)} s old` : 'age unknown';
      bleLog.debug(`Renpho R-MSC04: stored history record seq ${f[5]} ignored (${age})`);
      return null;
    }
    if (frame.cmd !== CMD_RECORD || frame.len !== RECORD_LEN) {
      bleLog.debug(`Renpho R-MSC04: unexpected record 0x${frame.cmd.toString(16)}: ${hex(f)}`);
      return null;
    }

    const rec = decodeRecord(f);
    const ohm = (v: number[]): string => v.map((x) => x.toFixed(1)).join(' / ');
    bleLog.debug(
      `Renpho R-MSC04: record ${rec.weight.toFixed(2)} kg, fat ${rec.fatPercent} %, ` +
        `BMI ${rec.bmi}, skeletal muscle ${rec.skeletalMusclePercent} %, ` +
        `visceral ${rec.visceralFat}; impedance (trunk / L arm / R arm / L leg / R leg) ` +
        `20 kHz ${ohm(rec.impedance20kHz)} ohm, 100 kHz ${ohm(rec.impedance100kHz)} ohm`,
    );
    this.s.diag.record = 'ignored';
    if (this.s.guestProfileSent && this.s.sentHeightTenths !== null && rec.bmi > 0) {
      // Whether the scale computed this record for the b2 we sent, by the
      // criterion of the D079 gate. Only yes or no: a signed gap next to the
      // record's own weight and BMI would give the user's height away. It tells
      // nothing for a user whose Renpho app profile has the same height as the
      // first configured user.
      const verdict = fitsSentHeight(rec, this.s.sentHeightTenths) ? 'matches' : 'does not match';
      bleLog.debug(
        `Renpho R-MSC04: the record's BMI ${verdict} the height we sent (BMI within 0.1)`,
      );
    }

    const weight = this.s.finalReceived ? this.weightFromFinal(rec) : this.weightFromRecord(rec);
    if (weight === null) return null;

    // A copy, not the session's object: another session can start before
    // computeMetrics runs (#394), and this one still sends statuses (0x05, 0x04).
    const own = this.s.own;
    const record: PinnedRecord = own
      ? {
          rec,
          guestProfile: this.s.guestProfileSent,
          own: {
            heightTenths: own.heightTenths,
            gender: own.gender,
            birthDate: own.birthDate,
            age: own.age,
            written: own.written,
            answeredBeforeComplete: this.s.answeredBeforeComplete,
          },
        }
      : { rec, guestProfile: this.s.guestProfileSent };
    const reading: ScaleReading = { weight, impedance: 0, scaleComposition: record };
    this.s.diag.record = 'used';
    bleLog.info(
      `Renpho R-MSC04: body composition received (fat ${rec.fatPercent} %, ` +
        `visceral ${rec.visceralFat})`,
    );
    return reading;
  }

  /** The 0x24 weight when the record is within RECORD_WEIGHT_TOLERANCE_KG of it, else null. */
  private weightFromFinal(rec: CompositionRecord): number | null {
    if (Math.abs(rec.weight - this.s.finalWeight) > RECORD_WEIGHT_TOLERANCE_KG) {
      bleLog.debug(
        `Renpho R-MSC04: record weight ${rec.weight.toFixed(2)} kg does not match the ` +
          `settled ${this.s.finalWeight.toFixed(2)} kg, ignored`,
      );
      return null;
    }
    return this.s.finalWeight;
  }

  /**
   * The record's own weight in a session without a 0x24, or null (#434, D057).
   *
   * The scale sends 0x24 once, when the weight settles, so a session that
   * connects after that never gets one. The record carries no age, so it is
   * taken as this weigh-in only when the status right before it was 0x11 (a
   * live record follows 0x11 in every capture and log) and the session started
   * with no stored records ([8] 00), so no stored weigh-in can be what the
   * scale delivers (a third-party log on #117 says an unacknowledged stored
   * record can come back as 0x25). In the #117 capture the record's weight is
   * the 0x24 weight of the same weigh-in.
   */
  private weightFromRecord(rec: CompositionRecord): number | null {
    let why: string | null = null;
    if (this.s.lastState !== STATE_COMPLETE) {
      const last =
        this.s.lastState === null ? 'no status' : `status 0x${byteHex(this.s.lastState)}`;
      why = `${last} right before it, not 0x11`;
    } else if (this.s.storedAtStart !== 0) {
      const n = this.s.storedAtStart;
      why =
        n === null
          ? 'no stored-record count at the start of the session'
          : `the session started with ${n} stored ${n === 1 ? 'record' : 'records'}`;
    } else if (!isPlausibleKg(rec.weight)) {
      why = `its weight ${rec.weight.toFixed(2)} kg is out of range`;
    }
    if (why !== null) {
      bleLog.debug(`Renpho R-MSC04: record ignored, no 0x24 in this session: ${why}`);
      return null;
    }
    return rec.weight;
  }

  /**
   * Acknowledge each 0x20 status frame the way the Renpho app does:
   *   55 AA B0 00 02 <status seq> 01 <checksum>
   * In the #117 capture the app answers every status with this (seq 00, 02
   * and 03 on the measuring connection) and acknowledges nothing else the
   * scale sends during a live weigh-in, the 0x25 record included. Whether the
   * scale needs it before it sends the record is not known: a working
   * ESPHome client on #117 does not send it.
   */
  buildAck(data: Buffer): number[] | null {
    if (!isBareFrame(data)) return null;
    const frame = validateFrame(data);
    if (!frame || frame.cmd !== CMD_STATUS || frame.len !== 5) return null;
    const ack = [HDR0, HDR1, 0xb0, 0x00, 0x02, data[5], 0x01];
    ack.push(ack.reduce((sum, b) => sum + b, 0) & 0xff);
    return ack;
  }

  /** A 0x24 weight, or a reading a 0x25 record completed, also without a 0x24 (D057). */
  isComplete(reading: ScaleReading): boolean {
    return reading.weight > 0 && (this.s.finalReceived || this.isFinal(reading));
  }

  /** Final only once a 0x25 record completed the reading, with or without a 0x24. */
  isFinal(reading: ScaleReading): boolean {
    return reading.scaleComposition != null;
  }

  computeMetrics(reading: ScaleReading, profile: UserProfile): BodyComposition {
    const pinned = reading.scaleComposition as PinnedRecord | undefined;
    if (!pinned) return buildPayload(reading.weight, 0, {}, profile);
    if (pinned.own) {
      const comp = ownProfileComposition(pinned.rec, pinned.own, profile);
      return buildPayload(reading.weight, 0, comp, profile);
    }
    if (pinned.guestProfile) {
      bleLog.info(
        "Renpho R-MSC04: the scale's body fat and visceral fat were computed for the guest " +
          'profile we sent, not exported (#434); using the estimate',
      );
      return buildPayload(reading.weight, 0, {}, profile);
    }
    return buildPayload(reading.weight, 0, this.scaleComposition(pinned.rec, profile), profile);
  }

  /** The scale's own figures, or {} (the profile estimate) when they are not this user's. */
  private scaleComposition(rec: CompositionRecord, profile: UserProfile): ScaleBodyComp {
    if (!(rec.fatPercent > 0)) {
      bleLog.info('Renpho R-MSC04: the scale reported no body fat, using the estimate');
      return {};
    }
    if (!(rec.bmi > 0)) {
      bleLog.info('Renpho R-MSC04: the scale reported no BMI, using the estimate');
      return {};
    }
    const scaleHeight = 100 * Math.sqrt(rec.weight / rec.bmi);
    if (Math.abs(scaleHeight - profile.height) > PROFILE_HEIGHT_TOLERANCE_CM) {
      bleLog.info(
        `Renpho R-MSC04: the scale's BMI implies a ${scaleHeight.toFixed(0)} cm profile, ` +
          `not the configured ${profile.height} cm, so its figures are not used. ` +
          `It is likely the profile last written to the scale by the Renpho app, ` +
          `which may be another user's.`,
      );
      return {};
    }
    return recordComposition(rec);
  }
}
