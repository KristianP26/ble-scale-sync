import type { Peripheral } from '@abandonware/noble';
import type {
  ScaleAdapter,
  ScaleReading,
  UserProfile,
  GarminPayload,
} from '../interfaces/scale-adapter.js';
import { uuid16, buildPayload } from './body-comp-helpers.js';

/**
 * Ported from openScale's RenphoHandler.kt
 *
 * Handler for RENPHO ES-WBE28 — a newer Renpho model that uses standard BLE
 * services (Body Composition 0x181B, User Data 0x181C, Weight Scale 0x181D,
 * Current Time 0x1805) but with vendor-specific payload encoding.
 *
 * Weight is published on the Weight Measurement characteristic (0x2A9D) in a
 * proprietary format: data[0] must equal 0x2E, weight = LE uint16 at [1-2] / 20.0.
 *
 * Vendor handshake:
 *   MAGIC0 [0x10, 0x01, 0x00, 0x11] → written to 0xFFE2
 *   MAGIC1 [0x03, 0x00, 0x01, 0x04] → written to 0xFFE2
 *   MAGIC_UCP [0x02, 0xAA, 0x0F, 0x27] → written to 0x2A9F (consent user 0xAA, code 9999)
 *
 * Mutual exclusion with QnScaleAdapter:
 *   RenphoHandler claims "renpho-scale" devices that do NOT advertise 0xFFE0/0xFFF0.
 *   Devices WITH 0xFFE0/0xFFF0 are handled by QnScaleAdapter (QNHandler.kt).
 */

const CHR_WEIGHT = uuid16(0x2a9d); // notify — proprietary weight encoding
const CHR_CUSTOM0 = uuid16(0xffe2); // write  — vendor magic commands

// QN vendor service UUIDs (used for exclusion)
const SVC_QN_T1 = 'ffe0';
const SVC_QN_T2 = 'fff0';

export class RenphoScaleAdapter implements ScaleAdapter {
  readonly name = 'Renpho ES-WBE28';
  readonly charNotifyUuid = CHR_WEIGHT;
  readonly charWriteUuid = CHR_CUSTOM0;
  /** MAGIC0 — kicks the device into measurement mode. */
  readonly unlockCommand = [0x10, 0x01, 0x00, 0x11];
  readonly unlockIntervalMs = 3000;

  /**
   * Match "renpho-scale" (or "renpho") devices that do NOT advertise QN vendor
   * service UUIDs (0xFFE0 / 0xFFF0). Those are handled by QnScaleAdapter.
   */
  matches(peripheral: Peripheral): boolean {
    const name = (peripheral.advertisement.localName || '').toLowerCase();
    if (!name.includes('renpho')) return false;

    // Reject QN-protocol devices (mutual exclusion from RenphoHandler.kt)
    const uuids = (peripheral.advertisement.serviceUuids || []).map((u) => u.toLowerCase());
    const hasQn = uuids.some(
      (u) => u === SVC_QN_T1 || u === SVC_QN_T2 || u === uuid16(0xffe0) || u === uuid16(0xfff0),
    );
    return !hasQn;
  }

  /**
   * Parse a Renpho ES-WBE28 weight notification on 0x2A9D.
   *
   * Proprietary layout (from RenphoHandler.kt):
   *   [0]    0x2E — valid frame marker
   *   [1]    weight low byte  (LE)
   *   [2]    weight high byte (LE)
   *   weight_kg = ((data[2] << 8) | data[1]) / 20.0
   */
  parseNotification(data: Buffer): ScaleReading | null {
    if (data.length < 3) return null;
    if (data[0] !== 0x2e) return null;

    const raw = data.readUInt16LE(1);
    const weight = raw / 20.0;

    if (weight <= 0 || !Number.isFinite(weight)) return null;

    // No impedance available from this device
    return { weight, impedance: 0 };
  }

  isComplete(reading: ScaleReading): boolean {
    // Weight-only device — complete as soon as we have a valid weight
    return reading.weight > 0;
  }

  computeMetrics(reading: ScaleReading, profile: UserProfile): GarminPayload {
    // No impedance — use estimated body composition from BMI
    return buildPayload(reading.weight, 0, {}, profile);
  }
}
