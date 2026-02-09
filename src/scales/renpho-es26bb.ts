import type { Peripheral } from '@abandonware/noble';
import type {
  ScaleAdapter,
  ScaleReading,
  UserProfile,
  GarminPayload,
} from '../interfaces/scale-adapter.js';
import { uuid16, buildPayload } from './body-comp-helpers.js';

// Renpho ES-26BB custom service / characteristic UUIDs
const CHR_RESULTS = uuid16(0x2a10); // notify — measurement results
const CHR_CONTROL = uuid16(0x2a11); // write  — commands

/**
 * Adapter for the Renpho ES-26BB-B scale.
 *
 * Protocol ported from openScale's RenphoES26BBHandler:
 *   - Service 0x1A10, notify 0x2A10, write 0x2A11
 *   - Start measurement: 55 AA 90 00 04 01 00 00 00 94
 *   - Live frame (action 0x14): weight at bytes [6-9] BE uint32 / 100, impedance at [10-11] BE uint16
 *   - Offline frame (action 0x15): weight at [5-8] BE uint32 / 100, impedance at [9-10] BE uint16
 */
export class RenphoEs26bbAdapter implements ScaleAdapter {
  readonly name = 'Renpho ES-26BB';
  readonly charNotifyUuid = CHR_RESULTS;
  readonly charWriteUuid = CHR_CONTROL;
  /** START_CMD — initiates a measurement on the scale. */
  readonly unlockCommand = [0x55, 0xaa, 0x90, 0x00, 0x04, 0x01, 0x00, 0x00, 0x00, 0x94];
  readonly unlockIntervalMs = 5000;

  matches(peripheral: Peripheral): boolean {
    const name = (peripheral.advertisement.localName || '').toLowerCase();
    return name === 'es-26bb-b';
  }

  /**
   * Parse an ES-26BB notification frame.
   *
   * Live measurement (action byte = 0x14):
   *   [6-9]   weight (BE uint32 / 100 → kg)
   *   [10-11] impedance (BE uint16)
   *
   * Offline measurement (action byte = 0x15):
   *   [5-8]   weight (BE uint32 / 100 → kg)
   *   [9-10]  impedance (BE uint16)
   */
  parseNotification(data: Buffer): ScaleReading | null {
    if (data.length < 12) return null;

    const action = data[2] ?? data[3];

    let weight: number;
    let impedance: number;

    if (action === 0x14 && data.length >= 12) {
      weight = data.readUInt32BE(6) / 100;
      impedance = data.readUInt16BE(10);
    } else if (action === 0x15 && data.length >= 11) {
      weight = data.readUInt32BE(5) / 100;
      impedance = data.readUInt16BE(9);
    } else {
      return null;
    }

    if (weight <= 0 || !Number.isFinite(weight)) return null;

    return { weight, impedance };
  }

  isComplete(reading: ScaleReading): boolean {
    return reading.weight > 10 && reading.impedance > 0;
  }

  computeMetrics(reading: ScaleReading, profile: UserProfile): GarminPayload {
    return buildPayload(reading.weight, reading.impedance, {}, profile);
  }
}
