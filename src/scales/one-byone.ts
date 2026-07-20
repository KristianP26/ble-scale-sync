import type {
  BleDeviceInfo,
  ConnectionContext,
  ScaleAdapterCore,
  GattWiring,
  Unlockable,
  ScaleReading,
  UserProfile,
  BodyComposition,
} from '../interfaces/scale-adapter.js';
import { uuid16, buildPayload, xorChecksum, type ScaleBodyComp } from './body-comp-helpers.js';
import { matchesDescriptor, type MatchDescriptor } from './match-descriptor.js';

/**
 * Hold window (ms) for the weight-stability gate (#284). 1byone frames stream
 * continuously with no "measurement locked" flag, so resolving on the first
 * weight>0 frame could export a value while the person was still settling.
 * Instead we hold the link open and resolve once two consecutive frames report
 * the same weight (isFinal). If that never happens within the window, shared.ts
 * resolves the last held reading, so no reading is ever lost.
 */
const WEIGHT_STABLE_HOLD_MS = 3000;

// ─── OneByoneAdapter (Eufy C1/P1, Health Scale) ─────────────────────────────

/**
 * Adapter for Eufy C1/P1/A1 and "Health Scale" branded 1byone devices.
 *
 * Protocol: service 0xFFF0, notify 0xFFF4, write 0xFFF1.
 * Unlock via clock-sync frame: [0xF1, yearHi, yearLo, month, day, hour, min, sec].
 * Measurement frames begin with 0xCF header.
 *   Weight at bytes [3-4] little-endian uint16 / 100 (kg).
 *   Impedance: ((data[2]<<8)+data[1]) * 0.1, valid when byte[9] != 1 and != 0.
 */
export class OneByoneAdapter implements ScaleAdapterCore, GattWiring {
  readonly name = '1byone (Eufy)';
  readonly match: MatchDescriptor = {
    priority: 70,
    custom: true,
    names: { includes: ['t9146', 't9147', 't9120', 'health scale'] },
    charUuids: ['fff4'],
  };
  readonly charNotifyUuid = uuid16(0xfff4);
  readonly charWriteUuid = uuid16(0xfff1);
  readonly normalizesWeight = true;

  /** Raw weight (hundredths of kg) of the previous frame this session. */
  private previousRawWeight: number | null = null;
  /** True once two consecutive frames reported the same weight. */
  private weightStable = false;

  matches(device: BleDeviceInfo): boolean {
    // Name match is unambiguous (T914x / Health Scale); keep it.
    const name = (device.localName || '').toLowerCase();
    if (this.match.names?.includes?.some((n) => name.includes(n))) return true;

    const chars = (device.characteristicUuids ?? []).map((u) => u.toLowerCase());
    if (chars.length === 0) return false;
    // Post-discovery: 0xFFF4 identifies the 1byone family, but the Eufy P2 also
    // exposes 0xFFF4 alongside 0xFFF2 + its auth char. A real 1byone C1/P1 uses
    // fff1 + fff4 and never fff2, so require fff4 WITHOUT fff2. This stops a
    // nameless Eufy P2 reaching an mqtt-proxy autonomous connect from being
    // driven with the wrong 1byone protocol (it falls through to its own
    // adapter via the notify-char fallback instead).
    return chars.includes(uuid16(0xfff4)) && !chars.includes(uuid16(0xfff2));
  }

  /**
   * Init sequence per openScale OneByoneHandler:
   *   1. Mode/unit command: [0xFD, 0x37, unit, group, ...padding, XOR]
   *   2. Clock sync: [0xF1, yearHi, yearLo, month, day, hour, min, sec]
   */
  async onConnected(ctx: ConnectionContext): Promise<void> {
    this.previousRawWeight = null;
    this.weightStable = false;

    // Step 1: Mode/unit command
    const unitCmd = [0xfd, 0x37, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00];
    unitCmd.push(xorChecksum(unitCmd, 0, unitCmd.length));
    await ctx.write(this.charWriteUuid, unitCmd, false);

    // Step 2: Clock sync
    const now = new Date();
    const clockCmd = [
      0xf1,
      (now.getFullYear() >> 8) & 0xff,
      now.getFullYear() & 0xff,
      now.getMonth() + 1,
      now.getDate(),
      now.getHours(),
      now.getMinutes(),
      now.getSeconds(),
    ];
    await ctx.write(this.charWriteUuid, clockCmd, false);
  }

