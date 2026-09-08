import type {
  BleDeviceInfo,
  ConnectionContext,
  ScaleAdapterCore,
  GattWiring,
  ScaleReading,
  UserProfile,
  BodyComposition,
} from '../interfaces/scale-adapter.js';
import {
  uuid16,
  buildPayload,
  xorChecksum,
  ReadingComposition,
  type ScaleBodyComp,
} from './body-comp-helpers.js';
import type { MatchDescriptor } from './match-descriptor.js';

const SVC_UUID = uuid16(0xfff0);
const CHR_NOTIFY = uuid16(0xfff1);
const CHR_WRITE = uuid16(0xfff2);
/** 1byone/Eufy write char, present on that family, never on a real Inlife. */
const CHR_ONEBYONE = uuid16(0xfff4);

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
export class InlifeScaleAdapter implements ScaleAdapterCore, GattWiring {
  readonly name = 'Inlife';
  readonly match: MatchDescriptor = {
    priority: 90,
    custom: true,
    names: { exact: ['000fatscale01', '000fatscale02', '042fatscale01'] },
    serviceUuids: ['fff0'],
    charUuids: ['fff2'],
  };
  readonly charNotifyUuid = CHR_NOTIFY;
  readonly charWriteUuid = CHR_WRITE;
  readonly normalizesWeight = true;

  /** Cached body-composition values from parsed frame. */
  private cachedComp: ScaleBodyComp = {};
  /**
   * Composition pinned to the reading it was measured with (#394): this adapter
   * is a shared singleton and `computeMetrics()` runs later than the parse, so
   * on the watcher transports the live cache can already belong to the next
   * weigh-in. See ReadingComposition.
   */
  private readonly comp = new ReadingComposition<ScaleBodyComp>();
  /** Cached impedance from impedance-mode frames. */
  private cachedImpedance = 0;

  matches(device: BleDeviceInfo): boolean {
    const name = (device.localName || '').toLowerCase();
    if (KNOWN_NAMES.includes(name)) return true;

    const chars = device.characteristicUuids;
    if (chars && chars.length > 0) {
      // Post-discovery: 0xFFF0 is a generic vendor service shared with the
      // 1byone/Eufy family, so require Inlife's own write characteristic
      // 0xFFF2 rather than the bare service UUID. Prevents the #177 collision
      // where a nameless T9146 (0xFFF1 + 0xFFF4, no 0xFFF2) fell to Inlife.
      // Also reject any device carrying the 1byone/Eufy write char 0xFFF4:
      // a real Inlife never exposes it, and some Eufy variants (T9147, #251)
      // expose fff2 AND fff4, which would otherwise still hit Inlife here.
      return chars.includes(CHR_WRITE) && !chars.includes(CHR_ONEBYONE);
    }

    // Pre-connect (no characteristics yet): keep the legacy advertised-service
    // fallback so true Inlife scales still match before a GATT connection.
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

    const reading: ScaleReading = { weight, impedance: this.cachedImpedance };
    this.comp.pin(reading, this.cachedComp);
    return reading;
  }

  isComplete(reading: ScaleReading): boolean {
    return reading.weight > 0;
  }

  /**
   * Clear the previous weigh-in before anything is subscribed (#394).
   *
   * The pin above is what fixes the real leak. This reset covers the OTHER
   * path: a reading built outside parseNotification (a direct caller, a test)
   * has nothing pinned, so computeMetrics falls back to the live cache - and
   * that must not still hold the previous person's numbers. It is also what
   * the ScaleAdapter contract requires of every adapter, so a sibling added
   * later inherits a correct example rather than this one's peculiarity.
   */
  onSessionStart(): void {
    this.cachedComp = {};
    this.cachedImpedance = 0;
  }

  computeMetrics(reading: ScaleReading, profile: UserProfile): BodyComposition {
    return buildPayload(
      reading.weight,
      reading.impedance,
      this.comp.of(reading, this.cachedComp),
      profile,
    );
  }
}
