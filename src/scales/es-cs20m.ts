import type {
  BleDeviceInfo,
  ScaleAdapterCore,
  GattWiring,
  ScaleReading,
  UserProfile,
  BodyComposition,
  ConnectionContext,
} from '../interfaces/scale-adapter.js';
import { uuid16, buildPayload, type ScaleBodyComp } from './body-comp-helpers.js';
import { matchesDescriptor, type MatchDescriptor } from './match-descriptor.js';
import { bleLog, errMsg } from '../ble/types.js';

const CHR_NOTIFY = uuid16(0x2a10);
const CHR_WRITE = uuid16(0x2a11);

/**
 * The JieLi AE00 pair. The #436 unit has it and read nothing with the kg
 * command alone; the #376 unit has no AE00 service at all (three
 * public btsnoops of it list 1801/180A/180F/1A10/FFF0 only) and reads with the
 * single kg command. Nothing on the wire is read or written on these two: they
 * only tell the two revisions apart.
 */
const CHR_AE01 = uuid16(0xae01);
const CHR_AE02 = uuid16(0xae02);

// ─── 55AA frames this adapter writes ─────────────────────────────────────────

const HEADER_LEN = 5;

const CMD_POWER_ON_ACK = 0x91;
const CMD_SET_TIME = 0x97;
const CMD_GUEST_PROFILE = 0x96;
const CMD_DISPLAY_UNIT = 0x90;

/** 0x97 sub-op 1 is the clock; other sub-ops were probed on these units with unknown effect. */
const SET_TIME_SUBOP = 0x01;

/**
 * Slot 9 with 0xFF at [12] is the guest form: the scale computes composition
 * from it for this weigh-in and does not persist it as a user. A registered
 * slot would create or overwrite a user the Renpho app owns.
 */
const GUEST_SLOT = 9;
const GUEST_MASK = 0xff;
/** [13]: 0x05 runs the impedance pass. 0x06 skips it (the app's hold-baby flow). */
const TRAILER_IMPEDANCE = 0x05;
const TRAILER_NO_IMPEDANCE = 0x06;
/**
 * [11]: 0xA8 (0x68 for the athlete curve) plus a two-bit body-fat method. The
 * #436 app capture sends method 2.
 */
const FLAGS_STANDARD = 0xa8 | 2;
const FLAGS_ATHLETE = 0x68 | 2;

/** Used when the profile has no usable height: 170.0 cm. */
const FALLBACK_HEIGHT_TENTHS = 1700;
/**
 * Used when the profile has no usable last weight: 70.00 kg. Never 0, which
 * openScale saw the scale refuse.
 */
const FALLBACK_WEIGHT_CG = 7000;

function checksum(bytes: Uint8Array): number {
  let sum = 0;
  for (const b of bytes) sum += b;
  return sum & 0xff;
}

function buildFrame(cmd: number, payload: number[]): Buffer {
  const body = [0x55, 0xaa, cmd, (payload.length >> 8) & 0xff, payload.length & 0xff, ...payload];
  return Buffer.from([...body, checksum(Uint8Array.from(body))]);
}

/** `0x90 [unit, 0, mode, 0]` with mode 0, which leaves the scale's stored measuring mode alone. */
export function buildDisplayUnitFrame(unit: number): Buffer {
  return buildFrame(CMD_DISPLAY_UNIT, [unit, 0x00, 0x00, 0x00]);
}

/** `0x91 [01]`, which the app sends after every 0x11 status frame. Meaning not decoded. */
export function buildPowerOnAckFrame(): Buffer {
  return buildFrame(CMD_POWER_ON_ACK, [0x01]);
}

/**
 * `0x97` sub-op 1: Unix seconds (UTC) as u48 big-endian, then the local offset
 * as a sign (1 = behind UTC) and whole hours. A half-hour zone is truncated,
 * as the frame has no field for the minutes.
 */
export function buildSetTimeFrame(now: Date): Buffer {
  const seconds = Buffer.alloc(6);
  seconds.writeUIntBE(Math.floor(now.getTime() / 1000), 0, 6);
  // getTimezoneOffset is positive west of Greenwich, which is the frame's "behind".
  const offset = now.getTimezoneOffset();
  return buildFrame(CMD_SET_TIME, [
    SET_TIME_SUBOP,
    ...seconds,
    offset > 0 ? 1 : 0,
    Math.floor(Math.abs(offset) / 60),
  ]);
}

