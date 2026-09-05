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
import { uuid16, buildPayload, computeBiaFat } from './body-comp-helpers.js';
import { bleLog } from '../ble/types.js';
import type { MatchDescriptor } from './match-descriptor.js';

// ─── Speediance FG2211WBF (SPEED_S_*, Lefu/Icomon OEM, FFB0 protocol) ────────
//
// Sibling of the Robi S9 (same 0xFFB0 service, same 20-byte
// [seq][len][part][type][payload][checksum] framing). The difference that
// matters: the Speediance/Fitdays app arms the impedance phase with `b8`
// (timestamped identity) and `b4` frames that the Robi handshake lacks, so the
// Robi adapter gets weight-only. This handshake is the real app's 16 ffb1
// writes, replayed VERBATIM from a PacketLogger capture (tools/decode-capture.py,
// tools/speediance-analysis.md). The 20-byte checksum is not cracked; the scale
// accepts the stale replay (same as Robi), so regenerating frames is unneeded.
//
// With the full handshake the scale returns a populated `a7` multi-part result
// whose part-00 carries weight (u24 BE grams @ off 9, known-good) and a
// whole-body impedance (u16 LE @ off 15). Per-limb segmental impedances ride
// part-01 and are not decoded yet (whole-body BIA does not need them).

const CHR_FFB1 = uuid16(0xffb1); // write (handshake)
const CHR_FFB2 = uuid16(0xffb2); // notify (live frames)
const CHR_FFB3 = uuid16(0xffb3); // indicate (result)

const HANDSHAKE: string[] = [
  '000300b000000000000000000000000000000010',
  '011a00b86a96d1e880f001ac17709813880f0017',
  '011a010000000669636f6d6f6e0000000000000b',
  '021a00b86a96d1e880f001b11770ac13880f0030',
  '021a010000000669636f6d6f6e0000000000002b',
  '035200bd074f68747470733a2f2f617069322e38',
  '035201737065656469616e63652e636f6d2f612e',
  '03520270692f6d6f62696c652f626f6479466124',
  '035203744d6561737572656d656e742f72657030',
  '0352046f72743f70726f746f636f6c3d3326732f',
  '0352056e3d00000000000000000000000000002b',
  '041a00b86a96d1e880f001b141a0ac13880f002a',
  '041a010000000669636f6d6f6e0000000000002b',
  '051500b40101b141a0ac13880f0000000006692d',
  '051501636f6d6f6e00000000000000000000003c',
  '060300b04d00000000000000000000000000003d',
];

const WEIGHT_OFFSET = 9;
const WEIGHT_BYTES = 3;
const WEIGHT_DIV = 1000;
const IMPEDANCE_OFFSET = 15; // u16 LE

/**
 * Plausible whole-body BIA range, ohms.
 *
 * The capture's value at IMPEDANCE_OFFSET is 3022, which is not a whole-body
 * figure: the Hutbit adapter established this same 150 to 1200 range in #322
 * after a unit started publishing nonsense. Two uint16 LE values sit next to
 * each other in the A7 frame, 3022 and 2967, and both land inside the range
 * once divided by ten, so the field is probably right and the scaling probably
 * is not. That is a hypothesis, and this project does not ship impedance on a
 * hypothesis, so out-of-range values are dropped and body composition falls
 * back to the BMI estimate rather than being computed from a number that is
 * plausibly off by a factor of ten. Settling the divisor needs one weigh-in
 * with the vendor app's own body-fat figure to check against (#383).
 */
const IMPEDANCE_MIN_OHM = 150;
const IMPEDANCE_MAX_OHM = 1200;

export class SpeedianceAdapter implements ScaleAdapterCore, GattWiring, MultiCharNotify {
  readonly name = 'Speediance';
  readonly match: MatchDescriptor = {
    // Above Robi S9 (40): a SPEED_S_* unit must not be claimed by the Robi
    // handshake, which would strand it on weight-only.
    priority: 45,
    custom: true,
    names: { includes: ['speed_s', 'speediance'] },
    serviceUuids: ['ffb0'],
    charUuids: ['ffb3'],
  };
  readonly charNotifyUuid = CHR_FFB2;
  readonly charWriteUuid = CHR_FFB1;
  readonly normalizesWeight = true;

  readonly characteristics: CharacteristicBinding[] = [
    { uuid: CHR_FFB1, type: 'write' },
    { uuid: CHR_FFB2, type: 'notify' },
    { uuid: CHR_FFB3, type: 'notify' }, // physically indicate; declared notify to get subscribed (see Robi note)
  ];

  private cachedWeight = 0;
  private cachedImpedance = 0;
  private final = false;

  matches(device: BleDeviceInfo): boolean {
    const name = (device.localName || '').toLowerCase();
    return name.startsWith('speed_s') || name.includes('speediance');
  }

  async onConnected(ctx: ConnectionContext): Promise<void> {
    this.cachedWeight = 0;
    this.cachedImpedance = 0;
    this.final = false;
    for (const hex of HANDSHAKE) {
      await ctx.write(CHR_FFB1, Buffer.from(hex, 'hex'), true);
      await new Promise((r) => setTimeout(r, 150));
    }
    bleLog.debug('Speediance: handshake sent');
  }

  parseCharNotification(_charUuid: string, data: Buffer): ScaleReading | null {
    if (data.length < 12 || data[2] !== 0x00) return null; // part-00 frames only
    bleLog.debug(`Speediance frame: ${data.toString('hex')}`);

    // Final result: the a7 part-00 frame carries weight + whole-body impedance.
    if (data[3] === 0xa7) {
      const w = data.readUIntBE(WEIGHT_OFFSET, WEIGHT_BYTES) / WEIGHT_DIV;
      if (w > 0 && Number.isFinite(w)) {
        this.cachedWeight = w;
        const imp = data.readUInt16LE(IMPEDANCE_OFFSET);
        if (imp >= IMPEDANCE_MIN_OHM && imp <= IMPEDANCE_MAX_OHM) {
          this.cachedImpedance = imp;
        } else {
          this.cachedImpedance = 0;
          if (imp > 0) {
            bleLog.debug(
              `Speediance: impedance ${imp} is outside the ${IMPEDANCE_MIN_OHM} to ` +
                `${IMPEDANCE_MAX_OHM} ohm range, ignoring it (#383)`,
            );
          }
        }
        this.final = true;
      }
    }

    if (this.final && this.cachedWeight > 0) {
      return { weight: this.cachedWeight, impedance: this.cachedImpedance };
    }
    return null;
  }

  parseNotification(data: Buffer): ScaleReading | null {
    return this.parseCharNotification(CHR_FFB2, data);
  }

  isComplete(reading: ScaleReading): boolean {
    return reading.weight > 0 && this.final;
  }

  computeMetrics(reading: ScaleReading, profile: UserProfile): BodyComposition {
    // buildPayload does NOT run the BIA estimator; that is the caller's job, and
    // passing an empty comp here would silently produce the BMI estimate no
    // matter what the scale measured (#386). With the impedance gated above, a
    // value this adapter does not trust reaches here as 0 and the BMI fallback
    // is then the deliberate outcome rather than an accident.
    const fat =
      reading.impedance > 0 ? computeBiaFat(reading.weight, reading.impedance, profile) : undefined;
    return buildPayload(reading.weight, reading.impedance, { fat }, profile);
  }
}
