import type {
  BleDeviceInfo,
  CharacteristicBinding,
  ConnectionContext,
  ScaleAdapter,
  ScaleReading,
  UserProfile,
  BodyComposition,
} from '../interfaces/scale-adapter.js';
import { uuid16, buildPayload } from './body-comp-helpers.js';
import { bleLog } from '../ble/types.js';

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
export class RobiS9Adapter implements ScaleAdapter {
  readonly name = 'Robi S9';
  // Legacy single-char fields (unused in multi-char mode).
  readonly charNotifyUuid = CHR_FFB2;
  readonly charWriteUuid = CHR_FFB1;
  readonly normalizesWeight = true;
  readonly unlockCommand: number[] = [];
  readonly unlockIntervalMs = 0;

  // FFB3 is physically an indicate characteristic, but the shared subscribe loop
  // only auto-subscribes bindings of type 'notify'. node-ble/noble enable
  // indications transparently from the char's real properties, so declare it
  // 'notify' to get it subscribed (same pattern as BeurerBf720).
  readonly characteristics: CharacteristicBinding[] = [
    { uuid: CHR_FFB1, type: 'write' },
    { uuid: CHR_FFB2, type: 'notify' },
    { uuid: CHR_FFB3, type: 'notify' },
  ];

  private cachedWeight = 0;
  private cachedImpedance = 0;
  private final = false;

  matches(device: BleDeviceInfo): boolean {
    const name = (device.localName || '').toLowerCase();
    // Swan/Icomon/YG are the openScale MGB protocol, not this one.
    if (name.startsWith('swan') || name === 'icomon' || name === 'yg') return false;
    if (name.includes('robi')) return true;

    // Nameless: require the FFB0 vendor service AND the FFB3 result characteristic
    // (post-discovery) to disambiguate from MGB scales, which expose FFB1/FFB2
    // but not the FFB3 indicate result char.
    const uuids = (device.serviceUuids || []).map((u) => u.toLowerCase());
    const hasFfb0 = uuids.some((u) => u === 'ffb0' || u === uuid16(0xffb0));
    const chars = (device.characteristicUuids || []).map((u) => u.toLowerCase());
    const hasFfb3 = chars.some((u) => u === 'ffb3' || u === CHR_FFB3);
    return hasFfb0 && hasFfb3;
  }

  async onConnected(ctx: ConnectionContext): Promise<void> {
    this.cachedWeight = 0;
    this.cachedImpedance = 0;
    this.final = false;
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
        this.cachedWeight = w;
        // Impedance offset is not yet decoded: the only captured A3 frame has
        // all-zero bytes after the weight. Emit 0 (BIA fallback) rather than a
        // guessed offset that could surface garbage; pin it from a future
        // known-impedance DEBUG capture (#248).
        this.cachedImpedance = 0;
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
    // Body composition via BIA from weight + impedance; the vendor's own
    // body-comp frames are scrambled and not decoded.
    return buildPayload(reading.weight, reading.impedance, {}, profile);
  }
}