function birthOf(profile: UserProfile, now: Date): [number, number, number] {
  if (profile.birthDate) {
    // YYYY-MM-DD parses as UTC midnight, so read it back in UTC: the local
    // getters shift the day west of Greenwich.
    const born = new Date(profile.birthDate);
    if (!Number.isNaN(born.getTime())) {
      return [born.getUTCFullYear(), born.getUTCMonth() + 1, born.getUTCDate()];
    }
  }
  return [now.getFullYear() - Math.max(1, Math.round(profile.age)), 1, 1];
}

/**
 * `0x96` guest profile: sex and slot, birth date, height in 0.1 cm, last
 * weight in 0.01 kg, method flags, guest mask, trailer. The scale works out
 * the user's age from the birth date and the 0x97 clock.
 */
export function buildGuestProfileFrame(profile: UserProfile, now: Date): Buffer {
  const sex = profile.gender === 'male' ? 1 : 2;
  const [year, month, day] = birthOf(profile, now);

  const tenths = Math.round(profile.height * 10);
  const height =
    Number.isFinite(tenths) && tenths >= 1 && tenths <= 0xffff ? tenths : FALLBACK_HEIGHT_TENTHS;

  const cg = Math.round((profile.lastKnownWeight ?? Number.NaN) * 100);
  const weight = Number.isFinite(cg) && cg > 0 && cg <= 0xffffffff ? cg : FALLBACK_WEIGHT_CG;
  const weightBytes = Buffer.alloc(4);
  weightBytes.writeUInt32BE(weight);

  return buildFrame(CMD_GUEST_PROFILE, [
    (sex << 4) | GUEST_SLOT,
    (year >> 8) & 0xff,
    year & 0xff,
    month,
    day,
    (height >> 8) & 0xff,
    height & 0xff,
    ...weightBytes,
    profile.isAthlete ? FLAGS_ATHLETE : FLAGS_STANDARD,
    GUEST_MASK,
    TRAILER_IMPEDANCE,
  ]);
}

/**
 * Throw unless `frame` is one of the forms this adapter is allowed to send.
 *
 * The builders cannot produce anything else; this is the backstop for when one
 * of them changes. Every rule here is about a setting the scale persists: a
 * non-zero 0x90 mode byte (mode 2 left the #376 unit in zero-current mode with
 * no known way back), a 0x96 outside the guest slot (writes a user the app
 * owns) and any 0x97 other than the clock. The length field and checksum are
 * checked too, so a second frame cannot ride along behind an allowed one.
 */
export function assertAllowedWrite(frame: Buffer): void {
  const refuse = (why: string): never => {
    throw new Error(`ES-CS20M: refusing to write ${why}`);
  };
  if (frame.length < HEADER_LEN + 1 || frame[0] !== 0x55 || frame[1] !== 0xaa) {
    refuse('a frame without the 55AA header');
  }
  const len = frame.readUInt16BE(3);
  if (frame.length !== HEADER_LEN + len + 1) refuse('a frame whose length field does not match');
  if (checksum(frame.subarray(0, frame.length - 1)) !== frame[frame.length - 1]) {
    refuse('a frame with a bad checksum');
  }
  const cmd = frame[2];
  const p = frame.subarray(HEADER_LEN, frame.length - 1);
  switch (cmd) {
    case CMD_POWER_ON_ACK:
      if (len !== 1 || p[0] !== 0x01) refuse('a 0x91 other than [01]');
      return;
    case CMD_SET_TIME:
      if (len !== 9 || p[0] !== SET_TIME_SUBOP || p[7] > 1 || p[8] > 14) {
        refuse('a 0x97 other than the set-time form');
      }
      return;
    case CMD_GUEST_PROFILE: {
      const sex = p[0] >> 4;
      if (
        len !== 14 ||
        (p[0] & 0x0f) !== GUEST_SLOT ||
        (sex !== 1 && sex !== 2) ||
        p[12] !== GUEST_MASK ||
        (p[13] !== TRAILER_IMPEDANCE && p[13] !== TRAILER_NO_IMPEDANCE)
      ) {
        refuse('a 0x96 other than the guest form');
      }
      return;
    }
    case CMD_DISPLAY_UNIT:
      if (len !== 4 || p[0] < 1 || p[0] > 4 || p[1] !== 0 || p[2] !== 0 || p[3] !== 0) {
        refuse('a 0x90 with a mode byte or an unknown unit');
      }
      return;
    default:
      refuse(`command 0x${cmd.toString(16).padStart(2, '0')}`);
  }
}

