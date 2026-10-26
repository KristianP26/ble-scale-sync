import type {
  BleDeviceInfo,
  CharacteristicBinding,
  ConnectionContext,
  ScaleAdapterCore,
  GattWiring,
  MultiCharNotify,
  ScaleReading,
  UserProfile,
  BodyComposition,
} from '../interfaces/scale-adapter.js';
import { uuid16, buildPayload, type ScaleBodyComp } from './body-comp-helpers.js';
import { bleLog, LBS_TO_KG } from '../ble/types.js';
import { parseSigDateTime, parseSigWeightMeasurement, trustedScaleTime } from './sig-wss.js';
import type { MatchDescriptor } from './match-descriptor.js';

// ─── Beurer BF500 adapter ───────────────────────────────────────────────────
//
// Protocol taken from openScale's StandardBeurerSanitasHandler (BEURER_BF500
// profile) and StandardWeightProfileHandler, which are known to work on this
// scale. The BF500 is SIG User Data / Weight Scale / Body Composition like the
// BF720, but its vendor characteristics sit on service 0xFFFF and the vendor
// user list is NOT where the BF720 keeps it.

// Standard SIG characteristics.
const CHR_WEIGHT_MEASUREMENT = uuid16(0x2a9d); // Weight Scale Service 0x181D
const CHR_BODY_COMPOSITION = uuid16(0x2a9c); // Body Composition Service 0x181B
const CHR_USER_CONTROL_POINT = uuid16(0x2a9f); // User Data Service 0x181C
const CHR_DB_CHANGE_INCREMENT = uuid16(0x2a99); // User Data Service 0x181C
const CHR_CURRENT_TIME = uuid16(0x2a2b); // Current Time Service 0x1805
const CHR_DATE_OF_BIRTH = uuid16(0x2a85); // User Data Service 0x181C
const CHR_GENDER = uuid16(0x2a8c); // User Data Service 0x181C
const CHR_HEIGHT = uuid16(0x2a8e); // User Data Service 0x181C

// Beurer vendor characteristics on service 0xFFFF (openScale BEURER_BF500 profile).
// The BF720 layout (0xFFF2 user list, 0xFFF3 activity) is shifted by one: writing
// the user-list query to 0xFFF2 here would store an invalid activity level.
const CHR_VENDOR_USER_LIST = uuid16(0xfff1); // notify: one frame per user slot
const CHR_VENDOR_ACTIVITY = uuid16(0xfff2); // write: activity level 1..5
const CHR_VENDOR_TAKE_MEASUREMENT = uuid16(0xfff4); // write 0x00: start a measurement

/** Activity level written for a freshly registered user (openScale range 1..5). */
const DEFAULT_ACTIVITY_LEVEL = 0x03;

// User Control Point opcodes (subset).
/**
 * SIG User Data Service "Register New User": `01 <consent code u16 LE>`.
 *
 * A consent can only succeed on a slot that exists. A BF500 whose batteries
 * were removed has no user records at all, and answers a consent on any index
 * with OPERATION_FAILED (not USER_NOT_AUTHORIZED, which means a wrong code on a
 * slot that exists). The scale answers a registration with the index it assigned.
 */
const UCP_REGISTER_NEW_USER = 0x01;
const UCP_CONSENT = 0x02;
const UCP_RESPONSE = 0x20;
const UCP_RESULT_SUCCESS = 0x01;
const UCP_RESULT_OPERATION_FAILED = 0x04;
const UCP_RESULT_NOT_AUTHORIZED = 0x05;

/** User Control Point result codes, so a log line names the failure. */
const UCP_RESULTS: Record<number, string> = {
  0x01: 'SUCCESS',
  0x02: 'OP_CODE_NOT_SUPPORTED',
  0x03: 'INVALID_PARAMETER',
  0x04: 'OPERATION_FAILED',
  0x05: 'USER_NOT_AUTHORIZED',
};

