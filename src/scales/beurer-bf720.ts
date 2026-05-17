import type {
  BleDeviceInfo,
  CharacteristicBinding,
  ConnectionContext,
  ScaleAdapter,
  ScaleReading,
  UserProfile,
  BodyComposition,
} from '../interfaces/scale-adapter.js';
import { uuid16, buildPayload, type ScaleBodyComp } from './body-comp-helpers.js';
import { bleLog } from '../ble/types.js';

// ─── Beurer SIG-standard adapter (BF720, BF105) ─────────────────────────────

// Standard SIG characteristics.
const CHR_WEIGHT_MEASUREMENT = uuid16(0x2a9d); // Weight Scale Service 0x181D
const CHR_BODY_COMPOSITION = uuid16(0x2a9c); // Body Composition Service 0x181B
const CHR_USER_CONTROL_POINT = uuid16(0x2a9f); // User Data Service 0x181C
const CHR_DB_CHANGE_INCREMENT = uuid16(0x2a99); // User Data Service 0x181C
const CHR_CURRENT_TIME = uuid16(0x2a2b); // Current Time Service 0x1805

// Beurer GmbH SIG-assigned company identifier (advertisement manufacturer data).
const BEURER_COMPANY_ID = 0x0611;

// User Control Point opcodes (subset; consent-only path).
const UCP_CONSENT = 0x02;
const UCP_RESPONSE = 0x20;
const UCP_RESULT_SUCCESS = 0x01;
const UCP_RESULT_NOT_AUTHORIZED = 0x05;

/**
 * Frames whose embedded timestamp is older than this are treated as cached
 * historical readings (routed into the back-dated replay path). BF720 stamps
 * every frame including the live weigh-in, so the age check is what separates
 * a live measurement (stamped "now") from the on-scale history dump (stamped
 * days ago).
 */
const HISTORY_MAX_AGE_MS = 5 * 60_000;

interface CachedComp {
  fat?: number; // %
  muscle?: number; // %
  waterMass?: number; // kg
  softLean?: number; // kg
}

/**
 * Adapter for Beurer SIG-standard BLE scales (BF720, BF105).
 *
 * These speak pure Bluetooth SIG GATT: Weight Scale (0x181D / 0x2A9D), Body
 * Composition (0x181B / 0x2A9C) and User Data (0x181C / 0x2A9F) services. Body
 * composition is delivered natively by the scale, so no BIA/Deurenberg
 * estimation is used.
 *
 * Measurements are gated behind a User Control Point consent code. The user
 * obtains it once by pairing the scale with the Beurer / openScale app (or
 * reads it off the scale's control unit) and puts it in config.yaml under
 * `users[].beurer_pin` (and optionally `users[].beurer_user_index`, default 1).
 *
 * Protocol decoded from an openScale HCI snoop (#168) and cross-checked
 * against openScale's StandardWeightProfileHandler.
 */
export class BeurerBf720Adapter implements ScaleAdapter {
  readonly name = 'Beurer BF720/BF105';
  // Legacy single-char fallback (unused in multi-char mode).
  readonly charNotifyUuid = CHR_WEIGHT_MEASUREMENT;
  readonly charWriteUuid = CHR_CURRENT_TIME;
  readonly normalizesWeight = true;
  readonly unlockCommand: number[] = [];
  readonly unlockIntervalMs = 0;

  readonly characteristics: CharacteristicBinding[] = [
    { uuid: CHR_WEIGHT_MEASUREMENT, type: 'notify' },
    { uuid: CHR_BODY_COMPOSITION, type: 'notify' },
    { uuid: CHR_USER_CONTROL_POINT, type: 'notify' },
    { uuid: CHR_DB_CHANGE_INCREMENT, type: 'notify', optional: true },
    { uuid: CHR_CURRENT_TIME, type: 'write' },
  ];

  private cachedWeight = 0;
  private cachedTimestamp: Date | undefined;
  private cachedComp: CachedComp = {};

  matches(device: BleDeviceInfo): boolean {
    const name = (device.localName || '').toLowerCase();
    if (name.includes('bf720') || name.includes('bf105')) return true;
    return device.manufacturerData?.id === BEURER_COMPANY_ID;
  }

