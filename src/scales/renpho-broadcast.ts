import type {
  BleDeviceInfo,
  ScaleAdapter,
  ScaleReading,
  UserProfile,
  BodyComposition,
} from '../interfaces/scale-adapter.js';
import { buildPayload, type ScaleBodyComp } from './body-comp-helpers.js';

/**
 * Adapter for the broadcast-only variant of the Renpho ES-CS20M scale.
 *
 * This variant does NOT support GATT connections. Instead it broadcasts weight
 * data in the BLE advertisement manufacturer-specific data with company ID 0xFFFF.
 *
 * Manufacturer data layout (after company ID bytes):
 *   [0-1]   0xAABB — magic header
 *   [2-7]   MAC address of the device
 *   [8]     sequence / status byte (changes each broadcast)
 *   [9-14]  unknown
 *   [15]    status flags — bit 5 (0x20) = measurement stable
 *   [16]    unknown
 *   [17-18] weight: little-endian uint16 / 100 = kg
 *   [19-22] unknown (possibly impedance/checksum)
 *
 * No impedance is available from the broadcast — body composition is estimated
 * using the Deurenberg formula (BMI + age + gender).
 */
export class RenphoBroadcastAdapter implements ScaleAdapter {
  readonly name = 'Renpho Broadcast (ES-CS20M)';
  readonly charNotifyUuid = '';
  readonly charWriteUuid = '';
  readonly unlockCommand: number[] = [];
  readonly unlockIntervalMs = 0;
  readonly normalizesWeight = true;

  matches(device: BleDeviceInfo): boolean {
    if (!device.manufacturerData) return false;
    if (device.manufacturerData.id !== 0xffff) return false;
    const data = device.manufacturerData.data;
    // Must have the 0xAABB magic header and enough bytes for weight
    return data.length >= 19 && data[0] === 0xaa && data[1] === 0xbb;
  }

  parseBroadcast(manufacturerData: Buffer): ScaleReading | null {
    if (manufacturerData.length < 19) return null;
    if (manufacturerData[0] !== 0xaa || manufacturerData[1] !== 0xbb) return null;

    // Only accept stable readings (bit 5 of byte 15 = "measurement settled")
    if ((manufacturerData[15] & 0x20) === 0) return null;

    const weight = manufacturerData.readUInt16LE(17) / 100;
    if (weight <= 0 || !Number.isFinite(weight)) return null;

    return { weight, impedance: 0 };
  }

  parseNotification(_data: Buffer): ScaleReading | null {
    // Broadcast-only — no GATT notifications
    return null;
  }

  isComplete(reading: ScaleReading): boolean {
    return reading.weight > 0;
  }

  computeMetrics(reading: ScaleReading, profile: UserProfile): BodyComposition {
    const comp: ScaleBodyComp = {};
    return buildPayload(reading.weight, 0, comp, profile);
  }
}
