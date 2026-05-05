import type {
  BleDeviceInfo,
  ConnectionContext,
  ScaleAdapter,
  ScaleReading,
  UserProfile,
  BodyComposition,
} from '../interfaces/scale-adapter.js';
import { uuid16, buildPayload } from './body-comp-helpers.js';
import { bleLog } from '../ble/types.js';

// Renpho ES-26BB custom service / characteristic UUIDs
const CHR_RESULTS = uuid16(0x2a10); // notify — measurement results
const CHR_CONTROL = uuid16(0x2a11); // write  — commands

const START_CMD = [0x55, 0xaa, 0x90, 0x00, 0x04, 0x01, 0x00, 0x00, 0x00, 0x94];

// Acknowledge an offline measurement so the scale stops resending it.
// Last byte = sum(prev) & 0xFF = (0x55 + 0xAA + 0x95 + 0x00 + 0x01 + 0x01) & 0xFF = 0x96.
const OFFLINE_ACK = [0x55, 0xaa, 0x95, 0x00, 0x01, 0x01, 0x96];

const ACTION_LIVE = 0x14;
const ACTION_OFFLINE = 0x15;

const LIVE_TYPE_FINAL = 0x01;
const LIVE_TYPE_FINAL_ALT = 0x11;

function isChecksumValid(data: Buffer): boolean {
  if (data.length < 2) return false;
  let sum = 0;
  for (let i = 0; i < data.length - 1; i++) sum = (sum + data[i]) & 0xff;
  return sum === data[data.length - 1];
}

/**
 * Adapter for the Renpho ES-26BB-B scale.
 *
 * Protocol ported from openScale's RenphoES26BBHandler:
 *   - Service 0x1A10, notify 0x2A10, write 0x2A11
 *   - Start cmd: 55 AA 90 00 04 01 00 00 00 94
 *   - Live frame (0x14): byte[5] type (final 0x01/0x11), weight at [6-9] BE u32 / 100, impedance at [10-11] BE u16
 *   - Offline frame (0x15): weight at [5-8] BE u32 / 100, impedance at [9-10] BE u16, secondsAgo at [11-14] BE u32
 *   - Last byte = sum(prev) & 0xFF
 *   - Offline frames MUST be acked (55 AA 95 00 01 01 96), otherwise scale resends them on every reconnect.
 */
export class RenphoEs26bbAdapter implements ScaleAdapter {
  readonly name = 'Renpho ES-26BB';
  readonly charNotifyUuid = CHR_RESULTS;
  readonly charWriteUuid = CHR_CONTROL;
  readonly normalizesWeight = true;
  readonly unlockCommand: number[] = [];
  readonly unlockIntervalMs = 0;

  private ctx: ConnectionContext | null = null;

  matches(device: BleDeviceInfo): boolean {
    const name = (device.localName || '').toLowerCase();
    return name === 'es-26bb-b';
  }

  async onConnected(ctx: ConnectionContext): Promise<void> {
    this.ctx = ctx;
    try {
      await ctx.write(CHR_CONTROL, START_CMD, false);
      bleLog.debug(
        `ES-26BB-B: start cmd sent [${START_CMD.map((b) => b.toString(16).padStart(2, '0')).join(' ')}]`,
      );
    } catch (e) {
      bleLog.warn(`ES-26BB-B: start cmd failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * Parse an ES-26BB notification frame.
   *
   * Validates the trailing sum-checksum, then dispatches by action byte at offset 2.
   * Live (0x14): only "final" frames (type byte 0x01 or 0x11) become readings;
   *   non-final progress frames are ignored to avoid duplicate measurements.
   * Offline (0x15): triggers a fire-and-forget ack write so the scale clears
   *   the cached frame and stops resending it on the next connect.
   */
  parseNotification(data: Buffer): ScaleReading | null {
    if (data.length < 11) return null;
    if (!isChecksumValid(data)) {
      bleLog.debug('ES-26BB-B: dropping frame with invalid checksum');
      return null;
    }

    const action = data[2];

    if (action === ACTION_LIVE) {
      if (data.length < 12) return null;
      const type = data[5];
      if (type !== LIVE_TYPE_FINAL && type !== LIVE_TYPE_FINAL_ALT) {
        bleLog.debug(
          `ES-26BB-B: ignoring non-final live frame (type=0x${type.toString(16).padStart(2, '0')})`,
        );
        return null;
      }
      const weight = data.readUInt32BE(6) / 100;
      const impedance = data.readUInt16BE(10);
      if (weight <= 0 || !Number.isFinite(weight)) return null;
      return { weight, impedance };
    }

    if (action === ACTION_OFFLINE) {
      void this.sendOfflineAck();
      const weight = data.readUInt32BE(5) / 100;
      const impedance = data.readUInt16BE(9);
      if (weight <= 0 || !Number.isFinite(weight)) return null;
      return { weight, impedance };
    }

    return null;
  }

  isComplete(reading: ScaleReading): boolean {
    return reading.weight > 10 && reading.impedance > 0;
  }

  computeMetrics(reading: ScaleReading, profile: UserProfile): BodyComposition {
    return buildPayload(reading.weight, reading.impedance, {}, profile);
  }

  private async sendOfflineAck(): Promise<void> {
    const ctx = this.ctx;
    if (!ctx) return;
    try {
      await ctx.write(CHR_CONTROL, OFFLINE_ACK, true);
      bleLog.debug('ES-26BB-B: offline ack sent');
    } catch (e) {
      bleLog.debug(
        `ES-26BB-B: offline ack failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
}
