import type {
  AckProtocol,
  BleDeviceInfo,
  CharacteristicBinding,
  ConnectionContext,
  ScaleAdapterCore,
  GattWiring,
  HoldForComposition,
  MultiCharNotify,
  ScaleReading,
  UserProfile,
  BodyComposition,
} from '../interfaces/scale-adapter.js';
import {
  uuid16,
  buildPayload,
  ReadingComposition,
  type ScaleBodyComp,
} from './body-comp-helpers.js';
import { matchesDescriptor, type MatchDescriptor } from './match-descriptor.js';
import { bleLog, errMsg } from '../ble/types.js';

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
 * guest b2 the record is not exported at all (D038); otherwise the profile may
 * be another household member's. The BMI the scale reports gives the height it
 * used away; a larger gap than this to the user's configured height means the
 * scale's figures are not about this user.
 */
const PROFILE_HEIGHT_TOLERANCE_CM = 3;

/** A reassembled record is 42 (0x25) or 46 (0x26) bytes; anything past this is not one. */
const MAX_REASSEMBLED_BYTES = 64;

/** Application-level fragment header: marker (0xAD, 0xAE, 0xAF), seq, fragments remaining. */
const FRAGMENT_HEADER_LEN = 3;

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

/** How close the record's BMI height must be to the height we sent to count as ours. */
const SENT_HEIGHT_MATCH_CM = 1;

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

/** A record pinned to its reading, and whether our guest b2 went out in that session. */
interface PinnedRecord {
  rec: CompositionRecord;
  guestProfile: boolean;
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
  let sum = 0;
  for (let i = 0; i < frameLen - 1; i++) sum += data[i];
  if ((sum & 0xff) !== data[frameLen - 1]) return null; // bad checksum
  return { cmd: data[2], len, frameLen };
}

function hex(data: Buffer): string {
  return data.toString('hex');
}