  async onConnected(ctx: ConnectionContext): Promise<void> {
    const required = [CHR_WEIGHT_MEASUREMENT, CHR_BODY_COMPOSITION, CHR_USER_CONTROL_POINT];
    const missing = required.filter((u) => !ctx.availableChars.has(u));
    if (missing.length > 0) {
      throw new Error(
        `Beurer BF720: required characteristics not discovered (${missing.join(', ')}). ` +
          'Likely a transient GATT discovery race. Try again.',
      );
    }

    const pin = ctx.scaleAuth?.pin;
    if (pin == null) {
      throw new Error(
        'Beurer BF720/BF105 needs a consent PIN. Set `users[].beurer_pin` in config.yaml ' +
          '(the code the scale was paired with in the Beurer / openScale app, or shown on ' +
          "the scale's control unit).",
      );
    }
    const userIndex = ctx.scaleAuth?.userIndex ?? 1;

    // Reset per-connection state (adapter instance is shared across sessions).
    this.cachedWeight = 0;
    this.cachedTimestamp = undefined;
    this.cachedComp = {};

    await ctx.write(CHR_CURRENT_TIME, this.buildCurrentTime(), true);
    await ctx.write(
      CHR_USER_CONTROL_POINT,
      [UCP_CONSENT, userIndex & 0xff, pin & 0xff, (pin >> 8) & 0xff],
      true,
    );
    bleLog.debug(`Beurer BF720: consent sent for user index ${userIndex}`);
  }

  /** Current Time Service 0x2A2B payload (10 bytes). */
  private buildCurrentTime(): number[] {
    const now = new Date();
    const year = now.getFullYear();
    return [
      year & 0xff,
      (year >> 8) & 0xff,
      now.getMonth() + 1,
      now.getDate(),
      now.getHours(),
      now.getMinutes(),
      now.getSeconds(),
      ((now.getDay() + 6) % 7) + 1, // 1 = Monday .. 7 = Sunday
      0x00, // fractions256
      0x00, // adjust reason
    ];
  }

  parseCharNotification(charUuid: string, data: Buffer): ScaleReading | null {
    if (charUuid === CHR_USER_CONTROL_POINT) {
      this.handleUcpResponse(data);
      return null;
    }
    if (charUuid === CHR_WEIGHT_MEASUREMENT) {
      this.parseWeightMeasurement(data);
      return this.buildReading();
    }
    if (charUuid === CHR_BODY_COMPOSITION) {
      this.parseBodyComposition(data);
      return this.buildReading();
    }
    return null;
  }

  /** Legacy single-char path: only weight measurement frames. */
  parseNotification(data: Buffer): ScaleReading | null {
    this.parseWeightMeasurement(data);
    return this.buildReading();
  }

  private handleUcpResponse(data: Buffer): void {
    if (data.length < 3 || data[0] !== UCP_RESPONSE) return;
    const result = data[2];
    if (result === UCP_RESULT_SUCCESS) {
      bleLog.debug('Beurer BF720: consent accepted, awaiting measurement');
    } else if (result === UCP_RESULT_NOT_AUTHORIZED) {
      bleLog.warn(
        'Beurer BF720: consent rejected (USER_NOT_AUTHORIZED). Check `users[].beurer_pin` ' +
          'and `users[].beurer_user_index` match the slot the scale was paired with.',
      );
    } else {
      bleLog.debug(`Beurer BF720: User Control Point result 0x${result.toString(16)}`);
    }
  }

  /** Decode a 7-byte SIG timestamp; return undefined on a zero/invalid date. */
  private parseTimestamp(data: Buffer, offset: number): Date | undefined {
    if (offset + 7 > data.length) return undefined;
    const year = data.readUInt16LE(offset);
    if (year === 0) return undefined;
    const d = new Date(
      year,
      data[offset + 2] - 1,
      data[offset + 3],
      data[offset + 4],
      data[offset + 5],
      data[offset + 6],
    );
    return Number.isNaN(d.getTime()) ? undefined : d;
  }

