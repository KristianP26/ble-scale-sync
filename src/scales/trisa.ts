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

// Original Trisa firmware exposes 0x8A21 (notify) for measurement.
const CHR_MEASUREMENT_TRISA = uuid16(0x8a21);
// ADE BA 1600 / fitvigo firmware does NOT expose 0x8A21 — measurement frames
// arrive on 0x8A24 (indicate) instead. Frame layout (weight portion) is
// compatible with the Trisa decoder; body composition encoding still TBD.
const CHR_MEASUREMENT_ADE = uuid16(0x8a24);
// On ADE the scale also pushes another payload on 0x8A22 (indicate) shortly
// after the weight frame. Encoding is not yet decoded — we subscribe to it
// purely so future captures with debug logging can collect the bytes.
const CHR_BODYCOMP_ADE = uuid16(0x8a22);
// 0x8A82 is the upload channel on both variants. Trisa sends password (0xA0)
// + challenge (0xA1); ADE only sends challenge (0xA1) without a preceding
// password frame.
const CHR_UPLOAD = uuid16(0x8a82);
// 0x8A81 is the host -> scale write channel on both variants.
const CHR_DOWNLOAD = uuid16(0x8a81);

// openScale opcodes for the Trisa challenge-response protocol.
const OP_PASSWORD = 0xa0;
const OP_CHALLENGE = 0xa1;
// Time-sync command — opcode 0x02 followed by 4-byte LE seconds-since-2010.
// Identical on Trisa and ADE.
const OP_TIME_SYNC = 0x02;
// Final "pairing complete" / broadcast-id opcode. Trisa uses 0x21, ADE 0x22.
const OP_BROADCAST_TRISA = 0x21;
const OP_BROADCAST_ADE = 0x22;
// Challenge response opcode. Trisa echoes 0xA1; ADE uses 0x20 (the response
// payload encoding is also different — see handleUploadChannel).
const OP_RESPONSE_TRISA = 0xa1;

const EPOCH_2010 = 1262304000;

type Variant = 'trisa' | 'ade';

/**
 * Adapter for the Trisa body-composition scale family.
 *
 * Two firmware variants are supported:
 *   - Trisa (default): exposes 0x8A21 (notify) for measurement, full
 *     password + challenge handshake on 0x8A82.
 *   - ADE BA 1600 / fitvigo: 0x8A21 is missing; measurement arrives on 0x8A24
 *     (indicate). Different challenge-response and different
 *     "pairing complete" opcode (0x22 instead of 0x21). Body-composition
 *     decoding is not yet implemented — only weight is reported.
 *
 * Variant detection happens in `onConnected()` via `ctx.availableChars`:
 * if 0x8A21 is missing but 0x8A24 is present → ADE.
 */
export class TrisaAdapter implements ScaleAdapter {
  readonly name = 'Trisa';
  // Legacy single-char fallback (only used when `characteristics` is ignored).
  readonly charNotifyUuid = CHR_MEASUREMENT_TRISA;
  readonly charWriteUuid = CHR_DOWNLOAD;

  readonly normalizesWeight = true;
  readonly unlockCommand: number[] = [];
  readonly unlockIntervalMs = 0;

  readonly characteristics: CharacteristicBinding[] = [
    // Trisa-only measurement char.
    { uuid: CHR_MEASUREMENT_TRISA, type: 'notify', optional: true },
    // ADE-only measurement char.
    { uuid: CHR_MEASUREMENT_ADE, type: 'notify', optional: true },
    // ADE-only body-composition push (encoding TBD — captured via debug log).
    { uuid: CHR_BODYCOMP_ADE, type: 'notify', optional: true },
    // Shared upload channel (password + challenge).
    { uuid: CHR_UPLOAD, type: 'notify' },
    // Shared write channel.
    { uuid: CHR_DOWNLOAD, type: 'write' },
  ];

  /** Detected firmware variant. Set in onConnected(). */
  private variant: Variant = 'trisa';
  /** Stored password from opcode 0xA0 (Trisa). ADE does not send this. */
  private password: Buffer | null = null;
  /** Reference to write function, saved from onConnected context. */
  private writeFn: ConnectionContext['write'] | null = null;

