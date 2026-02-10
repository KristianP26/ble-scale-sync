import type {
  BleDeviceInfo,
  CharacteristicBinding,
  ConnectionContext,
  ScaleAdapter,
  ScaleReading,
  UserProfile,
  GarminPayload,
} from '../interfaces/scale-adapter.js';
import { uuid16, buildPayload, type ScaleBodyComp } from './body-comp-helpers.js';

const CHR_MEASUREMENT = uuid16(0x8a21);
const CHR_UPLOAD = uuid16(0x8a82);
const CHR_DOWNLOAD = uuid16(0x8a81);

/** openScale opcodes for the Trisa challenge-response protocol. */
const OP_PASSWORD = 0xa0;
const OP_CHALLENGE = 0xa1;

/**
 * Adapter for Trisa body-composition scales (names starting with "01257B" or "11257B").
 *
 * Protocol details (from openScale TrisaBodyAnalyzeHandler):
 *   - Service 0x7802
 *   - 0x8A21 (notify) — measurement data
 *   - 0x8A82 (notify) — upload channel: scale sends password + challenge
 *   - 0x8A81 (write)  — download channel: host sends challenge response
 *   - Scale sends password (opcode 0xA0) on 0x8A82, then challenge (0xA1).
 *     Host replies with XOR(challenge, password) on 0x8A81.
 *   - Measurement frames on 0x8A21 use base-10 float encoding.
 */
export class TrisaAdapter implements ScaleAdapter {
  readonly name = 'Trisa';
  readonly charNotifyUuid = CHR_MEASUREMENT;
  readonly charWriteUuid = CHR_DOWNLOAD;

  readonly normalizesWeight = true;
  readonly unlockCommand: number[] = [];
  readonly unlockIntervalMs = 0;

  readonly characteristics: CharacteristicBinding[] = [
    { uuid: CHR_MEASUREMENT, type: 'notify' },
    { uuid: CHR_UPLOAD, type: 'notify' },
    { uuid: CHR_DOWNLOAD, type: 'write' },
  ];

  /** Stored password from opcode 0xA0, used to solve the challenge. */
  private password: Buffer | null = null;
  /** Reference to write function, saved from onConnected context. */
  private writeFn: ConnectionContext['write'] | null = null;

  matches(device: BleDeviceInfo): boolean {
    const name = (device.localName || '').toUpperCase();
    return name.startsWith('01257B') || name.startsWith('11257B');
  }

  async onConnected(ctx: ConnectionContext): Promise<void> {
    this.writeFn = ctx.write;
  }

  /**
   * Dispatch notifications from different characteristics.
   *
   * - 0x8A82: password (0xA0) and challenge (0xA1) frames
   * - 0x8A21: measurement data
   */
  parseCharNotification(charUuid: string, data: Buffer): ScaleReading | null {
    if (charUuid === CHR_UPLOAD) {
      this.handleUploadChannel(data);
      return null;
    }
    if (charUuid === CHR_MEASUREMENT) {
      return this.parseMeasurement(data);
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

  computeMetrics(reading: ScaleReading, profile: UserProfile): GarminPayload {
    const comp: ScaleBodyComp = {};
    return buildPayload(reading.weight, reading.impedance, comp, profile);
  }

  /**
   * Handle password and challenge frames from the upload channel (0x8A82).
   */
  private handleUploadChannel(data: Buffer): void {
    if (data.length < 2) return;
    const opcode = data[0];

    if (opcode === OP_PASSWORD) {
      this.password = Buffer.from(data.subarray(1));
    } else if (opcode === OP_CHALLENGE && this.password && this.writeFn) {
      const challenge = data.subarray(1);
      const response = Buffer.alloc(challenge.length + 1);
      response[0] = OP_CHALLENGE;
      for (let i = 0; i < challenge.length; i++) {
        response[i + 1] = challenge[i] ^ (this.password[i % this.password.length] ?? 0);
      }
      // Fire-and-forget write — no need to await in notification handler
      void this.writeFn(CHR_DOWNLOAD, response, true);
    }
  }

  /**
   * Parse a Trisa measurement frame from 0x8A21.
   *
   * Layout:
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
   * Weight = mantissa * 10^exponent
   * Impedance from resistance2: r2 < 410 ? 3.0 : 0.3 * (r2 - 400)
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

    // Walk through optional fields to find resistance2
    let offset = 5;

    if (hasTimestamp) {
      offset += 7;
    }

    if (hasResistance1) {
      offset += 4;
    }

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
