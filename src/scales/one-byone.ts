import type {
  BleDeviceInfo,
  ConnectionContext,
  ScaleAdapterCore,
  GattWiring,
  HoldForComposition,
  Unlockable,
  ScaleReading,
  UserProfile,
  BodyComposition,
} from '../interfaces/scale-adapter.js';
import { uuid16, xorChecksum, WEIGHT_ONLY_HOLD_MS, biaPayload } from './body-comp-helpers.js';
import { matchesDescriptor, type MatchDescriptor } from './match-descriptor.js';
import { bleLog } from '../ble/types.js';

/**
 * Hold window (ms) from the first weight, before the scale has said anything
 * about its measurement. Byte [9] of a 0xCF frame is a status: the Eufy C1
 * sends 0x01 on every frame while it measures, from the first one on, then
 * goes silent for about 5 s, then sends one frame with 0x00 that carries the
 * impedance (#534, full log of one session). The window is short, and
 * isCompositionPending extends it in steps (at most 3 s + 20 s) while the last
 * frame still says "measuring", which covers the silence. The frame with the
 * impedance ends the hold (isFinal); otherwise shared.ts resolves the last held
 * reading, so no weigh-in is lost (socks, a scale that never sends the impedance).
 */
const MEASURING_HOLD_MS = 3000;

/**
 * Byte [9] values with a known meaning: measuring (C1) and the lock values of
 * openScale's "Health Scale".
 */
const STATUS_MEASURING = 0x01;
const STATUS_LOCKED = [0x00, 0x36];

// ─── OneByoneAdapter (Eufy C1/P1, Health Scale) ─────────────────────────────

/**
 * One weigh-in's state, replaced in onConnected rather than onSessionStart.
 * Safe only for a legacy single-char adapter: shared.ts runs its subscribe and
 * onConnected under one Promise.all, so the synchronous prefix wins the race.
 */
class OneByoneSession {
  /** Raw weight (hundredths of kg) of the previous frame this session. */
  previousRawWeight: number | null = null;
  /** True when the last frame reported the same weight as the one before it. */
  weightStable = false;
  /**
   * A weight above 0 came twice in a row; from then on only a repeated weight
   * is held (isComplete).
   */
  settled = false;
  /**
   * The last 0xCF frame has a weight and a status in [9] that is not a lock
   * value; see isCompositionPending.
   */
  measuring = false;
  /** The debug line for an unknown [9] went out this session. */
  unknownStatusLogged = false;
}

/**
 * Adapter for Eufy C1/P1/A1 and "Health Scale" branded 1byone devices.
 *
 * Protocol: service 0xFFF0, notify 0xFFF4, write 0xFFF1.
 * Unlock via clock-sync frame: [0xF1, yearHi, yearLo, month, day, hour, min, sec].
 * Measurement frames begin with 0xCF header.
 *   Weight at bytes [3-4] little-endian uint16 / 100 (kg).
 *   Impedance: ((data[2]<<8)+data[1]) * 0.1, valid when byte[9] != 1 and != 0.
 *   Byte[9] is a status: 0x01 while the scale measures (Eufy C1, log), 0x00 on
 *   the frame with the impedance; openScale also takes 0x36 as locked ("Health
 *   Scale", from the vendor app). Anything else is treated as still measuring.
 */
export class OneByoneAdapter implements ScaleAdapterCore, GattWiring, HoldForComposition {
  readonly name = '1byone (Eufy)';
  readonly match: MatchDescriptor = {
    priority: 70,
    custom: true,
    names: { includes: ['t9146', 't9147', 't9120', 'health scale'] },
    charUuids: ['fff4'],
  };
  readonly charNotifyUuid = uuid16(0xfff4);
  readonly charWriteUuid = uuid16(0xfff1);

  private s = new OneByoneSession();

