import type {
  AckProtocol,
  BleDeviceInfo,
  BodyComposition,
  GattWiring,
  HoldForComposition,
  ScaleAdapterCore,
  ScaleReading,
  Unlockable,
  UserProfile,
} from '../interfaces/scale-adapter.js';
import { uuid16, buildPayload } from './body-comp-helpers.js';
import { bleLog } from '../ble/types.js';
import { matchesDescriptor, type MatchDescriptor } from './match-descriptor.js';

// ─── Salter smart scale (0xFFCC "Healthcare ELectronic" command protocol) ────

const CHR_FFC1 = uuid16(0xffc1);

/**
 * Opcodes decoded from an iOS PacketLogger trace of the Salter Health app doing
 * one weigh-in, then corrected against live hardware. Every command is written
 * to FFC1 write-without-response and the reply arrives as a notification on that
 * same characteristic. FFC2 and FFC3 are advertised as notify and the app
 * subscribes to both, but neither ever carried a byte: the entire protocol lives
 * on FFC1.
 *
 * Not used here, but decoded and recorded so the next person does not have to:
 *   01 <unix u32 LE>   set the clock          02  read the clock
 *   03 <i> <5 bytes>   write a user profile   04 <i>  read one back
 *   08 <i>             record-status probe    0a <i> 00  clear a record
 */
const CMD_PING = 0x0b; // keepalive; the vendor app sends it before every poll
const CMD_CLOCK = 0x02; // `02` → `02 <seconds u32 LE>`, the scale's own clock
const CMD_FETCH = 0x09; // `09 <index> 00` → the 20-byte record in that slot

/** `02 <u32 LE>`: opcode plus the clock, five bytes. */
const CLOCK_REPLY_LEN = 5;

/**
 * How far ahead of the scale's clock a record may legitimately be stamped.
 *
 * Covers a weigh-in taken mid-session, after this session's clock read: the poll
 * restarts every few seconds and the link is held open for a few more, so a
 * handful of seconds of "future" is normal. Anything beyond it is a record from
 * before the clock was reset — see `isFromAnotherEpoch`.
 */
const FUTURE_TOLERANCE_SEC = 60;

/**
 * How far BEHIND the scale's own clock a record may be and still count as this
 * weigh-in.
 *
 * Without this bound the only staleness guard is `lastReportedTs`, an in-memory
 * high-water mark that starts at zero on every process start. The first session
 * after a restart would therefore accept the newest record the scale still
 * holds, whatever its age, and publish it as today's weight. This project has
 * already shipped that bug once on another protocol family, where a stored
 * record six days old published 67.10 kg for a 75 kg user, and it reads as "the
 * numbers are occasionally wrong" rather than as an obvious failure.
 *
 * Five minutes is deliberately generous rather than tight. The scale records a
 * weigh-in the moment it settles and the host may only poll a little later: the
 * sweep restarts every few seconds, but a continuous-mode run reconnects on its
 * own cadence, and someone who steps off before the host connects should still
 * get their reading. Anything older than this is buffer the scale never forgets.
 */
const MAX_RECORD_AGE_SEC = 300;

/**
 * Number of record slots the scale keeps. Measurements land in a rotating
 * buffer, NOT in one fixed place: a sweep of a live unit found records sitting
 * at indices 2, 6 and 7 with the rest empty, and the index a given weigh-in
 * occupies is not predictable from anything the client can see.
 */
const RECORD_SLOTS = 8;

/**
 * How often the sweep is kicked off. Each tick sends only a keepalive and a
 * clock read; the slot walk chains itself off the replies (see `buildAck`), so
 * this is the restart interval rather than the pace of the sweep itself.
 */
const SWEEP_INTERVAL_MS = 3000;

/**
 * How long the link is held open after the first record decodes.
 *
 * A sweep issues nine writes and their replies trickle back over a second or
 * two, so the window has to outlast a full cycle rather than ending the session
 * on the first frame that decodes. It also covers the case where the scale is
 * mid-reply when the first record lands.
 */
const COMPLETION_HOLD_MS = 5000;

/**
 * Measurement record: `<index> 00 | <unix seconds u32 LE> | <7 x u16 LE>`.
 *
 * The seven trailing fields are weight, body fat %, body water %, muscle mass %,
 * bone mass kg, BMR kcal and BMI — each scaled by ten except BMR, a whole number
 * of kilocalories. Confirmed field by field against the Salter Health app's own
 * display for the same reading, and the weight against six weigh-ins called out
 * from the scale (87.6, 85.7, 88.0, 88.8, 89.7, 7.4 kg).
 *
 * Only the weight is read; see the class comment for why the other six are not.
 */
const RECORD_LEN = 20;
const TIMESTAMP_OFFSET = 2;
const WEIGHT_OFFSET = 6;
const WEIGHT_DIV = 10;