function byteHex(b: number): string {
  return b.toString(16).padStart(2, '0');
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
 * b2 [11..13] verbatim from the ESPHome client. [11] is not decoded (most
 * likely sex and age; "0x80 | age" is refuted by two profiles of known age),
 * which is why the scale's figures from such a session are not exported.
 */
const GUEST_TAIL = [0xa9, 0xff, 0x02];

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

function checksum(bytes: Uint8Array | number[]): number {
  let sum = 0;
  for (const b of bytes) sum += b;
  return sum & 0xff;
}

function buildFrame(cmd: number, payload: number[]): Buffer {
  const body = [HDR0, HDR1, cmd, (payload.length >> 8) & 0xff, payload.length & 0xff, ...payload];
  return Buffer.from([...body, checksum(body)]);
}

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
 * 0.01 kg (both u16 BE), then a9 ff 02. The seq is echoed in the 0x22 reply.
 */
export function buildGuestProfileFrame(seq: number, profile: UserProfile): Buffer {
  const height = heightTenths(profile) ?? FALLBACK_HEIGHT_TENTHS;
  const weight = weightCg(profile) ?? FALLBACK_WEIGHT_CG;
  return buildFrame(CMD_PROFILE, [
    seq & 0xff,
    GUEST_SLOT,
    (height >> 8) & 0xff,
    height & 0xff,
    (weight >> 8) & 0xff,
    weight & 0xff,
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
  return buildFrame(CMD_CLOCK, [
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
 * behind an allowed one.
 */
export function assertAllowedWrite(frame: Buffer): void {
  const refuse = (why: string): never => {
    throw new Error(`Renpho R-MSC04: refusing to write ${why}`);
  };
  if (frame.length < FRAME_OVERHEAD || frame[0] !== HDR0 || frame[1] !== HDR1) {
    refuse('a frame without the 55AA header');
  }
  const len = frame.readUInt16BE(3);
  if (frame.length !== len + FRAME_OVERHEAD) refuse('a frame whose length field does not match');
  if (checksum(frame.subarray(0, frame.length - 1)) !== frame[frame.length - 1]) {
    refuse('a frame with a bad checksum');
  }
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
        GUEST_TAIL.some((b, i) => p[6 + i] !== b)
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
 * lands, or weight-only when none does. 0x26 records are stored history of
 * earlier weigh-ins and are never used.
 *
 * Of the record, only the scale's body fat and visceral fat are ever exported,
 * and only from a session in which we did NOT write our guest b2 (its [11] is
 * not decoded, so the scale may have computed them for the wrong sex or age;
 * D038), and only when the profile the scale computed them for matches the
 * user (see PROFILE_HEIGHT_TOLERANCE_CM). The segment impedances are logged at debug
 * level; no whole-body impedance is derived from them, so the reading keeps
 * impedance 0.
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
  readonly normalizesWeight = true;
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

  private finalReceived = false;
  private finalWeight = 0;
  private readonly reassembler = new FragmentReassembler();
  /**
   * The record pinned to the reading it completed (#394): this adapter is a
   * shared singleton, and on the watcher transports the next session can start
   * before computeMetrics() runs for this one.
   */
  private readonly records = new ReadingComposition<PinnedRecord | null>();

  /** This session's context, so a write left over from a dead session never runs. */
  private ctx: ConnectionContext | null = null;
  /** A b2 write was attempted in this session: the scale's figures are not exported. */
  private guestProfileSent = false;
  /** The height in this session's b2, in 0.1 cm. Compared, never logged. */
  private sentHeightTenths: number | null = null;
  /** Log the unsendable time zone once per adapter instance (one per process in production). */
  private zoneLogged = false;
  /** BLE_RMSC04_HANDSHAKE values already warned about, once per value and instance. */
  private readonly unknownHandshakeValues = new Set<string>();
  private diag = freshDiagnostics();

  private readonly now: () => Date;

  /** `now` is the clock the b3 frame carries; durations use Date.now(). */
  constructor(now: () => Date = () => new Date()) {
    this.now = now;
  }

  matches(device: BleDeviceInfo): boolean {
    return matchesDescriptor(device, this.match);
  }

  /**
   * Clear the previous weigh-in before anything is subscribed (#394).
   *
   * This used to live in `onConnected`, which is too late for a multi-char
   * adapter: `subscribeAndInit` enables EVERY notify binding and only then
   * awaits `startInit()`, so frames can already be arriving - through several
   * D-Bus round trips for the second and third binding - while the reset has
   * not run. `onSessionStart` runs before the first subscribe.
   */
  onSessionStart(): void {
    this.finalReceived = false;
    this.finalWeight = 0;
    this.reassembler.reset();
    this.ctx = null;
    this.guestProfileSent = false;
    this.sentHeightTenths = null;
    this.diag = freshDiagnostics();
  }

  async onConnected(ctx: ConnectionContext): Promise<void> {
    if (!ctx.availableChars.has(CHR_WRITE)) {
      throw new Error(
        `Renpho R-MSC04: write characteristic (${CHR_WRITE}) not discovered. ` +
          'Likely a transient GATT discovery race. Try again.',
      );
    }
    this.ctx = ctx;
    const mode = this.connectWrites();
    this.diag.handshakeAt = Date.now();
    this.diag.mode = mode;
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
    if (this.diag.handshakeAt !== null) this.logSummary(this.diag.handshakeAt);
    this.ctx = null;
  }

  /**
   * One line per session for #434: how long it lived after the handshake
   * started (about 0.65 s after the connect), which writes the scale answered,
   * what it reported, and how long it was silent before the end. Best effort:
   * onSessionEnd does not run on every transport path.
   */
  private logSummary(start: number): void {
    const d = this.diag;
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
        `0x24 ${this.finalReceived ? 'yes' : 'no'}; stored records replayed ${d.replayed}; ` +
        `composition record ${d.record}; ${lastFrame})`,
    );
  }

  /**
   * The guest b2. Neither the frame nor the height or weight in it ever reaches
   * the log: they are the first user's.
   */
  private async writeGuestProfile(owner: ConnectionContext, seq: number): Promise<void> {
    const profile = owner.profile;
    if (heightTenths(profile) === null) {
      bleLog.debug('Renpho R-MSC04: no usable height for the guest profile, sending 170.0 cm');
    }
    if (weightCg(profile) === null) {
      bleLog.debug('Renpho R-MSC04: no usable last weight for the guest profile, sending 70.00 kg');
    }
    this.sentHeightTenths = heightTenths(profile) ?? FALLBACK_HEIGHT_TENTHS;
    await this.send(
      owner,
      CMD_PROFILE,
      () => buildGuestProfileFrame(seq, profile),
      'guest profile (b2)',
      false,
    );
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
   */
  private async send(
    owner: ConnectionContext,
    cmd: number,
    frame: () => Buffer,
    label: string,
    logBytes: boolean,
  ): Promise<void> {
    if (this.ctx !== owner) return;
    const started = Date.now();
    const diag = this.diag;
    diag.writes.set(cmd, 'refused');
    try {
      const buf = frame();
      assertAllowedWrite(buf);
      if (buf[2] === CMD_PROFILE) this.guestProfileSent = true;
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
    } catch (e: unknown) {
      if (diag.writes.get(cmd) === 'pending') diag.writes.set(cmd, 'failed');
      if (this.ctx === owner) bleLog.warn(`Renpho R-MSC04: ${label} not sent: ${errMsg(e)}`);
    }
  }

  parseCharNotification(_charUuid: string, data: Buffer): ScaleReading | null {
    this.diag.lastFrameAt = Date.now();
    // Routed by content, not by characteristic: fragments carry no 55AA header.
    if (!isBareFrame(data)) {
      const record = this.reassembler.push(data);
      return record ? this.onRecord(record) : null;
    }

    const frame = validateFrame(data);
    if (!frame) return null;

    if (frame.cmd === CMD_STATUS) {
      this.logStatus(data, frame.len);
      return null;
    }
    if (REPLY_TO[frame.cmd] !== undefined) {
      this.logReply(data, frame.cmd, frame.frameLen);
      return null;
    }
    if (frame.cmd !== CMD_LIVE && frame.cmd !== CMD_FINAL) return null; // out of scope

    // Once the weight has settled, live frames are the user stepping off. The
    // settled reading is being held for the composition record, and a held
    // reading is replaced by every later complete one, so these must not
    // reach it.
    if (frame.cmd === CMD_LIVE && this.finalReceived) return null;

    const weight = this.decodeWeight(data, frame.len, frame.frameLen);
    if (weight === null) return null;
    if (frame.cmd === CMD_FINAL) {
      this.finalReceived = true;
      this.finalWeight = weight;
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
    if (weight < 0.5 || weight > 300 || !Number.isFinite(weight)) return null;
    return weight;
  }

  /**
   * A 0x20 status: seq, state, then [7] (01 in every capture and log), [8]
   * the number of stored records the scale still holds (#117 capture: 03,
   * then exactly three 0x26 records, then 00) and [9] (0x50 in July, 0x46 in
   * September and October; the battery is a guess).
   */
  private logStatus(data: Buffer, len: number): void {
    if (len < 2) return;
    const state = data[6];
    const name = STATUS_NAMES[state] ?? 'unknown';
    let extra = '';
    if (len >= 5) {
      const stored = data[8];
      extra =
        `, ${stored} stored ${stored === 1 ? 'record' : 'records'}, ` +
        `[7] ${byteHex(data[7])}, [9] ${byteHex(data[9])}`;
      this.diag.firstStatus ??= { state, stored };
    }
    this.diag.lastStatus = { state, at: Date.now() };
    bleLog.debug(
      `Renpho R-MSC04: status seq ${data[5]}, state 0x${byteHex(state)} (${name})${extra}`,
    );
  }

  /** 0x22/0x23 (and 0x27/0x28): the scale answering a write, with its seq and result. */
  private logReply(data: Buffer, cmd: number, frameLen: number): void {
    const to = REPLY_TO[cmd];
    this.diag.answered.add(to);
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
      this.diag.replayed++;
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
    this.diag.record = 'ignored';
    if (this.guestProfileSent && this.sentHeightTenths !== null && rec.bmi > 0) {
      // Whether the scale computed this record for the b2 we sent. Only yes or
      // no: a signed gap next to the record's own weight and BMI would give
      // the user's height away. It tells nothing for a user whose Renpho app
      // profile has the same height as the first configured user.
      const gap = Math.abs(100 * Math.sqrt(rec.weight / rec.bmi) - this.sentHeightTenths / 10);
      const verdict = gap <= SENT_HEIGHT_MATCH_CM ? 'matches' : 'does not match';
      bleLog.debug(
        `Renpho R-MSC04: the record's BMI height ${verdict} the height we sent ` +
          `(within ${SENT_HEIGHT_MATCH_CM} cm)`,
      );
    }

    if (!this.finalReceived) {
      bleLog.debug('Renpho R-MSC04: record arrived before the settled weight, ignored');
      return null;
    }
    if (Math.abs(rec.weight - this.finalWeight) > RECORD_WEIGHT_TOLERANCE_KG) {
      bleLog.debug(
        `Renpho R-MSC04: record weight ${rec.weight.toFixed(2)} kg does not match the ` +
          `settled ${this.finalWeight.toFixed(2)} kg, ignored`,
      );
      return null;
    }

    const reading: ScaleReading = { weight: this.finalWeight, impedance: 0 };
    this.records.pin(reading, { rec, guestProfile: this.guestProfileSent });
    this.diag.record = 'used';
    bleLog.info(
      `Renpho R-MSC04: body composition received (fat ${rec.fatPercent} %, ` +
        `visceral ${rec.visceralFat})`,
    );
    return reading;
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

  isComplete(reading: ScaleReading): boolean {
    return reading.weight > 0 && this.finalReceived;
  }

  /** Final only once a matching 0x25 record completed the reading. */
  isFinal(reading: ScaleReading): boolean {
    return this.records.of(reading, null) !== null;
  }

  computeMetrics(reading: ScaleReading, profile: UserProfile): BodyComposition {
    const pinned = this.records.of(reading, null);
    if (!pinned) return buildPayload(reading.weight, 0, {}, profile);
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
    const comp: ScaleBodyComp = { fat: rec.fatPercent };
    if (rec.visceralFat >= 1 && rec.visceralFat <= 59) comp.visceralFat = rec.visceralFat;
    return comp;
  }
}
