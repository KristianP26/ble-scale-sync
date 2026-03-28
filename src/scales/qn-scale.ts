import { computeBiaFat, buildPayload } from './body-comp-helpers.js';
import type {
  BleDeviceInfo,
  ConnectionContext,
  ScaleAdapter,
  ScaleReading,
  UserProfile,
  BodyComposition,
} from '../interfaces/scale-adapter.js';
import { uuid16 } from './body-comp-helpers.js';
import { bleLog } from '../ble/types.js';

/** Format bytes as hex string for debug logging. */
const hex = (data: number[]): string => data.map((b) => b.toString(16).padStart(2, '0')).join(' ');

/**
 * Ported from openScale's QNHandler.kt
 *
 * QN / FITINDEX ES-26M style scales (vendor protocol on 0xFFE0 / 0xFFF0).
 *
 * Two very similar layouts:
 *   Type 1 (0xFFE0): FFE1 notify, FFE2 indicate, FFE3 write-config, FFE4 write-time
 *   Type 2 (0xFFF0): FFF1 notify, FFF2 write-shared
 *
 * Some newer firmware (e.g. Renpho ES-CS20M / Elis 1) also exposes an AE00
 * service (AE01 write, AE02 notify) that must be initialized before the scale
 * starts sending notifications on FFF1.
 *
 * The handshake is notification-driven: the scale sends 0x12 (scale info),
 * the client responds with 0x13 (config); the scale sends 0x14 (ready),
 * the client responds with 0x20 (time sync) + A2 (user profile); the scale
 * sends 0x21 (config request), the client responds with A00D frames + 0x22
 * (start measurement). Weight data (0x10 frames) flows after the handshake.
 *
 * 0x10 frame (original format, 10 bytes):
 *   [3-4]   weight (BE uint16, / weightScaleFactor)
 *   [5]     stability (1 = stable, 0 = measuring)
 *   [6-7]   resistance R1 (BE uint16)
 *   [8-9]   resistance R2 (BE uint16)
 *
 * 0x10 frame (ES-30M format, 14 bytes, weightScaleFactor=10):
 *   [4]     state (0x00=measuring, 0x01=stabilizing, 0x02=stable)
 *   [5-6]   weight (BE uint16, / weightScaleFactor)
 *   [7-8]   resistance R1 (BE uint16)
 *   [9-10]  resistance R2 (BE uint16)
 *
 * 0x12 frame (scale info):
 *   [2]     protocol type (echoed back in all config commands)
 *   [10]    weight scale flag (1 = /100, else /10)
 */

// Type 2 UUIDs (most common variant)
const CHR_NOTIFY = uuid16(0xfff1);
const CHR_WRITE = uuid16(0xfff2);

// Type 1 UUIDs (alternate variant, service 0xFFE0)
const CHR_NOTIFY_T1 = uuid16(0xffe1);
const CHR_WRITE_T1 = uuid16(0xffe3);

// AE00 service UUIDs (newer firmware, e.g. Renpho ES-CS20M)
const CHR_AE01 = uuid16(0xae01);
const CHR_AE02 = uuid16(0xae02);

// Service UUIDs for matching
const SVC_T1 = 'ffe0';
const SVC_T2 = 'fff0';

/** Seconds from Unix epoch to 2000-01-01 00:00:00 UTC. */
const SCALE_EPOCH_OFFSET = 946684800;

export class QnScaleAdapter implements ScaleAdapter {
  readonly name = 'QN Scale';
  readonly charNotifyUuid = CHR_NOTIFY;
  readonly charWriteUuid = CHR_WRITE;
  readonly altCharNotifyUuid = CHR_NOTIFY_T1;
  readonly altCharWriteUuid = CHR_WRITE_T1;
  readonly normalizesWeight = true;
  readonly unlockCommand: number[] = [];
  readonly unlockIntervalMs = 0;

  /**
   * Weight divisor: 100 (Type 1 default) or 10 (Type 2).
   * Updated dynamically when a 0x12 scale-info frame arrives.
   */
  private weightScaleFactor = 100;

