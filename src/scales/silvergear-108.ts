import type {
  BleDeviceInfo,
  BodyComposition,
  BroadcastSource,
  LiveWeight,
  ScaleAdapterCore,
  ScaleReading,
  UserProfile,
} from '../interfaces/scale-adapter.js';
import { buildPayload } from './body-comp-helpers.js';
import { bleLog, IMPEDANCE_GRACE_MS } from '../ble/types.js';
import { uuidClaimHits, type MatchDescriptor } from './match-descriptor.js';

// ─── Silvergear Smart Scale 108 (broadcast-only, obfuscated 0xA0AC advert) ───

/**
 * Company id in the advertisement's manufacturer data.
 *
 * Not a Bluetooth SIG assignment: the vendor invented it. On air the element
 * reads `ac a0 ...`, and the Lefu FFB0 family's 0x02AC reads `ac 02 ...`, so
 * these are plausibly the same OEM with a different variant byte. That is an
 * observation, not a basis for sharing code: the payloads are unrelated.
 */
const COMPANY_ID = 0xa0ac;

/** Vendor service the unit advertises. Nothing is ever read from it. */
const SVC_FFB0 = 'ffb0';

/**
 * Manufacturer-data layout, 12 bytes after the company id:
 *
 *   [0..5]  the device's own MAC, reversed
 *   [6..11] the payload below
 *
 * Payload, after XOR-ing every byte with 0xA0 except where noted:
 *
 *   d[0]      status flags. bit 7 set = settled reading, clear = still settling
 *   d[1..3]   weight, 24-bit big-endian, in grams, biased by WEIGHT_BIAS
 *   p[4]      frame type, IN CLEAR (not XOR-ed): 0x0D weight, 0x06 body data
 *   p[5]      checksum, IN CLEAR
 *
 * Decoded from two iOS PacketLogger captures with known outcomes, 108.5 kg and
 * 5.6 kg (#297). Both captures contain LE advertising reports only and no ATT
 * traffic at all, which matches the reporter's nRF Connect finding that the
 * device is not connectable: everything this scale says, it broadcasts.
 */
const PAYLOAD_OFFSET = 6;
const PAYLOAD_LEN = 6;
const MFG_LEN = PAYLOAD_OFFSET + PAYLOAD_LEN;
const OBFUSCATION_KEY = 0xa0;

/**
 * Constant subtracted from the 24-bit field to get grams.
 *
 * Fixed empirically: it is the value that makes the idle frame read exactly
 * zero. That frame, payload `a0 2c a0 a0 0d b9`, appears in BOTH captures, so
 * it is a genuine zero-load reading rather than a coincidence of one session.
 */
const WEIGHT_BIAS = 0x8c0000;

/** p[4]: a weight frame. */
const FRAME_TYPE_WEIGHT = 0x0d;

/**
 * p[4]: the post-weigh-in frame. Its d[0..1] big-endian field reads 529 for the
 * 108.5 kg person and 0 for the 5.6 kg object, which is the right shape and
 * magnitude for a whole-body impedance in ohm. One sample is not a decode, so
 * it is logged and not published; a body-fat figure from the vendor app for the
 * same weigh-in is what would settle it.
 */
const FRAME_TYPE_BODY = 0x06;

/** Settled-reading flag in the de-obfuscated status byte. */
const FLAG_SETTLED = 0x80;

/**
 * Plausibility bound on a settled weight. The checksum below is only 5 bits
 * wide, so it alone would accept roughly one malformed frame in 32; this makes
 * the frame gate depend on the payload as well as on its checksum.
 */
const WEIGHT_MIN_KG = 2;
const WEIGHT_MAX_KG = 300;

/**
 * The last payload byte is two fields, not one.
 *
 * Low 5 bits: a checksum over the other five OBFUSCATED bytes. Verified against
 * every advertisement in four captures covering three display units, 200+
 * frames, none failing.
 *
 * High 3 bits: the unit the scale is DISPLAYING. Reading the whole byte as a
 * checksum against a fixed 0xA0 base is what the first version of this adapter
 * did, and it rejected every frame from a scale not set to kilograms (#297).
 *
 * The weight itself does NOT change with the display unit. A capture taken with
 * the scale reading `17 st 2 lb`, and another reading `240.0 lb`, both decode to
 * 108.86 kg from the same 24-bit gram field, and 17 st 2 lb is 108.862 kg. So
 * the unit is presentation only and nothing here converts.
 */
