import type {
  BleDeviceInfo,
  ConnectionContext,
  ScaleAdapterCore,
  GattWiring,
  ScaleReading,
  UserProfile,
  BodyComposition,
} from '../interfaces/scale-adapter.js';
import { uuid16, buildPayload } from './body-comp-helpers.js';
import type { MatchDescriptor } from './match-descriptor.js';
import { bleLog } from '../ble/types.js';

// Service 0x1A10 — custom Renpho scale service (shared with ES-26BB)
const CHR_CONTROL = uuid16(0x2a11); // write  — commands to scale
const CHR_STATUS = uuid16(0x2a10); // notify — status / progress
const CHR_RESULTS = uuid16(0x2a12); // indicate — final BIA measurement

// 55-AA frame magic
const MAGIC0 = 0x55;
const MAGIC1 = 0xaa;

// Request a measurement session.
// Identical to ES-26BB start command: 55 AA 90 00 04 01 00 00 00 94
const START_CMD = [0x55, 0xaa, 0x90, 0x00, 0x04, 0x01, 0x00, 0x00, 0x00, 0x94];

// Ack a cached offline measurement so the scale stops replaying it on every
// connect.  Last byte = sum(prev) & 0xFF = (55+AA+95+00+01+01) & FF = 96.
const OFFLINE_ACK = [0x55, 0xaa, 0x95, 0x00, 0x01, 0x01, 0x96];

// Command bytes on the indication characteristic
const CMD_MEAS_SHORT = 0x25; // 36-byte payload (post-composition result)
const CMD_MEAS_LONG = 0x26; // 40-byte payload (pre-composition + result)

/**
 * Extended scale reading that carries the pre-computed BIA metrics the
 * R-MSC04 transmits in the indication frame.  Stored on the adapter instance
 * between parseNotification() and computeMetrics().
 */
interface ExtendedBia {
  bodyFatPct: number;
  bmi: number;
  skelMuscleMassKg: number;
  boneMassKg: number;
  visceralFat: number;
}

function isChecksumValid(data: Buffer): boolean {
  if (data.length < 2) return false;
  let sum = 0;
  for (let i = 0; i < data.length - 1; i++) sum = (sum + data[i]) & 0xff;
  return sum === data[data.length - 1];
}

/**
 * Adapter for the Renpho R-MSC04 body composition scale.
 *
 * ─── GATT layout (service 0x1A10) ───────────────────────────────────────────
 *   0x2A11  write    — send 55-AA commands (start, offline ack)
 *   0x2A10  notify   — status / progress events (not parsed here)
 *   0x2A12  indicate — final BIA measurement frame (55-AA cmd 0x25 / 0x26)
 *
 * ─── Session flow ───────────────────────────────────────────────────────────
 *   1. Write START_CMD to 0x2A11 after connect.
 *   2. Scale streams status notifications on 0x2A10 (ignored).
 *   3. Scale sends final measurement indication on 0x2A12.
 *   4. Ack with OFFLINE_ACK so cached frames are cleared from scale memory.
 *
 * ─── Measurement frame layout (55-AA frame on 0x2A12) ──────────────────────
 *   [0-1]  magic: 55 AA
 *   [2]    cmd:   0x25 (short) | 0x26 (long, 4 extra bytes before weight)
 *   [3]    sub:   0x00
 *   [4]    payload_len: 0x24 (36) | 0x28 (40)
 *   [5 .. 5+payload_len-1]  payload:
 *     [0]        user_id
 *     [1-2]      sequence (LE uint16)
 *     [3]        flags/padding (cmd 0x25)  ← body_start = 4
 *     [3-6]      extra fields  (cmd 0x26)  ← body_start = 8
 *     body[0-1]  weight           BE uint16 / 100   → kg
 *     body[2-3]  padding          0x0A 0x00
 *     body[4-5]  unknown_A        LE uint16
 *     body[6-7]  unknown_B        LE uint16
 *     body[8-9]  BIA impedance    LE uint16 / 10    → Ω  (~181 Ω typical)
 *     body[10-11] body fat %      LE uint16 / 100   → %
 *     body[12-13] unknown_C       LE uint16
 *     body[14-15] BMI             LE uint16 / 100
 *     body[16-17] unknown_D       LE uint16
 *     body[18-19] unknown_E       LE uint16
 *     body[20-21] unknown_F       LE uint16
 *     body[22-23] skeletal muscle LE uint16 / 10    → kg
 *     body[24-25] bone mass       BE uint16 / 100   → kg
 *     body[26..]  remaining (not yet decoded)
 *     payload[last]  visceral fat rating (raw byte)
 *   [5+payload_len]  checksum  (sum of all preceding bytes & 0xFF)
 *
 * Verified against two captured weigh-in sessions (macOS HCI capture):
 *   cmd 0x26: weight=78.80 kg  fat=19.88%  muscle=44.0 kg  bone=1.94 kg  visceral=5
 *   cmd 0x25: weight=78.05 kg  fat=19.67%  muscle=42.8 kg  bone=1.90 kg  visceral=5
 */
export class RenphoMsc04Adapter implements ScaleAdapterCore, GattWiring {
  readonly name = 'Renpho R-MSC04';
  readonly match: MatchDescriptor = {
    // Sit between ES-26BB (230) and the generic Renpho ES-WBE28 (240).
    priority: 235,
    names: { exact: ['r-msc04'] },
    manufacturerId: 0x1a10,
    custom: true,
  };
  readonly charNotifyUuid = CHR_RESULTS;
  readonly charWriteUuid = CHR_CONTROL;
  readonly normalizesWeight = true;

