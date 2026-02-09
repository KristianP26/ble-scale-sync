import type { Peripheral } from '@abandonware/noble';
import type {
  ScaleAdapter,
  ScaleReading,
  UserProfile,
  GarminPayload,
} from '../interfaces/scale-adapter.js';
import { uuid16, buildPayload, type ScaleBodyComp } from './body-comp-helpers.js';

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
  /**
   * User config command:
   *   [0] = 0xD2 (command)
   *   [1] = level (1)
   *   [2] = sex (0x00 = male)
   *   [3] = user id (1)
   *   [4] = age (0x1E = 30)
   *   [5] = height (0xA0 = 160 cm)
   */
  readonly unlockCommand = [0xd2, 0x01, 0x00, 0x01, 0x1e, 0xa0];
  readonly unlockIntervalMs = 5000;

  /** Cached body-composition values from parsed frame. */
  private cachedComp: ScaleBodyComp = {};
  /** Cached impedance from impedance-mode frames. */
  private cachedImpedance = 0;

  matches(peripheral: Peripheral): boolean {
    const name = (peripheral.advertisement.localName || '').toLowerCase();
    if (KNOWN_NAMES.includes(name)) return true;

    // Also match by advertised service UUID
    const uuids = (peripheral.advertisement.serviceUuids || []).map((u) => u.toLowerCase());
    return uuids.some((u) => u === 'fff0' || u === SVC_UUID);
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
