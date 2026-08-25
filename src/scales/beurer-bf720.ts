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
import { bleLog } from '../ble/types.js';
import type { MatchDescriptor } from './match-descriptor.js';

// ─── Beurer SIG-standard adapter (BF720, BF105) ─────────────────────────────

// Standard SIG characteristics.
const CHR_WEIGHT_MEASUREMENT = uuid16(0x2a9d); // Weight Scale Service 0x181D
const CHR_BODY_COMPOSITION = uuid16(0x2a9c); // Body Composition Service 0x181B
const CHR_USER_CONTROL_POINT = uuid16(0x2a9f); // User Data Service 0x181C
const CHR_DB_CHANGE_INCREMENT = uuid16(0x2a99); // User Data Service 0x181C
const CHR_CURRENT_TIME = uuid16(0x2a2b); // Current Time Service 0x1805
const CHR_DATE_OF_BIRTH = uuid16(0x2a85); // User Data Service 0x181C
const CHR_GENDER = uuid16(0x2a8c); // User Data Service 0x181C
const CHR_HEIGHT = uuid16(0x2a8e); // User Data Service 0x181C

// Beurer vendor characteristics on service 0xFFF0, proven from the #229 capture.
const CHR_VENDOR_USER_LIST = uuid16(0xfff2); // notify: one frame per user slot
const CHR_VENDOR_ACTIVITY = uuid16(0xfff3); // read/write: activity level

/** Render bytes as spaced lowercase hex for the diagnostic log lines. */
const hex = (b: Buffer | number[]): string =>
  Array.from(b)
    .map((v) => v.toString(16).padStart(2, '0'))
    .join(' ');

interface ProfileField {
  uuid: string;
  label: string;
  /** True when the value the scale returned is a real, usable value. */
  isSet(v: Buffer): boolean;
  /** Bytes to write when the scale has nothing stored (#229 battery wipe). */
  fromProfile(p: UserProfile): number[];
}

/**
 * User Data characteristics the scale expects to be committed after consent,
 * in the order the Beurer app writes them (#229 capture, att.txt 1571-1579).
 * The order is load bearing, so this stays an array.
 *
 * `isSet` answers "does the scale already hold a real value here". It only
 * decides whether the provisioning path may fill the field in; a populated
 * profile is always written back byte for byte, exactly as before.
 */
const PROFILE_FIELDS: ProfileField[] = [
  {
    uuid: CHR_DATE_OF_BIRTH,
    label: 'date of birth',
    // Erased flash reads back as 0xff, so 0xffff must not pass as a year.
    isSet: (v) => {
      if (v.length < 4) return false;
      const year = v.readUInt16LE(0);
      return year >= 1900 && year <= new Date().getFullYear();
    },
    fromProfile: (p) => {
      // YYYY-MM-DD parses as UTC midnight, so read it back in UTC: the local
      // getters shift the day west of Greenwich.
      const born = p.birthDate ? new Date(p.birthDate) : null;
      if (born && !Number.isNaN(born.getTime())) {
        const y = born.getUTCFullYear();
        return [y & 0xff, (y >> 8) & 0xff, born.getUTCMonth() + 1, born.getUTCDate()];
      }
      // No birth date in the profile: anchor to 1 January of the derived year.
      const year = new Date().getFullYear() - Math.max(1, Math.round(p.age));
      return [year & 0xff, (year >> 8) & 0xff, 1, 1];
    },
  },
  {
    uuid: CHR_GENDER,
    label: 'gender',
    // Male is 0x00, so "non zero" would read a valid male profile as unset.
    // The cost is that a wiped scale returning 0x00 is indistinguishable from a
    // real male profile and is therefore never provisioned. Accepted
    // deliberately: silently rewriting a valid profile is the worse failure.
    isSet: (v) => v.length >= 1 && v[0] <= 2,
    fromProfile: (p) => [p.gender === 'female' ? 1 : 0],
  },
  {
    uuid: CHR_HEIGHT,
    label: 'height',
    // Bounded for the same reason as the birth year: 0xffff is erased flash,
    // not a 655 metre person.
    isSet: (v) => {
      if (v.length < 2) return false;
      const cm = v.readUInt16LE(0);
      return cm >= 50 && cm <= 250;
    },
    fromProfile: (p) => {
      const cm = Math.max(1, Math.round(p.height));
      return [cm & 0xff, (cm >> 8) & 0xff];
    },
  },
  {
    uuid: CHR_VENDOR_ACTIVITY,
    label: 'activity level',
    isSet: (v) => v.length >= 1 && v[0] > 0 && v[0] < 0xff,
    // 0x03 is the value the reporter's own app had stored on this exact BF788
    // (#229 capture). It is not derived from anything in UserProfile.
    fromProfile: () => [0x03],
  },
];