  private ctx: ConnectionContext | null = null;
  private _bia: ExtendedBia | null = null;

  matches(device: BleDeviceInfo): boolean {
    const name = (device.localName ?? '').toLowerCase();
    if (name === 'r-msc04') return true;
    // Secondary match: Renpho company ID 0x1A10 in manufacturer data
    if (device.manufacturerData?.id === 0x1a10) return true;
    return false;
  }

  async onConnected(ctx: ConnectionContext): Promise<void> {
    this.ctx = ctx;

    // Subscribe to the status notify char (best-effort — non-fatal if absent).
    const statusNorm = CHR_STATUS.replace(/-/g, '');
    if (ctx.availableChars.has(statusNorm)) {
      try {
        await ctx.subscribe(CHR_STATUS);
      } catch (e) {
        bleLog.debug(
          `R-MSC04: status char subscribe failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }

    // Kick off a measurement session.
    try {
      await ctx.write(CHR_CONTROL, START_CMD, false);
      bleLog.debug(
        `R-MSC04: start cmd sent [${START_CMD.map((b) => b.toString(16).padStart(2, '0')).join(' ')}]`,
      );
    } catch (e) {
      bleLog.warn(`R-MSC04: start cmd failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * Parse a 55-AA indication frame from the R-MSC04 (0x2A12).
   *
   * Only cmd 0x25 and 0x26 measurement frames are returned as readings; all
   * other 55-AA commands (status, ack confirmations, etc.) return null.
   * After a successful parse, an offline-ack is fired so the scale clears
   * the cached frame and does not replay it on the next connect.
   */
  parseNotification(data: Buffer): ScaleReading | null {
    // Minimum: 55 AA cmd sub len  + at least 26 body bytes + checksum
    if (data.length < 33) return null;
    if (data[0] !== MAGIC0 || data[1] !== MAGIC1) return null;

    const cmd = data[2];
    if (cmd !== CMD_MEAS_SHORT && cmd !== CMD_MEAS_LONG) return null;

    const payloadLen = data[4];
    const expectedTotal = 5 + payloadLen + 1;
    if (data.length < expectedTotal) {
      bleLog.debug(`R-MSC04: frame too short (got=${data.length} want=${expectedTotal})`);
      return null;
    }

    const frame = data.slice(0, expectedTotal);
    if (!isChecksumValid(frame)) {
      bleLog.debug('R-MSC04: dropping frame with bad checksum');
      return null;
    }

    const payload = data.slice(5, 5 + payloadLen);
    // body_start: 4 for cmd 0x25, 8 for cmd 0x26 (4 extra header bytes)
    const bodyStart = cmd === CMD_MEAS_LONG ? 8 : 4;

    if (payload.length < bodyStart + 26) {
      bleLog.debug('R-MSC04: payload too short for body composition fields');
      return null;
    }

    const weightRaw = payload.readUInt16BE(bodyStart + 0);
    const weight = weightRaw / 100;
    if (weight <= 0 || !Number.isFinite(weight)) return null;

    const impedance = payload.readUInt16LE(bodyStart + 8) / 10; // Ω
    const bodyFatPct = payload.readUInt16LE(bodyStart + 10) / 100;
    const bmi = payload.readUInt16LE(bodyStart + 14) / 100;
    const skelMuscleMassKg = payload.readUInt16LE(bodyStart + 22) / 10;
    const boneMassKg = payload.readUInt16BE(bodyStart + 24) / 100;
    const visceralFat = payload[payload.length - 1];

    bleLog.debug(
      `R-MSC04: weight=${weight}kg fat=${bodyFatPct}% bmi=${bmi} ` +
        `muscle=${skelMuscleMassKg}kg bone=${boneMassKg}kg ` +
        `visceral=${visceralFat} Z=${impedance}Ω`,
    );

    this._bia = { bodyFatPct, bmi, skelMuscleMassKg, boneMassKg, visceralFat };

    // Fire-and-forget ack so cached frames are cleared from scale memory.
    void this.sendOfflineAck();

    return { weight, impedance };
  }

  isComplete(reading: ScaleReading): boolean {
    return reading.weight > 10 && reading.impedance > 0;
  }

  /**
   * Build the full BodyComposition output.
   *
   * Pre-computed BIA values from the scale (fat%, muscle mass, bone mass,
   * visceral fat) are passed directly to buildPayload() so they override the
   * generic BIA estimation formulas.  The scale's on-device calculation uses
   * the user profile stored in the Renpho app; the HA user profile is used
   * only for the derived fields that the scale does not transmit (BMR,
   * metabolic age, physique rating).
   */
  computeMetrics(reading: ScaleReading, profile: UserProfile): BodyComposition {
    const bia = this._bia;
    return buildPayload(
      reading.weight,
      reading.impedance,
      {
        fat: bia?.bodyFatPct,
        bone: bia?.boneMassKg,
        // buildPayload expects muscle% of body weight; scale gives absolute kg
        muscle: bia != null ? (bia.skelMuscleMassKg / reading.weight) * 100 : undefined,
        visceralFat: bia?.visceralFat,
      },
      profile,
    );
  }

  private async sendOfflineAck(): Promise<void> {
    const ctx = this.ctx;
    if (!ctx) return;
    try {
      await ctx.write(CHR_CONTROL, OFFLINE_ACK, true);
      bleLog.debug('R-MSC04: offline ack sent');
    } catch (e) {
      bleLog.warn(
        `R-MSC04: offline ack failed (scale may replay cached frame on next connect): ` +
          `${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
}
