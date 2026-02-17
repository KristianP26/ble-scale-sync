import type {
  BleDeviceInfo,
  ScaleAdapter,
  ScaleReading,
  UserProfile,
  BodyComposition,
} from '../interfaces/scale-adapter.js';
import { uuid16, buildPayload, type ScaleBodyComp } from './body-comp-helpers.js';

const CHR_NOTIFY = uuid16(0x2a10);
const CHR_WRITE = uuid16(0x2a11);

/**
 * Adapter for the ES-CS20M BLE body-composition scale (Yunmai lineage).
 *
 * Protocol details:
 *   - Service 0x1A10, notify 0x2A10, write 0x2A11
 *   - Start measurement command: [0x55, 0xAA, 0x90, ...]
 *   - Message ID 0x11 (start/stop frame): byte[5]=0x01 start, byte[5]=0x00 stop
 *   - Message ID 0x14 (weight frame): weight at [8-9], optional resistance at [10-11]
 *   - Message ID 0x15 (extended frame): resistance at bytes [9-10]
 *   - Weight at [8-9] big-endian uint16 / 100 (kg)
 *   - Complete when stable flag is set (some firmware) or STOP frame received (others)
 *
 * Per openScale PR #1300, some firmware variants do not use a per-frame stability
 * flag in 0x14 frames. Instead, stability is signaled by a 0x11 STOP frame.
 * This adapter supports both paths.
 */
export class EsCs20mAdapter implements ScaleAdapter {
  readonly name = 'ES-CS20M';
  readonly charNotifyUuid = CHR_NOTIFY;
  readonly charWriteUuid = CHR_WRITE;
  readonly normalizesWeight = true;
  readonly unlockCommand = [0x55, 0xaa, 0x90, 0x00, 0x04, 0x01, 0x00, 0x00, 0x00, 0x94];
  readonly unlockIntervalMs = 0;

  private stable = false;
  private stopped = false;
  private resistance = 0;
  private lastWeight = 0;

  matches(device: BleDeviceInfo): boolean {
    const name = (device.localName || '').toLowerCase();
    if (name.includes('es-cs20m')) return true;

    // Fallback: match by vendor service UUID (0x1A10) for unnamed devices
    const uuids = (device.serviceUuids || []).map((u) => u.toLowerCase());
    return uuids.some((u) => u === '1a10' || u === uuid16(0x1a10));
  }

  /**
   * Parse an ES-CS20M notification frame.
   *
   * Three message types are handled:
   *
   * ID 0x11 - start/stop frame:
   *   [5]      0x01 = start, 0x00 = stop (measurement complete)
   *
   * ID 0x14 - weight frame:
   *   [5]      stability flag (some firmware only, others always 0)
   *   [8-9]    weight, big-endian uint16 / 100 (kg)
   *   [10-11]  resistance, big-endian uint16 (optional)
   *
   * ID 0x15 - extended frame:
   *   [9-10]   resistance, big-endian uint16
   */
  parseNotification(data: Buffer): ScaleReading | null {
    if (data.length < 2) return null;

    // Robust msgId: try data[2] first (with 55 AA header), fall back to data[0] (stripped)
    const msgId =
      data.length > 2 && (data[2] === 0x11 || data[2] === 0x14 || data[2] === 0x15)
        ? data[2]
        : data[0];

    // 0x11 - start/stop control frame
    if (msgId === 0x11) {
      if (data.length < 6) return null;
      if (data[5] === 0x01) {
        // START: reset state for new measurement
        this.stable = false;
        this.stopped = false;
        this.resistance = 0;
        this.lastWeight = 0;
      } else if (data[5] === 0x00) {
        // STOP: measurement complete, return last accumulated reading
        this.stopped = true;
        if (this.lastWeight > 0) {
          return { weight: this.lastWeight, impedance: this.resistance };
        }
      }
      return null;
    }

    if (msgId === 0x15) {
      // Extended frame - resistance only
      if (data.length >= 11) {
        this.resistance = data.readUInt16BE(9);
      }
      return null;
    }

    if (msgId !== 0x14) return null;
    if (data.length < 10) return null;

    this.stable = data[5] !== 0;
    const weight = data.readUInt16BE(8) / 100;

    // Range validation (0.5-300 kg) filters garbage during initial connection
    if (weight < 0.5 || weight > 300 || !Number.isFinite(weight)) return null;

    // Optional resistance in the weight frame
    if (data.length >= 12) {
      const r = data.readUInt16BE(10);
      if (r > 0) this.resistance = r;
    }

    this.lastWeight = weight;
    return { weight, impedance: this.resistance };
  }

  isComplete(reading: ScaleReading): boolean {
    return reading.weight > 0 && (this.stable || this.stopped);
  }

  computeMetrics(reading: ScaleReading, profile: UserProfile): BodyComposition {
    const comp: ScaleBodyComp = {};
    return buildPayload(reading.weight, reading.impedance, comp, profile);
  }
}