const CHECKSUM_MASK = 0x1f;
const UNIT_MASK = 0xe0;

/** Observed values of the unit field. An unseen value is not a reason to reject. */
const UNIT_NAMES: Record<number, string> = {
  0xa0: 'kg',
  0x80: 'lb',
  0xe0: 'st',
};

function payloadChecksum(p: Buffer): number {
  return (p[0] + p[1] + p[2] + p[3] + p[4]) & CHECKSUM_MASK;
}

/** True when the frame's checksum closes, whatever unit the scale is showing. */
function checksumOk(p: Buffer): boolean {
  return (p[5] & CHECKSUM_MASK) === payloadChecksum(p);
}

// ─── Holding a weigh-in for its own post-weigh-in frame (#357) ───

/**
 * How long a settled weigh-in waits for its `0x06` frame before that frame is no
 * longer accepted as belonging to it.
 *
 * In three captures with a weigh-in in them (#297) the first `0x06` followed the
 * first settled frame after 0.885, 1.539 and 1.697 s, so 8 s is several times
 * what the scale needs.
 *
 * It MUST stay below `IMPEDANCE_GRACE_MS`. The transports hold the weight-only
 * reading for that long and then hand it on by themselves, and the proxy
 * watchers do that without recording it in their dedup window. A `0x06` paired
 * after that point would complete a second reading of a weigh-in that has
 * already been exported. A test pins the ordering.
 */
export const BODY_FRAME_WINDOW_MS = 8_000;

/**
 * How long a weigh-in is remembered at all, counted from its first settled frame.
 *
 * Normally a new weigh-in is recognised by the settling stream in front of it,
 * which clears the last one. If that stream was missed (discovery finishing
 * after the scale settled) and the new weigh-in happens to land on exactly the
 * same grams as a remembered, already paired one, it would be taken for a
 * repeat and dropped. Forgetting a weigh-in after a minute bounds that. The
 * captures show settled frames for at most about 1.5 s before the `0x06`
 * stream takes over, so a settled frame this late is a new weigh-in.
 */
const WEIGH_IN_MEMORY_MS = 60_000;

/** Units tracked at once, oldest out. A household has one; this is a leak bound. */
const MAX_UNITS = 8;

interface WeighIn {
  grams: number;
  /** First settled frame of this weigh-in; repeats of it do not move it. */
  settledAt: number;
  /** Its `0x06` has been paired, so nothing from this weigh-in completes again. */
  closed: boolean;
}

interface UnitState {
  weighIn: WeighIn | null;
  /**
   * When the reading the transport is currently holding was first handed out.
   *
   * This is what the pairing window is measured from, not `settledAt`, because
   * it is what the transport's grace timer is measured from: that timer is armed
   * by the first weight-only reading and is NOT re-armed by later ones until it
   * has fired. A settling stream in between (someone stepping off and back on)
   * past the pairing window ends the weigh-in but not the timer, so measuring
   * from the second weigh-in would let its `0x06` complete after the timer had
   * already exported it. Inside the window the step-off completes the first
   * weigh-in instead (see `endWeighIn`), which does end the timer, and clears
   * this.
   */
  heldAt: number | null;
}

/**
 * Adapter for the Silvergear Smart Scale 108 (#297).
 *
 * Broadcast only. The unit advertises ADV_NONCONN_IND, so there is no GATT
 * connection to make and no handshake to replay; a connect attempt is what the
 * reporter's original BlueZ error came from, since BlueZ discards the Device1
 * object for a non-connectable peer the moment discovery stops.
 *
 * Weight only. The advertisement carries no impedance that has been decoded, so
 * body composition is estimated from BMI.
 *
 * A settled weight is not complete on its own. The scale follows it with a
 * `0x06` frame about two seconds later, and a reading that resolved on the
 * weight alone ended the scan before that frame arrived, so it was never seen
 * (#357). The settled weight is therefore handed out as a partial reading, which
 * every broadcast transport holds for `IMPEDANCE_GRACE_MS`, and the reading
 * completes on the `0x06` that follows THAT weigh-in. If none does, the
 * transport forwards the weight on its own when the hold runs out.
 *
 * The state behind that is per unit, keyed by the MAC the scale puts in its own
 * payload. It cannot hang off a session: this adapter is a shared registry
 * singleton, and `onSessionStart` is a GATT hook the broadcast path never calls.
 */
