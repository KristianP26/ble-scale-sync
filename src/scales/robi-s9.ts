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
import {
  uuid16,
  buildPayload,
  biaFatIfPlausible,
  IMPEDANCE_MIN_OHM,
  IMPEDANCE_MAX_OHM,
} from './body-comp-helpers.js';
import { bleLog } from '../ble/types.js';
import { isHutbitOemAdvert } from './lefu-signature.js';
import type { MatchDescriptor } from './match-descriptor.js';

// ─── Robi S9 (Lefu / Fitdays FFB0-new protocol) ─────────────────────────────

const CHR_FFB1 = uuid16(0xffb1); // write (handshake)
const CHR_FFB2 = uuid16(0xffb2); // notify (live frames)
const CHR_FFB3 = uuid16(0xffb3); // indicate (final result) - see binding note
const ROBI_FRAME_LENGTH = 20;
const ROBI_TRAILER_MASK = 0x1f;
const ROBI_BA_CONSTANT = 0x78;
const ROBI_BA_TRAILER_CONSTANT = 0x2f;

/** The protocol keeps only the low five bits of this frame sum. */
export function robiS9Trailer(frame: Buffer): number {
  return frame.subarray(3, 19).reduce((sum, byte) => sum + byte, 0) & ROBI_TRAILER_MASK;
}

function withTrailer(frame: Buffer): Buffer {
  frame[19] = robiS9Trailer(frame);
  return frame;
}

function buildHandshake(profile: UserProfile, sequenceAnchor: number, now = new Date()): Buffer[] {
  const timestamp = Math.floor(now.getTime() / 1000);
  const timestampBytes = Buffer.alloc(4);
  timestampBytes.writeUInt32BE(timestamp >>> 0);
  const age = Math.max(0, Math.min(0x7f, Math.round(profile.age)));
  const profileByte = (profile.gender === 'male' ? 0x80 : 0) | age;

  const hello = Buffer.alloc(ROBI_FRAME_LENGTH);
  hello.set([0x00, 0x03, 0x00, 0xb0, sequenceAnchor & 0xff]);

  const config = Buffer.alloc(ROBI_FRAME_LENGTH);
  config.set([0x01, 0x10, 0x00, 0xba]);
  timestampBytes.copy(config, 4);
  config[8] = 0x00;
  config[9] = ROBI_BA_CONSTANT;
  config[14] = 0xac;
  config.writeUInt16BE(0x1770, 15);
  config[17] = 0x98;
  config[18] = ROBI_BA_TRAILER_CONSTANT;

  const user = Buffer.from(config);
  user[0] = 0x02;
  user[14] = Math.max(0, Math.min(255, Math.round(profile.height)));
  user.writeUInt16BE(0, 15);
  user[17] = profileByte;

  const userRepeat = Buffer.from(user);
  userRepeat[0] = 0x03;

  const close = Buffer.alloc(ROBI_FRAME_LENGTH);
  close.set([0x04, 0x03, 0x00, 0xb0, (sequenceAnchor + 4) & 0xff]);

  return [hello, config, user, userRepeat, close].map(withTrailer);
}

// Weight is stored as a 3-byte big-endian gram count in the A3 result frame
// (#248: 01 2d c2 = 77250 g = 77.25 kg). The earlier #228 guess treated the high
// gram bytes (01 2c..) as a constant prefix because both prior captures were
// ~77 kg; they are not constant, they are the weight.
const WEIGHT_OFFSET = 5;
const WEIGHT_BYTES = 3;
const WEIGHT_DIV = 1000;

/**
 * Adapter for the Robi S9 smart scale (Fitdays app, Lefu-style FFB0 protocol).
 *
 * Shares service 0xFFB0 with the openScale MGB family but speaks a different
 * 20-byte frame protocol (`[seq][len][00][type][payload][trailer]`): the phone
 * runs a `B0`/`BA` handshake on FFB1, the scale streams A2 live frames on FFB2
 * (notify) and the final result as an A3 frame on FFB3 (indicate). The MGB
 * adapter sent the wrong init and never subscribed FFB3, so the scale dropped
 * the link before any reading (#228).
 *
 * Weight and impedance offsets are decoded from a Fitdays capture.
 */
export class RobiS9Adapter implements ScaleAdapterCore, GattWiring, MultiCharNotify {
  readonly name = 'Robi S9';
  readonly match: MatchDescriptor = {
    priority: 40,
    custom: true,
    names: { includes: ['robi'] },
    serviceUuids: ['ffb0'],
    charUuids: ['ffb3'],
  };
  // Legacy single-char fields (unused in multi-char mode).
  readonly charNotifyUuid = CHR_FFB2;
  readonly charWriteUuid = CHR_FFB1;
  readonly normalizesWeight = true;