/** An empty slot reads back as all zeros; slot 0 uses 0xFFFFFFFF instead. */
const TIMESTAMP_UNSET = 0xffffffff;

/** True for a measurement record as opposed to a command echo. */
function isRecord(data: Buffer): boolean {
  return data.length === RECORD_LEN && data[0] < RECORD_SLOTS;
}

/**
 * Adapter for Salter Bluetooth body-analyser scales (SALTER-SA00656-BK and the
 * SA00432 firmware family it reports in its Device Information Service; the
 * vendor string is "Healthcare ELectronic", a Nordic nRF5x design).
 *
 * This scale never speaks first. It answers a GATT connection, advertises three
 * notify characteristics, then sends nothing at all — through a weigh-in,
 * through a two-minute wait, through anything — until the client writes to FFC1.
 * It also puts no weight in its advertisement. Neither passive broadcast parsing
 * nor waiting for a stream works here; the only way to read it is to ask:
 *
 *   -> 0b 00        <- 0b 00                  keepalive
 *   -> 02           <- 02 <clock u32 LE>      the scale's own clock
 *   -> 09 00 00     <- 00 00 ffffffff ...     slot 0, empty
 *   -> 09 01 00     <- ...                    each reply triggers the next
 *   -> 09 02 00     <- 02 00 <ts> <record>    slot 2, a real measurement
 *
 * MEASUREMENTS SIT IN A ROTATING EIGHT-SLOT BUFFER, AND ONLY THE NEWEST MATTERS.
 * The scale stores each weigh-in and keeps it; a live sweep found records at
 * indices 2, 6 and 7 with the rest empty, and which slot a weigh-in lands in is
 * not predictable. So every slot is read and the newest timestamp wins.
 *
 * That buffer is not treated as history to be replayed. The scale only wakes
 * because somebody stood on it, so the newest record IS this weigh-in; the older
 * ones are past readings already dealt with, some of them months old. Reporting
 * them would overwrite today's numbers with last month's. Records arrive in slot
 * order, which is not chronological, so the newest-wins rule is also what makes
 * the reading that resolves the session the right one rather than whichever slot
 * happened to be read first.
 *
 * NOTHING IS EVER CLEARED. The protocol has a clear (`0a <index> 00`) and the
 * vendor app uses it, but this adapter does not, and that is deliberate. An
 * earlier version fetched one fixed slot and cleared after each fetch; because
 * the clear consumes a record independently of which slot was read, it destroyed
 * three unread weigh-ins off a real user's scale before anyone noticed. Sweeping
 * and de-duplicating on the record's own timestamp achieves the same result with
 * no destructive write in the protocol at all — the scale's buffer rotates by
 * itself.
 *
 * THE SCALE IS OFF MOST OF THE TIME. It powers up when someone stands on it and
 * powers down after the reading and a short standby, taking its radio with it. A
 * session open when it switches off gets no clean disconnect: the link dies
 * silently and writes stop completing. Continuous mode with a short cooldown is
 * the configuration that suits it.
 *
 * BODY COMPOSITION IS DELIBERATELY NOT TAKEN FROM THE SCALE. The record carries
 * six derived values and they decode perfectly, but the scale computes them from
 * a user profile stored on the device, and that profile is whatever the vendor
 * app last wrote. On the unit this was decoded against the app had provisioned a
 * height of 100 cm, which the scale's own BMI field confirmed by reporting 85.7
 * for an 85.7 kg person — weight ÷ 1.00 m². Every derived value on that reading
 * inherited the error: 45 % body fat, 36.2 % water, 1078 kcal BMR, all displayed
 * by the app without question.
 *
 * Even provisioned correctly those values would describe whoever the scale was
 * last told about, not the user this reading is being matched to. So the adapter
 * reports weight only (`impedance: 0`) and body composition comes from the shared
 * estimator using the height, age and gender in the user's own config. That
 * follows the Hutbit adapter's precedent, where the vendor's derived body fat was
 * similarly unusable.
 *
 * The scale does measure bioimpedance — the display runs an electrode animation
 * with bare feet, and all six derived fields drop to zero in a socks-on reading
 * while the weight stays identical — but it exposes only the computed results,
 * never the raw ohms. There is nothing to feed the BIA estimator.
 */
