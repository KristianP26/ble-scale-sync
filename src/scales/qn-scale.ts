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
const hex = (data: number[] | Buffer): string =>
  [...data].map((b) => b.toString(16).padStart(2, '0')).join(' ');

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
 * starts sending measurement data on FFF1.
 *
 * The handshake is notification-driven (matching openScale and the official
 * Renpho app): the scale sends 0x12 (scale info) when FFF1 CCCD is written,
 * and each subsequent command is sent in response to a specific frame:
 *
 *   0x12 (scale info) -> AE01 init (if AE00) -> 0x13 config
 *   0x14 (ready ACK)  -> 0x20 time sync + A2 user profile + "pass" auth
 *   0x21 (config req)  -> A00D history responses + 0x22 start measurement
 *   0x10 (weight)      -> parse weight + 0x1F acknowledge stable reading
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
 * 0x12 frame (scale info, classic 11-byte format):
 *   [2]     protocol type (echoed back in all config commands)
 *   [10]    weight scale flag (1 = /100, else /10)
 *
 * 0x12 frame (ES-26M long format, 18 bytes):
 *   [1]     length (== packet length, i.e. 0x12 == 18)
 *   [2-7]   MAC address (NOT protocol type!)
 *   Protocol type should be set to 0x00 for this variant.
 *   Weight scale factor is 10 (ES-30M format with heuristic /100 fallback).
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

// SIG Body Composition / Weight Scale services. A 'renpho'-named device that
// advertises these but NO QN vendor service is a Renpho ES-WBE28 (#191),
// handled by RenphoScaleAdapter — see matches().
const SVC_SIG_BCS = '181b';
const SVC_SIG_WSS = '181d';

/** Seconds from Unix epoch to 2000-01-01 00:00:00 UTC. */
const SCALE_EPOCH_OFFSET = 946684800;

/**
 * Grace period (ms) to wait for an impedance frame after the first stable
 * R1=R2=0 frame on long-frame variants (e.g. ES-26M). If an impedance frame
 * arrives within this window, it supersedes the weight-only reading. If not,
 * the weight-only reading is accepted on the next stable frame.
 */
const IMPEDANCE_GRACE_MS = 1500;

/**
 * Max age (seconds) of a 0x23 stored record relative to session start before it
 * is treated as stale history and ignored. Mirrors openScale QNHandler's
 * MAX_STORED_RECORD_AGE_BEFORE_SESSION_SECONDS. Prevents importing an old
 * weigh-in saved days before the current connection (#213 / #75).
 */
const MAX_STORED_RECORD_AGE_SEC = 90;

/**
 * Bounded re-query of the 0x22 stored-data command when a 0x23 record is stale
 * or empty. V10 firmware may return an old slot first and only save the fresh
 * weigh-in a moment later, so we re-ask a few times (openScale retries 10x/5s;
 * we use a shorter window to fit the scale's brief connection). #213 / #75.
 */