interface CachedComp {
  fat?: number; // %
  muscle?: number; // %
  waterMass?: number; // kg
  softLean?: number; // kg
  impedance?: number; // ohm
}

/**
 * Adapter for the Beurer BF500.
 *
 * Measurements are gated behind a User Control Point consent code on a user
 * slot the scale already holds. The sequence mirrors openScale:
 *
 *   1. time write, vendor user-list query (0xFFF1)
 *   2. `beurer_register_new_user`: Register New User, then consent on the
 *      assigned slot and write the profile (DOB, gender, height, change
 *      increment, activity). Otherwise: consent on `beurer_user_index`.
 *   3. after an accepted consent, write 0x00 to the take-measurement
 *      characteristic (0xFFF4). The BF500 does not send a measurement until
 *      asked, unlike the BF720.
 *
 * Body composition is delivered natively by the scale, so no BIA/Deurenberg
 * estimation is used.
 */
export class BeurerBf500Adapter implements ScaleAdapterCore, GattWiring, MultiCharNotify {
  readonly name = 'Beurer BF500';
  readonly match: MatchDescriptor = {
    // One above the BF720/BF105 adapter, which still claims "bf500" by name.
    priority: 221,
    custom: true,
    names: { includes: ['bf500'] },
  };
  // Legacy single-char fallback (unused in multi-char mode).
  readonly charNotifyUuid = CHR_WEIGHT_MEASUREMENT;
  readonly charWriteUuid = CHR_CURRENT_TIME;
  // SIG User Data Service (0x181C) CCCD writes need an encrypted link.
  readonly requiresBonding = true;

  readonly characteristics: CharacteristicBinding[] = [
    { uuid: CHR_WEIGHT_MEASUREMENT, type: 'notify' },
    { uuid: CHR_BODY_COMPOSITION, type: 'notify' },
    { uuid: CHR_USER_CONTROL_POINT, type: 'notify' },
    { uuid: CHR_DB_CHANGE_INCREMENT, type: 'notify', optional: true },
    { uuid: CHR_VENDOR_USER_LIST, type: 'notify', optional: true },
    { uuid: CHR_CURRENT_TIME, type: 'write' },
  ];

  private cachedWeight = 0;
  private cachedTimestamp: Date | undefined;
  /** User slot the current weigh-in's frames name, when they carry one. */
  private cachedUserIndex: number | undefined;
  private cachedComp: CachedComp = {};
  /**
   * The adapter instance is shared across GATT sessions, so the post-consent
   * steps are keyed on a session counter: a late consent response must never
   * write into a ConnectionContext that has already been torn down.
   */
  private ctx: ConnectionContext | undefined;
  private session = 0;
  /** Scale user slot the consent applies to; used in the log lines. */
  private userIndex = 1;
  /** Consent code in use this session (also the code a registration stores). */
  private pin = 0;
  /** users[].beurer_register_new_user: create a SIG user record. */
  private registerNewUser = false;
  /** True once this session registered a user, so the profile must be written. */
  private registeredThisSession = false;
  /** Latch so the post-consent steps run once per session. */
  private measurementRequested = false;
  /** Vendor user-slot records seen on 0xFFF1 this session. */
  private userSlotsSeen = 0;
  /** Whether the scale answered the consent write at all this session. */
  private consentAnswered = false;
  /** Whether a consent write went out this session (gates the silence warning). */
  private consentSent = false;
  /** Whether a reading was emitted this session (gates the session-end warning). */
  private readingEmitted = false;

  /**
   * Name only. A nameless Beurer (company id 0x0611 plus a SIG service) stays
   * with the BF720/BF105 adapter's fallback: the company id is shared across
   * the whole range and says nothing about the BF500's vendor layout.
   */
  matches(device: BleDeviceInfo): boolean {
    return (device.localName || '').toLowerCase().includes('bf500');
  }

