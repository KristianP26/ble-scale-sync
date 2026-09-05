import type {
  BleDeviceInfo,
  ScaleAdapterCore,
  GattWiring,
  Unlockable,
  AckProtocol,
  HoldForComposition,
  ScaleReading,
  UserProfile,
  BodyComposition,
} from '../interfaces/scale-adapter.js';
import { uuid16, buildPayload } from './body-comp-helpers.js';
import type { MatchDescriptor } from './match-descriptor.js';

// Beurer/Sanitas custom BLE service + characteristic
const CHR_FFE1 = uuid16(0xffe1);

/** Known device name prefixes/substrings for Beurer / Sanitas / RT-Libra scales. */
const KNOWN_NAMES = [
  'bf-700',
  'beurer bf700',
  'bf-800',
  'beurer bf800',
  'rt-libra-b',
  'rt-libra-w',
  'libra-b',
  'libra-w',
  'bf700',
  'beurer bf710',
  'sanitas sbf70',
  'sbf75',
  'aicdscale1',
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
 *   - BF700/800 (start byte 0xF7): weight at bytes [4-5] BE, 16-byte composition frame
 *   - BF710/SBF70/SBF75 (start byte 0xE7): weight at bytes [3-4] BE in compact 5-byte 0x58 frames
 *   - Weight is big-endian * 50 / 1000 (50g resolution) in both variants
 *
 * The protocol uses a multi-step handshake (INIT, SET_TIME, SCALE_STATUS)
 * with alternating start bytes depending on device variant.
 * We simplify to a periodic INIT command as the unlock.
 *
 * For the BF710/SBF70 variant we apply a stability window (last N weights within
 * tolerance) to ignore the initial metadata frame the scale sends before the
 * user has stepped on.
 */
const BF710_STABILITY_COUNT = 3;
const BF710_STABILITY_TOLERANCE_KG = 0.3;
// Snoop shows composition lands ~10-12 s after the weight first stabilizes;
// 15 s leaves margin without holding an unregistered scale's link too long.
const BF710_COMPOSITION_HOLD_MS = 15000;

export class BeurerSanitasScaleAdapter
  implements ScaleAdapterCore, GattWiring, Unlockable, AckProtocol, HoldForComposition
{
  readonly name = 'Beurer / Sanitas';
  readonly match: MatchDescriptor = {
    priority: 180,
    custom: true,
    names: {
      includes: [
        'bf-700',
        'beurer bf700',
        'bf-800',
        'beurer bf800',
        'rt-libra-b',
        'rt-libra-w',
        'libra-b',
        'libra-w',
        'bf700',
        'beurer bf710',
        'sanitas sbf70',
        'sbf75',
        'aicdscale1',
      ],
    },
  };
  readonly charNotifyUuid = CHR_FFE1;
  readonly charWriteUuid = CHR_FFE1;
  readonly normalizesWeight = true;
  readonly unlockIntervalMs = 5000;

  private isBf710Type = false;
  private readingBuffer: number[] = [];

  /** INIT command: F7 01 for BF700/800, E7 01 for BF710/Sanitas. */
  get unlockCommand(): number[] {
    return this.isBf710Type ? [0xe7, 0x01] : [0xf7, 0x01];
  }
  private cachedComp: CachedComp | null = null;

  /** Accumulated 0x59 composition parts (part number -> payload after byte 4). */
  private compParts = new Map<number, Buffer>();

  /** Per-frame ACK echoing bytes [1..3]; BF710/SBF70 gate the 0x59 stream on it. */
  buildAck(data: Buffer): number[] | null {
    if (data.length >= 4 && data[0] === 0xe7) {
      return [0xe7, 0xf1, data[1], data[2], data[3]];
    }
    return null;
  }

  /** Hold the link for the bioimpedance step only on the BF710/SBF70 variant. */
  get completionHoldMs(): number | undefined {
    return this.isBf710Type ? BF710_COMPOSITION_HOLD_MS : undefined;
  }

  /** A reading carrying impedance is the final composition reading. */
  isFinal(reading: ScaleReading): boolean {
    return reading.impedance > 0;
  }

  matches(device: BleDeviceInfo): boolean {
    const name = (device.localName || '').toLowerCase();
    const matched = KNOWN_NAMES.some((n) => name.includes(n));
    if (matched) {
      this.isBf710Type =
        name.includes('bf710') || name.includes('sbf7') || name.includes('aicdscale');
    }
    return matched;
  }

  /**
   * Parse a Beurer/Sanitas notification frame.
   *
   * BF700/BF800 weight-only frame (command 0x58):
   *   [0-3]   timestamp (BE uint32, Unix seconds)
   *   [4-5]   weight (BE uint16, * 50 / 1000 for kg)
   *
   * BF700/BF800 full composition frame (command 0x59, two parts merged):
   *   [0-3]   timestamp
   *   [4-5]   weight (BE uint16, * 50 / 1000)
   *   [6-7]   impedance (BE uint16)
   *   [8-9]   fat (BE uint16, / 10)
   *   [10-11] water (BE uint16, / 10)
   *   [12-13] muscle (BE uint16, / 10)
   *   [14-15] bone (BE uint16, * 50 / 1000)
   *
   * BF710/SBF70/SBF75 compact weight frame (5 bytes, command 0x58):
   *   [0]     start byte 0xE7
   *   [1]     cmd 0x58
   *   [2]     flag (0x01 = user on scale, 0x00 = off)
   *   [3-4]   weight (BE uint16, * 50 / 1000)
   *
   * BF710/SBF70/SBF75 finalize frame (command 0x59) streams body composition
   * in multiple parts (see parseBf710Composition). The scale only advances the
   * stream when each frame is acknowledged (buildAck); an all-zero composition
   * (unregistered user) falls back to the weight-only stability window.
   */
  parseNotification(data: Buffer): ScaleReading | null {
    if (this.isBf710Type) {
      return this.parseBf710Notification(data);
    }

    if (data.length < 6) return null;

    const weight = (data.readUInt16BE(4) * 50) / 1000;
    if (weight <= 0 || weight > 300 || !Number.isFinite(weight)) return null;

    let impedance = 0;
    this.cachedComp = null;

    if (data.length >= 16) {
      impedance = data.readUInt16BE(6);

      this.cachedComp = {
        fat: data.readUInt16BE(8) / 10,
        water: data.readUInt16BE(10) / 10,
        muscle: data.readUInt16BE(12) / 10,
        bone: (data.readUInt16BE(14) * 50) / 1000,
      };
    }

    return { weight, impedance };
  }

  private parseBf710Notification(data: Buffer): ScaleReading | null {
    if (data.length < 2 || data[0] !== 0xe7) return null;

    const cmd = data[1];

    if (cmd === 0x58 && data.length >= 5) {
      const weight = (data.readUInt16BE(3) * 50) / 1000;
      if (weight <= 0 || weight > 300 || !Number.isFinite(weight)) return null;

      this.readingBuffer.push(weight);
      if (this.readingBuffer.length > BF710_STABILITY_COUNT) {
        this.readingBuffer.shift();
      }
      this.cachedComp = null;
      return { weight, impedance: 0 };
    }

    if (cmd === 0x59 && data.length >= 4) {
      return this.parseBf710Composition(data);
    }

    return null;
  }

  /**
   * Reassemble the multipart 0x59 composition stream.
   *
   * Frame: [0]=0xE7 [1]=0x59 [2]=count [3]=part [4..]=payload. Part 1 is the
   * user-identification frame (no measurement) so it is skipped. Parts 2..count
   * carry the payload; concatenated they form the same 16-byte big-endian
   * layout as the BF700/800 composition frame (weight@4, impedance@6, fat@8,
   * water@10, muscle@12, bone@14). The scale only advances this stream when each
   * frame is acknowledged (see buildAck); otherwise it stops after part 1. An
   * all-zero composition means an unregistered user, so it is treated as
   * weight-only.
   */
  private parseBf710Composition(data: Buffer): ScaleReading | null {
    const count = data[2];
    const part = data[3];

    if (part <= 1) {
      this.compParts.clear();
      return null;
    }

    this.compParts.set(part, Buffer.from(data.subarray(4)));
    if (part < count) return null;

    const ordered: Buffer[] = [];
    for (let p = 2; p <= count; p++) {
      const chunk = this.compParts.get(p);
      if (!chunk) {
        this.compParts.clear();
        return null;
      }
      ordered.push(chunk);
    }
    this.compParts.clear();

    const merged = Buffer.concat(ordered);
    if (merged.length < 16) return null;

    const weight = (merged.readUInt16BE(4) * 50) / 1000;
    const impedance = merged.readUInt16BE(6);
    const fat = merged.readUInt16BE(8) / 10;
    const water = merged.readUInt16BE(10) / 10;
    const muscle = merged.readUInt16BE(12) / 10;
    const bone = (merged.readUInt16BE(14) * 50) / 1000;

    if (impedance === 0 && fat === 0 && water === 0 && muscle === 0) {
      this.cachedComp = null;
      return null;
    }
    if (weight <= 0 || weight > 300 || !Number.isFinite(weight)) return null;

    this.cachedComp = { fat, water, muscle, bone };
    return { weight, impedance };
  }

  isComplete(reading: ScaleReading): boolean {
    if (this.isBf710Type) {
      if (reading.impedance > 0) return true;
      if (this.readingBuffer.length < BF710_STABILITY_COUNT) return false;
      const min = Math.min(...this.readingBuffer);
      const max = Math.max(...this.readingBuffer);
      return max - min <= BF710_STABILITY_TOLERANCE_KG && reading.weight > 0;
    }
    return reading.weight > 0;
  }

  computeMetrics(reading: ScaleReading, profile: UserProfile): BodyComposition {
    const comp = this.cachedComp;
    if (comp) {
      return buildPayload(
        reading.weight,
        reading.impedance,
        {
          fat: comp.fat,
          water: comp.water,
          muscle: comp.muscle,
          bone: comp.bone,
        },
        profile,
      );
    }

    return buildPayload(reading.weight, reading.impedance, {}, profile);
  }
}