  matches(device: BleDeviceInfo): boolean {
    const name = (device.localName || '').toUpperCase();
    return name.startsWith('01257B') || name.startsWith('11257B');
  }

  async onConnected(ctx: ConnectionContext): Promise<void> {
    this.writeFn = ctx.write;

    // Both measurement chars are declared `optional` so that variant detection
    // can pick whichever one the firmware exposes. If neither shows up, that
    // is almost certainly a transient BlueZ ServicesResolved race
    // (bluez/bluez#1489) — fail fast with a clear message instead of silently
    // subscribing to no measurement char and stalling on read.
    const hasMeasurement =
      ctx.availableChars.has(CHR_MEASUREMENT_TRISA) || ctx.availableChars.has(CHR_MEASUREMENT_ADE);
    if (!hasMeasurement) {
      throw new Error(
        'Trisa: no measurement characteristic discovered (expected 0x8A21 or 0x8A24). ' +
          'Likely a transient BlueZ discovery race — try again.',
      );
    }

    this.variant = this.detectVariant(ctx.availableChars);
    bleLog.debug(`Trisa adapter: variant=${this.variant}`);

    // Time sync (same opcode on both variants).
    const now = Math.floor(Date.now() / 1000) - EPOCH_2010;
    const tsCmd = Buffer.alloc(5);
    tsCmd[0] = OP_TIME_SYNC;
    tsCmd.writeUInt32LE(now, 1);
    await ctx.write(CHR_DOWNLOAD, [...tsCmd], true);

    // Broadcast / pairing-complete opcode differs between variants.
    const broadcastOp = this.variant === 'ade' ? OP_BROADCAST_ADE : OP_BROADCAST_TRISA;
    await ctx.write(CHR_DOWNLOAD, [broadcastOp], true);
  }

  private detectVariant(available: ReadonlySet<string>): Variant {
    const hasTrisa = available.has(CHR_MEASUREMENT_TRISA);
    const hasAde = available.has(CHR_MEASUREMENT_ADE);
    if (!hasTrisa && hasAde) return 'ade';
    return 'trisa';
  }

  /**
   * Dispatch notifications from different characteristics.
   *
   * Trisa:
   *   - 0x8A82: password (0xA0) and challenge (0xA1) frames
   *   - 0x8A21: measurement data
   * ADE BA 1600:
   *   - 0x8A82: challenge (0xA1) — no password frame; response algo unknown
   *   - 0x8A24: measurement data (Trisa-compatible weight encoding)
   *   - 0x8A22: body-composition push (encoding TBD)
   */
  parseCharNotification(charUuid: string, data: Buffer): ScaleReading | null {
    if (charUuid === CHR_UPLOAD) {
      this.handleUploadChannel(data);
      return null;
    }
    if (charUuid === CHR_MEASUREMENT_TRISA || charUuid === CHR_MEASUREMENT_ADE) {
      return this.parseMeasurement(data);
    }
    if (charUuid === CHR_BODYCOMP_ADE) {
      // Capture for future analysis — encoding not yet decoded so we can't
      // turn this into impedance/fat/water/etc.
      bleLog.debug(`ADE body-comp frame on 0x8A22 (TBD encoding): ${data.toString('hex')}`);
      return null;
    }
    return null;
  }

  /**
   * Fallback for legacy single-char path — parses measurement data only.
   */
  parseNotification(data: Buffer): ScaleReading | null {
    return this.parseMeasurement(data);
  }

  isComplete(reading: ScaleReading): boolean {
    return reading.weight > 0;
  }

  computeMetrics(reading: ScaleReading, profile: UserProfile): BodyComposition {
    const comp: ScaleBodyComp = {};
    return buildPayload(reading.weight, reading.impedance, comp, profile);
  }