// SIG service UUIDs (normalized 128-bit lowercase form, same as the BLE layer
// produces via normalizeUuid). Used to corroborate a bare Beurer company id so
// the adapter does not shadow the older name-based Beurer/Sanitas adapters.
const SVC_WEIGHT_SCALE = uuid16(0x181d);
const SVC_BODY_COMPOSITION = uuid16(0x181b);

// Beurer GmbH SIG-assigned company identifier (advertisement manufacturer data).
const BEURER_COMPANY_ID = 0x0611;

// User Control Point opcodes (subset).
/**
 * SIG User Data Service "Register New User": `01 <consent code u16 LE>`.
 *
 * A SIG user record exists ONLY after this operation. The profiles created in
 * the scale's own SET menu are display-side records for its body-composition
 * maths and are NOT SIG users, so on a scale whose user was registered by the
 * vendor app, Consent can never succeed from another client whatever code is
 * supplied: there is no record that client is entitled to. Established on a
 * BF915 in #335, where all three slots answered USER_NOT_AUTHORIZED with every
 * code tried, on a link that bonded and subscribed cleanly.
 *
 * The scale answers with the index it assigned, which is what the user then
 * puts in `users[].beurer_user_index`.
 */
const UCP_REGISTER_NEW_USER = 0x01;
const UCP_CONSENT = 0x02;
const UCP_RESPONSE = 0x20;
const UCP_RESULT_SUCCESS = 0x01;
const UCP_RESULT_NOT_AUTHORIZED = 0x05;

/** User Control Point result codes, so a log line names the failure. */
const UCP_RESULTS: Record<number, string> = {
  0x01: 'SUCCESS',
  0x02: 'OP_CODE_NOT_SUPPORTED',
  0x03: 'INVALID_PARAMETER',
  0x04: 'OPERATION_FAILED',
  0x05: 'USER_NOT_AUTHORIZED',
};

/**
 * Frames whose embedded timestamp is older than this are treated as cached
 * historical readings (routed into the back-dated replay path). BF720 stamps
 * every frame including the live weigh-in, so the age check is what separates
 * a live measurement (stamped "now") from the on-scale history dump (stamped
 * days ago).
 */
const HISTORY_MAX_AGE_MS = 5 * 60_000;

/** SIG mass fields are in lb when the frame's unit flag is set. */
const LBS_TO_KG = 0.453592;

interface CachedComp {
  fat?: number; // %
  muscle?: number; // %
  waterMass?: number; // kg
  softLean?: number; // kg
}