export class Silvergear108Adapter implements ScaleAdapterCore, BroadcastSource {
  readonly name = 'Silvergear Smart Scale 108';
  /**
   * Above the generic Standard GATT catch-all, and custom because the claim is
   * a payload shape rather than a name: the unit advertises "108", which is far
   * too generic to match on.
   */
  readonly match: MatchDescriptor = {
    priority: 212,
    custom: true,
    serviceUuids: [SVC_FFB0],
    manufacturerId: COMPANY_ID,
  };
  readonly normalizesWeight = true;
  readonly preferPassive = true;

  /** Per-unit weigh-in state, keyed by the MAC in the payload's first six bytes. */
  private readonly units = new Map<string, UnitState>();
  /** Readings built from a paired `0x06`: the only ones `isComplete` accepts. */
  private readonly completeReadings = new WeakSet<ScaleReading>();
  /** Last unpaired `0x06` logged, so a repeated advertisement logs once. */
  private lastUnpairedBodyHex: string | null = null;

  /** @param now clock, injectable so the pairing window can be tested. */
  constructor(private readonly now: () => number = () => Date.now()) {}

  matches(device: BleDeviceInfo): boolean {
    const m = device.manufacturerData;
    if (m?.id !== COMPANY_ID || m.data.length !== MFG_LEN) return false;
    // The service list is absent on some transports (BlueZ exposes no advertised
    // UUIDs before a connection), so it narrows the claim when present rather
    // than being required. The company id plus the exact 12-byte length plus the
    // checksum below is already a far narrower fingerprint than a name.
    const uuids = device.serviceUuids ?? [];
    if (uuids.length > 0 && !uuidClaimHits([SVC_FFB0], uuids)) return false;
    const p = m.data.subarray(PAYLOAD_OFFSET);
    // Gate on the frame grammar as well as the checksum. The checksum is only
    // five bits wide, so on its own it would accept roughly one unrelated
    // payload in 32; requiring a known frame type costs nothing on real frames
    // and matters because this adapter outranks Robi, Hutbit and MGB, so a
    // same-OEM sibling appearing on 0xA0AC would otherwise be claimed here.
    if (p[4] !== FRAME_TYPE_WEIGHT && p[4] !== FRAME_TYPE_BODY) return false;
    return checksumOk(p);
  }

  parseNotification(): ScaleReading | null {
    return null;
  }

  /**
   * Decode a weight frame into its settled flag and kilograms, or null when the
   * buffer is not one.
   *
   * Shared by `parseBroadcast` and `parseLiveBroadcast` so the two can never
   * disagree about what a frame says: they differ only in which side of the
   * settled flag they answer for (#356).
   */
  private decodeWeightFrame(manufacturerData: Buffer): { settled: boolean; weight: number } | null {
    if (manufacturerData.length !== MFG_LEN) return null;
    const p = manufacturerData.subarray(PAYLOAD_OFFSET);
    if (!checksumOk(p)) return null;
    if (p[4] !== FRAME_TYPE_WEIGHT) return null;

    const flags = p[0] ^ OBFUSCATION_KEY;
    const grams =
      (((p[1] ^ OBFUSCATION_KEY) << 16) |
        ((p[2] ^ OBFUSCATION_KEY) << 8) |
        (p[3] ^ OBFUSCATION_KEY)) -
      WEIGHT_BIAS;
    return { settled: (flags & FLAG_SETTLED) !== 0, weight: grams / 1000 };
  }

  /**
   * The settling stream, for a display that follows the scale (#356).
   *
   * Returns nothing for a settled frame, which `parseBroadcast` owns, so one
   * advertisement is never reported through both channels. The same
   * plausibility bound applies: a garbled frame must not put 6553 kg on
   * somebody's screen just because it is only a display.
   */
  parseLiveBroadcast(manufacturerData: Buffer): LiveWeight | null {
    const frame = this.decodeWeightFrame(manufacturerData);
    if (!frame || frame.settled) return null;
    if (frame.weight < WEIGHT_MIN_KG || frame.weight > WEIGHT_MAX_KG) return null;
    return { weight: frame.weight };
  }

  /** Last settling weight logged, so a re-polled advertisement logs once. */
  private lastSettlingKg: number | null = null;