  /** Stored connection context for notification-driven state machine writes. */
  private ctx: ConnectionContext | null = null;

  /** Protocol type byte captured from the scale's 0x12 frame, echoed in config commands. */
  private seenProtocolType = 0x00;

  /** Whether the AE00 service is available (newer firmware). */
  private hasAe00 = false;

  /** Deduplication guards: prevent duplicate state machine responses. */
  private configSent = false;
  private timeSyncSent = false;
  private historyResponseSent = false;

  /** Write to FFF2 (write char), fall back to FFE3 (Type 1). */
  private async writeCmd(data: number[]): Promise<void> {
    if (!this.ctx) return;
    try {
      await this.ctx.write(CHR_WRITE, data, false);
    } catch {
      try {
        await this.ctx.write(CHR_WRITE_T1, data, false);
      } catch {
        return;
      }
    }
    bleLog.debug(`QN write: [${hex(data)}]`);
  }

  /** Write to AE01 (best-effort, not all firmware has AE00 service). */
  private async writeAe01(data: number[]): Promise<void> {
    if (!this.ctx) return;
    try {
      await this.ctx.write(CHR_AE01, data, false);
      bleLog.debug(`QN AE01 write: [${hex(data)}]`);
    } catch {
      // AE01 not available
    }
  }

  /**
   * Multi-step init called after BLE connection and service discovery.
   *
   * Sends the initial handshake burst for backward compatibility with older
   * firmware. Newer firmware also needs the notification-driven state machine
   * in parseNotification() which responds to 0x12, 0x14, and 0x21 frames.
   */
  async onConnected(ctx: ConnectionContext): Promise<void> {
    // Reset state for new connection
    this.ctx = ctx;
    this.seenProtocolType = 0x00;
    this.weightScaleFactor = 100;
    this.hasAe00 = false;
    this.configSent = false;
    this.timeSyncSent = false;
    this.historyResponseSent = false;

    const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

    // Step 1: Subscribe to AE02 notifications if available (newer firmware)
    try {
      await ctx.subscribe(CHR_AE02);
      this.hasAe00 = true;
      bleLog.debug('QN: subscribed to AE02');
    } catch {
      bleLog.debug('QN: AE02 not available (older firmware)');
    }

    // Step 2: Write AE01 init handshake (wakes up FFF1 notifications)
    // Observed in official Renpho app packet capture:
    //   FEDC BAC0 0600 02XX 01EF  (XX = session counter)
    if (this.hasAe00) {
      await this.writeAe01([0xfe, 0xdc, 0xba, 0xc0, 0x06, 0x00, 0x02, 0x01, 0x01, 0xef]);
      await wait(200);
    }

    // Step 3: Send all unlock variants (backward compat for older firmware)
    // Newer firmware uses the state machine (0x12 -> 0x13 with echoed protocol type).
    const unlocks = [
      [0x13, 0x09, 0x00, 0x01, 0x01, 0x02],
      [0x13, 0x09, 0x00, 0x01, 0x10, 0x00, 0x00, 0x00, 0x2d],
      [0x13, 0x09, 0xff, 0x08, 0x10, 0x00, 0x00, 0x00, 0x33],
    ];
    for (const cmd of unlocks) {
      try {
        await this.writeCmd(cmd);
      } catch {
        break;
      }
    }
    await wait(300);

    // Step 4: Send user profile (0xA2)
    const age = Math.min(0xff, Math.max(1, ctx.profile.age));
    const profileCmd = [0xa2, 0x06, 0x01, 0x32, age, 0x00];
    profileCmd[5] = profileCmd.reduce((a, b) => a + b, 0) & 0xff;
    try {
      await this.writeCmd(profileCmd);
    } catch {
      // Best-effort
    }

    // Step 5: Send "pass" on AE01 (authentication handshake)
    if (this.hasAe00) {
      await wait(200);
      await this.writeAe01([0x02, 0x70, 0x61, 0x73, 0x73]);
      await wait(300);
    }

    // Step 6: Send start measurement command (0x22)
    const startCmd = [0x22, 0x06, 0xff, 0x00, 0x03, 0x00];
    startCmd[5] = startCmd.reduce((a, b) => a + b, 0) & 0xff;
    try {
      await this.writeCmd(startCmd);
    } catch {
      // Best-effort
    }

    // Step 7: Fallback for Linux (node-ble / BlueZ D-Bus)
    // On Linux, FFF1 CCCD subscription runs in parallel with onConnected().
    // The scale sends 0x12 in response to the CCCD write, but the notification
    // handler may not be registered yet, so we miss it. Without 0x12 the state
    // machine never triggers and the scale disconnects after ~25s.
    // After a 2s delay (by which FFF1 subscription is definitely active),
    // run the full handshake if the state machine hasn't fired yet.
    if (this.hasAe00) {
      setTimeout(() => void this.runFallbackHandshake(), 2000);
    }
  }