  matches(device: BleDeviceInfo): boolean {
    // Name match is unambiguous (T914x / Health Scale); keep it.
    const name = (device.localName || '').toLowerCase();
    if (this.match.names?.includes?.some((n) => name.includes(n))) return true;

    const chars = (device.characteristicUuids ?? []).map((u) => u.toLowerCase());
    if (chars.length === 0) return false;
    // Post-discovery: 0xFFF4 identifies the 1byone family, but the Eufy P2 also
    // exposes 0xFFF4 alongside 0xFFF2 + its auth char. A real 1byone C1/P1 uses
    // fff1 + fff4 and never fff2, so require fff4 WITHOUT fff2. This stops a
    // nameless Eufy P2 reaching an mqtt-proxy autonomous connect from being
    // driven with the wrong 1byone protocol (it falls through to its own
    // adapter via the notify-char fallback instead).
    return chars.includes(uuid16(0xfff4)) && !chars.includes(uuid16(0xfff2));
  }

  /**
   * Init sequence per openScale OneByoneHandler:
   *   1. Mode/unit command: [0xFD, 0x37, unit, group, ...padding, XOR]
   *   2. Clock sync: [0xF1, yearHi, yearLo, month, day, hour, min, sec]
   *
   * Both go out as Write Requests, as openScale's writeTo() does by default. On the
   * Eufy C1 0xFFF1 only has the `write` property, and BlueZ forwards a Write Command
   * anyway, so the scale rejects it with Write Not Permitted, never gets the clock
   * sync and never streams readings (#533).
   */
  async onConnected(ctx: ConnectionContext): Promise<void> {
    this.s = new OneByoneSession();

    // Step 1: Mode/unit command
    const unitCmd = [0xfd, 0x37, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00];
    unitCmd.push(xorChecksum(unitCmd, 0, unitCmd.length));
    await ctx.write(this.charWriteUuid, unitCmd, true);

    // Step 2: Clock sync
    const now = new Date();
    const clockCmd = [
      0xf1,
      (now.getFullYear() >> 8) & 0xff,
      now.getFullYear() & 0xff,
      now.getMonth() + 1,
      now.getDate(),
      now.getHours(),
      now.getMinutes(),
      now.getSeconds(),
    ];
    await ctx.write(this.charWriteUuid, clockCmd, true);
  }

  parseNotification(data: Buffer): ScaleReading | null {
    if (data.length < 5 || data[0] !== 0xcf) return null;

    const rawWeight = data.readUInt16LE(3);
    const weight = rawWeight / 100;

    let impedance = 0;
    if (data.length >= 10) {
      const rawImp = ((data[2] << 8) + data[1]) * 0.1;
      const impedanceInvalid = data[9] === 1 || rawImp === 0;
      if (!impedanceInvalid) {
        impedance = rawImp;
      }
    }

    this.s.weightStable = this.s.previousRawWeight === rawWeight;
    if (this.s.weightStable && rawWeight > 0) this.s.settled = true;
    this.s.previousRawWeight = rawWeight;

    const status = data.length >= 10 ? data[9] : undefined;
    const locked = status === undefined || STATUS_LOCKED.includes(status);
    this.s.measuring = rawWeight > 0 && !locked;
    if (this.s.measuring && status !== STATUS_MEASURING && !this.s.unknownStatusLogged) {
      this.s.unknownStatusLogged = true;
      bleLog.debug(
        `1byone: byte 9 is 0x${status!.toString(16).padStart(2, '0')}, not a known status; treating it as measuring`,
      );
    }

    return { weight, impedance };
  }

  /**
   * HoldTimer holds the last complete reading, and a longer hold must not export
   * a frame from the person stepping on. Until a weight has repeated this
   * session any weight above 0 counts, so a lone frame is never lost; after
   * that only a repeated weight or a frame with the impedance does.
   */
  isComplete(reading: ScaleReading): boolean {
    if (reading.weight <= 0) return false;
    return reading.impedance > 0 || this.s.weightStable || !this.s.settled;
  }

  /** Hold the link open after the first weight so the scale can measure the impedance. */
  readonly completionHoldMs = MEASURING_HOLD_MS;

  /**
   * The frame with the impedance ends the weigh-in; the scale marks it, the
   * weight need not repeat.
   */
  isFinal(reading: ScaleReading): boolean {
    return reading.impedance > 0;
  }

  /**
   * The last frame has a weight and a status that is not a lock value: the
   * scale is still measuring.
   */
  isCompositionPending(): boolean {
    return this.s.measuring;
  }