/** The kg command the #376 revision has been read with since the adapter was ported. */
const LEGACY_DISPLAY_KG = buildDisplayUnitFrame(1);

/**
 * Company id on the anonymous advertisement of the ESCS20MB2 hardware revision.
 *
 * The same 0x1A10 number the family uses for its GATT service, which is a
 * vendor habit rather than a coincidence, but the two live in different
 * namespaces and neither implies the other.
 */
const QINGNIU_COMPANY_ID = 0x1a10;

/** `00 04 00 31 | <6-byte MAC> | 01 09` on the unit captured for #376. */
const ANON_PAYLOAD_LEN = 12;
const ANON_MAC_OFFSET = 4;

/** The six address bytes, uppercase and colon-free, or null. */
function macBytes(address: string | undefined): string | null {
  if (!address) return null;
  const clean = address.replace(/[:-]/g, '').toUpperCase();
  return /^[0-9A-F]{12}$/.test(clean) ? clean : null;
}

/**
 * True when the advertisement carries the device's own address inside its
 * manufacturer data.
 *
 * This is the whole reason the anonymous unit can be claimed safely. It sends
 * no name and no service UUIDs (#376), so the only pre-connect signal is a
 * company id, and claiming every nameless device that advertises one company id
 * is precisely the shape that produced the wrong-adapter reports in #235, #318
 * and #320. An address echo is self-validating instead: a device that is not
 * this scale will not happen to contain the address it is transmitting from.
 * `lefu-signature.ts` claims its family the same way.
 *
 * Both byte orders are accepted. The #376 capture has it forward
 * (`cf ea 02 07 2c 87` from `CF:EA:02:07:2C:87`, which the reporter described
 * as reversed), and other vendors in this space reverse it, so requiring one
 * orientation would be a guess about firmware nobody has seen yet. Matching
 * either costs nothing: a random payload hitting the exact advertising address
 * in either direction is not a case worth designing around.
 */
function hasOwnMacEcho(device: BleDeviceInfo): boolean {
  const md = device.manufacturerData;
  if (!md || md.id !== QINGNIU_COMPANY_ID) return false;
  if (md.data.length !== ANON_PAYLOAD_LEN) return false;
  const own = macBytes(device.address);
  if (!own) return false;
  const embedded = md.data
    .subarray(ANON_MAC_OFFSET, ANON_MAC_OFFSET + 6)
    .toString('hex')
    .toUpperCase();
  const reversed = [...md.data.subarray(ANON_MAC_OFFSET, ANON_MAC_OFFSET + 6)]
    .reverse()
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
  return embedded === own || reversed === own;
}

