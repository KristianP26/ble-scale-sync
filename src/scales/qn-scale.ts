import type { Peripheral } from '@abandonware/noble';
import { BodyCompCalculator } from '../calculator.js';
import type {
  ScaleAdapter,
  ScaleReading,
  UserProfile,
  GarminPayload,
} from '../interfaces/scale-adapter.js';
import { uuid16 } from './body-comp-helpers.js';

/**
 * Ported from openScale's QNHandler.kt
 *
 * QN / FITINDEX ES-26M style scales (vendor protocol on 0xFFE0 / 0xFFF0).
 *
 * Two very similar layouts:
 *   Type 1 (0xFFE0): FFE1 notify, FFE2 indicate, FFE3 write-config, FFE4 write-time
 *   Type 2 (0xFFF0): FFF1 notify, FFF2 write-shared
 *
 * We use Type 2 UUIDs (FFF1/FFF2) as they are the most common variant.
 *
 * 0x10 frame — live/stable weight:
 *   [0]     opcode (0x10)
 *   [1]     length / flags
 *   [2]     protocol type (echoed back in config commands)
 *   [3-4]   weight (BE uint16, / weightScaleFactor)
 *   [5]     stability (1 = stable, 0 = measuring)
 *   [6-7]   resistance R1 (BE uint16)
 *   [8-9]   resistance R2 (BE uint16)
 *
 * 0x12 frame — scale info:
 *   [10]    weight scale flag (1 = /100, else /10)
 *
 * Impedance: R1 at bytes [6-7] is the primary BIA resistance used for body
 *            composition. R2 at bytes [8-9] is a secondary measurement.
 *
 * openScale matches: name contains "qn-scale" OR "renpho-scale"
 *                    AND advertised service UUIDs include 0xFFE0 or 0xFFF0.
 */

// Type 2 UUIDs (most common variant)
const CHR_NOTIFY = uuid16(0xfff1);
const CHR_WRITE = uuid16(0xfff2);

// Type 1 UUIDs (alternate variant, service 0xFFE0)
const CHR_NOTIFY_T1 = uuid16(0xffe1);
const CHR_WRITE_T1 = uuid16(0xffe3);

// Service UUIDs for matching
const SVC_T1 = 'ffe0';
const SVC_T2 = 'fff0';

export class QnScaleAdapter implements ScaleAdapter {
  readonly name = 'QN Scale';
  readonly charNotifyUuid = CHR_NOTIFY;
  readonly charWriteUuid = CHR_WRITE;
  readonly altCharNotifyUuid = CHR_NOTIFY_T1;
  readonly altCharWriteUuid = CHR_WRITE_T1;
  readonly normalizesWeight = true;
  /**
   * Unlock / unit-config command (6-byte variant).
   * Confirmed working with Renpho, Sencor, and generic QN-Scale devices.
   * openScale's QNHandler uses a longer 9-byte variant
   * [0x13, 0x09, 0x00, 0x01, 0x10, 0x00, 0x00, 0x00, 0x2d] which may not
   * work with all QN-compatible scales.
   */
  readonly unlockCommand = [0x13, 0x09, 0x00, 0x01, 0x01, 0x02];
  readonly unlockIntervalMs = 2000;

  /**
   * Weight divisor — 100 (Type 1 default) or 10 (Type 2).
   * Updated dynamically when a 0x12 scale-info frame arrives.
   */
  private weightScaleFactor = 100;

  /**
   * openScale: requires BOTH name match AND service UUID match.
   * Names: "qn-scale", "renpho-scale" (from QNHandler.kt)
   *        "senssun", "sencor" (QN-compatible devices not in original QNHandler)
   */
  matches(peripheral: Peripheral): boolean {
    const name = (peripheral.advertisement.localName || '').toLowerCase();
    const nameMatch =
      name.includes('qn-scale') ||
      name.includes('renpho') ||
      name.includes('senssun') ||
      name.includes('sencor');
    if (!nameMatch) return false;

    // Require QN vendor service UUID (matching openScale's supportFor logic)
    const uuids = (peripheral.advertisement.serviceUuids || []).map((u) => u.toLowerCase());
    return uuids.some(
      (u) => u === SVC_T1 || u === SVC_T2 || u === uuid16(0xffe0) || u === uuid16(0xfff0),
    );
  }

  /**
   * Parse QN vendor notifications.
   *
   * 0x10 — weight frame (≥ 10 bytes):
   *   [3-4]  weight (BE uint16 / weightScaleFactor)
   *   [5]    stability (1 = final reading)
   *   [6-7]  R1 resistance (BE uint16) — primary BIA value
   *   [8-9]  R2 resistance (BE uint16)
   *
   * 0x12 — scale info frame:
   *   [10]   1 = weight/100, else weight/10
   */
  parseNotification(data: Buffer): ScaleReading | null {
    if (data.length < 3) return null;

    const opcode = data[0];

    // 0x12 — scale info: update weight scale factor
    if (opcode === 0x12 && data.length > 10) {
      this.weightScaleFactor = data[10] === 1 ? 100 : 10;
      return null;
    }

    // 0x10 — live weight frame
    if (opcode !== 0x10 || data.length < 10) return null;

    // Only process stable readings (byte[5] == 1)
    const stable = data[5] === 1;
    if (!stable) return null;

    const rawWeight = data.readUInt16BE(3);
    let weight = rawWeight / this.weightScaleFactor;

    // Heuristic fallback (from QNHandler): if weight looks unreasonable, try alternate factor
    if (weight <= 5 || weight >= 250) {
      const altFactor = this.weightScaleFactor === 100 ? 10 : 100;
      const altWeight = rawWeight / altFactor;
      if (altWeight > 5 && altWeight < 250) {
        weight = altWeight;
      }
    }

    if (weight <= 0 || !Number.isFinite(weight)) return null;

    // R1 (primary BIA resistance) and R2 (secondary)
    const r1 = data.readUInt16BE(6);
    const r2 = data.readUInt16BE(8);

    // Use R1 as impedance (primary BIA measurement, per openScale's QNHandler)
    // Fall back to R2 if R1 is zero
    const impedance = r1 > 0 ? r1 : r2;

    return { weight, impedance };
  }

  isComplete(reading: ScaleReading): boolean {
    return reading.weight > 10 && reading.impedance > 200;
  }

  computeMetrics(reading: ScaleReading, profile: UserProfile): GarminPayload {
    const calc = new BodyCompCalculator(
      reading.weight,
      reading.impedance,
      profile.height,
      profile.age,
      profile.gender,
      profile.isAthlete,
    );
    const metrics = calc.calculate();

    if (!metrics) {
      throw new Error('Calculation failed: invalid inputs');
    }

    return {
      weight: reading.weight,
      impedance: reading.impedance,
      ...metrics,
    };
  }
}
