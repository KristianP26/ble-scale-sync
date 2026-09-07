/**
 * The AABB broadcast path, for QN units that never accept a GATT connection.
 *
 * Pure over the advertisement buffer, with no adapter state involved, which is
 * why it sits outside the class.
 */

import type { ScaleReading } from '../../interfaces/scale-adapter.js';

/**
 * Parse AABB broadcast protocol (manufacturer data with company ID 0xFFFF).
 *
 * Layout (after company ID bytes):
 *   [0-1]   0xAABB magic header
 *   [2-7]   MAC address of the device
 *   [15]    status flags, bit 5 (0x20) = measurement stable
 *   [17-18] weight: little-endian uint16 / 100 = kg
 *
 * No impedance is available from the broadcast. Body composition is estimated
 * using the Deurenberg formula (BMI + age + gender).
 */
export function parseQnBroadcast(manufacturerData: Buffer): ScaleReading | null {
  if (manufacturerData.length < 19) return null;
  if (manufacturerData[0] !== 0xaa || manufacturerData[1] !== 0xbb) return null;

  // Only accept stable readings (bit 5 of byte 15 = "measurement settled")
  if ((manufacturerData[15] & 0x20) === 0) return null;

  const weight = manufacturerData.readUInt16LE(17) / 100;
  if (weight <= 0 || !Number.isFinite(weight)) return null;

  return { weight, impedance: 0 };
}
