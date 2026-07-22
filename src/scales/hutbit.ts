import type {
  BleDeviceInfo,
  CharacteristicBinding,
  ConnectionContext,
  ScaleAdapterCore,
  GattWiring,
  ScaleReading,
  UserProfile,
  BodyComposition,
} from '../interfaces/scale-adapter.js';
import { uuid16, buildPayload } from './body-comp-helpers.js';
import { bleLog } from '../ble/types.js';
import { isHutbitOemAdvert, LEFU_COMPANY_ID } from './lefu-signature.js';
import type { MatchDescriptor } from './match-descriptor.js';

// ─── Hutbit Smart Scale (Lefu / Fitdays FFB0 "AC02" 8-byte protocol) ─────────

const CHR_FFB1 = uuid16(0xffb1); // write (handshake, phone→scale)
const CHR_FFB2 = uuid16(0xffb2); // notify (weight stream, scale→phone)

/**
 * Handshake replayed on FFB1 (write-without-response) after enabling FFB2
 * notifications. Fixed 8-byte AC02 frames decoded from two Fitdays HCI snoops
 * (#254). Unlike the Robi S9's 20-byte protocol, every frame is a fixed
 * `AC 02 | D0 D1 D2 D3 | STATUS | CKSUM` with a plain additive checksum and NO
 * app-identity token, so the frames are stable and safe to replay verbatim.
 * `ac02fe060000ccd0` is the poll/keepalive the app repeats through the session.
 */
const HANDSHAKE: string[] = [
  'ac02fa010000ccc7',
  'ac02fb021fa5cc8d',
  'ac02fde20101ccad',
  'ac02fc010000ccc9',
  'ac02fe060000ccd0',
];

const FRAME_LEN = 8;
const FRAME_HEADER0 = 0xac;
const FRAME_HEADER1 = 0x02;
const STATUS_STABLE = 0xca; // final/stable reading (0xCE = measuring/unstable)
const WEIGHT_DIV = 10; // weight = u16 BE / 10 → kg

/** Additive checksum over D0..STATUS (bytes 2..6), matching the vendor frames. */
function frameChecksum(data: Buffer): number {
  return (data[2] + data[3] + data[4] + data[5] + data[6]) & 0xff;
}

/**
 * Adapter for the Hutbit Smart Scale (model 218008 / WL292, Fitdays app, Lefu
 * OEM). It shares service 0xFFB0 with the Robi S9 and openScale MGB families
 * but speaks a simpler, fixed 8-byte "AC02" protocol: after enabling FFB2
 * notifications the phone replays a short FFB1 handshake, then the scale streams
 * `AC 02 [weight_u16_BE] 00 00 [STATUS] [CKSUM]` frames on FFB2, where
 * STATUS 0xCE = measuring/unstable and 0xCA = stable/final. Weight = u16 / 10 kg.
 *
 * Decoded from two known-weight HCI snoops (#254): `ac0203490000ca16`
 * = 0x0349 = 841 → 84.1 kg. The unit's bioimpedance is unreliable (it reported
 * 0.4 to 0.7 % body fat), so it is treated as weight-only and body composition is
 * derived via the shared BIA/BMI pipeline, same as the Robi S9 / Renpho adapters.
 */
export class HutbitAdapter implements ScaleAdapterCore, GattWiring {
  readonly name = 'Hutbit';
  readonly match: MatchDescriptor = {
    priority: 35,
    custom: true,
    names: { includes: ['hutbit'] },
    serviceUuids: ['ffb0'],
    manufacturerId: LEFU_COMPANY_ID,
  };
  readonly charNotifyUuid = CHR_FFB2;
  readonly charWriteUuid = CHR_FFB1;
  readonly normalizesWeight = true;

  readonly characteristics: CharacteristicBinding[] = [
    { uuid: CHR_FFB1, type: 'write' },
    { uuid: CHR_FFB2, type: 'notify' },
  ];

  private final = false;

  matches(device: BleDeviceInfo): boolean {
    // Branded units advertise "Hutbit Scale". Lefu OEM stock units advertise a
    // generic name instead (observed: "SWAN", #278), and over the ESPHome proxy
    // the local name arrives empty entirely because it lives in the scan
    // response, so the name alone is not enough.
    if ((device.localName || '').toLowerCase().includes('hutbit')) return true;

    // OEM/rebranded units: claim on the advertisement fingerprint instead. This
    // deliberately does NOT claim the broader nameless FFB0 space; without the
    // fingerprint that space still belongs to the Robi S9 (FFB3 result char)
    // and the MGB fallback. RobiS9Adapter.matches() bows out to this exact
    // predicate, so the two must never drift apart (see lefu-signature.ts).
    return isHutbitOemAdvert(device);
  }

  async onConnected(ctx: ConnectionContext): Promise<void> {
    this.final = false;
    for (const hex of HANDSHAKE) {
      // Write without response: FFB1 is the Lefu/Fitdays FFB0 handshake char and
      // the family writes no-response. A char that advertises only
      // WRITE_NO_RESPONSE rejects a with-response write, so this is the safe mode
      // and matches the documented protocol above (#268 review).
      await ctx.write(CHR_FFB1, Buffer.from(hex, 'hex'), false);
      await new Promise((r) => setTimeout(r, 150));
    }
    bleLog.debug('Hutbit: handshake sent');
  }

  parseNotification(data: Buffer): ScaleReading | null {
    // Log every raw frame before any gate so a wrong shape/length is visible
    // (the `Hutbit frame:` line below only fires after the checksum gate). This
    // is what disambiguates "frames arrive but are rejected" from "frames never
    // arrive" on the ESPHome proxy transport (#291); mirrors QN / ADE-A2.
    bleLog.debug(`Hutbit RAW (${data.length}B): ${data.toString('hex')}`);

    // Fixed 8-byte AC02 weight frame: AC 02 [weight u16 BE] 00 00 [STATUS] [CKSUM]
    if (data.length !== FRAME_LEN) return null;
    if (data[0] !== FRAME_HEADER0 || data[1] !== FRAME_HEADER1) return null;
    if (frameChecksum(data) !== data[7]) return null;

    bleLog.debug(`Hutbit frame: ${data.toString('hex')}`);

    // Only the stable (0xCA) frame is a final reading; 0xCE frames are the live
    // settling stream and are treated as progress only.
    if (data[6] !== STATUS_STABLE) return null;

    const weight = data.readUInt16BE(2) / WEIGHT_DIV;
    if (!(weight > 0) || !Number.isFinite(weight)) return null;

    this.final = true;
    // Weight-only: the sensor's bioimpedance is unreliable, so emit impedance 0
    // and let the shared BIA/BMI pipeline derive body composition.
    return { weight, impedance: 0 };
  }

  isComplete(reading: ScaleReading): boolean {
    return reading.weight > 0 && this.final;
  }

  computeMetrics(reading: ScaleReading, profile: UserProfile): BodyComposition {
    // Body composition via the shared BMI/BIA fallback; the vendor's own
    // bioimpedance is unreliable and its body-comp frames are not decoded.
    return buildPayload(reading.weight, reading.impedance, {}, profile);
  }
}
