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
 * Adapter for the ES-CS20M BLE body-composition scale.
 *
 * Protocol details:
 *   - Service 0x1A10, notify 0x2A10, write 0x2A11
 *   - Start measurement command: [0x55, 0xAA, 0x90, ...]
 *   - Message ID 0x14 (weight frame): stability, weight, optional resistance
 *   - Message ID 0x15 (extended frame): resistance at bytes [9-10]
 *   - Weight at [8-9] big-endian uint16 / 100 (kg)
 *   - Complete when weight > 0 and measurement is stable
 */
export class EsCs20mAdapter implements ScaleAdapter {
  readonly name = 'ES-CS20M';
  readonly charNotifyUuid = CHR_NOTIFY;
  readonly charWriteUuid = CHR_WRITE;
  readonly normalizesWeight = true;
  readonly unlockCommand = [0x55, 0xaa, 0x90, 0x00, 0x04, 0x01, 0x00, 0x00, 0x00, 0x94];
  readonly unlockIntervalMs = 0;

  private stable = false;
  private resistance = 0;

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
   * Two message types are handled:
   *
   * ID 0x14 — weight frame:
   *   [5]      stability flag (!=0 means stable)
   *   [8-9]    weight, big-endian uint16 / 100 (kg)
   *   [10-11]  resistance, big-endian uint16 (optional)
   *
   * ID 0x15 — extended frame:
   *   [9-10]   resistance, big-endian uint16
   */
  parseNotification(data: Buffer): ScaleReading | null {
    if (data.length < 2) return null;

    // Robust msgId: try data[2] first (with 55 AA header), fall back to data[0] (stripped)
    const msgId = data.length > 2 && (data[2] === 0x14 || data[2] === 0x15) ? data[2] : data[0];

    if (msgId === 0x15) {
      // Extended frame — resistance only
      if (data.length >= 11) {
        this.resistance = data.readUInt16BE(9);
      }
      return null;
    }

    if (msgId !== 0x14) return null;
    if (data.length < 10) return null;

    this.stable = data[5] !== 0;
    const weight = data.readUInt16BE(8) / 100;

    if (weight <= 0 || !Number.isFinite(weight)) return null;

    // Optional resistance in the weight frame
    if (data.length >= 12) {
      const r = data.readUInt16BE(10);
      if (r > 0) this.resistance = r;
    }

    return { weight, impedance: this.resistance };
  }

  isComplete(reading: ScaleReading): boolean {
    return reading.weight > 0 && this.stable;
  }

  computeMetrics(reading: ScaleReading, profile: UserProfile): BodyComposition {
    const comp: ScaleBodyComp = {};
    return buildPayload(reading.weight, reading.impedance, comp, profile);
  }
}