  /**
   * Only timestamps older than the freshness window mark a reading as
   * historical. A live weigh-in is stamped "now" and must resolve immediately
   * rather than being buffered as cached history.
   */
  private historicalTimestamp(ts: Date | undefined): Date | undefined {
    if (!ts) return undefined;
    return Date.now() - ts.getTime() > HISTORY_MAX_AGE_MS ? ts : undefined;
  }

  /** Weight Measurement 0x2A9D. */
  private parseWeightMeasurement(data: Buffer): void {
    if (data.length < 3) return;
    const flags = data[0];
    const isKg = (flags & 0x01) === 0;
    const hasTimestamp = (flags & 0x02) !== 0;

    const weight = data.readUInt16LE(1) * (isKg ? 0.005 : 0.01);
    if (weight > 0 && Number.isFinite(weight)) this.cachedWeight = weight;

    if (hasTimestamp) {
      const ts = this.parseTimestamp(data, 3);
      if (ts) this.cachedTimestamp = ts;
    }
  }

  /** Body Composition Measurement 0x2A9C. */
  private parseBodyComposition(data: Buffer): void {
    if (data.length < 4) return;
    const flags = data.readUInt16LE(0);
    const isKg = (flags & 0x0001) === 0;
    const massMul = isKg ? 0.005 : 0.01;

    let off = 2;
    // Body Fat % is always present, immediately after the flags.
    this.cachedComp.fat = data.readUInt16LE(off) * 0.1;
    off += 2;

    if (flags & 0x0002) {
      // Timestamp.
      const ts = this.parseTimestamp(data, off);
      if (ts) this.cachedTimestamp = ts;
      off += 7;
    }
    if (flags & 0x0004) off += 1; // User ID
    if (flags & 0x0008) off += 2; // Basal Metabolism (kJ, unused)
    if (flags & 0x0010) {
      this.cachedComp.muscle = data.readUInt16LE(off) * 0.1; // Muscle %
      off += 2;
    }
    if (flags & 0x0020) off += 2; // Muscle Mass (unused)
    if (flags & 0x0040) off += 2; // Fat Free Mass (unused)
    if (flags & 0x0080) {
      this.cachedComp.softLean = data.readUInt16LE(off) * massMul; // Soft Lean Mass kg
      off += 2;
    }
    if (flags & 0x0100) {
      this.cachedComp.waterMass = data.readUInt16LE(off) * massMul; // Body Water Mass kg
      off += 2;
    }
    if (flags & 0x0200) off += 2; // Impedance (unused; native comp)
    if (flags & 0x0400) {
      const w = data.readUInt16LE(off) * massMul; // Weight
      if (w > 0 && Number.isFinite(w)) this.cachedWeight = w;
      off += 2;
    }
    // Remaining optional fields (Height, ...) are not needed.
  }

  /**
   * Emit a reading only once weight AND native body composition are both
   * known, mirroring openScale's weight/body-comp pairing. BF720 always sends
   * both characteristics per measurement.
   */
  private buildReading(): ScaleReading | null {
    if (this.cachedWeight <= 0 || this.cachedComp.fat == null) return null;
    const reading: ScaleReading = { weight: this.cachedWeight, impedance: 0 };
    const histTs = this.historicalTimestamp(this.cachedTimestamp);
    if (histTs) reading.timestamp = histTs;
    return reading;
  }

  isComplete(reading: ScaleReading): boolean {
    return reading.weight > 0;
  }

  computeMetrics(reading: ScaleReading, profile: UserProfile): BodyComposition {
    const { weight } = reading;
    const c = this.cachedComp;
    const comp: ScaleBodyComp = {};

    if (c.fat != null) comp.fat = c.fat;
    if (c.muscle != null) comp.muscle = c.muscle;
    if (c.waterMass != null && weight > 0) {
      comp.water = (c.waterMass / weight) * 100;
    }
    if (c.fat != null && c.softLean != null && weight > 0) {
      const leanBodyMass = weight - weight * (c.fat / 100);
      const bone = leanBodyMass - c.softLean;
      if (bone > 0) comp.bone = bone;
    }

    return buildPayload(weight, reading.impedance, comp, profile);
  }
}
