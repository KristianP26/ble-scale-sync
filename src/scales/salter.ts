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
 * Widest age a stored record may claim and still be believed.
 *
 * Guards against a scale whose clock was reset (fresh batteries restart it from
 * zero, so `02` answers with an uptime rather than a wall clock) producing an
 * absurd measurement date. A record that fails this is left unreported rather
 * than exported with a wrong time; the next session promotes it to the live
 * reading, which carries no timestamp at all.
 */
const MAX_RECORD_AGE_SEC = 30 * 24 * 60 * 60;

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
 * MEASUREMENTS SIT IN A ROTATING EIGHT-SLOT BUFFER. The scale stores each
 * weigh-in and keeps it; a live sweep found records at indices 2, 6 and 7. There
 * is no reliable way to know which slot a given weigh-in is in, so every slot is
 * read on every cycle and records are de-duplicated by their own timestamp. This is also what lets a
 * weigh-in taken with nothing connected be collected later, which is the normal
 * way this scale is used: it is off and unreachable most of the time.
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
   * Timestamps already handed to the handler, kept ACROSS sessions so a stored
   * weigh-in is not re-reported on every sweep. Nothing clears records on the
   * scale, so without this the same measurement returns forever.
   *
   * A SET, not a high-water mark. A high-water mark suppresses anything older
   * than the newest record seen, which quietly loses the first of two weigh-ins
   * whenever two people share the scale: partner weighs after you, their record
   * is newer, and yours is never reported. On a household scale that is the
   * normal case, not an edge case.
   *
   * Deliberately NOT reset by {@link onSessionEnd} — this is de-duplication
   * state, not session state. It resets when the process restarts, which
   * re-reports stored readings once; that is the safe direction to err, since
   * the alternative is dropping a genuine weigh-in.
   */
  private readonly reported = new Set<number>();

  /**
   * Whether the session's LIVE reading has been emitted yet.
   *
   * The handler keeps only the last live reading it is given, so exactly one
   * record per session may be emitted that way. Every further unreported record
   * is emitted as a historical reading instead, which the handler buffers and
   * hands back alongside the live one — and the pipeline matches and exports
   * every entry, so a household where two people weighed before the sync ran
   * gets both readings out of a single session rather than needing the scale to
   * stay awake for two.
   */
  private liveEmitted = false;

  /** Scale clock from the last `02` reply, and the local time it arrived. */
  private clockSec = 0;
  private clockAt = 0;

  /** Bound on {@link reported}; far more than the scale's eight slots hold. */
  private static readonly MAX_REPORTED = 64;

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
      this.clockSec = data.readUInt32LE(1);
      this.clockAt = Date.now();
      return null;
    }

    if (!isRecord(data)) return null;

    const timestamp = data.readUInt32LE(TIMESTAMP_OFFSET);
    if (timestamp === 0 || timestamp === TIMESTAMP_UNSET) return null; // empty slot

    const weight = data.readUInt16LE(WEIGHT_OFFSET) / WEIGHT_DIV;
    if (!(weight > 0) || !Number.isFinite(weight)) return null;

    if (this.reported.has(timestamp)) return null;

    // The first unreported record of the session is the live reading; the rest
    // are dated from the scale's own clock and ride along as history.
    if (!this.liveEmitted) {
      this.liveEmitted = true;
      this.remember(timestamp);
      bleLog.debug(`Salter: ${weight.toFixed(1)} kg from slot ${data[0]} (live)`);
      return { weight, impedance: 0 };
    }

    const takenAt = this.dateOf(timestamp);
    if (!takenAt) return null; // clock unusable — leave it for the next session

    this.remember(timestamp);
    bleLog.debug(`Salter: ${weight.toFixed(1)} kg from slot ${data[0]} @ ${takenAt.toISOString()}`);
    return { weight, impedance: 0, timestamp: takenAt };
  }

  /**
   * Convert a record's timestamp into a real date.
   *
   * The scale's clock does NOT agree with the host's — one unit was found an
   * hour out, because whatever last set it wrote local time into a field read as
   * UTC. Comparing the record against the scale's own clock sidesteps that
   * entirely: both come from the same wrong clock, so the offset cancels and
   * what is left is the record's true age. Returns null when the clock has not
   * been read yet or the resulting age is not credible.
   */
  private dateOf(timestamp: number): Date | null {
    if (!this.clockSec) return null;
    const elapsedSec = (Date.now() - this.clockAt) / 1000;
    const ageSec = this.clockSec + elapsedSec - timestamp;
    if (!Number.isFinite(ageSec) || ageSec < 0 || ageSec > MAX_RECORD_AGE_SEC) return null;
    return new Date(Date.now() - ageSec * 1000);
  }

  /** Record a timestamp as reported, keeping the set bounded. */
  private remember(timestamp: number): void {
    this.reported.add(timestamp);
    if (this.reported.size <= SalterAdapter.MAX_REPORTED) return;
    // Drop the oldest half; timestamps are seconds, so numeric order is age.
    const keep = [...this.reported].sort((a, b) => b - a).slice(0, SalterAdapter.MAX_REPORTED / 2);
    this.reported.clear();
    for (const ts of keep) this.reported.add(ts);
  }

  /**
   * Re-arm for the next session. Adapters are shared singletons, so without this
   * the live-reading gate would stay closed for the rest of the process and
   * every later weigh-in would arrive as history against a stale clock.
   */
  onSessionEnd(): void {
    this.liveEmitted = false;
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