  /** Run the full state machine handshake if no 0x12 was received (Linux fallback). */
  private async runFallbackHandshake(): Promise<void> {
    if (!this.ctx) return;
    const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

    if (!this.configSent) {
      this.seenProtocolType = 0xff;
      bleLog.debug('QN: no scale info received, fallback config with proto=0xFF');
      await this.handleScaleInfo();
      await wait(500);
    }

    if (!this.timeSyncSent) {
      bleLog.debug('QN: no ready frame received, fallback time sync + profile');
      await this.handleReady();
      await wait(500);
    }

    if (!this.historyResponseSent) {
      bleLog.debug('QN: no config request received, fallback history + start');
      await this.handleConfigRequest();
    }
  }

  /**
   * Name match is sufficient (brand names are unambiguous).
   * UUID fallback covers unnamed devices advertising QN vendor services.
   *
   * Note: openScale requires BOTH name AND UUID, but on Linux (node-ble / BlueZ
   * D-Bus) advertised service UUIDs are not available before connection, so
   * name-only matching is needed for auto-discovery without SCALE_MAC.
   */
  matches(device: BleDeviceInfo): boolean {
    // AABB broadcast protocol (0xFFFF company ID + 0xAABB magic header)
    if (device.manufacturerData) {
      const { id, data } = device.manufacturerData;
      if (id === 0xffff && data.length >= 19 && data[0] === 0xaa && data[1] === 0xbb) {
        return true;
      }
    }

    const name = (device.localName || '').toLowerCase();
    const nameMatch =
      name.includes('qn-scale') ||
      name.includes('renpho') ||
      name.includes('senssun') ||
      name.includes('sencor');
    if (nameMatch) return true;

    // Fallback: match by QN vendor service UUID for unnamed devices
    const uuids = (device.serviceUuids || []).map((u) => u.toLowerCase());
    if (
      uuids.some(
        (u) => u === SVC_T1 || u === SVC_T2 || u === uuid16(0xffe0) || u === uuid16(0xfff0),
      )
    ) {
      return true;
    }

    return false;
  }

