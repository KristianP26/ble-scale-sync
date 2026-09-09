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
import { matchesDescriptor, type MatchDescriptor } from './match-descriptor.js';
import { bleLog } from '../ble/types.js';

// ─── Renpho R-MSC04 (55AA framed, vendor service 0x1A10) ────────────────────

const CHR_NOTIFY = uuid16(0x2a10); // live weight / status stream (cmd 0x21)
const CHR_WRITE = uuid16(0x2a11); // send the 55AA start command
const CHR_INDICATE = uuid16(0x2a12); // final measurement (cmd 0x24)

const HDR0 = 0x55;
const HDR1 = 0xaa;
const CMD_LIVE = 0x21; // live weight on 0x2A10
const CMD_FINAL = 0x24; // final weight on 0x2A12

// Header (2) + cmd (1) + length (2) + checksum (1) = 6 non-payload bytes.
const FRAME_OVERHEAD = 6;

// Start/unlock command, byte-identical to the ES-CS20M unlock, which is what
// makes the R-MSC04 begin streaming. Self-consistent 55AA frame (checksum 0x94).
const START_COMMAND = [0x55, 0xaa, 0x90, 0x00, 0x04, 0x01, 0x00, 0x00, 0x00, 0x94];

/**
 * Adapter for the Renpho R-MSC04 body-composition scale (#117, #265; sibling of
 * the R-MSC02 in #230).
 *
 * WEIGHT ONLY. The scale frames everything as
 *   55 AA | cmd(1) | length(2 BE) | payload(length) | checksum(1)
 * with checksum = (sum of every preceding byte) & 0xff. Live weight arrives as
 * cmd 0x21 on notify 0x2A10; the final settled weight arrives as cmd 0x24 on
 * indicate 0x2A12. For both, weight = last two payload bytes, big-endian, / 100.
 *
 * Body composition (a cmd 0x26 record dump behind a b0/b3/b2/b7/b8 handshake) is
 * unverified and deliberately out of scope; impedance is reported as 0 and body
 * composition is left to buildPayload's profile estimate.
 *
 * Routing is by advertised name only (names.exact ['r-msc04']). The device also
 * exposes service 0x1A10, which ES-CS20M claims, so this adapter intentionally
 * does NOT claim 0x1A10: a nameless 0x1A10 device stays with ES-CS20M, while a
 * named R-MSC04 wins here on priority (235 > 130).
 */
export class RenphoMsc04Adapter implements ScaleAdapterCore, GattWiring, MultiCharNotify {
  readonly name = 'Renpho R-MSC04';
  readonly match: MatchDescriptor = {
    priority: 235,
    custom: true,
    names: { exact: ['r-msc04'] },
  };
  // Legacy single-char fallback (unused in multi-char mode).
  readonly charNotifyUuid = CHR_NOTIFY;
  readonly charWriteUuid = CHR_WRITE;
  readonly normalizesWeight = true;

  // 0x2A12 is physically an indicate characteristic. The shared subscribe loop
  // only auto-subscribes 'notify' bindings, and node-ble/noble enable
  // indications transparently, so declare it 'notify' (same pattern as
  // BeurerBf720 / RobiS9).
  readonly characteristics: CharacteristicBinding[] = [
    { uuid: CHR_WRITE, type: 'write' },
    { uuid: CHR_NOTIFY, type: 'notify' },
    { uuid: CHR_INDICATE, type: 'notify' },
  ];

  private finalReceived = false;

  matches(device: BleDeviceInfo): boolean {
    return matchesDescriptor(device, this.match);
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
    this.finalReceived = false;
  }

  async onConnected(ctx: ConnectionContext): Promise<void> {
    if (!ctx.availableChars.has(CHR_WRITE)) {
      throw new Error(
        `Renpho R-MSC04: write characteristic (${CHR_WRITE}) not discovered. ` +
          'Likely a transient GATT discovery race. Try again.',
      );
    }
    // Written WITHOUT response: the handler sends the identical ES-CS20M unlock
    // without response (src/ble/shared.ts writeChar.write(buf, false)).
    await ctx.write(CHR_WRITE, START_COMMAND, false);
    bleLog.debug('Renpho R-MSC04: start command sent');
  }

  parseCharNotification(_charUuid: string, data: Buffer): ScaleReading | null {
    const frame = this.decodeFrame(data);
    if (!frame) return null;
    if (frame.cmd === CMD_FINAL) this.finalReceived = true;
    return { weight: frame.weight, impedance: 0 };
  }

  /** Legacy single-char path (routes by frame content; the char UUID is irrelevant). */
  parseNotification(data: Buffer): ScaleReading | null {
    return this.parseCharNotification(CHR_NOTIFY, data);
  }

  /**
   * Validate and decode a 55AA frame. Returns {cmd, weight} for the two weight
   * commands (0x21 live, 0x24 final) or null for any malformed, bad-checksum, or
   * out-of-scope frame. Layout:
   *   [0]=0x55 [1]=0xAA [2]=cmd [3..4]=length BE [5..]=payload [last]=checksum
   * checksum = low byte of the sum of all bytes before it; weight = the last two
   * payload bytes big-endian / 100 (kg).
   */
  private decodeFrame(data: Buffer): { cmd: number; weight: number } | null {
    if (data.length < 5) return null; // need [0..4] to read the length field
    if (data[0] !== HDR0 || data[1] !== HDR1) return null;

    const len = data.readUInt16BE(3);
    if (len < 2) return null; // need at least the 2 weight bytes
    const frameLen = len + FRAME_OVERHEAD;
    if (data.length < frameLen) return null; // truncated / declared-length mismatch

    let sum = 0;
    for (let i = 0; i < frameLen - 1; i++) sum += data[i];
    if ((sum & 0xff) !== data[frameLen - 1]) return null; // bad checksum

    const cmd = data[2];
    if (cmd !== CMD_LIVE && cmd !== CMD_FINAL) return null; // out of scope

    // Weight bytes are the two just before the checksum: frameLen - 3.
    const weight = data.readUInt16BE(frameLen - 3) / 100;
    if (weight < 0.5 || weight > 300 || !Number.isFinite(weight)) return null;

    return { cmd, weight };
  }

  isComplete(reading: ScaleReading): boolean {
    return reading.weight > 0 && this.finalReceived;
  }

  computeMetrics(reading: ScaleReading, profile: UserProfile): BodyComposition {
    // Weight only: impedance 0, no scale-provided body composition (#117/#265).
    return buildPayload(reading.weight, 0, {}, profile);
  }
}