  parseNotification(data: Buffer): ScaleReading | null {
    if (data.length < 5 || data[0] !== 0xcf) return null;

    const rawWeight = data.readUInt16LE(3);
    const weight = rawWeight / 100;

    let impedance = 0;
    if (data.length >= 10) {
      const rawImp = ((data[2] << 8) + data[1]) * 0.1;
      const impedanceInvalid = data[9] === 1 || rawImp === 0;
      if (!impedanceInvalid) {
        impedance = rawImp;
      }
    }

    this.weightStable = this.previousRawWeight === rawWeight;
    this.previousRawWeight = rawWeight;

    return { weight, impedance };
  }

  isComplete(reading: ScaleReading): boolean {
    return reading.weight > 0;
  }

  /**
   * Hold the link open after the first weight so it can settle, rather than
   * exporting the first frame while the person is still stepping on.
   */
  readonly completionHoldMs = WEIGHT_STABLE_HOLD_MS;

  /** Resolve immediately once the weight has stabilized across two frames. */
  isFinal(_reading: ScaleReading): boolean {
    return this.weightStable;
  }

  computeMetrics(reading: ScaleReading, profile: UserProfile): BodyComposition {
    const comp: ScaleBodyComp = {};
    return buildPayload(reading.weight, reading.impedance, comp, profile);
  }
}

// ─── OneByoneNewAdapter (1byone scale — newer protocol) ─────────────────────

/**
 * Adapter for the newer "1byone scale" branded device.
 *
 * Protocol: service 0xFFB0, notify 0xFFB2, write 0xFFB1.
 * All frames begin with [0xAB, 0x2A].
 *   Type at byte[2]:
 *     0x80 = final weight: bytes [3-5] 24-bit big-endian, mask 0x03FFFF, /1000 (kg).
 *     0x01 = impedance: bytes [4-5] big-endian uint16.
 *     0x00 with byte[7]=0x80 = history (ignored).
 */
export class OneByoneNewAdapter implements ScaleAdapterCore, GattWiring, Unlockable {
  readonly name = '1byone Scale (new)';
  readonly match: MatchDescriptor = {
    priority: 60,
    names: { exact: ['1byone scale'] },
  };
  readonly charNotifyUuid = uuid16(0xffb2);
  readonly charWriteUuid = uuid16(0xffb1);
  readonly normalizesWeight = true;
  readonly unlockCommand = [
    0xab, 0x2a, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0xd7,
  ];
  readonly unlockIntervalMs = 0;

  private cachedWeight = 0;
  private cachedImpedance = 0;

  matches(device: BleDeviceInfo): boolean {
    return matchesDescriptor(device, this.match);
  }

  parseNotification(data: Buffer): ScaleReading | null {
    if (data.length < 3 || data[0] !== 0xab || data[1] !== 0x2a) return null;

    const type = data[2];

    if (type === 0x80 && data.length >= 6) {
      // Final weight frame: 24-bit BE at [3-5], mask lower 18 bits
      const raw24 = (data[3] << 16) | (data[4] << 8) | data[5];
      this.cachedWeight = (raw24 & 0x03ffff) / 1000;
    } else if (type === 0x01 && data.length >= 6) {
      // Impedance frame: BE uint16 at [4-5]
      this.cachedImpedance = (data[4] << 8) | data[5];
    } else if (type === 0x00 && data.length >= 8 && data[7] === 0x80) {
      // History frame — ignored
      return null;
    }

    if (this.cachedWeight <= 0) return null;

    return { weight: this.cachedWeight, impedance: this.cachedImpedance };
  }

  isComplete(reading: ScaleReading): boolean {
    return reading.weight > 0 && reading.impedance > 0;
  }

  computeMetrics(reading: ScaleReading, profile: UserProfile): BodyComposition {
    const comp: ScaleBodyComp = {};
    return buildPayload(reading.weight, reading.impedance, comp, profile);
  }
}
