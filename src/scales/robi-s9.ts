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
import { uuid16, buildPayload } from './body-comp-helpers.js';
import { bleLog } from '../ble/types.js';
import { isHutbitOemAdvert } from './lefu-signature.js';
import type { MatchDescriptor } from './match-descriptor.js';

// ─── Robi S9 (Lefu / Fitdays FFB0-new protocol) ─────────────────────────────

const CHR_FFB1 = uuid16(0xffb1); // write (handshake)
const CHR_FFB2 = uuid16(0xffb2); // notify (live frames)
const CHR_FFB3 = uuid16(0xffb3); // indicate (final result) - see binding note

/**
 * Captured handshake (#228 HCI snoop, Fitdays app). Replayed verbatim: the
 * 20-byte frames carry a trailer checksum whose algorithm is not cracked, plus a
 * unix-timestamp + token in the B1 frames, so regenerating them is unsafe. The
 * timestamp is therefore stale on replay; the scale appears to accept it for a
 * weigh-in. Order = seq 00..0a as the app sent them.
 */
const HANDSHAKE: string[] = [
  '000300b000000000000000000000000000000010',
  '011000b16a2eefa9003c01aa1e55b20f1b581403',
  '021000b16a2eefa9003c01aa1e55b20f1b581403',
  '030600b201aa1e55b20000000000000000000002',
  '040200bd09000000000000000000000000000006',
  '051000b16a2eefa9003c01aa1e55b20f1b581403',
  '061000b16a2eefa9003c01aa1e55b20f1b581403',
  '070600b201aa1e55b20000000000000000000002',
  '081000b16a2eefa9003c01aa1e55b20f1b581403',
  '090300b001000000000000000000000000000011',
  '0a0300b002000000000000000000000000000012',
];

// Weight is stored as a 3-byte big-endian gram count in the A3 result frame
// (#248: 01 2d c2 = 77250 g = 77.25 kg). The earlier #228 guess treated the high
// gram bytes (01 2c..) as a constant prefix because both prior captures were
// ~77 kg; they are not constant, they are the weight.
const WEIGHT_OFFSET = 5;
const WEIGHT_BYTES = 3;
const WEIGHT_DIV = 1000;

// Healthkeep S11 (same FFB0 family, Fitdays app) never sends an A3 frame. Its
// final result is a 35-byte A7 record on FFB3, split over three 20-byte
// packets whose byte 2 is the packet index (00, 01, 02). The first packet is
//   [seq][23][00][a7][unix ts u32 BE][1 byte][weight u24 BE grams][...]
// (the same layout as the Speediance FG2211WBF record). The record is never
// acknowledged, so the scale resends it every 10 s and can offer the record of
// an earlier weigh-in right after connecting. An A7 is therefore taken only
// when its weight equals the settled A2 weight of this session, and never when
// its stamp (the scale's real clock) equals the last one exported.
const A7_STAMP_OFFSET = 4;
const A7_WEIGHT_OFFSET = 9;
// A2 live frames: [seq][07][00][a2][state][00][weight u24 BE grams][...] (#248).
// State 01 while the weight settles, 03 once it is settled, 00 after stepping off.
const A2_STATE_OFFSET = 4;
const A2_STATE_SETTLED = 0x03;
const A2_WEIGHT_OFFSET = 6;

/** One weigh-in's state, replaced whole in onSessionStart (#394, SCALES.md). */
class RobiS9Session {
  /** Weight of the last settled A2 live frame, in grams (0 = none yet). */
  liveGrams = 0;
  cachedWeight = 0;
  cachedImpedance = 0;
  final = false;
}