  /**
   * Parse QN vendor notifications.
   *
   * Implements a notification-driven state machine for the handshake:
   *   0x12 (scale info) -> send 0x13 config with echoed protocol type
   *   0x14 (ready ACK)  -> send 0x20 time sync + A2 user profile
   *   0x21 (config req)  -> send A00D history responses + 0x22 start
   *   0x10 (weight)      -> parse weight (original or ES-30M format)
   *
   * State machine writes are fire-and-forget (async, not awaited) so they
   * don't block the synchronous parseNotification return.
   */
  parseNotification(data: Buffer): ScaleReading | null {
    if (data.length < 3) return null;

    const opcode = data[0];

    // 0x12: scale info, update weight scale factor and capture protocol type
    if (opcode === 0x12 && data.length > 10) {
      this.weightScaleFactor = data[10] === 1 ? 100 : 10;
      this.seenProtocolType = data[2];
      bleLog.debug(
        `QN: scale info, factor=${this.weightScaleFactor}, proto=0x${this.seenProtocolType.toString(16).padStart(2, '0')}`,
      );
      void this.handleScaleInfo();
      return null;
    }

    // 0x14: ready/config ACK, respond with time sync + user profile
    if (opcode === 0x14) {
      bleLog.debug('QN: ready frame, sending time sync + profile');
      void this.handleReady();
      return null;
    }

    // 0x21: config request, respond with A00D history frames + start measurement
    if (opcode === 0x21) {
      bleLog.debug('QN: config request, sending history response + start');
      void this.handleConfigRequest();
      return null;
    }

    // 0xA1, 0xA3: acknowledgment frames (no action needed)
    // 0x23: historical record (no action needed)
    if (opcode === 0xa1 || opcode === 0xa3 || opcode === 0x23) {
      return null;
    }

    // 0x10: live weight frame
    if (opcode !== 0x10 || data.length < 10) return null;

    let stable: boolean;
    let rawWeight: number;
    let r1: number;
    let r2: number;

    // ES-30M format: byte[4] is a state flag (0x00/0x01/0x02) instead of weight LSB.
    // Detected when weightScaleFactor=10, byte[4] <= 0x02, and frame has enough bytes.
    // In the original format, byte[4] is the low byte of the 16-bit weight, which is
    // almost always > 0x02 for adult weights (> 25.5 kg raw value with factor 10).
    const isEs30m = data.length >= 11 && data[4] <= 0x02 && this.weightScaleFactor === 10;

    if (isEs30m) {
      // ES-30M: [4]=state (0x02=stable), [5-6]=weight, [7-8]=R1, [9-10]=R2
      stable = data[4] === 0x02;
      rawWeight = data.readUInt16BE(5);
      r1 = data.readUInt16BE(7);
      r2 = data.readUInt16BE(9);

      // ES-30M scales send a weight-only stable frame (R1=R2=0) before the
      // impedance-bearing one. Skip it so isComplete() doesn't accept an
      // impedance=0 reading prematurely (which triggers broadcast-mode logic).
      if (stable && r1 === 0 && r2 === 0) return null;
    } else {
      // Original: [3-4]=weight, [5]=stable(1), [6-7]=R1, [8-9]=R2
      stable = data[5] === 1;
      rawWeight = data.readUInt16BE(3);
      r1 = data.readUInt16BE(6);
      r2 = data.readUInt16BE(8);
    }

    if (!stable) return null;

    let weight = rawWeight / this.weightScaleFactor;

    // Heuristic fallback (from QNHandler): if weight looks unreasonable, try alternate factor
    if (weight <= 5 || weight >= 250) {
      const altFactor = this.weightScaleFactor === 100 ? 10 : 100;
      const altWeight = rawWeight / altFactor;
      if (altWeight > 5 && altWeight < 250) {
        weight = altWeight;
      }
    }

    if (weight <= 0 || !Number.isFinite(weight)) return null;

    // R1 (primary BIA resistance) and R2 (secondary)
    const impedance = r1 > 0 ? r1 : r2;

    // Acknowledge stable reading (0x1F) so the scale knows we received it
    if (this.ctx) {
      const ackCmd = [0x1f, 0x05, this.seenProtocolType, 0x10, 0x00];
      ackCmd[4] = ackCmd.reduce((a, b) => a + b, 0) & 0xff;
      void this.writeCmd(ackCmd);
    }

    return { weight, impedance };
  }

  // ── State machine handlers (fire-and-forget from parseNotification) ─────

  /** Respond to 0x12 (scale info) with 0x13 config using echoed protocol type. */
  private async handleScaleInfo(): Promise<void> {
    if (this.configSent) return;
    this.configSent = true;
    // 0x13 config: [opcode, length, protocolType, unitFlags, 0x10, 0x00, 0x00, 0x00, checksum]
    // byte[3]=0x08 observed in Renpho app packet capture
    const cmd = [0x13, 0x09, this.seenProtocolType, 0x08, 0x10, 0x00, 0x00, 0x00, 0x00];
    cmd[8] = cmd.reduce((a, b) => a + b, 0) & 0xff;
    await this.writeCmd(cmd);
  }