export class SalterAdapter
  implements ScaleAdapterCore, GattWiring, Unlockable, AckProtocol, HoldForComposition
{
  readonly name = 'Salter';
  readonly match: MatchDescriptor = {
    priority: 125,
    names: { startsWith: ['salter-'] },
    // The GATT service is 0xFFCC, but the advertisement carries it byte-swapped
    // as 0xCCFF (observed on CoreBluetooth, which reports the advertised UUID
    // verbatim). Both are claimed so the adapter matches pre-connect on the
    // advertised form and post-connect on the discovered one, and so a unit
    // whose local name is missing — as happens over the ESPHome proxy, where the
    // name lives in the scan response — is still recognised.
    serviceUuids: ['ffcc', 'ccff'],
    charUuids: [CHR_FFC1],
  };

  readonly charNotifyUuid = CHR_FFC1;
  readonly charWriteUuid = CHR_FFC1;

  /**
   * The record's weight is treated as canonical kg, so the handler must not run
   * it through the lbs conversion on top.
   *
   * INFERRED, NOT DIRECTLY VERIFIED. Every capture so far was taken with the
   * scale displaying kg, so a record from a scale set to lb has never been seen.
   * The inference rests on the record's companion fields, which are unambiguously
   * metric whatever the display is doing: bone mass arrives in kilograms and BMR
   * in kilocalories. A record that switched its weight field to pounds while
   * leaving bone mass in kilograms would be a very strange protocol, and the
   * vendor app converts for display anyway.
   *
   * If a unit with a lb display ever reports weights wrong by a factor of 2.2,
   * this flag is the first thing to check.
   */
  readonly normalizesWeight = true;

  /**
   * What each tick kicks off: a keepalive, then the clock read whose reply starts
   * the slot walk (see {@link buildAck}). The slots themselves are NOT listed
   * here — writing them as one burst is what this firmware drops.
   *
   * `unlockCommand` is the interface's required single-command member;
   * `unlockCommands` is what actually runs.
   */
  readonly unlockCommand = [CMD_CLOCK];
  readonly unlockCommands = [[CMD_PING, 0x00], [CMD_CLOCK]];
  readonly unlockIntervalMs = SWEEP_INTERVAL_MS;

  /** FFC1 is write-without-response only; a with-response write is rejected. */
  readonly ackWithResponse = false;

  /**
   * Walk the record slots, one reply at a time.
   *
   * The slots CANNOT be read as a burst. This firmware has a single command
   * buffer, so writes fired back-to-back overwrite one another: sending the
   * ping, the clock read and eight fetches together got three answers out of
   * ten, and the only fetch that survived was the last one written. Chaining
   * each fetch off the previous reply paces the sweep at the device's own
   * round-trip instead, which is what the vendor app effectively does.
   *
   * The periodic clock read is what restarts the walk, so a dropped reply costs
   * one cycle rather than stalling the session.
   */
  buildAck(data: Buffer): number[] | null {
    if (data.length === CLOCK_REPLY_LEN && data[0] === CMD_CLOCK) {
      return [CMD_FETCH, 0, 0x00];
    }
    if (isRecord(data)) {
      const next = data[0] + 1;
      return next < RECORD_SLOTS ? [CMD_FETCH, next, 0x00] : null;
    }
    return null;
  }

  /** Keep the link open for a whole sweep; see {@link COMPLETION_HOLD_MS}. */
  readonly completionHoldMs = COMPLETION_HOLD_MS;

  /**
   * Timestamp of the newest record ever reported, kept ACROSS sessions.
   *
   * The scale is a sender of one current reading, not an archive: it wakes
   * because someone stood on it, so the newest record in the buffer is that
   * weigh-in. Anything older is a past reading that has already been dealt with,
   * and re-reporting it would overwrite today's numbers with last month's.
   *
   * Records arrive in slot order, which is not chronological, so this is also
   * what makes the NEWEST record the one that resolves the session: only a
   * record newer than everything before it is emitted, and the handler keeps the
   * last reading it was given.
   *
   * Deliberately NOT reset by {@link onSessionEnd} — it is de-duplication state,
   * not session state. It is cleared only when the scale's clock goes backwards;
   * see {@link noteClock}.
   */
  private lastReportedTs = 0;

  /** Scale clock from the last `02` reply, and the local time it arrived. */
  private clockSec = 0;
  private clockAt = 0;

  matches(device: BleDeviceInfo): boolean {
    return matchesDescriptor(device, this.match);
  }

  parseNotification(data: Buffer): ScaleReading | null {
    // Log every frame before the shape gate, so "frames arrive but are rejected"
    // stays distinguishable from "frames never arrive" — the question every
    // stalled-scale report ends up asking.
    bleLog.debug(`Salter RAW (${data.length}B): ${data.toString('hex')}`);

    // The clock reply arrives on the same characteristic; capture it, then stop.
    if (data.length === CLOCK_REPLY_LEN && data[0] === CMD_CLOCK) {
      this.noteClock(data.readUInt32LE(1));
      return null;
    }

    if (!isRecord(data)) return null;

    const timestamp = data.readUInt32LE(TIMESTAMP_OFFSET);
    if (timestamp === 0 || timestamp === TIMESTAMP_UNSET) return null; // empty slot

    const weight = data.readUInt16LE(WEIGHT_OFFSET) / WEIGHT_DIV;
    if (!(weight > 0) || !Number.isFinite(weight)) return null;

    if (this.isFromAnotherEpoch(timestamp)) return null;

    // Every record this scale returns is a stored one, so age is the only thing
    // separating the weigh-in that just happened from the buffer behind it.
    // Without a clock there is nothing to measure age against, and a record of
    // unknown age must not be published as today's weight. The sweep always
    // reads the clock before any record, so this is defensive rather than a
    // state the protocol produces.
    if (!this.clockSec) {
      bleLog.debug(`Salter: record from slot ${data[0]} ignored, no clock read yet`);
      return null;
    }
    const ageSec = this.scaleNow() - timestamp;
    if (ageSec > MAX_RECORD_AGE_SEC) {
      bleLog.debug(
        `Salter: ignoring stored record from slot ${data[0]}, ` +
          `${Math.round(ageSec)}s old (limit ${MAX_RECORD_AGE_SEC}s)`,
      );
      return null;
    }

    // Newest wins. Older records are past weigh-ins the scale simply never
    // forgets; only a record newer than anything reported before is a new
    // measurement, and emitting them in ascending order leaves the newest as the
    // reading the handler resolves with.
    if (timestamp <= this.lastReportedTs) return null;
    this.lastReportedTs = timestamp;

    bleLog.debug(
      `Salter: ${weight.toFixed(1)} kg from slot ${data[0]} ` +
        `(stamp ${timestamp}, ${Math.round(ageSec)}s old)`,
    );
    // Deliberately UNDATED, even though every record here is a stored one.
    // Setting `ScaleReading.timestamp` routes a reading into the cache-replay
    // buffer in `waitForRawReading`, which returns early and only drains on
    // disconnect. This adapter holds the link open and polls until the session
    // times out, and a timeout rejects, so a dated reading would be buffered and
    // never delivered. The age bound above is what replaces the platform's own
    // replay protections, which undated readings do not get.
    return { weight, impedance: 0 };
  }

  /** The scale's clock, advanced by the time since it was read. */
  private scaleNow(): number {
    return this.clockSec + (Date.now() - this.clockAt) / 1000;
  }

  /**
   * Record the scale's clock, and notice when it has gone backwards.
   *
   * New batteries restart the clock near zero. Every subsequent weigh-in is then
   * stamped with a small number, far below the newest timestamp already reported
   * — so a plain high-water mark would suppress every future reading, forever
   * and silently. A clock behind the mark means the epoch changed, and the mark
   * belongs to a numbering that no longer exists.
   */
  private noteClock(seconds: number): void {
    this.clockSec = seconds;
    this.clockAt = Date.now();
    if (this.lastReportedTs && seconds + FUTURE_TOLERANCE_SEC < this.lastReportedTs) {
      bleLog.info(
        "Salter: the scale's clock went backwards (new batteries?); resetting de-duplication",
      );
      this.lastReportedTs = 0;
    }
  }

  /**
   * True for a record whose timestamp sits ahead of the scale's own clock.
   *
   * Changing the batteries restarts the clock near zero while the stored records
   * keep the timestamps of the old epoch, so everything weighed before the change
   * suddenly reads as far in the future. Those records are stale by definition
   * and there is no way to date them — the clock that produced them is gone — so
   * they are dropped rather than reported as though they were taken today.
   *
   * The tolerance covers the ordinary case of someone stepping on the scale
   * mid-session, after this session's clock was read.
   */
  private isFromAnotherEpoch(timestamp: number): boolean {
    if (!this.clockSec) return false; // no clock yet: nothing to compare against
    return timestamp > this.scaleNow() + FUTURE_TOLERANCE_SEC;
  }

  /**
   * Forget this session's clock reading. Adapters are shared singletons, so a
   * stale clock would otherwise be used to judge the next session's records —
   * including the backwards-clock check, which must see a fresh value.
   */
  onSessionEnd(): void {
    this.clockSec = 0;
    this.clockAt = 0;
  }

  isComplete(reading: ScaleReading): boolean {
    return reading.weight > 0;
  }

  /**
   * Never resolve on a record, always wait out the hold window.
   *
   * There is no richer frame to wait for; the hold exists so a full sweep lands
   * before the newest record is chosen. Returning true would resolve on whichever
   * slot happened to be read first.
   */
  isFinal(): boolean {
    return false;
  }

  computeMetrics(reading: ScaleReading, profile: UserProfile): BodyComposition {
    // No raw impedance exists in this protocol, so this is the BMI-based estimate
    // path for every reading. See the class comment for why the scale's own
    // derived values are not used instead.
    return buildPayload(reading.weight, reading.impedance, {}, profile);
  }
}
