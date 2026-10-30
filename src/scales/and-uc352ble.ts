import type {
  BleDeviceInfo,
  BodyComposition,
  CharacteristicBinding,
  ConnectionContext,
  GattWiring,
  HoldForComposition,
  MultiCharNotify,
  ScaleAdapterCore,
  ScaleReading,
  UserProfile,
} from '../interfaces/scale-adapter.js';
import { buildPayload, uuid16 } from './body-comp-helpers.js';
import { matchesDescriptor, type MatchDescriptor } from './match-descriptor.js';
import { encodeSigDateTime, parseSigWeightMeasurement, trustedScaleTime } from './sig-wss.js';
import { bleLog, errMsg, normalizeUuid } from '../ble/types.js';

// A&D UC-352BLE (SIG Weight Scale, bonded)
//
// The order of the writes and the frames come from the public HCI capture in
// oliexdev/openScale#1505 (mrblowntobits), cited byte for byte in
// tests/scales/and-uc352ble.test.ts. The GATT layout is the discovery dump in
// HEADS-project/ThingML-BLE (another unit; the capture has no discovery, but
// every handle it touches matches that dump), and the time-then-indications
// order is also what A&D's own iOS sample app (andengineering/BLE_iOS_SampleApp)
// does. No code was copied.
//
// What the scale does, per that capture, in each of three connections:
//
//   1. It sends an SMP Security Request at once; the phone encrypts with the
//      stored key. Everything in the Weight Scale service needs that link, and
//      the scale sends data only to the collector it is bonded with. It keeps
//      ONE bond (the manual: "Paired device: 1 device").
//   2. The app writes the local time, 7 bytes, to Date Time 0x2A08, which this
//      scale hosts inside its Weight Scale service. It has no Current Time
//      Service; the 10-byte 0x2A2B write some handlers send goes nowhere.
//   3. Only then does the app enable indications on Weight Measurement 0x2A9D.
//      The weigh-in follows within 100 ms, flags 0x02 (kg, Time Stamp), and
//      its Time Stamp is the time written in step 2, to the second.
//   4. About 4 s later the app turns indications off and the scale
//      disconnects.
//
// Weight only: the scale measures no impedance.

const CHR_WEIGHT_MEASUREMENT = uuid16(0x2a9d);
const CHR_DATE_TIME = uuid16(0x2a08);

/** The advertised name is `A&D_UC-352BLE_` plus the last three address bytes. */
const NAME_PREFIX = 'a&d_uc-352ble';

/**
 * How long a session stays up after the first live weigh-in. The app kept the
 * link 4.03 to 4.04 s after the indication in all three connections. If two
 * live records arrive inside it, the later one wins.
 */
const HOLD_MS = 4_000;

/** What a refused time write or indication enable most likely means. */
const NOT_PAIRED_HINT =
  'most likely because the scale is not paired with this host. Pairing works on Linux ' +
  '(BlueZ) with ble.scale_mac set: hold SET on the scale until the display shows Pr, ' +
  'then weigh in again.';

/**
 * Adapter for the A&D UC-352BLE: a Bluetooth SIG Weight Scale that needs a
 * bond and the time written before it sends anything (#408).
 *
 * Claimed by its advertised name only. A claim on the Weight Scale service
 * would take every WSS scale; the generic adapter keeps the nameless ones.
 * Priority 225 sits below Renpho ES-WBE28 (240) on purpose: the mqtt-proxy
 * autonomous connect falls back to the highest-priority adapter whose notify
 * characteristic the device exposes, and both have 0x2A9D (registry-check
 * enforces the order).
 */
export class AndUc352bleAdapter
  implements ScaleAdapterCore, GattWiring, MultiCharNotify, HoldForComposition
{
  readonly name = 'A&D UC-352BLE';
  readonly match: MatchDescriptor = { priority: 225, names: { startsWith: [NAME_PREFIX] } };
  readonly charNotifyUuid = CHR_WEIGHT_MEASUREMENT;
  readonly charWriteUuid = CHR_DATE_TIME;
  readonly characteristics: CharacteristicBinding[] = [
    // Enabled from onConnected, after the time write (the app's order).
    { uuid: CHR_WEIGHT_MEASUREMENT, type: 'notify', deferred: true },
    { uuid: CHR_DATE_TIME, type: 'write', optional: true },
  ];
  readonly requiresBonding = true;
  readonly singleBond = true;
  readonly completionHoldMs = HOLD_MS;

  /** Whether the missing-Date-Time warning was printed in this process. */
  private noDateTimeWarned = false;

  /** The clock is injectable so a test can write the exact bytes of the capture. */
  constructor(private readonly now: () => Date = () => new Date()) {}

  matches(device: BleDeviceInfo): boolean {
    return matchesDescriptor(device, this.match);
  }

  async onConnected(ctx: ConnectionContext): Promise<void> {
    if (ctx.availableChars.has(CHR_DATE_TIME)) {
      try {
        // With a response, as the app writes it.
        await ctx.write(CHR_DATE_TIME, encodeSigDateTime(this.now()), true);
      } catch (err) {
        throw new Error(`The scale refused the time write, ${NOT_PAIRED_HINT} (${errMsg(err)})`, {
          cause: err,
        });
      }
    } else if (!this.noDateTimeWarned) {
      this.noDateTimeWarned = true;
      bleLog.warn(
        'A&D UC-352BLE: no Date Time characteristic (0x2A08) found, so the scale clock is not ' +
          'set; its readings may carry a wrong time.',
      );
    }

    try {
      await ctx.subscribe(CHR_WEIGHT_MEASUREMENT);
    } catch (err) {
      // Absent altogether is a different failure; its own message says so.
      if (!ctx.availableChars.has(CHR_WEIGHT_MEASUREMENT)) throw err;
      throw new Error(
        `The scale refused to enable weight indications, ${NOT_PAIRED_HINT} (${errMsg(err)})`,
        { cause: err },
      );
    }
    bleLog.info('A&D UC-352BLE: indications on. Waiting for the scale to send its weigh-in.');
  }

  parseCharNotification(charUuid: string, data: Buffer): ScaleReading | null {
    if (normalizeUuid(charUuid) !== CHR_WEIGHT_MEASUREMENT) return null;
    return this.parseNotification(data);
  }

  /**
   * One Weight Measurement indication. Its Time Stamp goes into the reading
   * (D027): on a live weigh-in it is the time we just wrote, so the runtime
   * treats it as live; a record the scale stored while nobody was listening
   * keeps its older stamp and goes out as history. No window against the host
   * clock, because such a record is legitimately older.
   */
  parseNotification(data: Buffer): ScaleReading | null {
    const m = parseSigWeightMeasurement(data);
    const weight = m.weightKg;
    // undefined covers a short frame and the 0xFFFF "Measurement Unsuccessful".
    if (weight === undefined || !Number.isFinite(weight) || weight <= 0) return null;
    const reading: ScaleReading = { weight, impedance: 0 };
    const timestamp = trustedScaleTime(m.timestamp);
    if (timestamp) reading.timestamp = timestamp;
    if (m.userIndex !== undefined) reading.userIndex = m.userIndex;
    return reading;
  }

  isComplete(reading: ScaleReading): boolean {
    return reading.weight > 0;
  }

  /** Never final: the hold always runs out, so a later live record can win. */
  isFinal(): boolean {
    return false;
  }

  computeMetrics(reading: ScaleReading, profile: UserProfile): BodyComposition {
    // No impedance on this scale, so the BMI-based estimate.
    return buildPayload(reading.weight, 0, {}, profile);
  }
}