  parseBroadcast(manufacturerData: Buffer): ScaleReading | null {
    if (manufacturerData.length !== MFG_LEN) return null;
    const p = manufacturerData.subarray(PAYLOAD_OFFSET);
    if (!checksumOk(p)) return null;
    const mac = manufacturerData.subarray(0, PAYLOAD_OFFSET).toString('hex');

    if (p[4] === FRAME_TYPE_BODY) return this.onBodyFrame(mac, manufacturerData);
    if (p[4] !== FRAME_TYPE_WEIGHT) return null;

    const flags = p[0] ^ OBFUSCATION_KEY;
    const grams =
      (((p[1] ^ OBFUSCATION_KEY) << 16) |
        ((p[2] ^ OBFUSCATION_KEY) << 8) |
        (p[3] ^ OBFUSCATION_KEY)) -
      WEIGHT_BIAS;
    const weight = grams / 1000;

    // Only the settled frame is a reading. The settling stream is the scale
    // converging on a number and swings wildly while someone steps on
    // (the 108.5 kg capture runs 39.60, 55.48, 83.46, 107.03 ... before it
    // settles), so publishing any of it would publish a weight the scale never
    // showed. It is surfaced through `parseLiveBroadcast` instead, whose return
    // type cannot reach an exporter.
    if ((flags & FLAG_SETTLED) === 0) {
      // Whatever weigh-in this unit had is over: the scale is converging on a
      // new number, or idle at zero. Cleared whether or not it was paired, so a
      // new weigh-in that lands on the same grams is not mistaken for a repeat.
      const state = this.units.get(mac);
      const ended = state ? this.endWeighIn(state) : null;
      // Log the value, not the poll. The node-ble broadcast path re-reads
      // BlueZ's cached ManufacturerData on a timer as a fallback for
      // PropertiesChanged, so an unchanged advertisement is re-parsed several
      // times a second. Printing each one produced pages of an identical line
      // and made a frozen advertisement indistinguishable from a live settling
      // stream, which is the whole question when a scale never settles (#372).
      if (weight !== this.lastSettlingKg) {
        this.lastSettlingKg = weight;
        bleLog.debug(`Silvergear settling: ${weight.toFixed(3)} kg`);
      }
      return ended;
    }
    this.lastSettlingKg = null;
    if (weight < WEIGHT_MIN_KG || weight > WEIGHT_MAX_KG) return null;
    const unit = UNIT_NAMES[p[5] & UNIT_MASK] ?? `0x${(p[5] & UNIT_MASK).toString(16)}`;
    return this.onSettled(mac, grams, unit);
  }

  /**
   * A settled weight frame: start a weigh-in, or repeat the one in progress.
   *
   * Returns a weight-only reading, which the transport holds, or null when this
   * weigh-in has nothing more to say: it was already paired, or its hold has run
   * past the pairing window and the transport now owns the fallback. Returning
   * a reading then would re-arm that fallback once it had fired.
   */
  private onSettled(mac: string, grams: number, unit: string): ScaleReading | null {
    const t = this.now();
    const state = this.unitState(mac);
    let current = state.weighIn;
    if (current && t - current.settledAt > WEIGH_IN_MEMORY_MS) current = state.weighIn = null;

    if (current && current.grams === grams) {
      if (current.closed) return null;
      if (state.heldAt === null || t - state.heldAt > BODY_FRAME_WINDOW_MS) return null;
      return { weight: grams / 1000, impedance: 0 };
    }

    state.weighIn = { grams, settledAt: t, closed: false };
    this.lastUnpairedBodyHex = null;
    // A new hold starts only once the transport's grace timer for the last one
    // can have fired; see UnitState.heldAt.
    if (state.heldAt === null || t - state.heldAt >= IMPEDANCE_GRACE_MS) state.heldAt = t;
    const waiting =
      t - state.heldAt <= BODY_FRAME_WINDOW_MS
        ? 'holding for its post-weigh-in frame'
        : 'too late in the current hold to wait for its post-weigh-in frame';
    bleLog.debug(
      `Silvergear settled: ${(grams / 1000).toFixed(3)} kg (scale is displaying ${unit}), ${waiting}`,
    );
    return { weight: grams / 1000, impedance: 0 };
  }

