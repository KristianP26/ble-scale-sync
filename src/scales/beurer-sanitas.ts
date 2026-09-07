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
import { uuid16, buildPayload, biaFatIfPlausible } from './body-comp-helpers.js';
import { bleLog } from '../ble/types.js';
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

/**
 * Composition the scale computed itself, when it sent one.
 *
 * Every field is optional because a zero is not a measurement. buildPayload
 * gates on `comp.fat ?? estimateBodyFat(...)`, which `0` passes, so a frame
 * carrying a real impedance next to a zeroed fat used to export 0 % body fat,
 * 73 % water and a muscle mass equal to the whole body. The sibling SIG adapter
 * has guarded against exactly that since #211; this one never did.
 */
interface CachedComp {
  fat?: number;
  water?: number;
  muscle?: number;
  bone?: number;
}

/** A scale-reported value, or undefined when the scale reported nothing. */
function measured(v: number): number | undefined {
  return v > 0 ? v : undefined;
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
  /** Composition as it stood when each reading was emitted; see `emit()`. */
  private readonly compByReading = new WeakMap<ScaleReading, CachedComp | null>();

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
    // Latch the variant off the frame itself, not only off the advertised name.
    // `matches()` is the only other place that sets it, and it does not always
    // run: `ble.force_scale_adapter` replaces the matcher wholesale, and a unit
    // advertising a name that is not in KNOWN_NAMES never reaches it either. A
    // BF710/SBF70/SBF75 opens every frame with 0xE7, while a BF700/BF800 frame
    // opens with a Unix timestamp, whose top byte does not reach 0xE7 until
    // 2092. Without this an SBF70 fell through to the BF700 layout, where the
    // 5-byte live frames are too short to parse and the 0x59 finalize frame
    // decodes as a constant 12.80 kg (#384, same symptom as #112).
    if (!this.isBf710Type && data.length >= 2 && data[0] === 0xe7) {
      this.isBf710Type = true;
      bleLog.debug(
        'Beurer/Sanitas: 0xE7 frame seen, switching to the BF710/SBF70/SBF75 frame layout',
      );
    }

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
        fat: measured(data.readUInt16BE(8) / 10),
        water: measured(data.readUInt16BE(10) / 10),
        muscle: measured(data.readUInt16BE(12) / 10),
        bone: measured((data.readUInt16BE(14) * 50) / 1000),
      };
    }

    return this.emit(weight, impedance);
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
      return this.emit(weight, 0);
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

    this.cachedComp = {
      fat: measured(fat),
      water: measured(water),
      muscle: measured(muscle),
      bone: measured(bone),
    };
    return this.emit(weight, impedance);
  }

  /**
   * Build a reading and pin the composition that produced it onto it.
   *
   * `computeMetrics()` runs LATER than the parse that built the reading, and
   * the very next parse nulls `cachedComp`. On the watcher transports
   * (mqtt-proxy, esphome-proxy) that next parse can belong to the NEXT session:
   * `loop.ts` awaits `processReading()` - network exports included - while the
   * watcher is free to open another GATT session. Reading the live cache in
   * `computeMetrics` would then hand the completed reading a null. Weak so the
   * processor dropping a reading frees the snapshot.
   */
  private emit(weight: number, impedance: number): ScaleReading {
    const reading: ScaleReading = { weight, impedance };
    this.compByReading.set(reading, this.cachedComp ? { ...this.cachedComp } : null);
    return reading;
  }

  /**
   * Clear the previous weigh-in's gating state (#394).
   *
   * `readingBuffer` fed the three-sample stability gate, so a second session
   * inherited a full buffer and could satisfy it one frame in, on a weight that
   * had not settled. `compParts` holds partial 0x59 chunks; a session that died
   * mid-stream left them behind and the next reassembly could splice a
   * composition out of two different weigh-ins.
   *
   * Two fields are deliberately NOT cleared here:
   *
   *   - `cachedComp` is read by computeMetrics, which runs after the session is
   *     over. Clearing per-session state that a later computeMetrics reads is
   *     the trap this whole change exists to avoid, and it is why onSessionEnd
   *     was the wrong hook. It does NOT get nulled at the top of every parse -
   *     only on the paths that go on to build a reading (the length/range
   *     guards return first). What holds is the weaker but sufficient
   *     invariant: every path that RETURNS a reading nulls or overwrites it
   *     first, and `emit()` then snapshots it onto that reading. Preserve that
   *     invariant if a fourth return path is ever added.
   *   - `isBf710Type` drives the `unlockCommand` and `completionHoldMs` getters,
   *     which are read at session start before any frame. Clearing the latch
   *     would send [0xF7 0x01] and a 0 ms hold to a BF710 whose advertised name
   *     is not in KNOWN_NAMES, which is the #384 case the latch exists for.
   */
  onSessionStart(): void {
    this.readingBuffer.length = 0;
    this.compParts.clear();
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
    // Per-reading snapshot taken in emit(). `has` rather than `??`, because a
    // null snapshot ("this reading carried no composition") is a real answer
    // and must not fall through to the live cache. The fallback is only for a
    // reading this adapter did not build (direct callers, tests).
    const snapshot = this.compByReading.has(reading)
      ? this.compByReading.get(reading)
      : this.cachedComp;
    const comp = snapshot ?? {};
    // The scale's own figure wins when it sent one. Where it did not, the
    // impedance this adapter already parsed is used rather than thrown away
    // (#386). On the normal path the two arrive together, so this mostly
    // matters for a frame that carried a resistance and a zeroed composition,
    // and under BLE_RAW_CAPTURE, where a rejected trailing weight frame can
    // clear the cache while the captured reading still holds an impedance.
    return buildPayload(
      reading.weight,
      reading.impedance,
      {
        fat: comp.fat ?? biaFatIfPlausible(reading.weight, reading.impedance, profile),
        water: comp.water,
        muscle: comp.muscle,
        bone: comp.bone,
      },
      profile,
    );
  }
}