/**
 * Adapter for the Robi S9 smart scale (Fitdays app, Lefu-style FFB0 protocol).
 *
 * Shares service 0xFFB0 with the openScale MGB family but speaks a different
 * 20-byte frame protocol (`[seq][len][00][type][payload][trailer]`): the phone
 * runs a B0/B1/B2/BD handshake on FFB1, the scale streams A2 live frames on FFB2
 * (notify) and the final result as an A3 frame on FFB3 (indicate). The MGB
 * adapter sent the wrong init and never subscribed FFB3, so the scale dropped
 * the link before any reading (#228).
 *
 * Decoded from the reporter's HCI snoop. The handshake (the fix for the
 * disconnect) is replayed verbatim; the weight scale is confirmed against a
 * known-weight capture (#248), but the impedance offset and the scrambled body
 * composition are not decoded yet (BIA is used instead).
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

  // FFB3 is physically an indicate characteristic, but the shared subscribe loop
  // only auto-subscribes bindings of type 'notify'. node-ble/noble enable
  // indications transparently from the char's real properties, so declare it
  // 'notify' to get it subscribed (same pattern as BeurerBf720).
  readonly characteristics: CharacteristicBinding[] = [
    { uuid: CHR_FFB1, type: 'write' },
    { uuid: CHR_FFB2, type: 'notify' },
    { uuid: CHR_FFB3, type: 'notify' },
  ];

  private s = new RobiS9Session();

  /**
   * Stamp of the last A7 record exported. De-duplication state, not session
   * state: it outlives sessions, and the runtime persists it through
   * {@link dedupMark} so it also outlives a restart. Compared for equality only,
   * so a scale whose clock was reset cannot block new readings.
   */
  private lastA7Stamp = 0;

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

  onSessionStart(): void {
    this.s = new RobiS9Session();
  }

  async onConnected(ctx: ConnectionContext): Promise<void> {
    for (const hex of HANDSHAKE) {
      await ctx.write(CHR_FFB1, Buffer.from(hex, 'hex'), true);
      await new Promise((r) => setTimeout(r, 150));
    }
    bleLog.debug('Robi S9: handshake sent');
  }

  parseCharNotification(_charUuid: string, data: Buffer): ScaleReading | null {
    if (data.length < 11 || data[2] !== 0x00) return null;
    bleLog.debug(`Robi S9 frame: ${data.toString('hex')}`);

    // Final result arrives as the A3 frame on FFB3. A2 (live) frames use a
    // different alignment and are treated as progress only. A3 layout:
    //   [seq][len][00][a3][flag][weight u24 BE grams][... trailer]
    if (data[3] === 0xa3) {
      const w = data.readUIntBE(WEIGHT_OFFSET, WEIGHT_BYTES) / WEIGHT_DIV;
      if (w > 0 && Number.isFinite(w)) {
        this.s.cachedWeight = w;
        // Impedance offset is not yet decoded: the only captured A3 frame has
        // all-zero bytes after the weight. Emit 0 (BIA fallback) rather than a
        // guessed offset that could surface garbage; pin it from a future
        // known-impedance DEBUG capture (#248).
        this.s.cachedImpedance = 0;
        this.s.final = true;
      }
    }

    if (
      data[3] === 0xa2 &&
      data[A2_STATE_OFFSET] === A2_STATE_SETTLED &&
      data.length >= A2_WEIGHT_OFFSET + WEIGHT_BYTES
    ) {
      const grams = data.readUIntBE(A2_WEIGHT_OFFSET, WEIGHT_BYTES);
      if (grams > 0) this.s.liveGrams = grams;
    }

    // Healthkeep S11: final result as the first packet of the A7 record.
    if (data[3] === 0xa7 && data.length >= A7_WEIGHT_OFFSET + WEIGHT_BYTES) {
      const grams = data.readUIntBE(A7_WEIGHT_OFFSET, WEIGHT_BYTES);
      const stamp = data.readUInt32BE(A7_STAMP_OFFSET);
      if (stamp !== 0 && stamp === this.lastA7Stamp) {
        bleLog.debug(`Robi S9: A7 record ${stamp} was already exported, ignoring it`);
      } else if (grams === 0 || grams !== this.s.liveGrams) {
        bleLog.debug(
          `Robi S9: A7 record (${grams} g) does not match this weigh-in (${this.s.liveGrams} g), ignoring it`,
        );
      } else {
        this.lastA7Stamp = stamp;
        this.s.cachedWeight = grams / WEIGHT_DIV;
        // The second A7 packet carries what look like per-segment impedances
        // (8-electrode scale), not decoded yet: BMI fallback as for A3.
        this.s.cachedImpedance = 0;
        this.s.final = true;
      }
    }

    if (this.s.final && this.s.cachedWeight > 0) {
      return { weight: this.s.cachedWeight, impedance: this.s.cachedImpedance };
    }
    return null;
  }

  /** Legacy single-char path (unused in multi-char mode, kept for the interface). */
  parseNotification(data: Buffer): ScaleReading | null {
    return this.parseCharNotification(CHR_FFB2, data);
  }

  isComplete(reading: ScaleReading): boolean {
    return reading.weight > 0 && this.s.final;
  }

  /** The stamp of the last exported A7 record, for the runtime to persist. */
  dedupMark(): number | undefined {
    return this.lastA7Stamp || undefined;
  }

  /**
   * Restore a stamp persisted by an earlier process. Only a value that can be a
   * u32 A7 stamp is taken; anything else is ignored.
   */
  restoreDedupMark(mark: number): void {
    if (!Number.isInteger(mark) || mark <= 0 || mark > 0xffffffff) return;
    this.lastA7Stamp = mark;
  }

  computeMetrics(reading: ScaleReading, profile: UserProfile): BodyComposition {
    // NOT BIA, despite what this comment used to say. `parseCharNotification`
    // emits `impedance: 0` on purpose: the only captured A3 frame has all-zero
    // bytes after the weight, so there is no impedance offset to read yet
    // (#248). The vendor's own body-comp frames are scrambled and not decoded
    // either, so body composition here is the Deurenberg BMI estimate and will
    // stay that way until someone posts a capture with a known impedance.
    //
    // Listed in #386 as an adapter that reads an impedance and ignores it. It
    // does not read one.
    return buildPayload(reading.weight, reading.impedance, {}, profile);
  }
}