  /**
   * The post-weigh-in `0x06` frame. Completes the reading of the weigh-in it
   * follows, and only that one.
   *
   * The scale keeps sending it for several seconds after a weigh-in, so the
   * first advertisement a new session sees can be the LAST weigh-in's `0x06`.
   * Pairing that with a new weight is exactly the contamination that made the
   * field unusable as evidence (#372), so a frame with no open weigh-in of its
   * own completes nothing. The field is logged, never published: see
   * FRAME_TYPE_BODY.
   */
  private onBodyFrame(mac: string, manufacturerData: Buffer): ScaleReading | null {
    const t = this.now();
    const p = manufacturerData.subarray(PAYLOAD_OFFSET);
    const field = ((p[0] ^ OBFUSCATION_KEY) << 8) | (p[1] ^ OBFUSCATION_KEY);
    const hex = manufacturerData.toString('hex');
    const state = this.units.get(mac);
    const current = state?.weighIn;

    // Already paired: a repeat of the frame that closed it.
    if (current?.closed) return null;

    if (current && state?.heldAt != null && t - state.heldAt <= BODY_FRAME_WINDOW_MS) {
      current.closed = true;
      state.heldAt = null;
      bleLog.debug(
        `Silvergear body frame (undecoded): ${hex} field=${field}, ` +
          `${((t - current.settledAt) / 1000).toFixed(1)} s after settling at ` +
          `${(current.grams / 1000).toFixed(3)} kg`,
      );
      const reading: ScaleReading = { weight: current.grams / 1000, impedance: 0 };
      this.completeReadings.add(reading);
      return reading;
    }

    if (hex !== this.lastUnpairedBodyHex) {
      this.lastUnpairedBodyHex = hex;
      const why = current
        ? `too late for the ${(current.grams / 1000).toFixed(3)} kg weigh-in`
        : 'no settled weight from this weigh-in';
      bleLog.debug(`Silvergear body frame (undecoded, ${why}): ${hex} field=${field}`);
    }
    return null;
  }

  /**
   * End this unit's weigh-in on a settling or idle frame. Returns a completed
   * weight-only reading when the weigh-in ended unpaired while its hold was
   * still inside the pairing window, and null otherwise.
   *
   * That case is someone stepping off before the `0x06` arrives. The transport
   * is still holding their weight, and a second weigh-in in the same hold would
   * overwrite it there (GraceTimers keeps one reading per address), so the first
   * person's weigh-in would be lost. Completing it here makes the transport
   * export it at once and cancel its grace timer, and the next weigh-in starts a
   * hold of its own. Inside the window the grace timer cannot have fired yet
   * (BODY_FRAME_WINDOW_MS < IMPEDANCE_GRACE_MS), so this is never a second
   * export of the same weigh-in; past it the timer owns the weigh-in, as for a
   * late `0x06`.
   */
  private endWeighIn(state: UnitState): ScaleReading | null {
    const current = state.weighIn;
    state.weighIn = null;
    if (!current || current.closed || state.heldAt === null) return null;
    if (this.now() - state.heldAt > BODY_FRAME_WINDOW_MS) return null;
    current.closed = true;
    state.heldAt = null;
    bleLog.debug(
      `Silvergear weigh-in ended before its post-weigh-in frame: ` +
        `${(current.grams / 1000).toFixed(3)} kg, reporting it without one`,
    );
    const reading: ScaleReading = { weight: current.grams / 1000, impedance: 0 };
    this.completeReadings.add(reading);
    return reading;
  }

  private unitState(mac: string): UnitState {
    let state = this.units.get(mac);
    if (state) return state;
    if (this.units.size >= MAX_UNITS) {
      const oldest = this.units.keys().next().value;
      if (oldest !== undefined) this.units.delete(oldest);
    }
    state = { weighIn: null, heldAt: null };
    this.units.set(mac, state);
    return state;
  }

  /**
   * Complete only on a reading built from a paired `0x06` frame. A settled
   * weight alone is partial, so the transport holds it for that frame (#357).
   * The bound is re-stated rather than assumed so a future caller cannot
   * complete on a zero weight.
   */
  isComplete(reading: ScaleReading): boolean {
    return (
      this.completeReadings.has(reading) &&
      reading.weight >= WEIGHT_MIN_KG &&
      reading.weight <= WEIGHT_MAX_KG
    );
  }

  computeMetrics(reading: ScaleReading, profile: UserProfile): BodyComposition {
    return buildPayload(reading.weight, 0, {}, profile);
  }
}
