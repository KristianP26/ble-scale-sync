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
import { bleLog } from '../ble/types.js';

// ─── Renpho R-MSC04 (55AA framed, vendor service 0x1A10) ────────────────────

const CHR_NOTIFY = uuid16(0x2a10); // live weight stream (cmd 0x21)
const CHR_WRITE = uuid16(0x2a11); // send the 55AA start command
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

// Start/unlock command, byte-identical to the ES-CS20M unlock, which is what
// makes the R-MSC04 begin streaming. Self-consistent 55AA frame (checksum 0x94).
const START_COMMAND = [0x55, 0xaa, 0x90, 0x00, 0x04, 0x01, 0x00, 0x00, 0x00, 0x94];

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
 * (height 187.0 cm) on every connection, and we write none. That profile may
 * be another household member's. The BMI the scale reports gives the height it
 * used away; a larger gap than this to the user's configured height means the
 * scale's figures are not about this user.
 */
const PROFILE_HEIGHT_TOLERANCE_CM = 3;

/** A reassembled record is 42 (0x25) or 46 (0x26) bytes; anything past this is not one. */
const MAX_REASSEMBLED_BYTES = 64;

/** Application-level fragment header: marker (0xAD, 0xAE, 0xAF), seq, fragments remaining. */
const FRAGMENT_HEADER_LEN = 3;

const STATUS_NAMES: Record<number, string> = {
  0x01: 'measuring',
  0x09: 'weight locked',
  0x11: 'measurement complete',
};

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
 * Body composition is measured AFTER the weight settles. The scale reports
 * its progress as 0x20 status frames and then sends a 0x25 record, split
 * over three indications on 0x2A12 (#117 capture: 15.9 s after the 0x24
 * frame). So the 0x24 weight no longer ends the session: it is held for up
 * to COMPOSITION_HOLD_MS and resolves at once when a matching 0x25 record
 * lands, or weight-only when none does. 0x26 records are stored history of
 * earlier weigh-ins and are never used.
 *
 * Of the record, only the scale's body fat and visceral fat are exported, and
 * only when the profile the scale computed them for matches the user (see
 * PROFILE_HEIGHT_TOLERANCE_CM). The segment impedances are logged at debug
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
  private readonly records = new ReadingComposition<CompositionRecord | null>();

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
  }

  async onConnected(ctx: ConnectionContext): Promise<void> {
    if (!ctx.availableChars.has(CHR_WRITE)) {
      throw new Error(
        `Renpho R-MSC04: write characteristic (${CHR_WRITE}) not discovered. ` +
          'Likely a transient GATT discovery race. Try again.',
      );
    }
    // Written WITHOUT response: the handler sends the identical ES-CS20M unlock
    // without response (src/ble/shared.ts writeChar.write(buf, false)).
    await ctx.write(CHR_WRITE, START_COMMAND, false);
    bleLog.debug('Renpho R-MSC04: start command sent');
  }

  parseCharNotification(_charUuid: string, data: Buffer): ScaleReading | null {
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

  private logStatus(data: Buffer, len: number): void {
    if (len < 2) return;
    const state = data[6];
    const name = STATUS_NAMES[state] ?? 'unknown';
    bleLog.debug(
      `Renpho R-MSC04: status seq ${data[5]}, state 0x${state.toString(16).padStart(2, '0')} ` +
        `(${name})`,
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
      const age = frame.len >= 6 ? `${f.readUInt32BE(7)} s old` : 'age unknown';
      bleLog.debug(`Renpho R-MSC04: stored history record ignored (${age})`);
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
    this.records.pin(reading, rec);
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
    const rec = this.records.of(reading, null);
    return buildPayload(reading.weight, 0, rec ? this.scaleComposition(rec, profile) : {}, profile);
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