  // FFB3 is physically an indicate characteristic, but the shared subscribe loop
  // only auto-subscribes bindings of type 'notify'. node-ble/noble enable
  // indications transparently from the char's real properties, so declare it
  // 'notify' to get it subscribed (same pattern as BeurerBf720).
  // Order matches the app capture: it enables FFB3 (indicate) before FFB2
  // (notify), and the scale's very first ack (the A1 "ready" indicate) arrives
  // right after FFB3 is armed, before FFB2 is even subscribed.
  readonly characteristics: CharacteristicBinding[] = [
    { uuid: CHR_FFB1, type: 'write' },
    { uuid: CHR_FFB3, type: 'notify' },
    { uuid: CHR_FFB2, type: 'notify' },
  ];

  private cachedWeight = 0;
  private cachedImpedance = 0;
  private sequenceAnchor = 0;
  private final = false;

  matches(device: BleDeviceInfo): boolean {
    const name = (device.localName || '').toLowerCase();
    // Swan/Icomon/YG are the openScale MGB protocol, not this one.
    if (name.startsWith('swan') || name === 'icomon' || name === 'yg') return false;
    if (name.includes('robi')) return true;

    // Hutbit units expose an (unused) FFB3 too, and their local name does not
    // survive every transport (the ESPHome proxy delivers an empty name), so the
    // swan-name guard above cannot catch a rebranded Hutbit here. Bow out of the
    // Lefu OEM advertisement fingerprint before claiming nameless FFB0 (#278);
    // otherwise this adapter wins post-discovery re-resolution and replays a
    // handshake the Hutbit rejects. This MUST be the same predicate the Hutbit
    // claims on: bowing out of a wider set than the Hutbit takes would strand
    // the device on MGB, which cannot parse this family's frames.
    if (isHutbitOemAdvert(device)) return false;

    // Nameless: require the FFB0 vendor service AND the FFB3 result characteristic
    // (post-discovery) to disambiguate from MGB scales, which expose FFB1/FFB2
    // but not the FFB3 indicate result char.
    const uuids = (device.serviceUuids || []).map((u) => u.toLowerCase());
    const hasFfb0 = uuids.some((u) => u === 'ffb0' || u === uuid16(0xffb0));
    const chars = (device.characteristicUuids || []).map((u) => u.toLowerCase());
    const hasFfb3 = chars.some((u) => u === 'ffb3' || u === CHR_FFB3);
    return hasFfb0 && hasFfb3;
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
    this.cachedWeight = 0;
    this.cachedImpedance = 0;
    this.sequenceAnchor = 0;
    this.final = false;
  }

  async onConnected(ctx: ConnectionContext): Promise<void> {
    for (const frame of buildHandshake(ctx.profile, this.sequenceAnchor)) {
      await ctx.write(CHR_FFB1, frame, true);
      await new Promise((r) => setTimeout(r, 150));
    }
    bleLog.debug('Robi S9: handshake sent');
  }

  /**
   * A session that dies before `onConnected()` (e.g. a dropped subscribe)
   * leaves the previous reading cached, so the next connection's first
   * notification gets reported as a fresh result. So, reset here too.
   */
  onSessionEnd(): void {
    this.onSessionStart();
  }

  parseCharNotification(_charUuid: string, data: Buffer): ScaleReading | null {
    if (data.length < 11 || data[2] !== 0x00) return null;
    if (data.length === ROBI_FRAME_LENGTH && data[3] >= 0xa0 && data[3] <= 0xa3) {
      if (data[19] !== robiS9Trailer(data)) return null;
      if (data[3] === 0xa1) this.sequenceAnchor = data[0];
    }
    bleLog.debug(`Robi S9 frame: ${data.toString('hex')}`);

    // Final result arrives as the A3 frame on FFB3. A2 (live) frames use a
    // different alignment and are treated as progress only. A3 layout:
    //   [seq][len][00][a3][flag][weight u24 BE grams][... trailer]
    if (data[3] === 0xa3) {
      const w = data.readUIntBE(WEIGHT_OFFSET, WEIGHT_BYTES) / WEIGHT_DIV;
      if (w > 0 && Number.isFinite(w)) {
        this.cachedWeight = w;
        // Bytes 9-10 contain impedance in big-endian ohms.
        // Guarded to a plausible physiological range so a handshake that
        // still comes back all-zero (the #248 symptom) yields 0 -> BIA fallback.
        const imp = data.readUInt16BE(9);
        this.cachedImpedance = imp >= IMPEDANCE_MIN_OHM && imp <= IMPEDANCE_MAX_OHM ? imp : 0;
        this.final = true;
      }
    }

    if (this.final && this.cachedWeight > 0) {
      return { weight: this.cachedWeight, impedance: this.cachedImpedance };
    }
    return null;
  }

  /** Legacy single-char path (unused in multi-char mode, kept for the interface). */
  parseNotification(data: Buffer): ScaleReading | null {
    return this.parseCharNotification(CHR_FFB2, data);
  }

  isComplete(reading: ScaleReading): boolean {
    return reading.weight > 0 && this.final;
  }

  computeMetrics(reading: ScaleReading, profile: UserProfile): BodyComposition {
    const fat = biaFatIfPlausible(reading.weight, reading.impedance, profile);
    return buildPayload(reading.weight, reading.impedance, { fat }, profile);
  }
}
