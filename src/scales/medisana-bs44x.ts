import type {
  BleDeviceInfo,
  ConnectionContext,
  ScaleAdapterCore,
  GattWiring,
  ScaleReading,
  UserProfile,
  BodyComposition,
} from '../interfaces/scale-adapter.js';
import { uuid16, buildPayload, type ScaleBodyComp } from './body-comp-helpers.js';
import { matchesDescriptor, type MatchDescriptor } from './match-descriptor.js';

const CHR_NOTIFY = uuid16(0x8a21);
const CHR_WRITE = uuid16(0x8a81);

/** Seconds from the Unix epoch to 2010-01-01T00:00:00Z. */
export const MEDISANA_EPOCH_2010_OFFSET = 1262304000;

/**
 * Offset to subtract from Unix time for the time-sync command.
 *
 * openScale's MedisanaBs44xHandler predicts the epoch from the name: the
 * BS444/BS440 families ("013197", "013198", "0202b6") count seconds from
 * 2010-01-01, the BS430 ("0203b") and anything unrecognised count Unix
 * seconds. A BS444 sent Unix time sets its clock about 40 years ahead. Without
 * a name (a transport that saw none) Unix stays the default, as in openScale.
 */
export function medisanaTimeEpochOffset(deviceName: string | undefined): number {
  const name = (deviceName ?? '').toLowerCase();
  if (name.startsWith('013197') || name.startsWith('013198') || name.startsWith('0202b6')) {
    return MEDISANA_EPOCH_2010_OFFSET;
  }
  return 0;
}

/** One weigh-in's state, replaced whole in onSessionStart (#394, SCALES.md). */
class MedisanaSession {
  /** Cached weight from weight frames. */
  cachedWeight = 0;
  /** Cached body-composition values from feature frames. */
  cachedComp: ScaleBodyComp = {};
}

/**
 * Adapter for Medisana BS44x / BS440 BLE body-composition scales.
 *
 * Protocol details:
 *   - Service 0x78B2, notify (indicate) 0x8A21, write 0x8A81
 *   - Time sync unlock command: [0x02, t0, t1, t2, t3] (LE u32 unix timestamp)
 *   - Two notification types distinguished by frame length:
 *     - Weight frame (< 16 bytes): weight at [1-2] LE u16 / 100 (kg)
 *     - Feature frame (>= 16 bytes): fat, water, muscle, bone at various offsets
 *   - Values cached across frames; complete when weight > 0 and fat > 0
 */
export class MedisanaBs44xAdapter implements ScaleAdapterCore, GattWiring {
  readonly name = 'Medisana BS44x';
  readonly match: MatchDescriptor = {
    priority: 150,
    // startsWith, not exact: openScale matches all four families by prefix, and
    // these numeric names are firmware-generated, so a unit that appends a
    // suffix was missed by name and depended entirely on the 78b2 service
    // claim (#409).
    names: { startsWith: ['013197', '013198', '0202b6', '0203b'] },
    serviceUuids: ['78b2'],
  };
  readonly charNotifyUuid = CHR_NOTIFY;
  readonly charWriteUuid = CHR_WRITE;

  private s = new MedisanaSession();

  /**
   * Time sync: [0x02, u32 LE seconds]. The epoch depends on the model, which
   * only the advertised name tells apart (see medisanaTimeEpochOffset).
   */
  async onConnected(ctx: ConnectionContext): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    const cmd = Buffer.alloc(5);
    cmd[0] = 0x02;
    cmd.writeUInt32LE(now - medisanaTimeEpochOffset(ctx.deviceName), 1);
    await ctx.write(this.charWriteUuid, [...cmd], true);
  }

  matches(device: BleDeviceInfo): boolean {
    return matchesDescriptor(device, this.match);
  }

  /**
   * Parse a Medisana BS44x notification frame.
   *
   * Weight frame (length < 16):
   *   [1-2]    weight, little-endian uint16 / 100 (kg)
   *
   * Feature frame (length >= 16):
   *   [8-9]    fat %, little-endian uint16 & 0x0FFF / 10
   *   [10-11]  water %, little-endian uint16 & 0x0FFF / 10
   *   [12-13]  muscle %, little-endian uint16 & 0x0FFF / 10
   *   [14-15]  bone mass, little-endian uint16 & 0x0FFF / 10
   */
  parseNotification(data: Buffer): ScaleReading<ScaleBodyComp> | null {
    if (data.length < 3) return null;

    if (data.length >= 16) {
      // Feature frame — body composition data
      const fat = (data.readUInt16LE(8) & 0x0fff) / 10;
      const water = (data.readUInt16LE(10) & 0x0fff) / 10;
      const muscle = (data.readUInt16LE(12) & 0x0fff) / 10;
      const bone = (data.readUInt16LE(14) & 0x0fff) / 10;

      this.s.cachedComp = {
        fat: fat > 0 ? fat : undefined,
        water: water > 0 ? water : undefined,
        muscle: muscle > 0 ? muscle : undefined,
        bone: bone > 0 ? bone : undefined,
      };
    } else {
      // Weight frame
      if (data.length >= 3) {
        const weight = data.readUInt16LE(1) / 100;
        if (weight > 0 && Number.isFinite(weight)) {
          this.s.cachedWeight = weight;
        }
      }
    }

    if (this.s.cachedWeight <= 0) return null;

    return {
      weight: this.s.cachedWeight,
      impedance: 0,
      scaleComposition: { ...this.s.cachedComp },
    };
  }

  onSessionStart(): void {
    this.s = new MedisanaSession();
  }

  isComplete(reading: ScaleReading): boolean {
    return reading.weight > 0 && this.s.cachedComp.fat != null && this.s.cachedComp.fat > 0;
  }

  computeMetrics(reading: ScaleReading<ScaleBodyComp>, profile: UserProfile): BodyComposition {
    // Per-reading snapshot taken in parseNotification(). The live cache is only
    // a fallback for a reading this adapter did not build (direct callers,
    // tests); see `ScaleReading.scaleComposition` for why it cannot be trusted.
    const comp = reading.scaleComposition ?? this.s.cachedComp;
    return buildPayload(reading.weight, reading.impedance, comp, profile);
  }
}