  /** Respond to 0x14 (ready) with 0x20 time sync + A2 user profile + AE01 auth. */
  private async handleReady(): Promise<void> {
    if (this.timeSyncSent) return;
    this.timeSyncSent = true;
    // 0x20 time sync: seconds since 2000-01-01, little-endian
    const secs = Math.floor(Date.now() / 1000) - SCALE_EPOCH_OFFSET;
    const timeCmd = [
      0x20,
      0x08,
      this.seenProtocolType,
      secs & 0xff,
      (secs >> 8) & 0xff,
      (secs >> 16) & 0xff,
      (secs >> 24) & 0xff,
      0x00,
    ];
    timeCmd[7] = timeCmd.reduce((a, b) => a + b, 0) & 0xff;
    await this.writeCmd(timeCmd);

    // A2 user profile
    if (this.ctx) {
      const age = Math.min(0xff, Math.max(1, this.ctx.profile.age));
      const profileCmd = [0xa2, 0x06, 0x01, 0x32, age, 0x00];
      profileCmd[5] = profileCmd.reduce((a, b) => a + b, 0) & 0xff;
      await this.writeCmd(profileCmd);
    }

    // "pass" authentication on AE01 if AE00 service is available
    if (this.hasAe00) {
      await this.writeAe01([0x02, 0x70, 0x61, 0x73, 0x73]);
    }
  }

  /** Respond to 0x21 (config request) with A00D history frames + 0x22 start measurement. */
  private async handleConfigRequest(): Promise<void> {
    if (this.historyResponseSent) return;
    this.historyResponseSent = true;
    const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

    // A00D response 1 (from openScale QNHandler)
    const msg1 = [0xa0, 0x0d, 0x04, 0xfe, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00];
    msg1[12] = msg1.reduce((a, b) => a + b, 0) & 0xff;
    await this.writeCmd(msg1);

    await wait(200);

    // A00D response 2 (from openScale QNHandler)
    const msg2 = [0xa0, 0x0d, 0x02, 0x01, 0x00, 0x08, 0x00, 0x21, 0x06, 0xb8, 0x04, 0x02, 0x00];
    msg2[12] = msg2.reduce((a, b) => a + b, 0) & 0xff;
    await this.writeCmd(msg2);

    await wait(200);

    // 0x22 start measurement with echoed protocol type
    const startCmd = [0x22, 0x06, this.seenProtocolType, 0x00, 0x03, 0x00];
    startCmd[5] = startCmd.reduce((a, b) => a + b, 0) & 0xff;
    await this.writeCmd(startCmd);
  }

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
  parseBroadcast(manufacturerData: Buffer): ScaleReading | null {
    if (manufacturerData.length < 19) return null;
    if (manufacturerData[0] !== 0xaa || manufacturerData[1] !== 0xbb) return null;

    // Only accept stable readings (bit 5 of byte 15 = "measurement settled")
    if ((manufacturerData[15] & 0x20) === 0) return null;

    const weight = manufacturerData.readUInt16LE(17) / 100;
    if (weight <= 0 || !Number.isFinite(weight)) return null;

    return { weight, impedance: 0 };
  }

  isComplete(reading: ScaleReading): boolean {
    // Broadcast readings have impedance=0; GATT readings have impedance>200
    if (reading.impedance === 0) return reading.weight > 0;
    return reading.weight > 10 && reading.impedance > 200;
  }

  computeMetrics(reading: ScaleReading, profile: UserProfile): BodyComposition {
    // In broadcast mode impedance is 0: skip BIA, let buildPayload use Deurenberg fallback
    const fat =
      reading.impedance > 0 ? computeBiaFat(reading.weight, reading.impedance, profile) : undefined;
    return buildPayload(reading.weight, reading.impedance, { fat }, profile);
  }
}