const MAX_STORED_QUERY_ATTEMPTS = 6;
const STORED_QUERY_RETRY_MS = 3000;

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

  /**
   * Whether the scale sent a long-frame (18-byte) 0x12 variant (e.g. ES-26M).
   * These scales may never provide impedance, so stable frames with R1=R2=0
   * must be accepted after a grace period. Classic ES-30M scales always send
   * an impedance frame after the weight-only stable frame, so skipping
   * R1=R2=0 is correct there.
   */
  private isLongFrameVariant = false;

  /**
   * Timestamp (Date.now()) of the first stable R1=R2=0 frame seen on a
   * long-frame variant. After IMPEDANCE_GRACE_MS without an impedance frame,
   * subsequent R1=R2=0 stable frames are accepted.
   */
  private firstStableNoImpedanceAt: number | null = null;

  /**
   * Scale-epoch seconds (2000-epoch) captured when the connection opened, used
   * as the freshness reference for 0x23 stored records. Falls back to the
   * current time when a record arrives before onConnected ran.
   */
  private sessionStartedScaleSeconds: number | null = null;

  /** Deduplication guards: prevent duplicate state machine responses. */
  private configSent = false;
  private timeSyncSent = false;
  private historyResponseSent = false;

  /** Fallback timer handle for cancellation when state machine fires normally. */
  private fallbackTimer: ReturnType<typeof setTimeout> | null = null;

  /** Number of 0x22 stored-data re-queries sent this session. */
  private storedQueryAttempts = 0;

  /** Timer handle for the pending stored-data re-query. */
  private storedRetryTimer: ReturnType<typeof setTimeout> | null = null;

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
   * On Linux (node-ble / BlueZ D-Bus), FFF1 CCCD subscription runs in parallel
   * with onConnected(). The scale may send 0x12 BEFORE this method finishes,
   * so the state machine handlers (handleScaleInfo, handleReady, etc.) must
   * not depend on any state set here (especially hasAe00).
   *
   * For older firmware without AE00: sends legacy unlock variants on FFF2.
   */
  async onConnected(ctx: ConnectionContext): Promise<void> {
    // Reset state for new connection
    this.ctx = ctx;
    this.seenProtocolType = 0x00;
    this.weightScaleFactor = 100;
    this.hasAe00 = false;
    this.isLongFrameVariant = false;
    this.firstStableNoImpedanceAt = null;
    this.sessionStartedScaleSeconds = Math.floor(Date.now() / 1000) - SCALE_EPOCH_OFFSET;
    this.configSent = false;
    this.timeSyncSent = false;
    this.historyResponseSent = false;
    this.storedQueryAttempts = 0;
    if (this.fallbackTimer) {
      clearTimeout(this.fallbackTimer);
      this.fallbackTimer = null;
    }
    if (this.storedRetryTimer) {
      clearTimeout(this.storedRetryTimer);
      this.storedRetryTimer = null;
    }

    // Try subscribing to AE02 (newer firmware detection).
    // NOTE: on Linux, 0x12 may arrive before this completes. The state machine
    // handlers do NOT depend on hasAe00; they always attempt AE01 writes
    // (which fail silently on older firmware without AE00).
    try {
      await ctx.subscribe(CHR_AE02);
      this.hasAe00 = true;
      bleLog.debug('QN: subscribed to AE02');
    } catch {
      bleLog.debug('QN: AE02 not available (older firmware)');
    }

    if (!this.hasAe00) {
      // Older firmware: send legacy unlock variants on FFF2.
      // These work with Renpho, Sencor, and generic QN-Scale devices
      // that don't use the notification-driven handshake.
      const unlocks = [
        [0x13, 0x09, 0x00, 0x01, 0x01, 0x02],
        [0x13, 0x09, 0x00, 0x01, 0x10, 0x00, 0x00, 0x00, 0x2d],
      ];
      for (const cmd of unlocks) {
        await this.writeCmd(cmd);
      }
    }

    // Fallback timer for both firmware paths. If the state machine fires
    // normally (0x12 received), handleScaleInfo cancels this timer.
    // If 0x12 is lost (Linux BlueZ race) or never sent (older firmware
    // that only responds to unlocks), the fallback runs the full handshake.
    if (!this.configSent) {
      this.fallbackTimer = setTimeout(() => void this.runFallbackHandshake(), 2000);
    }
  }

  /**
   * Fallback handshake for Linux node-ble where 0x12 may be lost.
   * Sends AE01 init first, then the full handshake sequence.
   */
  private async runFallbackHandshake(): Promise<void> {
    if (!this.ctx) return;
    this.fallbackTimer = null;
    const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

    if (!this.configSent) {
      this.seenProtocolType = 0xff;
      bleLog.debug('QN: fallback: no 0x12 received, running handshake with proto=0xFF');
      // handleScaleInfo sends AE01 init + 0x13 config
      await this.handleScaleInfo();
      await wait(500);
    }

    if (!this.timeSyncSent) {
      bleLog.debug('QN: fallback: sending time sync + profile');
      await this.handleReady();
      await wait(500);
    }

    if (!this.historyResponseSent) {
      bleLog.debug('QN: fallback: sending history + start');
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
    const uuids = (device.serviceUuids || []).map((u) => u.toLowerCase());
    const hasQnVendor = uuids.some(
      (u) => u === SVC_T1 || u === SVC_T2 || u === uuid16(0xffe0) || u === uuid16(0xfff0),
    );

    const nameMatch =
      name.includes('qn-scale') ||
      name.includes('renpho') ||
      name.includes('senssun') ||
      name.includes('sencor');
    if (nameMatch) {
      // #191: a device named only via 'renpho' (not the QN-specific names)
      // that advertises a SIG Weight Scale / Body Composition service but NO
      // QN vendor service is a Renpho ES-WBE28 (proprietary 0x2A9D payload),
      // handled by RenphoScaleAdapter. Mirror its mutual-exclusion
      // symmetrically so this (registry-earlier) adapter does not shadow it.
      // QN-protocol Renpho scales advertise 0xFFE0/0xFFF0, or no SIG service
      // (e.g. Linux scans with empty UUIDs), so they are unaffected.
      const onlyRenpho =
        name.includes('renpho') &&
        !name.includes('qn-scale') &&
        !name.includes('senssun') &&
        !name.includes('sencor');
      const looksLikeWbe28 =
        !hasQnVendor &&
        uuids.some(
          (u) =>
            u === SVC_SIG_BCS || u === SVC_SIG_WSS || u === uuid16(0x181b) || u === uuid16(0x181d),
        );
      if (onlyRenpho && looksLikeWbe28) return false;
      return true;
    }

    // Fallback: match by QN vendor service UUID, but only for unnamed devices.
    // Named devices (e.g. "eufy T9149") should match their own specific adapter
    // rather than being caught by the generic FFF0/FFE0 UUID check.
    if (!name && hasQnVendor) return true;

    return false;
  }

  /**
   * Parse QN vendor notifications.
   *
   * Implements a notification-driven state machine for the handshake:
   *   0x12 (scale info) -> AE01 init + 0x13 config with echoed protocol type
   *   0x14 (ready ACK)  -> 0x20 time sync + A2 user profile + "pass" auth
   *   0x21 (config req)  -> A00D history responses + 0x22 start
   *   0x10 (weight)      -> parse weight (original or ES-30M format)
   *
   * State machine writes are fire-and-forget (async, not awaited) so they
   * don't block the synchronous parseNotification return.
   */
  parseNotification(data: Buffer): ScaleReading | null {
    if (data.length < 3) return null;

    bleLog.debug(`QN RAW (${data.length}B): [${hex(data)}]`);

    const opcode = data[0];

    // 0x12: scale info, update weight scale factor and capture protocol type
    if (opcode === 0x12 && data.length > 10) {
      // Renpho ES-26M (and similar newer firmware) sends an 18-byte 0x12
      // frame where byte[1] == packet length and bytes [2-7] contain the
      // MAC address. The classic QN format has ~11 bytes with protocol
      // type at [2] and weight scale flag at [10].
      if (data.length >= 18 && data[1] === data.length) {
        // Long frame (ES-26M): MAC at [2-7], use proto=0x00
        this.isLongFrameVariant = true;
        this.seenProtocolType = 0x00;
        this.weightScaleFactor = 10;
      } else {
        // Classic short frame
        this.seenProtocolType = data[2];
        this.weightScaleFactor = data[10] === 1 ? 100 : 10;
      }
      bleLog.debug(
        `QN: scale info (${data.length}B), ` +
          `factor=${this.weightScaleFactor}, ` +
          `proto=0x${this.seenProtocolType.toString(16).padStart(2, '0')}`,
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
    if (opcode === 0xa1 || opcode === 0xa3) {
      return null;
    }

    // 0x23: stored measurement record returned after the 0x22 history query.
    // V10 Renpho / ES-CS20M firmware delivers the weigh-in here, not reliably
    // via live 0x10 frames (#213 / #75). Layout from openScale QNHandler:
    //   [6-9]   record timestamp, LE uint32 (2000-epoch seconds)
    //   [10-11] weight, BE uint16, / 100 kg
    //   [13-14] primary resistance R1, LE uint16
    //   [15-16] secondary resistance R2, LE uint16
    if (opcode === 0x23) {
      if (data.length < 17) {
        this.scheduleStoredDataRetry();
        return null;
      }
      const weight = data.readUInt16BE(10) / 100;
      if (weight <= 5 || weight >= 300) {
        this.scheduleStoredDataRetry();
        return null;
      }
      const recordSeconds = data.readUInt32LE(6);
      const sessionSeconds =
        this.sessionStartedScaleSeconds ?? Math.floor(Date.now() / 1000) - SCALE_EPOCH_OFFSET;
      if (recordSeconds + MAX_STORED_RECORD_AGE_SEC < sessionSeconds) {
        this.scheduleStoredDataRetry();
        return null;
      }
      const r1 = data.readUInt16LE(13);
      const r2 = data.readUInt16LE(15);
      if (this.storedRetryTimer) {
        clearTimeout(this.storedRetryTimer);
        this.storedRetryTimer = null;
      }
      bleLog.debug(`QN: stored 0x23 reading ${weight}kg / ${r1 > 0 ? r1 : r2}Ω`);
      return { weight, impedance: r1 > 0 ? r1 : r2 };
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

      if (stable && r1 === 0 && r2 === 0) {
        if (!this.isLongFrameVariant) {
          // Classic ES-30M: always skip, impedance frame follows.
          return null;
        }
        // Long-frame variant (ES-26M): accept after grace period.
        // The first stable R1=R2=0 frame starts a timer. If no impedance
        // frame arrives within IMPEDANCE_GRACE_MS, subsequent R1=R2=0
        // frames are accepted. This prevents losing BIA data if the
        // scale sends a transient R1=R2=0 before the impedance frame.
        const now = Date.now();
        if (this.firstStableNoImpedanceAt === null) {
          this.firstStableNoImpedanceAt = now;
          return null;
        }
        if (now - this.firstStableNoImpedanceAt < IMPEDANCE_GRACE_MS) {
          return null;
        }
        // Grace period elapsed: accept this weight-only reading.
      }
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

    // Reset the impedance grace timer on successful reading
    this.firstStableNoImpedanceAt = null;

    // Acknowledge stable reading (0x1F) so the scale knows we received it
    if (this.ctx) {
      const ackCmd = [0x1f, 0x05, this.seenProtocolType, 0x10, 0x00];
      ackCmd[4] = ackCmd.reduce((a, b) => a + b, 0) & 0xff;
      void this.writeCmd(ackCmd);
    }

    return { weight, impedance };
  }

  // ── State machine handlers (fire-and-forget from parseNotification) ─────

  /**
   * Respond to 0x12 (scale info) with AE02 subscribe + AE01 init + 0x13 config.
   *
   * The official Renpho app sequence is: AE02 subscribe -> AE01 init -> 0x13.
   * On Linux, 0x12 can arrive before onConnected() subscribes AE02, so this
   * method must ensure AE02 is subscribed before sending AE01 init.
   *
   * AE01/AE02 writes fail silently on older firmware without AE00 service.
   */
  private async handleScaleInfo(): Promise<void> {
    if (this.configSent) return;
    this.configSent = true;

    // Cancel the fallback timer since the state machine is running normally
    if (this.fallbackTimer) {
      clearTimeout(this.fallbackTimer);
      this.fallbackTimer = null;
    }

    const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

    // Step 1: Subscribe AE02 if not already done (may not have happened yet
    // on Linux where 0x12 arrives before onConnected finishes AE02 subscribe).
    if (!this.hasAe00 && this.ctx) {
      try {
        await this.ctx.subscribe(CHR_AE02);
        this.hasAe00 = true;
        bleLog.debug('QN: subscribed to AE02 (from state machine)');
      } catch {
        // AE02 not available (older firmware)
      }
    }

    // Step 2: AE01 init. Fails silently on firmware without AE00.
    await this.writeAe01([0xfe, 0xdc, 0xba, 0xc0, 0x06, 0x00, 0x02, 0x01, 0x01, 0xef]);
    await wait(200);

    // Step 3: 0x13 config
    // byte[3] = unit flag: 0x01 (kg) or 0x02 (lb) per openScale QNHandler.
    // The Renpho app uses 0x08 which also works but switches the scale display to lb.
    const cmd = [0x13, 0x09, this.seenProtocolType, 0x01, 0x10, 0x00, 0x00, 0x00, 0x00];
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

    // "pass" authentication on AE01. Always attempted; fails silently without AE00.
    await this.writeAe01([0x02, 0x70, 0x61, 0x73, 0x73]);
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

    // 0x22 start measurement / stored-data query with echoed protocol type
    await this.writeCmd(this.buildStoredDataQuery());
  }

  /** Build the 0x22 stored-data query frame with a trailing checksum. */
  private buildStoredDataQuery(): number[] {
    const cmd = [0x22, 0x06, this.seenProtocolType, 0x00, 0x03, 0x00];
    cmd[5] = cmd.reduce((a, b) => a + b, 0) & 0xff;
    return cmd;
  }

  /**
   * Re-send the 0x22 stored-data query after a stale, empty, or short 0x23,
   * bounded by MAX_STORED_QUERY_ATTEMPTS. Gives V10 firmware a moment to save
   * the fresh weigh-in before the scale disconnects (#213 / #75).
   */
  private scheduleStoredDataRetry(): void {
    if (!this.ctx || this.storedQueryAttempts >= MAX_STORED_QUERY_ATTEMPTS) return;
    if (this.storedRetryTimer) clearTimeout(this.storedRetryTimer);
    this.storedRetryTimer = setTimeout(() => {
      this.storedRetryTimer = null;
      if (!this.ctx || this.storedQueryAttempts >= MAX_STORED_QUERY_ATTEMPTS) return;
      this.storedQueryAttempts += 1;
      bleLog.debug(
        `QN: stored-data re-query ${this.storedQueryAttempts}/${MAX_STORED_QUERY_ATTEMPTS}`,
      );
      void this.writeCmd(this.buildStoredDataQuery());
    }, STORED_QUERY_RETRY_MS);
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