  /** Clear the previous weigh-in before anything is subscribed (#394). */
  onSessionStart(): void {
    this.cachedWeight = 0;
    this.cachedTimestamp = undefined;
    this.cachedUserIndex = undefined;
    this.cachedComp = {};
    this.registeredThisSession = false;
    this.measurementRequested = false;
    this.userSlotsSeen = 0;
    this.consentAnswered = false;
    this.consentSent = false;
    this.readingEmitted = false;
  }

  async onConnected(ctx: ConnectionContext): Promise<void> {
    const required = [CHR_WEIGHT_MEASUREMENT, CHR_BODY_COMPOSITION, CHR_USER_CONTROL_POINT];
    const missing = required.filter((u) => !ctx.availableChars.has(u));
    if (missing.length > 0) {
      throw new Error(
        `Beurer BF500: required characteristics not discovered (${missing.join(', ')}). ` +
          'Likely a transient GATT discovery race. Try again.',
      );
    }

    const pin = ctx.scaleAuth?.pin;
    if (pin == null) {
      throw new Error(
        'Beurer BF500 needs a consent PIN. Set `users[].beurer_pin` in config.yaml (0-9999). ' +
          'A scale whose batteries were removed has no users: set `beurer_register_new_user: true` ' +
          'once to create one with that code.',
      );
    }

    this.session += 1;
    this.ctx = ctx;
    this.pin = pin;
    this.userIndex = ctx.scaleAuth?.userIndex ?? 1;
    this.registerNewUser = ctx.scaleAuth?.registerNewUser === true;

    await ctx.write(CHR_CURRENT_TIME, this.buildCurrentTime(), true);

    // Vendor user-slot query, answered with one frame per stored user. Informational
    // only, but it names the slots in the log and the scale expects it.
    if (ctx.availableChars.has(CHR_VENDOR_USER_LIST)) {
      try {
        await ctx.write(CHR_VENDOR_USER_LIST, [0x00], true);
      } catch (err) {
        bleLog.debug(`Beurer BF500: vendor user-list query failed: ${String(err)}`);
      }
    }

    if (this.registerNewUser) {
      // One-shot and opt-in: it creates a record on the scale and the slots are
      // finite. The consent for the assigned slot follows in handleUcpResponse.
      bleLog.info(
        `Beurer BF500: registering a new user with consent code ${pin}. ` +
          'This creates a record on the scale.',
      );
      await ctx.write(CHR_USER_CONTROL_POINT, this.registerPayload(pin), true);
      this.consentSent = true;
      return;
    }

    await this.sendConsent();
  }

  private registerPayload(pin: number): number[] {
    return [UCP_REGISTER_NEW_USER, pin & 0xff, (pin >> 8) & 0xff];
  }

  private async sendConsent(): Promise<void> {
    const ctx = this.ctx;
    if (!ctx) return;
    await ctx.write(
      CHR_USER_CONTROL_POINT,
      [UCP_CONSENT, this.userIndex & 0xff, this.pin & 0xff, (this.pin >> 8) & 0xff],
      true,
    );
    this.consentSent = true;
    bleLog.debug(`Beurer BF500: consent sent for user index ${this.userIndex}`);
  }

  /**
   * After an accepted consent: write the profile (only for a user registered in
   * this session) and ask the scale to measure.
   *
   * openScale writes the profile only after registering, so an existing user's
   * stored profile is never touched. The scale does not send a measurement on
   * its own; the 0x00 write to 0xFFF4 is what starts it.
   */
  private async startMeasurement(session: number): Promise<void> {
    const ctx = this.ctx;
    if (!ctx || session !== this.session || this.measurementRequested) return;
    this.measurementRequested = true;
    try {
      if (this.registeredThisSession) await this.writeProfile(ctx, session);
      if (session !== this.session) return;
      if (!ctx.availableChars.has(CHR_VENDOR_TAKE_MEASUREMENT)) {
        bleLog.warn('Beurer BF500: take-measurement characteristic 0xFFF4 not found.');
        return;
      }
      try {
        await ctx.write(CHR_VENDOR_TAKE_MEASUREMENT, [0x00], true);
      } catch {
        // Fall back to write-without-response if the characteristic only allows it.
        await ctx.write(CHR_VENDOR_TAKE_MEASUREMENT, [0x00], false);
      }
      bleLog.debug('Beurer BF500: measurement requested, step on the scale');
    } catch (err) {
      bleLog.warn(`Beurer BF500: could not request a measurement: ${String(err)}`);
    }
  }