/**
 * Adapter for the ES-CS20M BLE body-composition scale (Yunmai lineage).
 *
 * Also covers Renpho ES-32MD, which Renpho's own manual documents as the same
 * hardware family as ES-CS20M (same protocol, same characteristics). Some
 * ES-32MD units advertise with a `113360_` placeholder name instead of a model
 * string, so the matcher accepts that prefix too.
 *
 * Protocol details:
 *   - Service 0x1A10, notify 0x2A10, write 0x2A11
 *   - Display unit command 0x90 [unit, 0, mode, 0], always with mode 0
 *   - Message ID 0x11 (power/status frame): byte[5]=0x01 on (also sent right
 *     after subscribe, before anyone steps on), byte[5]=0x00 off
 *   - Message ID 0x14 (weight frame): status at [5], weight at [8-9], optional
 *     resistance at [10-11]
 *   - Message ID 0x15 (STORED offline record, not a live "extended frame"):
 *     resistance at bytes [9-10]; the adapter still keeps that resistance,
 *     see the 0x15 branch below
 *   - Weight at [8-9] big-endian uint16 / 100 (kg)
 *   - Complete on a 0x14 final (status low nibble 1) or on the 0x11 power-off
 *
 * Per openScale PR #1300, some firmware variants do not flag a final 0x14
 * frame; the reading then completes on the 0x11 power-off frame. This adapter
 * supports both paths.
 *
 * Two revisions are written to differently, told apart by the JieLi AE00 pair:
 *   - Without AE00 (#376): the kg command 0x90 [01 00 00 00] without response,
 *     once at connect and once more on the first power-on frame, which is when
 *     notifications are known to be on.
 *   - With AE00 (#436): nothing at connect. After every power-on frame the
 *     Renpho app's sequence from an iPhone capture, each write with response:
 *     0x91, 0x97 (clock), 0x96 (the first user as a guest profile) and 0x90 in
 *     the unit the scale itself reported. The app sends 0x90 with mode 1; this
 *     sends mode 0, the one deliberate change to a frame the app sends. Two of
 *     the app's writes are left out on purpose: the 0x91 after a power-off and
 *     the 0x96 it resends after the 0x18 result. With the kg command alone
 *     the #436 unit sent its power frames and no weight. Which of the four
 *     writes it actually needs is not known.
 */
export class EsCs20mAdapter implements ScaleAdapterCore, GattWiring {
  readonly name = 'ES-CS20M';
  readonly match: MatchDescriptor = {
    priority: 130,
    names: { includes: ['es-cs20m', 'es-32md'], startsWith: ['113360_'] },
    serviceUuids: ['1a10'],
  };
  readonly charNotifyUuid = CHR_NOTIFY;
  readonly charWriteUuid = CHR_WRITE;
  readonly normalizesWeight = true;

  private stable = false;
  private stopped = false;
  private resistance = 0;
  private lastWeight = 0;

  /**
   * The session's context, captured for the writes a power-on frame triggers.
   * Each write checks it is still the context it was queued for, so a step
   * left over from a dead session never reaches the next one.
   */
  private ctx: ConnectionContext | null = null;
  /** AE00 present on this session's device: send the app's sequence. */
  private handshake = false;
  /** Re-armed by each power-off frame, so a scale woken again gets the sequence again. */
  private handshakeArmed = true;
  private legacyRepeated = false;
  /** Keeps the writes of one power-on in order and two power-ons from interleaving. */
  private writes: Promise<void> = Promise.resolve();

  private readonly now: () => Date;

  constructor(now: () => Date = () => new Date()) {
    this.now = now;
  }

  matches(device: BleDeviceInfo): boolean {
    // The ESCS20MB2 revision advertises anonymously: no name, no service UUIDs,
    // only manufacturer data. It is claimed on the address echo in that payload
    // rather than on the company id alone; see hasOwnMacEcho for why (#376).
    return matchesDescriptor(device, this.match) || hasOwnMacEcho(device);
  }