/**
 * Adapter for Beurer SIG-standard BLE scales (BF720, BF105, BF500, BF788, BF950).
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
export class BeurerBf720Adapter implements ScaleAdapterCore, GattWiring, MultiCharNotify {
  readonly name = 'Beurer BF720/BF105';
  readonly match: MatchDescriptor = {
    priority: 220,
    custom: true,
    names: { includes: ['bf720', 'bf105', 'bf500', 'bf788', 'bf950'] },
    serviceUuids: ['181d', '181b'],
    manufacturerId: 0x0611,
  };
  // Legacy single-char fallback (unused in multi-char mode).
  readonly charNotifyUuid = CHR_WEIGHT_MEASUREMENT;
  readonly charWriteUuid = CHR_CURRENT_TIME;
  readonly normalizesWeight = true;
  // SIG User Data Service (0x181C) CCCD writes need an encrypted link; the
  // node-ble handler attempts a best-effort bond before subscribing. #168
  readonly requiresBonding = true;

  readonly characteristics: CharacteristicBinding[] = [
    { uuid: CHR_WEIGHT_MEASUREMENT, type: 'notify' },
    { uuid: CHR_BODY_COMPOSITION, type: 'notify' },
    { uuid: CHR_USER_CONTROL_POINT, type: 'notify' },
    { uuid: CHR_DB_CHANGE_INCREMENT, type: 'notify', optional: true },
    // Vendor user-slot list. The scale answers the FFF2=00 command with one
    // frame per stored user, which the app requests on every connection (#229).
    { uuid: CHR_VENDOR_USER_LIST, type: 'notify', optional: true },
    { uuid: CHR_CURRENT_TIME, type: 'write' },
  ];

  private cachedWeight = 0;
  private cachedTimestamp: Date | undefined;
  private cachedComp: CachedComp = {};
  /**
   * The adapter instance is shared across GATT sessions, so the post-consent
   * profile sync is keyed on a session counter: a late consent response must
   * never write into a ConnectionContext that has already been torn down.
   */
  private ctx: ConnectionContext | undefined;
  private session = 0;
  private profileSyncDone = false;
  /** Scale user slot the consent applies to; used in the log lines. */
  private userIndex = 1;
  /** users[].beurer_register_new_user: create a SIG user record (#335). */
  private registerNewUser = false;
  /** users[].beurer_provision: write the profile into an empty scale (#229). */
  private provision = false;
  /** Vendor user-slot records seen on 0xFFF2 this session. */
  private userSlotsSeen = 0;
  /** Whether the vendor user list terminated (or reported an error) this session. */
  private userListAnswered = false;
  /** Latch so the "no stored users" hint is printed at most once per session. */
  private emptyListReported = false;
  /** Whether the scale accepted the consent code this session. */
  private consentAccepted = false;
  /**
   * Whether the scale answered the consent write at all this session, with any
   * result. Distinct from {@link consentAccepted}: a rejection is answered and
   * already warns, whereas silence produces no diagnostic of its own and is the
   * failure mode behind #83, #290 and #335. The session then ends as a bare
   * "disconnected before reading completed", which says nothing about consent.
   */
  private consentAnswered = false;
  /** Whether a consent write went out this session (gates the silence warning). */
  private consentSent = false;
  /** Whether a reading was emitted this session (gates the session-end warning). */
  private readingEmitted = false;
  /**
   * Field labels already warned about, for the process lifetime. In continuous
   * mode a scale with a legitimately empty field would otherwise print the same
   * four lines on every cycle, forever.
   */
  private readonly warnedFields = new Set<string>();
  /**
   * Composition as it stood when each reading was emitted. Weak so buffered
   * history readings do not pin memory once the processor drops them.
   */
  private readonly compByReading = new WeakMap<ScaleReading, CachedComp>();

  matches(device: BleDeviceInfo): boolean {
    const name = (device.localName || '').toLowerCase();
    // BF500 (#83), BF788 (#229) and BF950 (#255) speak the same SIG consent+bond
    // protocol as the BF720: consent write 02/userIndex/pinLE on the User Control
    // Point 0x2A9F, weight on 0x2A9D, native body composition on 0x2A9C.
    //
    // BF788 is proven from the HCI snoop attached to #229: the app writes
    // `02 01 d8 09` to 0x2A9F (consent, user 1, PIN 2520 little-endian) and the
    // scale indicates `20 02 01` (response to op 0x02, success), which is what
    // this adapter emits byte for byte. A wrong PIN indicates `20 02 05` instead.
    // The link is bonded first (SMP pairing then ENCRYPTION_CHANGE then LTK
    // distribution), confirming requiresBonding below.
    //
    // BF950 is evidenced by the log in #255: it advertises the exact name
    // "BF950" and its discovered characteristics include the same SIG set
    // (0x2A9F/0x2A9D/0x2A9C/0x2A9B/0x2A9E/0x2A99/0x2A9A). The User Control Point
    // is the discriminator here: a plain BCS/WSS scale has no User Data service.
    //
    // Without this name routing they fall to Standard GATT, which sends a code-0
    // consent on an unbonded link and reads nothing, which is precisely the
    // "subscribed, then timed out" loop both reporters saw. On Linux
    // auto-discovery the advertised service UUIDs and manufacturer data are often
    // absent, so the name is what routes them here. Reading still needs the
    // per-device beurer_pin and a bonded link, so the ESPHome proxy path
    // (unbonded) is expected to need the native handler instead.
    if (
      name.includes('bf720') ||
      name.includes('bf105') ||
      name.includes('bf500') ||
      name.includes('bf788') ||
      name.includes('bf950')
    ) {
      return true;
    }
    // Everything below is the NAMELESS fallback: Linux auto-discovery and the
    // proxy transports often deliver no local name, and this is how a Beurer
    // still reaches the right adapter there. A device that DID advertise a name
    // has already had its chance above, so bow out and let the lower-priority
    // name-based Beurer / Sanitas adapters take it.
    //
    // Without this gate the adapter hijacks its own siblings. The company id is
    // shared across the whole Beurer range, and the SIG-service requirement
    // below is free post-connect since every SIG scale exposes 0x181B. So a
    // MAC-pinned Sanitas SBF72 (which reaches matches() with a name, discovered
    // services and manufacturer data) would be claimed here at priority 220
    // instead of by Sanitas SBF72/73 at 170, and then hard-fail asking for a
    // consent PIN it does not use. See the test below.
    if (name) return false;

    if (device.manufacturerData?.id !== BEURER_COMPANY_ID) return false;
    // A bare company id is too weak: this adapter is ordered ahead of the
    // name-based Beurer/Sanitas adapters, so require a SIG WSS/BCS service
    // (advertised or, on the connect path, discovered) before claiming it.
    // Accept both short (advertised) and full (discovered) UUID forms.
    const isSig = (u: string) => {
      const n = u.toLowerCase().replace(/-/g, '');
      return n === SVC_WEIGHT_SCALE || n === SVC_BODY_COMPOSITION || n === '181d' || n === '181b';
    };
    return (
      (device.serviceUuids ?? []).some(isSig) ||
      (device.serviceData ?? []).some((sd) => isSig(sd.uuid))
    );
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
        'Beurer BF720/BF105/BF500/BF788/BF950 needs a consent PIN. Set `users[].beurer_pin` in config.yaml ' +
          '(the code the scale was paired with in the Beurer / openScale app, or shown on ' +
          "the scale's control unit). If the scale was factory reset or had its batteries " +
          'removed, every user slot and its code are gone; try `beurer_pin: 0`.',
      );
    }
    const userIndex = ctx.scaleAuth?.userIndex ?? 1;

    // Reset per-connection state (adapter instance is shared across sessions).
    this.cachedWeight = 0;
    this.cachedTimestamp = undefined;
    this.cachedComp = {};
    this.session += 1;
    this.ctx = ctx;
    this.profileSyncDone = false;
    this.userIndex = userIndex;
    this.registerNewUser = ctx.scaleAuth?.registerNewUser === true;
    this.provision = ctx.scaleAuth?.provision === true;
    this.userSlotsSeen = 0;
    this.userListAnswered = false;
    this.emptyListReported = false;
    this.consentAccepted = false;
    this.consentAnswered = false;
    this.consentSent = false;
    this.readingEmitted = false;

    await ctx.write(CHR_CURRENT_TIME, this.buildCurrentTime(), true);

    // Vendor user-slot query. The app sends this on every connection, between
    // the time write and the consent write, and the scale answers with one
    // frame per stored user (#229 capture). Purely informational for us, but it
    // keeps our sequence identical to the app's and names the slots in the log.
    if (ctx.availableChars.has(CHR_VENDOR_USER_LIST)) {
      try {
        await ctx.write(CHR_VENDOR_USER_LIST, [0x00], true);
      } catch (err) {
        bleLog.debug(`Beurer BF720: vendor user-list query failed: ${String(err)}`);
      }
    }

    if (this.registerNewUser) {
      // One-shot provisioning, opt-in and never automatic. It CREATES a record
      // on the device and the slots are finite, so doing it on every rejected
      // consent would fill the scale with orphans. The user turns it on once,
      // reads the assigned index out of the log, puts that in
      // `beurer_user_index`, and turns it off again.
      await ctx.write(
        CHR_USER_CONTROL_POINT,
        [UCP_REGISTER_NEW_USER, pin & 0xff, (pin >> 8) & 0xff],
        true,
      );
      this.consentSent = true;
      bleLog.info(
        `Beurer BF720: registering a new user with consent code ${pin}. ` +
          'This creates a record on the scale.',
      );
      return;
    }

    await ctx.write(
      CHR_USER_CONTROL_POINT,
      [UCP_CONSENT, userIndex & 0xff, pin & 0xff, (pin >> 8) & 0xff],
      true,
    );
    this.consentSent = true;
    bleLog.debug(`Beurer BF720: consent sent for user index ${userIndex}`);
  }

  /**
   * Read the scale's stored user data back and commit it unchanged, then bump
   * the Database Change Increment.
   *
   * The #229 capture shows the Beurer app doing exactly this immediately after
   * the consent is accepted, and only afterwards does the scale send a real
   * body-composition frame: every frame before the commit carries zeroed
   * composition fields. Writing back the bytes we just read keeps the user's
   * on-scale profile intact; we are signalling "profile confirmed", not
   * changing it.
   */
  private async syncUserProfile(session: number): Promise<void> {
    const ctx = this.ctx;
    if (!ctx || session !== this.session || this.profileSyncDone) return;
    this.profileSyncDone = true;
    try {
      // Every read and write is isolated: only the BF788 is proven from a
      // capture, and on a sibling model one locked-down or read-only
      // characteristic must not cost us the increment below, which is the step
      // the scale actually waits for.
      const values = new Map<string, Buffer | number[]>();
      let provisioned = 0;
      for (const field of PROFILE_FIELDS) {
        if (!ctx.availableChars.has(field.uuid)) continue;
        if (session !== this.session) return;
        let stored: Buffer | null = null;
        try {
          stored = await ctx.read(field.uuid);
        } catch (err) {
          bleLog.debug(`Beurer BF720: profile read ${field.uuid} rejected: ${String(err)}`);
          // Never write into a characteristic we were not allowed to read: an
          // unreadable field is not the same thing as an empty one.
          continue;
        }
        bleLog.debug(`Beurer BF720: stored ${field.label} = [${hex(stored)}]`);
        // The write-back itself is unconditional, exactly as before this option
        // existed. Provisioning changes the BYTES, never whether the field is
        // committed: the scale waits for the full sequence, and dropping a write
        // on an install that never opted in would be an undeclared change.
        if (stored.length > 0 && field.isSet(stored)) {
          values.set(field.uuid, stored);
        } else if (this.provision) {
          const filled = field.fromProfile(ctx.profile);
          values.set(field.uuid, filled);
          provisioned += 1;
          bleLog.info(
            `Beurer BF720: the scale has no stored ${field.label} for user ` +
              `${this.userIndex}; writing the value from config.yaml [${hex(filled)}]`,
          );
        } else {
          values.set(field.uuid, stored);
          this.warnUnsetFieldOnce(field.label);
        }
      }
      let written = 0;
      for (const [uuid, value] of values) {
        if (session !== this.session) return;
        try {
          await ctx.write(uuid, value, true);
          written += 1;
        } catch (err) {
          bleLog.debug(`Beurer BF720: profile write ${uuid} rejected: ${String(err)}`);
        }
      }
      // The increment is the step the scale actually waits for, so its outcome
      // is reported in the commit line rather than inferred. It also gets its
      // own try/catch: a rejection here used to throw past the commit line
      // entirely, so a log without that line and a log with a failed increment
      // looked identical (#229).
      let increment = 'absent';
      if (ctx.availableChars.has(CHR_DB_CHANGE_INCREMENT)) {
        if (session !== this.session) return;
        try {
          await ctx.write(CHR_DB_CHANGE_INCREMENT, [0x01, 0x00, 0x00, 0x00], true);
          increment = 'written';
        } catch (err) {
          increment = 'rejected';
          bleLog.debug(`Beurer BF720: change increment rejected: ${String(err)}`);
        }
      }
      bleLog.debug(
        `Beurer BF720: user profile committed (${written}/${values.size} characteristics ` +
          `written, ${provisioned} from config, change increment ${increment}); ` +
          'scale can complete the measurement',
      );
    } catch (err) {
      // Never fail the reading over this: on firmware that does not need the
      // commit, the measurement arrives regardless.
      bleLog.debug(`Beurer BF720: user profile sync failed: ${String(err)}`);
    }
  }

  /** Decode one vendor user-slot frame (diagnostics only, never a reading). */
  private handleUserListFrame(data: Buffer): void {
    if (data.length === 0) return;
    if (data[0] === 0x01) {
      bleLog.debug('Beurer BF720: end of user-slot list');
      this.userListAnswered = true;
      this.reportEmptyUserList();
      return;
    }
    if (data[0] === 0x00) {
      // A truncated record still proves a slot exists; only its layout is
      // unknown. Counting it is what stops the "no stored users" hint firing on
      // a scale that plainly has one.
      this.userSlotsSeen += 1;
      if (data.length < 12) {
        bleLog.debug(`Beurer BF720: short user-slot record (${data.length}B), not decoded`);
        return;
      }
      const slot = data[1];
      const year = data.readUInt16LE(5);
      const height = data[9];
      // byte 10 was labelled gender, but the #229 capture has 0x01 here while
      // the same device's 0x2A8C reads back 0x00 (male). Report it raw.
      bleLog.debug(
        `Beurer BF720: user slot ${slot} (born ${year}-${data[7]}-${data[8]}, ${height} cm, ` +
          `raw10=0x${data[10].toString(16).padStart(2, '0')}, activity ${data[11]})`,
      );
      return;
    }
    // An unrecognised status byte still means the scale answered and named no
    // slot. On its own that is weak evidence, which is why reportEmptyUserList
    // also requires the consent to have been refused before it says anything.
    bleLog.debug(`Beurer BF720: user-list status 0x${data[0].toString(16).padStart(2, '0')}`);
    this.userListAnswered = true;
    this.reportEmptyUserList();
  }

  /** Warn once per process that a profile field came back empty. */
  private warnUnsetFieldOnce(label: string): void {
    if (this.warnedFields.has(label)) return;
    this.warnedFields.add(label);
    bleLog.warn(
      `Beurer BF720: the scale has no stored ${label} for user ${this.userIndex}. ` +
        'Set `users[].beurer_provision: true` to write it from config.yaml.',
    );
  }

  /**
   * Say plainly that the scale holds no user profiles at all (#229).
   *
   * Removing the batteries wipes every slot and its consent code, so no code
   * the scale was previously paired with can be correct, and the bare
   * USER_NOT_AUTHORIZED warning sends people hunting for the right PIN.
   */
  private reportEmptyUserList(): void {
    if (this.emptyListReported || !this.userListAnswered || this.userSlotsSeen > 0) return;
    // A scale that accepted the consent code is working. Telling that user to
    // switch to beurer_pin 0 would break a setup that reads fine today.
    //
    // The combination is still worth stating plainly, because it is a state the
    // SIG characteristics cannot show: those read back as fully populated once
    // provisioning has written them, while the vendor user table stays empty.
    // A scale that accepts the consent, reports no slot and then never sends a
    // measurement is in exactly that state (#229).
    if (this.consentAccepted) {
      this.emptyListReported = true;
      bleLog.debug(
        'Beurer BF720: the consent was accepted but the scale named no stored user slot, ' +
          'so its vendor user table is empty',
      );
      return;
    }
    this.emptyListReported = true;
    bleLog.warn(
      'Beurer BF720: the scale reports no stored user profiles. Removing the batteries ' +
        'wipes every user slot and its consent code, so no code the scale was previously ' +
        'paired with can be correct. On a scale in that state, try `users[].beurer_pin: 0`, ' +
        'and set `users[].beurer_provision: true` to write the profile back from config.yaml.',
    );
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
    // data[1] echoes the request opcode. Without this gate a response to some
    // other operation was read as a consent result.
    if (data[1] === UCP_REGISTER_NEW_USER) {
      this.consentAnswered = true;
      const result = data[2];
      if (result !== UCP_RESULT_SUCCESS) {
        const why = UCP_RESULTS[result] ?? `0x${result.toString(16).padStart(2, '0')}`;
        bleLog.warn(
          `Beurer BF720: the scale refused to register a new user (${why}). ` +
            'Its user slots may all be occupied; free one in the scale menu and retry.',
        );
        return;
      }
      // The assigned index follows the result byte. It is what makes this
      // useful: without it the caller has no way to know which slot to consent
      // to next, and searching costs a re-bond per attempt on some models.
      const assigned = data.length > 3 ? data[3] : undefined;
      this.userIndex = assigned ?? this.userIndex;
      bleLog.info(
        `Beurer BF720: registered a new user${assigned != null ? ` at index ${assigned}` : ''}. ` +
          `Set 'users[].beurer_user_index: ${assigned ?? '<index>'}' and turn ` +
          "'beurer_register_new_user' back off, or the next run registers another one.",
      );
      this.consentAccepted = true;
      void this.syncUserProfile(this.session);
      return;
    }
    if (data[1] !== UCP_CONSENT) {
      bleLog.debug(
        `Beurer BF720: User Control Point response to opcode ` +
          `0x${data[1].toString(16).padStart(2, '0')}, ignored`,
      );
      return;
    }
    this.consentAnswered = true;
    const result = data[2];
    const name = UCP_RESULTS[result] ?? `0x${result.toString(16).padStart(2, '0')}`;
    if (result === UCP_RESULT_SUCCESS) {
      this.consentAccepted = true;
      bleLog.debug('Beurer BF720: consent accepted, awaiting measurement');
      void this.syncUserProfile(this.session);
    } else if (result === UCP_RESULT_NOT_AUTHORIZED) {
      bleLog.warn(
        'Beurer BF720: consent rejected (USER_NOT_AUTHORIZED). Check `users[].beurer_pin` ' +
          'and `users[].beurer_user_index` match the slot the scale was paired with.',
      );
    } else {
      bleLog.warn(`Beurer BF720: User Control Point rejected the consent (${name}).`);
    }
    // The vendor user list can answer either side of this indication, so both
    // paths ask; reportEmptyUserList is latched and only fires once it knows.
    this.reportEmptyUserList();
  }

  /**
   * Drop the connection context when the session ends (#138).
   *
   * Deliberately does NOT bump `session`: cleanup() runs from finishWith while
   * the link is still up, and syncUserProfile re-checks the session before
   * every await, so bumping it could abort a commit half way and leave the
   * profile written but the increment not bumped. The loop snapshots ctx into a
   * local, so an in-flight commit still finishes.
   */
  onSessionEnd(): void {
    // Consent written and never answered. The scale says nothing at all in this
    // case, so without this line the session ends as a plain "disconnected
    // before reading completed" and the consent is not even implicated, let
    // alone the slot. A wrong slot is indistinguishable from a wrong code and
    // from the scale being asleep, and all three have been reported as "the
    // adapter receives nothing" (#83, #290, #335).
    //
    // The slot is worth naming because it is the half people do not think to
    // check: a vendor-app trace of a BF950 addresses user index 2, while this
    // adapter defaults to 1, and a profile that was ever recreated or shared
    // with a second person is unlikely to sit first in the scale's own list.
    if (this.consentSent && !this.consentAnswered) {
      bleLog.warn(
        `Beurer BF720: the scale never answered the consent for user index ` +
          `${this.userIndex}. It rejects nothing and reports nothing in this state, so a ` +
          `wrong slot looks exactly like a wrong code. If the code is right, try ` +
          `users[].beurer_user_index 2 and then 3: the slot is the position your profile ` +
          `occupies in the scale's own user list, which is not always the first.`,
      );
    }
    // Only when nothing was emitted at all. cachedComp is reset by every zeroed
    // composition stub, so testing it alone would fire on a successful session
    // that happened to end with a stub.
    if (!this.readingEmitted && this.cachedWeight > 0) {
      bleLog.warn(
        `Beurer BF720: the session ended with a weight (${this.cachedWeight.toFixed(2)} kg) ` +
          'but no usable body-composition values, so no reading was emitted. Either no ' +
          'composition frame arrived or every one of them was zeroed. Please report this ' +
          'log on issue #229.',
      );
    }
    // Clearing the cache here, not only in onConnected, matters: multi-char
    // subscriptions are enabled before onConnected is awaited, so a frame from
    // the next session could otherwise be parsed against this session's values
    // and inherit its composition snapshot and timestamp.
    this.ctx = undefined;
    this.cachedWeight = 0;
    this.cachedTimestamp = undefined;
    this.cachedComp = {};
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

    // `normalizesWeight = true` promises the shared layer that whatever comes
    // out of here is already kg, so it skips its own conversion. An lb frame
    // (flags bit 0) must therefore be converted here or pounds are exported as
    // kilograms, a 2.2x error. The sibling standard-gatt adapter, which parses
    // these identical SIG frames, has always done this.
    const weight = data.readUInt16LE(1) * (isKg ? 0.005 : 0.01 * LBS_TO_KG);
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
    // Reset rather than merely skip. `cachedComp` is cleared only in
    // onConnected(), so leaving a previously decoded real value in place would
    // stamp the live weigh-in's body fat onto every backdated history entry.
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
      const ts = this.parseTimestamp(data, off);
      if (ts) this.cachedTimestamp = ts;
      off += 7;
    }
    if (flags & 0x0004) off += 1; // User ID
    if (flags & 0x0008) off += 2; // Basal Metabolism (kJ, unused)
    if (flags & 0x0010) {
      const muscle = u16(off); // Muscle %
      if (muscle == null) return;
      this.cachedComp.muscle = muscle * 0.1;
      off += 2;
    }
    if (flags & 0x0020) off += 2; // Muscle Mass (unused)
    if (flags & 0x0040) off += 2; // Fat Free Mass (unused)
    if (flags & 0x0080) {
      const softLean = u16(off); // Soft Lean Mass kg
      if (softLean == null) return;
      this.cachedComp.softLean = softLean * massMul;
      off += 2;
    }
    if (flags & 0x0100) {
      const waterMass = u16(off); // Body Water Mass kg
      if (waterMass == null) return;
      this.cachedComp.waterMass = waterMass * massMul;
      off += 2;
    }
    if (flags & 0x0200) off += 2; // Impedance (unused; native comp)
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
   * both characteristics per measurement.
   */
  private buildReading(): ScaleReading | null {
    if (this.cachedWeight <= 0 || this.cachedComp.fat == null) return null;
    const reading: ScaleReading = { weight: this.cachedWeight, impedance: 0 };
    const histTs = this.historicalTimestamp(this.cachedTimestamp);
    if (histTs) reading.timestamp = histTs;
    // Snapshot the composition onto this specific reading. computeMetrics() runs
    // much later (the processor calls it per buffered frame once the session has
    // resolved), so reading the live cachedComp there would hand every history
    // entry whatever happened to be cached at the END of the session. With a
    // snapshot each reading keeps the composition it was actually built from.
    this.compByReading.set(reading, { ...this.cachedComp });
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
    const c = this.compByReading.get(reading) ?? this.cachedComp;
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