  computeMetrics(reading: ScaleReading, profile: UserProfile): BodyComposition {
    // buildPayload does NOT run the BIA estimator: without a fat percentage it
    // falls back to the Deurenberg BMI estimate, so an adapter that parses an
    // impedance and then passes an empty comp publishes the impedance and
    // ignores it (#386). biaFatIfPlausible bounds the value first. The C1 frames
    // of #533 and #534 read inside the band with the 0.1 factor, but no app
    // value confirms it; a wrong factor would arrive as 30-90 ohm
    // and be refused, leaving the BMI estimate.
    return biaPayload(reading, profile);
  }
}

// ─── OneByoneNewAdapter (1byone scale — newer protocol) ─────────────────────

/** One weigh-in's state, replaced whole in onSessionStart (#394, SCALES.md). */
class OneByoneNewSession {
  cachedWeight = 0;
  cachedImpedance = 0;
}

/**
 * Adapter for the newer "1byone scale" branded device.
 *
 * Protocol: service 0xFFB0, notify 0xFFB2, write 0xFFB1.
 * All frames begin with [0xAB, 0x2A].
 *   Type at byte[2]:
 *     0x80 = final weight: bytes [3-5] 24-bit big-endian, mask 0x03FFFF, /1000 (kg).
 *     0x01 = impedance: bytes [4-5] big-endian uint16.
 *     0x00 with byte[7]=0x80 = history (ignored).
 */
export class OneByoneNewAdapter
  implements ScaleAdapterCore, GattWiring, Unlockable, HoldForComposition
{
  readonly name = '1byone Scale (new)';
  readonly match: MatchDescriptor = {
    priority: 60,
    names: { exact: ['1byone scale'] },
  };
  readonly charNotifyUuid = uuid16(0xffb2);
  readonly charWriteUuid = uuid16(0xffb1);
  readonly unlockCommand = [
    0xab, 0x2a, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0xd7,
  ];
  readonly unlockIntervalMs = 0;

  private s = new OneByoneNewSession();

  onSessionStart(): void {
    this.s = new OneByoneNewSession();
  }

  matches(device: BleDeviceInfo): boolean {
    return matchesDescriptor(device, this.match);
  }

  parseNotification(data: Buffer): ScaleReading | null {
    if (data.length < 3 || data[0] !== 0xab || data[1] !== 0x2a) return null;

    const type = data[2];

    if (type === 0x80 && data.length >= 6) {
      // Final weight frame: 24-bit BE at [3-5], mask lower 18 bits
      const raw24 = (data[3] << 16) | (data[4] << 8) | data[5];
      this.s.cachedWeight = (raw24 & 0x03ffff) / 1000;
    } else if (type === 0x01 && data.length >= 6) {
      // Impedance frame: BE uint16 at [4-5]
      this.s.cachedImpedance = (data[4] << 8) | data[5];
    } else if (type === 0x00 && data.length >= 8 && data[7] === 0x80) {
      // History frame — ignored
      return null;
    }

    if (this.s.cachedWeight <= 0) return null;

    return { weight: this.s.cachedWeight, impedance: this.s.cachedImpedance };
  }

  /**
   * The 0x80 final weight completes the reading; the 0x01 impedance makes it
   * final (ADR D028, review D-07).
   *
   * Requiring the impedance here meant a weigh-in the scale could not analyse
   * (socks, a child), whose final weight is never followed by a 0x01 frame,
   * produced no reading at all: the session timed out and the weight was lost.
   * Now it holds the link for `WEIGHT_ONLY_HOLD_MS`, resolves at once when the
   * impedance arrives, and otherwise completes with the weight alone.
   */
  isComplete(reading: ScaleReading): boolean {
    return reading.weight > 0;
  }

  readonly completionHoldMs = WEIGHT_ONLY_HOLD_MS;

  isFinal(reading: ScaleReading): boolean {
    return reading.impedance > 0;
  }

  computeMetrics(reading: ScaleReading, profile: UserProfile): BodyComposition {
    // buildPayload does NOT run the BIA estimator: without a fat percentage it
    // falls back to the Deurenberg BMI estimate, so an adapter that parses an
    // impedance and then passes an empty comp publishes the impedance and
    // ignores it (#386). biaFatIfPlausible bounds the value first, because the
    // scaling of this field has never been checked against a capture.
    return biaPayload(reading, profile);
  }
}
