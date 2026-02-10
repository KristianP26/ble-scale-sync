import type {
  BleDeviceInfo,
  ScaleAdapter,
  ScaleReading,
  UserProfile,
  GarminPayload,
} from '../interfaces/scale-adapter.js';
import { buildPayload } from './body-comp-helpers.js';

// Soehnle custom 128-bit service / characteristic UUIDs
const CHR_NOTIFY_A = '352e300128e940b8a3616db4cca4147c';
const CHR_CMD = '352e300228e940b8a3616db4cca4147c';

const KNOWN_PREFIXES = ['shape200', 'shape100', 'shape50', 'style100'];

/**
 * Adapter for Soehnle Shape / Style scales (Shape200, Shape100, Shape50, Style100).
 *
 * **Limitation:** Requires user slot 1 to be configured on the scale via the
 * manufacturer's official app. openScale has a full user creation workflow
 * (create user → select user → request history) that is not implemented here.
 *
 * Protocol ported from openScale's SoehnleHandler:
 *   - Custom service 352e3000-…
 *   - Notify on 352e3001-… (measurement data)
 *   - Write to 352e3002-… (commands: user create/select, history request)
 *   - Frame type 0x09 (15 bytes): weight at [9-10] BE / 10, impedance 5kHz at [11-12] BE, 50kHz at [13-14] BE
 *
 * Unlock sends a history request command periodically.
 */
export class SoehnleScaleAdapter implements ScaleAdapter {
  readonly name = 'Soehnle Shape/Style';
  readonly charNotifyUuid = CHR_NOTIFY_A;
  readonly charWriteUuid = CHR_CMD;
  readonly normalizesWeight = true;
  /** History request for index 1 — triggers measurement streaming. */
  readonly unlockCommand = [0x09, 0x01];
  readonly unlockIntervalMs = 5000;

  matches(device: BleDeviceInfo): boolean {
    const name = (device.localName || '').toLowerCase();
    return KNOWN_PREFIXES.some((p) => name.startsWith(p));
  }

  /**
   * Parse a Soehnle measurement frame (type 0x09, 15 bytes).
   *
   * Layout:
   *   [0]      frame type (0x09)
   *   [1]      user index
   *   [2-8]    timestamp (year BE, month, day, hour, minute, second)
   *   [9-10]   weight (BE uint16, / 10.0 for kg)
   *   [11-12]  impedance 5 kHz (BE uint16)
   *   [13-14]  impedance 50 kHz (BE uint16)
   */
  parseNotification(data: Buffer): ScaleReading | null {
    if (data.length < 15) return null;
    if (data[0] !== 0x09) return null;

    const weight = data.readUInt16BE(9) / 10;
    if (weight <= 0 || !Number.isFinite(weight)) return null;

    // Use 50 kHz impedance (more commonly used for body composition)
    const impedance = data.readUInt16BE(13);

    return { weight, impedance };
  }

  isComplete(reading: ScaleReading): boolean {
    return reading.weight > 0 && reading.impedance > 0;
  }

  computeMetrics(reading: ScaleReading, profile: UserProfile): GarminPayload {
    return buildPayload(reading.weight, reading.impedance, {}, profile);
  }
}