  /** Profile writes in openScale's order: DOB, gender, height, increment, activity. */
  private async writeProfile(ctx: ConnectionContext, session: number): Promise<void> {
    const p = ctx.profile;
    const born = p.birthDate ? new Date(p.birthDate) : null;
    let dob: number[];
    if (born && !Number.isNaN(born.getTime())) {
      // YYYY-MM-DD parses as UTC midnight; read it back in UTC.
      const y = born.getUTCFullYear();
      dob = [y & 0xff, (y >> 8) & 0xff, born.getUTCMonth() + 1, born.getUTCDate()];
    } else {
      const y = new Date().getFullYear() - Math.max(1, Math.round(p.age));
      dob = [y & 0xff, (y >> 8) & 0xff, 1, 1];
    }
    const cm = Math.min(300, Math.max(1, Math.round(p.height)));
    const writes: Array<[string, number[]]> = [
      [CHR_DATE_OF_BIRTH, dob],
      [CHR_GENDER, [p.gender === 'female' ? 1 : 0]],
      [CHR_HEIGHT, [cm & 0xff, (cm >> 8) & 0xff]],
      [CHR_DB_CHANGE_INCREMENT, [0x01, 0x00, 0x00, 0x00]],
      [CHR_VENDOR_ACTIVITY, [DEFAULT_ACTIVITY_LEVEL]],
    ];
    for (const [uuid, value] of writes) {
      if (session !== this.session) return;
      if (!ctx.availableChars.has(uuid)) continue;
      try {
        await ctx.write(uuid, value, true);
      } catch (err) {
        bleLog.debug(`Beurer BF500: profile write ${uuid} rejected: ${String(err)}`);
      }
    }
    bleLog.debug('Beurer BF500: user profile written to the new slot');
  }

  /** Decode one vendor user-slot frame (diagnostics only, never a reading). */
  private handleUserListFrame(data: Buffer): void {
    if (data.length === 0) return;
    if (data[0] === 0x00) {
      this.userSlotsSeen += 1;
      if (data.length >= 12) {
        bleLog.debug(
          `Beurer BF500: user slot ${data[1]} (born ${data.readUInt16LE(5)}-${data[7]}-${data[8]}, ` +
            `${data[9]} cm, activity ${data[11]})`,
        );
      }
      return;
    }
    if (data[0] === 0x01) {
      bleLog.debug('Beurer BF500: end of user-slot list');
      return;
    }
    // Status 0x02: the scale holds no users.
    bleLog.debug(`Beurer BF500: user-list status 0x${data[0].toString(16).padStart(2, '0')}`);
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
    if (charUuid === CHR_VENDOR_USER_LIST) {
      this.handleUserListFrame(data);
      return null;
    }
    if (charUuid === CHR_WEIGHT_MEASUREMENT) {
      // A weight opens a weigh-in; only its 0x2A9C completes it (review C-01).
      this.parseWeightMeasurement(data);
      return null;
    }
    if (charUuid === CHR_BODY_COMPOSITION) {
      this.parseBodyComposition(data);
      return this.buildReading();
    }
    return null;
  }

  /**
   * Legacy single-char path: only weight measurement frames, which never carry
   * the composition this adapter emits on, so it caches and returns nothing.
   */
  parseNotification(data: Buffer): ScaleReading | null {
    this.parseWeightMeasurement(data);
    return null;
  }