  /**
   * Parse an ES-CS20M notification frame.
   *
   * Three message types are handled:
   *
   * ID 0x11 - power/status frame:
   *   [5]      0x01 = on (also sent right after subscribe), 0x00 = off
   *            (measurement complete)
   *
   * ID 0x14 - weight frame:
   *   [5]      status: low nibble 0 = settling, 1 = final, anything else
   *            unclassified; bit 4 (0x10) = zero-current mode
   *   [8-9]    weight, big-endian uint16 / 100 (kg)
   *   [10-11]  resistance, big-endian uint16 (optional)
   *
   * ID 0x15 - stored offline record (an earlier weigh-in, not a live frame;
   * per renpho-escs20m protocol.py and a third-party capture of seven
   * records, payload [6:10] is the seconds since that weigh-in):
   *   [9-10]   resistance, big-endian uint16
   */
  parseNotification(data: Buffer): ScaleReading | null {
    if (data.length < 2) return null;

    if (data.length >= HEADER_LEN + 1 && data[0] === 0x55 && data[1] === 0xaa) {
      if (data[2] === 0x10 || data[2] === 0x16 || data[2] === 0x17) {
        this.logReply(data);
        return null;
      }
    }

    // Robust msgId: try data[2] first (with 55 AA header), fall back to data[0] (stripped)
    const msgId =
      data.length > 2 && (data[2] === 0x11 || data[2] === 0x14 || data[2] === 0x15)
        ? data[2]
        : data[0];

    // 0x11 - power/status frame
    if (msgId === 0x11) {
      if (data.length < 6) return null;
      if (data[5] === 0x01) {
        // Power on (also sent right after subscribe): reset state for a new weigh-in
        this.stable = false;
        this.stopped = false;
        this.resistance = 0;
        this.lastWeight = 0;
        // The handshake echoes the display unit from [6], which every capture
        // shows in the 55AA form. No header-less 0x11 has been captured, so
        // where its unit sits is unknown and it must not pick the unit.
        if (data[0] === 0x55 && data[1] === 0xaa) this.onPowerOn(data);
      } else if (data[5] === 0x00) {
        this.handshakeArmed = true;
        // Power off: measurement complete, return the last accumulated reading
        this.stopped = true;
        if (this.lastWeight > 0) {
          return { weight: this.lastWeight, impedance: this.resistance };
        }
      }
      return null;
    }

    if (msgId === 0x15) {
      // A stored offline record, which the original port read as an "extended
      // frame". Keeping its resistance attaches an earlier weigh-in's value to
      // the live weight; that change is tracked separately and deliberately
      // not made here.
      if (data.length >= 11) {
        this.resistance = data.readUInt16BE(9);
      }
      return null;
    }

    if (msgId !== 0x14) return null;
    if (data.length < 10) return null;

    // Low nibble is the phase (0 settling, 1 final, other values unclassified);
    // bit 4 is the zero-current mode the Renpho app stores on the scale, so
    // 0x10 is an ordinary settling frame and 0x11 an ordinary final. The unit
    // from #376 has been stuck in zero-current mode since 2026-09-06 and sends
    // every settling frame as 0x10, the first one at 10.60 kg on the way up
    // (renpho-escs20m#10). Taking any non-zero status as stable completed the
    // reading on that first frame. Status layout per renpho-escs20m
    // x55aa/protocol.py, confirmed by its R-A016 app capture.
    this.stable = (data[5] & 0x0f) === 0x01;
    const weight = data.readUInt16BE(8) / 100;

    // Range validation (0.5-300 kg) filters garbage during initial connection
    if (weight < 0.5 || weight > 300 || !Number.isFinite(weight)) return null;

    // Optional resistance in the weight frame
    if (data.length >= 12) {
      const r = data.readUInt16BE(10);
      if (r > 0) this.resistance = r;
    }

    this.lastWeight = weight;
    return { weight, impedance: this.resistance };
  }

  /**
   * Clear the previous weigh-in (#394).
   *
   * Adapters are shared singletons. These fields used to be cleared only inside
   * the 0x11 START branch, and no GATT capture of the anonymous ESCS20MB2
   * revision exists to show that frame is always sent (#376). Without a
   * session-start reset a stale `stopped` completes the
   * next session on an unsettled weight, a stale `lastWeight` replays the
   * previous reading verbatim on an orphan STOP, and a stale `resistance`
   * drives one person's BIA from another person's impedance.
   */
  onSessionStart(): void {
    this.stable = false;
    this.stopped = false;
    this.resistance = 0;
    this.lastWeight = 0;
    this.handshake = false;
    this.handshakeArmed = true;
    this.legacyRepeated = false;
    this.writes = Promise.resolve();
  }

  /**
   * Pick the revision from the discovered characteristics and, without AE00,
   * send the kg command.
   *
   * With AE00 nothing is written here: the app writes nothing before the first
   * power-on frame, and the sequence needs that frame's unit byte anyway.
   */
  async onConnected(ctx: ConnectionContext): Promise<void> {
    this.ctx = ctx;
    this.handshake = ctx.availableChars.has(CHR_AE01) && ctx.availableChars.has(CHR_AE02);
    if (this.handshake) {
      bleLog.debug('ES-CS20M: AE00 present, sending the Renpho app sequence after power-on');
      return;
    }
    await this.send(ctx, LEGACY_DISPLAY_KG, false, 'display unit kg');
  }

