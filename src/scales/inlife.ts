import type {
  BleDeviceInfo,
  ConnectionContext,
  ScaleAdapter,
  ScaleReading,
  UserProfile,
  GarminPayload,
} from '../interfaces/scale-adapter.js';
import { uuid16, buildPayload, xorChecksum, type ScaleBodyComp } from './body-comp-helpers.js';

const SVC_UUID = uuid16(0xfff0);
const CHR_NOTIFY = uuid16(0xfff1);
const CHR_WRITE = uuid16(0xfff2);

const KNOWN_NAMES = ['000fatscale01', '000fatscale02', '042fatscale01'];

/**
 * Adapter for Inlife / "FatScale" BLE body-fat scales.
 *
 * Protocol ported from openScale's Inlife handler:
 *   - Service 0xFFF0, notify 0xFFF1, write 0xFFF2
 *   - 14-byte frames with [0]=0x02, [1]=CMD
 *   - Weight at [2-3] big-endian / 10 (kg)
 *   - If byte[11]=0x80 or 0x81: impedance as uint32 BE at [4-7]
 *   - Else legacy mode: LBM at [4-6] 24-bit BE / 1000,
 *     visceral at [7-8] BE / 10, BMR at [9-10] BE / 10
 */
export class InlifeScaleAdapter implements ScaleAdapter {
  readonly name = 'Inlife';
  readonly charNotifyUuid = CHR_NOTIFY;
  readonly charWriteUuid = CHR_WRITE;
  readonly normalizesWeight = true;
  readonly unlockCommand: number[] = [];
  readonly unlockIntervalMs = 5000;

  /** Cached body-composition values from parsed frame. */
  private cachedComp: ScaleBodyComp = {};
  /** Cached impedance from impedance-mode frames. */
  private cachedImpedance = 0;

  matches(device: BleDeviceInfo): boolean {
    const name = (device.localName || '').toLowerCase();
    if (KNOWN_NAMES.includes(name)) return true;

    // Also match by advertised service UUID
    const uuids = (device.serviceUuids || []).map((u) => u.toLowerCase());
    return uuids.some((u) => u === 'fff0' || u === SVC_UUID);
  }

  /**
   * Send user config with real profile:
   *   [0x02, 0xD2, level, sex, userId, age, height, ...padding, xor1, xor2, 0xAA]
   *
   * openScale Inlife: 14 bytes — cmd 0xD2, XOR checksum over payload.
   */
  async onConnected(ctx: ConnectionContext): Promise<void> {
    const { profile } = ctx;
    const sex = profile.gender === 'male' ? 0x00 : 0x01;
    const height = Math.min(0xff, Math.max(0, Math.round(profile.height)));
    const age = Math.min(0xff, Math.max(0, profile.age));
    const cmd = [0x02, 0xd2, 0x01, sex, 0x01, age, height, 0x00, 0x00, 0x00, 0x00, 0x00];
    const xor = xorChecksum(cmd, 0, cmd.length);
    cmd.push(xor, 0xaa);
    await ctx.write(this.charWriteUuid, cmd, false);
  }

  /**
   * Parse an Inlife notification frame.
   *
   * Layout (14 bytes):
   *   [0]      0x02 marker
   *   [1]      command / frame type
   *   [2-3]    weight, big-endian uint16 / 10 (kg)
   *   [4-7]    impedance (uint32 BE) if [11]=0x80|0x81,
   *            else [4-6] LBM 24-bit BE / 1000
   *   [7-8]    visceral fat BE / 10 (legacy mode)
   *   [9-10]   BMR BE / 10 (legacy mode)
   *   [11]     mode flag (0x80/0x81 = impedance mode)
   *   [12-13]  (remaining bytes)
   */
  parseNotification(data: Buffer): ScaleReading | null {
    if (data.length < 14 || data[0] !== 0x02) return null;

    const weight = data.readUInt16BE(2) / 10;
    if (weight <= 0 || !Number.isFinite(weight)) return null;

    const modeFlag = data[11];

    if (modeFlag === 0x80 || modeFlag === 0x81) {
      // Impedance mode — impedance as uint32 BE at bytes [4-7]
      this.cachedImpedance = data.readUInt32BE(4);
      this.cachedComp = {};
    } else {
      // Legacy mode — body comp values embedded
      const _lbm = ((data[4] << 16) | (data[5] << 8) | data[6]) / 1000;
      const visceral = data.readUInt16BE(7) / 10;
      const _bmr = data.readUInt16BE(9) / 10;

      this.cachedComp = {
        visceralFat: visceral > 0 ? visceral : undefined,
      };
      this.cachedImpedance = 0;
    }

    return { weight, impedance: this.cachedImpedance };
  }

  isComplete(reading: ScaleReading): boolean {
    return reading.weight > 0;
  }

  computeMetrics(reading: ScaleReading, profile: UserProfile): GarminPayload {
    return buildPayload(reading.weight, reading.impedance, this.cachedComp, profile);
  }
}