  private handleUcpResponse(data: Buffer): void {
    if (data.length < 3 || data[0] !== UCP_RESPONSE) return;
    const result = data[2];
    const name = UCP_RESULTS[result] ?? `0x${result.toString(16).padStart(2, '0')}`;

    if (data[1] === UCP_REGISTER_NEW_USER) {
      this.consentAnswered = true;
      if (result !== UCP_RESULT_SUCCESS || data.length < 4) {
        bleLog.warn(
          `Beurer BF500: the scale refused to register a new user (${name}). ` +
            'Its user slots may all be occupied; free one in the scale menu and retry.',
        );
        return;
      }
      // The assigned index follows the result byte. openScale consents to it
      // straight away, and only that consent unlocks the measurement.
      this.userIndex = data[3];
      this.registeredThisSession = true;
      bleLog.info(
        `Beurer BF500: registered a new user at index ${this.userIndex}. ` +
          `Set 'users[].beurer_user_index: ${this.userIndex}' and turn ` +
          "'beurer_register_new_user' back off, or the next run registers another one.",
      );
      this.consentAnswered = false;
      const session = this.session;
      this.sendConsent().catch((err) => {
        if (session === this.session) {
          bleLog.warn(`Beurer BF500: consent after registration failed: ${String(err)}`);
        }
      });
      return;
    }
    if (data[1] !== UCP_CONSENT) {
      bleLog.debug(
        `Beurer BF500: User Control Point response to opcode ` +
          `0x${data[1].toString(16).padStart(2, '0')}, ignored`,
      );
      return;
    }

    this.consentAnswered = true;
    if (result === UCP_RESULT_SUCCESS) {
      bleLog.debug('Beurer BF500: consent accepted, requesting a measurement');
      void this.startMeasurement(this.session);
    } else if (result === UCP_RESULT_NOT_AUTHORIZED) {
      bleLog.warn(
        'Beurer BF500: consent rejected (USER_NOT_AUTHORIZED). Check `users[].beurer_pin` ' +
          'and `users[].beurer_user_index` match the slot the scale was registered with.',
      );
    } else if (result === UCP_RESULT_OPERATION_FAILED) {
      bleLog.warn(
        `Beurer BF500: consent rejected (OPERATION_FAILED) for user index ${this.userIndex}. ` +
          'That slot does not exist on the scale, which is the state after the batteries were ' +
          'removed. Set `users[].beurer_register_new_user: true` and a `beurer_pin` for one run, ' +
          'then use the index the log reports.',
      );
    } else {
      bleLog.warn(`Beurer BF500: User Control Point rejected the consent (${name}).`);
    }
  }

  /** Drop the connection context when the session ends (#138). */
  onSessionEnd(): void {
    if (this.consentSent && !this.consentAnswered && !this.readingEmitted) {
      bleLog.warn(
        `Beurer BF500: the scale never answered the consent for user index ${this.userIndex}. ` +
          'Check the bond, the code and the slot.',
      );
    }
    if (!this.readingEmitted && this.cachedWeight > 0) {
      bleLog.warn(
        `Beurer BF500: the session ended with a weight (${this.cachedWeight.toFixed(2)} kg) ` +
          'but no usable body-composition values, so no reading was emitted.',
      );
    }
    this.ctx = undefined;
    this.cachedWeight = 0;
    this.cachedTimestamp = undefined;
    this.cachedUserIndex = undefined;
    this.cachedComp = {};
  }

  /**
   * Weight Measurement 0x2A9D, decoded by the shared SIG decoder.
   *
   * The kg/lb rule lives in the decoder because `normalizesWeight = true` makes
   * it a correctness requirement rather than a preference. What stays here is
   * the caching rule: a zero or non-finite weight must not overwrite a weight
   * this session already has, because the scale sends zeroed frames of its own.
   *
   * A real weight starts a NEW weigh-in, so it clears what the previous one
   * left behind: its composition, its time and its user slot (review C-01).
   * Each was otherwise inherited by this weight until its own 0x2A9C arrived: a
   * reading was emitted right here from the previous record's composition and
   * pinned to this weight, and when it was a live weigh-in the session ended on
   * it and exported somebody else's fat, water and impedance. A frame without a
   * time also kept the previous record's time.
   */
  private parseWeightMeasurement(data: Buffer): void {
    const { weightKg, timestamp, userIndex } = parseSigWeightMeasurement(data);
    if (weightKg !== undefined && weightKg > 0 && Number.isFinite(weightKg)) {
      this.cachedWeight = weightKg;
      this.cachedComp = {};
      this.cachedTimestamp = trustedScaleTime(timestamp);
      this.cachedUserIndex = userIndex;
    }
  }