  /**
   * Handle password and challenge frames from the upload channel (0x8A82).
   *
   * On Trisa: scale sends 0xA0 (password), then 0xA1 (challenge); host responds
   * with [0xA1, XOR(challenge, password)].
   *
   * On ADE BA 1600: scale sends 0xA1 (challenge) directly without a password
   * frame. The phone responds with 5 bytes starting with opcode 0x20 — the
   * exact algorithm is not yet known. We don't write anything here on ADE,
   * relying on the time-sync + broadcast handshake in onConnected() to
   * progress the scale to the measurement state. If the scale stalls on ADE,
   * a fresh capture with multiple weigh-ins will be needed to crack this.
   */
  private handleUploadChannel(data: Buffer): void {
    if (data.length < 2) return;
    const opcode = data[0];

    if (this.variant === 'ade') {
      // ADE challenge response algorithm is unknown. Logging the raw bytes
      // helps when comparing against future captures.
      bleLog.debug(`ADE upload frame (TBD response): ${data.toString('hex')}`);
      return;
    }

    if (opcode === OP_PASSWORD) {
      this.password = Buffer.from(data.subarray(1));
    } else if (opcode === OP_CHALLENGE && this.password && this.writeFn) {
      const challenge = data.subarray(1);
      const response = Buffer.alloc(challenge.length + 1);
      response[0] = OP_RESPONSE_TRISA;
      for (let i = 0; i < challenge.length; i++) {
        response[i + 1] = challenge[i] ^ (this.password[i % this.password.length] ?? 0);
      }
      // Fire-and-forget write — no need to await in notification handler
      void this.writeFn(CHR_DOWNLOAD, response, true);
    }
  }

  /**
   * Parse a Trisa measurement frame.
   *
   * Layout (verified for Trisa 0x8A21 and ADE BA 1600 0x8A24, weight only):
   *   [0]      info flags
   *             bit 0: timestamp present (7 bytes at offset 5)
   *             bit 1: resistance1 present (4 bytes base-10 float)
   *             bit 2: resistance2 present (4 bytes base-10 float)
   *   [1-3]    weight mantissa, unsigned 24-bit little-endian
   *   [4]      weight exponent, signed int8
   *   [5+]     optional timestamp (7 bytes if bit0 set)
   *   then:    optional resistance1 (4 bytes if bit1 set)
   *   then:    optional resistance2 (4 bytes if bit2 set)
   *
   * Weight = mantissa * 10^exponent.
   * Impedance from resistance2: r2 < 410 ? 3.0 : 0.3 * (r2 - 400).
   *
   * NOTE: only the Trisa branch walks the optional-field table. For ADE the
   * post-weight layout is unverified (timestamp may be 8 bytes instead of 7)
   * and body comp arrives on a separate 0x8A22 push, so the parser
   * short-circuits to weight-only after computing the weight.
   */
  private parseMeasurement(data: Buffer): ScaleReading | null {
    if (data.length < 5) return null;

    const flags = data[0];
    const hasTimestamp = (flags & 0x01) !== 0;
    const hasResistance1 = (flags & 0x02) !== 0;
    const hasResistance2 = (flags & 0x04) !== 0;

    // Skip frames that are just timestamps (only bit0 set, no weight data expected)
    if (hasTimestamp && !hasResistance1 && !hasResistance2) {
      const mantissa = data[1] | (data[2] << 8) | (data[3] << 16);
      if (mantissa === 0) return null;
    }

    // Weight: 24-bit unsigned LE mantissa + signed exponent
    const mantissa = data[1] | (data[2] << 8) | (data[3] << 16);
    const exponent = data.readInt8(4);
    const weight = mantissa * Math.pow(10, exponent);

    if (weight <= 0 || !Number.isFinite(weight)) return null;

    // ADE BA 1600: only the weight bytes are verified (single capture frame in
    // #138). The post-weight layout — timestamp width, resistance encoding —
    // is not confirmed and body-comp values arrive on a separate 0x8A22 push
    // anyway. Don't walk the offset table; return weight only until more
    // captures are available.
    if (this.variant === 'ade') return { weight, impedance: 0 };

    // Walk through optional fields to find resistance2.
    let offset = 5;
    if (hasTimestamp) offset += 7;
    if (hasResistance1) offset += 4;

    let impedance = 0;
    if (hasResistance2 && offset + 4 <= data.length) {
      const r2Mantissa = data[offset] | (data[offset + 1] << 8) | (data[offset + 2] << 16);
      const r2Exponent = data.readInt8(offset + 3);
      const r2 = r2Mantissa * Math.pow(10, r2Exponent);

      if (r2 < 410) {
        impedance = 3.0;
      } else {
        impedance = 0.3 * (r2 - 400);
      }
    }

    return { weight, impedance };
  }
}
