import { computeBiaFat, buildPayload } from './body-comp-helpers.js';
import type {
  BleDeviceInfo,
  ConnectionContext,
  ScaleAdapter,
  ScaleReading,
  UserProfile,
  BodyComposition,
} from '../interfaces/scale-adapter.js';
import { uuid16 } from './body-comp-helpers.js';
import { bleLog } from '../ble/types.js';

/** Format bytes as hex string for debug logging. */
const hex = (data: number[]): string => data.map((b) => b.toString(16).padStart(2, '0')).join(' ');

/**
 * Ported from openScale's QNHandler.kt
 *
 * QN / FITINDEX ES-26M style scales (vendor protocol on 0xFFE0 / 0xFFF0).
 *
 * Two very similar layouts:
 *   Type 1 (0xFFE0): FFE1 notify, FFE2 indicate, FFE3 write-config, FFE4 write-time
 *   Type 2 (0xFFF0): FFF1 notify, FFF2 write-shared
 *
 * Some newer firmware (e.g. Renpho ES-CS20M / Elis 1) also exposes an AE00
 * service (AE01 write, AE02 notify) that must be initialized before the scale
 * starts sending notifications on FFF1. Without the AE01 init handshake,
 * the scale connects but disconnects without ever sending weight data.
 *
 * 0x10 frame — live/stable weight:
 *   [0]     opcode (0x10)
 *   [1]     length / flags
 *   [2]     protocol type (echoed back in config commands)
 *   [3-4]   weight (BE uint16, / weightScaleFactor)
 *   [5]     stability (1 = stable, 0 = measuring)
 *   [6-7]   resistance R1 (BE uint16) — PRIMARY BIA measurement
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

// AE00 service UUIDs (newer firmware, e.g. Renpho ES-CS20M)
const CHR_AE01 = uuid16(0xae01);
const CHR_AE02 = uuid16(0xae02);

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
  readonly unlockCommand: number[] = [];
  readonly unlockIntervalMs = 0;

  /**
   * Weight divisor: 100 (Type 1 default) or 10 (Type 2).
   * Updated dynamically when a 0x12 scale-info frame arrives.
   */
  private weightScaleFactor = 100;

  /**
   * Multi-step init replacing legacy unlockCommands.
   *
   * Newer QN firmware (Renpho ES-CS20M, Elis 1) requires:
   *  1. Subscribe to AE02 notifications
   *  2. Write AE01 init handshake (wakes up FFF1 notification channel)
   *  3. Send unlock command on FFF2
   *  4. Send user profile on FFF2
   *
   * Older firmware ignores AE00 steps and just needs the unlock on FFF2.
   * Both paths are handled gracefully with try/catch.
   */
  async onConnected(ctx: ConnectionContext): Promise<void> {
    // Helper: write to FFF2, fall back to FFE3 (Type 1)
    const writeCmd = async (data: number[]): Promise<void> => {
      try {
        await ctx.write(CHR_WRITE, data, false);
      } catch {
        await ctx.write(CHR_WRITE_T1, data, false);
      }
      bleLog.debug(`QN write: [${hex(data)}]`);
    };

    // Step 1: Subscribe to AE02 notifications if available (newer firmware)
    try {
      await ctx.subscribe(CHR_AE02);
      bleLog.debug('QN: subscribed to AE02');
    } catch {
      bleLog.debug('QN: AE02 not available (older firmware)');
    }

    // Step 2: Write AE01 init handshake (wakes up FFF1 notifications)
    // Observed in official Renpho app packet capture:
    //   FEDC BAC0 0600 02XX 01EF  (XX = session counter)
    const ae01Init = [0xfe, 0xdc, 0xba, 0xc0, 0x06, 0x00, 0x02, 0x01, 0x01, 0xef];
    try {
      await ctx.write(CHR_AE01, ae01Init, false);
      bleLog.debug(`QN: AE01 init written: [${hex(ae01Init)}]`);
    } catch {
      bleLog.debug('QN: AE01 not available (older firmware)');
    }

    // Step 3: Send all unlock variants (different firmware versions respond to different formats)
    const unlocks = [
      [0x13, 0x09, 0x00, 0x01, 0x01, 0x02],
      [0x13, 0x09, 0x00, 0x01, 0x10, 0x00, 0x00, 0x00, 0x2d],
      [0x13, 0x09, 0xff, 0x08, 0x10, 0x00, 0x00, 0x00, 0x33],
    ];
    for (const cmd of unlocks) {
      try {
        await writeCmd(cmd);
      } catch {
        break;
      }
    }

    // Step 4: Send user profile (0xA2)
    // Format: [0xA2, length, userId, param, age, checksum]
    const age = Math.min(0xff, Math.max(1, ctx.profile.age));
    const profileCmd = [0xa2, 0x06, 0x01, 0x32, age, 0x00];
    profileCmd[5] = profileCmd.reduce((a, b) => a + b, 0) & 0xff;
    try {
      await writeCmd(profileCmd);
    } catch {
      // Best-effort
    }

    // Step 5: Send start measurement command (0x22)
    // This is the trigger that makes the scale start sending 0x10 weight frames.
    // Format: [0x22, length, 0xFF, 0x00, measureType, checksum]
    // measureType 0x03 = weight + impedance
    const startCmd = [0x22, 0x06, 0xff, 0x00, 0x03, 0x00];
    startCmd[5] = startCmd.reduce((a, b) => a + b, 0) & 0xff;
    try {
      await writeCmd(startCmd);
    } catch {
      // Best-effort
    }
  }

  /**
   * Name match is sufficient (brand names are unambiguous).
   * UUID fallback covers unnamed devices advertising QN vendor services.
   *
   * Note: openScale requires BOTH name AND UUID, but on Linux (node-ble / BlueZ
   * D-Bus) advertised service UUIDs are not available before connection, so
   * name-only matching is needed for auto-discovery without SCALE_MAC.
   */
  matches(device: BleDeviceInfo): boolean {
    // AABB broadcast protocol (0xFFFF company ID + 0xAABB magic header)
    if (device.manufacturerData) {
      const { id, data } = device.manufacturerData;
      if (id === 0xffff && data.length >= 19 && data[0] === 0xaa && data[1] === 0xbb) {
        return true;
      }
    }

    const name = (device.localName || '').toLowerCase();
    const nameMatch =
      name.includes('qn-scale') ||
      name.includes('renpho') ||
      name.includes('senssun') ||
      name.includes('sencor');
    if (nameMatch) return true;

    // Fallback: match by QN vendor service UUID for unnamed devices
    const uuids = (device.serviceUuids || []).map((u) => u.toLowerCase());
    if (
      uuids.some(
        (u) => u === SVC_T1 || u === SVC_T2 || u === uuid16(0xffe0) || u === uuid16(0xfff0),
      )
    ) {
      return true;
    }

    return false;
  }

  /**
   * Parse QN vendor notifications.
   *
   * 0x10 — weight frame (>= 10 bytes):
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

  /**
   * Parse AABB broadcast protocol (manufacturer data with company ID 0xFFFF).
   *
   * Layout (after company ID bytes):
   *   [0-1]   0xAABB — magic header
   *   [2-7]   MAC address of the device
   *   [8]     sequence / status byte
   *   [9-14]  unknown
   *   [15]    status flags — bit 5 (0x20) = measurement stable
   *   [16]    unknown
   *   [17-18] weight: little-endian uint16 / 100 = kg
   *   [19-22] unknown (possibly impedance/checksum)
   *
   * No impedance is available from the broadcast — body composition is estimated
   * using the Deurenberg formula (BMI + age + gender).
   */
  parseBroadcast(manufacturerData: Buffer): ScaleReading | null {
    if (manufacturerData.length < 19) return null;
    if (manufacturerData[0] !== 0xaa || manufacturerData[1] !== 0xbb) return null;

    // Only accept stable readings (bit 5 of byte 15 = "measurement settled")
    if ((manufacturerData[15] & 0x20) === 0) return null;

    const weight = manufacturerData.readUInt16LE(17) / 100;
    if (weight <= 0 || !Number.isFinite(weight)) return null;

    return { weight, impedance: 0 };
  }

  isComplete(reading: ScaleReading): boolean {
    // Broadcast readings have impedance=0; GATT readings have impedance>200
    if (reading.impedance === 0) return reading.weight > 0;
    return reading.weight > 10 && reading.impedance > 200;
  }

  computeMetrics(reading: ScaleReading, profile: UserProfile): BodyComposition {
    // In broadcast mode impedance is 0 — skip BIA, let buildPayload use Deurenberg fallback
    const fat =
      reading.impedance > 0 ? computeBiaFat(reading.weight, reading.impedance, profile) : undefined;
    return buildPayload(reading.weight, reading.impedance, { fat }, profile);
  }
}