  /** Body Composition Measurement 0x2A9C. */
  private parseBodyComposition(data: Buffer): void {
    if (data.length < 4) return;
    const flags = data.readUInt16LE(0);
    const isKg = (flags & 0x0001) === 0;
    // Same lb contract as parseWeightMeasurement: soft lean mass, body water
    // mass and the optional weight field are all masses, so they need the same
    // conversion or water% and bone come out wrong. Body fat is a percentage
    // and is unit-independent per the SIG BCS spec, so it stays unscaled.
    const massMul = isKg ? 0.005 : 0.01 * LBS_TO_KG;

    // Bounds-checked little-endian uint16 reader. Real BF720 frames are
    // well-formed, but a malformed/truncated notification can set flag bits
    // for fields it did not actually include. Returning null (instead of
    // throwing a RangeError out of the notification handler) lets parsing
    // stop gracefully and keep whatever was decoded so far.
    const u16 = (o: number): number | null => (o + 2 <= data.length ? data.readUInt16LE(o) : null);

    let off = 2;
    // Body Fat % is always present, immediately after the flags.
    const fat = u16(off);
    if (fat == null) return;

    // Placeholder frames. The BF788 capture in #229 carries 36 body-composition
    // indications for a single session and 35 of them are zeroed stubs
    // (`9803 0000 <bmr> 0000 0000 0000 0000`): every composition field is 0 and
    // only the basal-metabolism field varies. They are paired with the scale's
    // backfilled history frames, which the app discards.
    //
    // A zero body fat is physically impossible, so it is the reliable marker.
    // It must be rejected rather than cached: `buildReading()` gates on
    // `fat == null`, which 0 passes, and `computeMetrics()` then derives bone as
    // `leanBodyMass - softLean`, so a zeroed frame yields boneMass equal to the
    // entire body weight (verified: 117.92 kg of "bone" from this capture).
    //
    // Reset rather than merely skip. `cachedComp` is otherwise cleared only at
    // the session boundaries (onSessionStart, onSessionEnd) and by the next
    // real weight, so leaving a previously decoded real value in place would
    // stamp it onto a weight that is paired with this stub.
    // 0xFFFF is the SIG sentinel for "measurement unsuccessful / unavailable".
    // buildPayload does not clamp a scale-provided fat, so letting it through
    // would export 6553.5 % and a negative bone mass. Not observed on these
    // models, unlike the zeroed stubs, but it is the same class of fabrication.
    if (fat === 0 || fat === 0xffff) {
      this.cachedComp = {};
      return;
    }

    this.cachedComp.fat = fat * 0.1;
    off += 2;

    if (flags & 0x0002) {
      // Timestamp.
      const ts = trustedScaleTime(parseSigDateTime(data, off));
      if (ts) this.cachedTimestamp = ts;
      off += 7;
    }
    if (flags & 0x0004) {
      // User ID; 0xFF is the SIG "unknown user".
      if (off < data.length && data[off] !== 0xff) this.cachedUserIndex = data[off];
      off += 1;
    }
    if (flags & 0x0008) off += 2; // Basal Metabolism (kJ, unused)
    if (flags & 0x0010) {
      const muscle = u16(off); // Muscle %
      if (muscle == null) return;
      // Same rule the fat field above already applies: 0 and 0xFFFF are "no
      // measurement", not a measurement of zero. buildPayload guards muscle on
      // `!= null`, so a zero here exports 0 kg of muscle and a physique rating
      // computed from it. Only the fat was guarded, which shielded the observed
      // stubs (they zero both) but not a frame that zeroes only this one (#405).
      if (muscle !== 0 && muscle !== 0xffff) this.cachedComp.muscle = muscle * 0.1;
      off += 2;
    }
    if (flags & 0x0020) off += 2; // Muscle Mass (unused)
    if (flags & 0x0040) off += 2; // Fat Free Mass (unused)
    if (flags & 0x0080) {
      const softLean = u16(off); // Soft Lean Mass kg
      if (softLean == null) return;
      // Same rule again, and here it is the field with the worst failure mode:
      // bone is derived as leanBodyMass - softLean, so a zeroed soft lean mass
      // reports the entire lean mass as bone. That is the 117.92 kg of "bone"
      // this file's own comment above records from the #229 capture (#405).
      if (softLean !== 0 && softLean !== 0xffff) this.cachedComp.softLean = softLean * massMul;
      off += 2;
    }
    if (flags & 0x0100) {
      const waterMass = u16(off); // Body Water Mass kg
      if (waterMass == null) return;
      // buildPayload takes `comp.water ?? <estimate>`, so a zero here wins over
      // the estimate and exports 0 % body water.
      if (waterMass !== 0 && waterMass !== 0xffff) this.cachedComp.waterMass = waterMass * massMul;
      off += 2;
    }
    if (flags & 0x0200) {
      // Impedance, 0.1 ohm per LSB. Skipped as "unused" since this adapter was
      // written, on the reasoning that the scale supplies its own composition,
      // so every reading from a BF720, BF788 or BF950 has carried a false zero
      // (#354). It is not unused: the fields the scale does NOT supply are
      // derived downstream, and a real impedance moves them off the BMI-only
      // estimate onto the BIA equations.
      const impedance = u16(off);
      if (impedance == null) return;
      // 0xFFFF is the SIG "unavailable" sentinel, not 6553.5 ohm, and the
      // reading reports no impedance as 0 (D028, review C-11). `sig-bcs.ts`
      // has always applied this; this walk did not.
      if (impedance !== 0xffff) this.cachedComp.impedance = impedance * 0.1;
      off += 2;
    }
    if (flags & 0x0400) {
      const raw = u16(off); // Weight
      if (raw == null) return;
      const w = raw * massMul;
      if (w > 0 && Number.isFinite(w)) this.cachedWeight = w;
      off += 2;
    }
    // Remaining optional fields (Height, ...) are not needed.
  }

