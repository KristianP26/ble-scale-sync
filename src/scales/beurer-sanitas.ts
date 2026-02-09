import type { Peripheral } from '@abandonware/noble';
import type {
  ScaleAdapter,
  ScaleReading,
  UserProfile,
  GarminPayload,
} from '../interfaces/scale-adapter.js';
import { uuid16, buildPayload, r2 } from './body-comp-helpers.js';

// Beurer/Sanitas custom BLE service + characteristic
const SVC_FFE0 = uuid16(0xffe0);
const CHR_FFE1 = uuid16(0xffe1);

/** Known device name prefixes/substrings for Beurer / Sanitas / RT-Libra scales. */
const KNOWN_NAMES = [
  'bf-700', 'beurer bf700', 'bf-800', 'beurer bf800',
  'rt-libra-b', 'rt-libra-w', 'libra-b', 'libra-w',
  'bf700', 'beurer bf710',
  'sanitas sbf70', 'sbf75', 'aicdscale1',
];

interface CachedComp {
  fat: number;
  water: number;
  muscle: number;
  bone: number;
}

/**
 * Adapter for Beurer BF700/BF710/BF800 and Sanitas SBF70/SBF75 scales,
 * plus RT-Libra variants.
 *
 * Protocol ported from openScale's BeurerSanitasHandler:
 *   - Service 0xFFE0, characteristic 0xFFE1 (notify + write)
 *   - Weight at bytes [4-5] big-endian * 50 / 1000 (50g resolution)
 *   - Impedance at bytes [6-7] big-endian
 *   - Fat/water/muscle/bone in follow-up composition frame
 *
 * The protocol uses a multi-step handshake (INIT, SET_TIME, SCALE_STATUS)
 * with alternating start bytes depending on device variant.
 * We simplify to a periodic INIT command as the unlock.
 */
export class BeurerSanitasScaleAdapter implements ScaleAdapter {
  readonly name = 'Beurer / Sanitas';
  readonly charNotifyUuid = CHR_FFE1;
  readonly charWriteUuid = CHR_FFE1;
  /** INIT command — F7 01 for BF700/800, E7 01 for BF710/Sanitas. */
  readonly unlockCommand = [0xf7, 0x01];
  readonly unlockIntervalMs = 5000;

  private isBf710Type = false;
  private cachedComp: CachedComp | null = null;

  matches(peripheral: Peripheral): boolean {
    const name = (peripheral.advertisement.localName || '').toLowerCase();
    const matched = KNOWN_NAMES.some((n) => name.includes(n));
    if (matched) {
      this.isBf710Type = name.includes('bf710') || name.includes('sbf7')
        || name.includes('aicdscale');
    }
    return matched;
  }

  /**
   * Parse a Beurer/Sanitas notification frame.
   *
   * Weight-only frame (command 0x58):
   *   [0-3]   timestamp (BE uint32, Unix seconds)
   *   [4-5]   weight (BE uint16, * 50 / 1000 for kg)
   *
   * Full composition frame (command 0x59, two parts merged):
   *   [0-3]   timestamp
   *   [4-5]   weight (BE uint16, * 50 / 1000)
   *   [6-7]   impedance (BE uint16)
   *   [8-9]   fat (BE uint16, / 10)
   *   [10-11] water (BE uint16, / 10)
   *   [12-13] muscle (BE uint16, / 10)
   *   [14-15] bone (BE uint16, * 50 / 1000)
   */
  parseNotification(data: Buffer): ScaleReading | null {
    if (data.length < 6) return null;

    const weight = data.readUInt16BE(4) * 50 / 1000;
    if (weight <= 0 || !Number.isFinite(weight)) return null;

    let impedance = 0;
    this.cachedComp = null;

    if (data.length >= 16) {
      impedance = data.readUInt16BE(6);

      this.cachedComp = {
        fat: data.readUInt16BE(8) / 10,
        water: data.readUInt16BE(10) / 10,
        muscle: data.readUInt16BE(12) / 10,
        bone: data.readUInt16BE(14) * 50 / 1000,
      };
    }

    return { weight, impedance };
  }

  isComplete(reading: ScaleReading): boolean {
    return reading.weight > 0;
  }

  computeMetrics(reading: ScaleReading, profile: UserProfile): GarminPayload {
    const comp = this.cachedComp;
    if (comp) {
      return buildPayload(reading.weight, reading.impedance, {
        fat: comp.fat,
        water: comp.water,
        muscle: comp.muscle,
        bone: comp.bone,
      }, profile);
    }

    return buildPayload(reading.weight, reading.impedance, {}, profile);
  }
}