  onSessionEnd(): void {
    this.ctx = null;
  }

  private onPowerOn(data: Buffer): void {
    const owner = this.ctx;
    if (!owner) return;
    if (!this.handshake) {
      // The connect-time write went out before notifications were on (shared.ts
      // subscribes and inits in parallel); this one is known to arrive after.
      if (this.legacyRepeated) return;
      this.legacyRepeated = true;
      this.enqueue(() => this.send(owner, LEGACY_DISPLAY_KG, false, 'display unit kg'));
      return;
    }
    if (!this.handshakeArmed) return;
    this.handshakeArmed = false;
    // Echo the unit the scale already shows (0x11 [6]: 1 kg, 2 lb, 3 st:lb,
    // 4 st), so reading it does not flip the display.
    const unit = data.length > 6 && data[6] >= 1 && data[6] <= 4 ? data[6] : 1;
    this.enqueue(() => this.sendAppSequence(owner, unit));
  }

  private enqueue(step: () => Promise<void>): void {
    // Steps never reject (send catches), so the chain cannot get stuck.
    this.writes = this.writes.then(step, step);
  }

  /**
   * The Renpho app's writes after a power-on frame, in its order, each waiting
   * for the previous write's response. The scale's 0x17 and 0x16 replies are
   * logged when they arrive rather than awaited: the app does not wait for them
   * either, and a missing one should show in the log, not stall the rest.
   */
  private async sendAppSequence(owner: ConnectionContext, unit: number): Promise<void> {
    bleLog.debug(`ES-CS20M: power-on, sending 0x91, 0x97, 0x96 and 0x90 (unit ${unit})`);
    const now = this.now();
    await this.send(owner, buildPowerOnAckFrame(), true, '0x91');
    await this.send(owner, () => buildSetTimeFrame(now), true, 'clock (0x97)');
    // The profile holds the user's birth date, height and weight, so its bytes
    // stay out of this log line. The scale's 0x16 reply still reaches the raw
    // debug log in shared.ts like every incoming frame.
    await this.send(
      owner,
      () => buildGuestProfileFrame(owner.profile, now),
      true,
      'guest profile (0x96)',
      false,
    );
    await this.send(owner, buildDisplayUnitFrame(unit), true, `display unit ${unit} (0x90)`);
  }

  /**
   * One checked write. Never throws: a refused or failed write is logged and the
   * caller carries on with the next step.
   */
  private async send(
    owner: ConnectionContext,
    frame: Buffer | (() => Buffer),
    withResponse: boolean,
    label: string,
    logBytes = true,
  ): Promise<void> {
    if (this.ctx !== owner) return;
    try {
      const buf = typeof frame === 'function' ? frame() : frame;
      assertAllowedWrite(buf);
      await owner.write(CHR_WRITE, buf, withResponse);
      bleLog.debug(`ES-CS20M: sent ${label}${logBytes ? ` [${buf.toString('hex')}]` : ''}`);
    } catch (e: unknown) {
      if (this.ctx === owner) bleLog.warn(`ES-CS20M: ${label} not sent: ${errMsg(e)}`);
    }
  }

  /** The replies the capture shows to 0x97 (0x17), 0x96 (0x16) and 0x90 (0x10). */
  private logReply(data: Buffer): void {
    const cmd = data[2];
    if (cmd === 0x16) {
      // Its payload differs per model, so only a one-byte slot echo is shown.
      const len = data.readUInt16BE(3);
      const what = len === 1 ? `slot ${data[5]}` : `${len} bytes`;
      bleLog.debug(`ES-CS20M: scale answered 0x96 with 0x16 (${what})`);
      return;
    }
    const sent = cmd === 0x17 ? '0x97' : '0x90';
    bleLog.debug(`ES-CS20M: scale answered ${sent} with [${data.toString('hex')}]`);
  }

  isComplete(reading: ScaleReading): boolean {
    return reading.weight > 0 && (this.stable || this.stopped);
  }

  computeMetrics(reading: ScaleReading, profile: UserProfile): BodyComposition {
    const comp: ScaleBodyComp = {};
    return buildPayload(reading.weight, reading.impedance, comp, profile);
  }
}