  /**
   * Emit a reading only once weight AND native body composition are both
   * known, mirroring openScale's weight/body-comp pairing. BF720 always sends
   * both characteristics per measurement, the weight first.
   *
   * The frame's own time goes on every reading, live or stored (D027): the
   * runtime, not this adapter, decides from its age whether it is a stored
   * record. The user slot goes on when the frames name one.
   */
  private buildReading(): ScaleReading | null {
    if (this.cachedWeight <= 0 || this.cachedComp.fat == null) return null;
    const reading: ScaleReading = {
      weight: this.cachedWeight,
      impedance: this.cachedComp.impedance ?? 0,
      // A snapshot: computeMetrics() runs once the session has resolved, when the
      // live cachedComp holds whatever came LAST, not what this reading was built
      // from (#394).
      scaleComposition: { ...this.cachedComp },
    };
    if (this.cachedTimestamp) reading.timestamp = this.cachedTimestamp;
    if (this.cachedUserIndex !== undefined) reading.userIndex = this.cachedUserIndex;
    this.readingEmitted = true;
    return reading;
  }

  isComplete(reading: ScaleReading): boolean {
    return reading.weight > 0;
  }

  computeMetrics(reading: ScaleReading, profile: UserProfile): BodyComposition {
    const { weight } = reading;
    // Per-reading snapshot taken in buildReading(). Falling back to the live
    // cache keeps direct callers (and tests) working for a reading this adapter
    // did not build.
    const c = (reading.scaleComposition as CachedComp | undefined) ?? this.cachedComp;
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
