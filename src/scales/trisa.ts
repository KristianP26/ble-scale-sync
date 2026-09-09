import type {
  BleDeviceInfo,
  CharacteristicBinding,
  ConnectionContext,
  ScaleAdapterCore,
  GattWiring,
  MultiCharNotify,
  ScaleReading,
  UserProfile,
  BodyComposition,
} from '../interfaces/scale-adapter.js';
import { uuid16, buildPayload, type ScaleBodyComp } from './body-comp-helpers.js';
import { matchesDescriptor, type MatchDescriptor } from './match-descriptor.js';
import { bleLog, errMsg } from '../ble/types.js';

// Original Trisa firmware exposes 0x8A21 (notify) for measurement.
const CHR_MEASUREMENT_TRISA = uuid16(0x8a21);
// ADE BA 1600 / fitvigo firmware does NOT expose 0x8A21. Measurement frames
// arrive on 0x8A24 (indicate) instead. Frame layout (weight portion) is
// compatible with the Trisa decoder; body composition encoding still TBD.
const CHR_MEASUREMENT_ADE = uuid16(0x8a24);
// On ADE the scale also pushes another payload on 0x8A22 (indicate) shortly
// after the weight frame. Encoding is not yet decoded; we subscribe to it
// purely so future captures with debug logging can collect the bytes.
const CHR_BODYCOMP_ADE = uuid16(0x8a22);
// 0x8A82 is the upload channel on both variants. Trisa sends password (0xA0)
// + challenge (0xA1); ADE only sends challenge (0xA1) without a preceding
// password frame.
const CHR_UPLOAD = uuid16(0x8a82);
// 0x8A81 is the host -> scale write channel on both variants.
const CHR_DOWNLOAD = uuid16(0x8a81);

// openScale opcodes for the Trisa challenge-response protocol.
const OP_PASSWORD = 0xa0;
const OP_CHALLENGE = 0xa1;
// Time-sync command: opcode 0x02 followed by 4-byte LE seconds-since-2010.
// Identical on Trisa and ADE.
const OP_TIME_SYNC = 0x02;
// Final "pairing complete" / broadcast-id opcode. Trisa uses 0x21, ADE 0x22.
const OP_BROADCAST_TRISA = 0x21;
const OP_BROADCAST_ADE = 0x22;
// Challenge response opcode. Trisa echoes 0xA1; ADE uses 0x20 (the response
// payload encoding is also different; see handleUploadChannel).
const OP_RESPONSE_TRISA = 0xa1;
const OP_RESPONSE_ADE = 0x20;

const EPOCH_2010 = 1262304000;

/**
 * Retry budget for a challenge-response write. BlueZ answers a badly timed
 * write with a transient `org.bluez.Error.InProgress`, and the scale is waiting
 * on that single ack (#138).
 */
const CHALLENGE_WRITE_RETRIES = 2;
const CHALLENGE_RETRY_MS = 250;

type Variant = 'trisa' | 'ade';

/**
 * Adapter for the Trisa body-composition scale family.
 *
 * Two firmware variants are supported:
 *   - Trisa (default): exposes 0x8A21 (notify) for measurement, full
 *     password + challenge handshake on 0x8A82.
 *   - ADE BA 1600 / fitvigo: 0x8A21 is missing; measurement arrives on 0x8A24
 *     (indicate). Different challenge-response and different
 *     "pairing complete" opcode (0x22 instead of 0x21). Body-composition
 *     decoding is not yet implemented; only weight is reported.
 *
 * Variant detection happens in `onConnected()` via `ctx.availableChars`:
 * if 0x8A21 is missing but 0x8A24 is present → ADE.
 */
export class TrisaAdapter implements ScaleAdapterCore, GattWiring, MultiCharNotify {
  readonly name = 'Trisa';
  readonly match: MatchDescriptor = { priority: 140, names: { startsWith: ['01257b', '11257b'] } };
  // Legacy single-char fallback (only used when `characteristics` is ignored).
  readonly charNotifyUuid = CHR_MEASUREMENT_TRISA;
  readonly charWriteUuid = CHR_DOWNLOAD;

  readonly normalizesWeight = true;

  readonly characteristics: CharacteristicBinding[] = [
    // Trisa-only measurement char.
    { uuid: CHR_MEASUREMENT_TRISA, type: 'notify', optional: true },
    // ADE-only measurement char.
    { uuid: CHR_MEASUREMENT_ADE, type: 'notify', optional: true },
    // ADE-only body-composition push (encoding TBD; captured via debug log).
    { uuid: CHR_BODYCOMP_ADE, type: 'notify', optional: true },
    // Shared upload channel (password + challenge).
    { uuid: CHR_UPLOAD, type: 'notify' },
    // Shared write channel.
    { uuid: CHR_DOWNLOAD, type: 'write' },
  ];

  /** Detected firmware variant. Set in onConnected(). */
  private variant: Variant = 'trisa';
  /** Stored password from opcode 0xA0 (Trisa). ADE does not send this. */
  private password: Buffer | null = null;
  /** Reference to write function, saved from onConnected context. */
  private writeFn: ConnectionContext['write'] | null = null;
  /** Challenge frame that arrived before the connection was ready (#138). */
  private pendingChallenge: Buffer | null = null;
  /**
   * True once onConnected() has run for the current session.
   *
   * The adapter is a shared singleton, so `writeFn` alone cannot say whether a
   * connection is live: it still holds the previous session's closure after a
   * disconnect, and writing through that one throws.
   */
  private connected = false;

  matches(device: BleDeviceInfo): boolean {
    return matchesDescriptor(device, this.match);
  }

  async onConnected(ctx: ConnectionContext): Promise<void> {
    // NOTE: pendingChallenge is deliberately NOT cleared here. The frame it
    // holds arrived moments ago, before this method ran, and replaying it is the
    // whole point (#138). The PREVIOUS session's leftovers are cleared in
    // onSessionStart(), which runs before anything is subscribed and so cannot
    // discard a frame belonging to this session.
    this.writeFn = ctx.write;
    this.connected = true;

    // Both measurement chars are declared `optional` so that variant detection
    // can pick whichever one the firmware exposes. If neither shows up, that
    // is almost certainly a transient GATT discovery race (BlueZ
    // ServicesResolved firing before all chars are exported (bluez/bluez#1489,
    // or the noble equivalent on Windows/macOS). Fail fast with a clear
    // message instead of silently subscribing to no measurement char and
    // stalling on read.
    const hasMeasurement =
      ctx.availableChars.has(CHR_MEASUREMENT_TRISA) || ctx.availableChars.has(CHR_MEASUREMENT_ADE);
    if (!hasMeasurement) {
      throw new Error(
        'Trisa: no measurement characteristic discovered (expected 0x8A21 or 0x8A24). ' +
          'Likely a transient GATT discovery race. Try again.',
      );
    }

    this.variant = this.detectVariant(ctx.availableChars);
    bleLog.debug(`Trisa adapter: variant=${this.variant}`);

    // Time sync (same opcode on both variants).
    const now = Math.floor(Date.now() / 1000) - EPOCH_2010;
    const tsCmd = Buffer.alloc(5);
    tsCmd[0] = OP_TIME_SYNC;
    tsCmd.writeUInt32LE(now, 1);
    await ctx.write(CHR_DOWNLOAD, [...tsCmd], true);

    // Broadcast / pairing-complete opcode differs between variants.
    const broadcastOp = this.variant === 'ade' ? OP_BROADCAST_ADE : OP_BROADCAST_TRISA;
    await ctx.write(CHR_DOWNLOAD, [broadcastOp], true);

    // Replay a challenge that beat this method to the notification handler, now
    // that both the write function and the variant are known (#138).
    const queued: Buffer | null = this.pendingChallenge;
    if (queued) {
      this.pendingChallenge = null;
      bleLog.debug(`Replaying queued challenge: ${queued.toString('hex')}`);
      this.handleUploadChannel(queued);
    }
  }

  /**
   * End of a GATT session: forget everything tied to it.
   *
   * `writeFn` is a closure over the connection that just went away, so anything
   * written through it after this point is discarded by the transport (on the
   * mqtt-proxy it is published into the void and even resolves successfully).
   * Clearing `connected` is also what re-arms the pre-connect challenge queue
   * for the next cycle; without it the #138 fix would work exactly once per
   * process, which in continuous mode means once ever.
   */
  /**
   * Clear the previous session's negotiated state (#394).
   *
   * This is the reliable half of the pair. onSessionEnd is best effort: a
   * timeout abandons the read promise rather than cancelling it, so it fires
   * only if a disconnect event follows, and the ESPHome proxy scan path can
   * drop a session without reaching cleanup. A session that ended either of
   * those ways used to carry its password and any unreplayed challenge into
   * the next one.
   *
   * Safe to clear pendingChallenge here, unlike in onConnected: nothing is
   * subscribed yet, so no frame of THIS session can have arrived.
   */
  onSessionStart(): void {
    this.pendingChallenge = null;
    this.password = null;
  }

  /**
   * Release the connection references. These two are not session state to be
   * re-derived but a live handle to a link that is gone, and writing through a
   * stale one throws (#138), so they are dropped as soon as the session ends
   * rather than waiting for the next one to start.
   */
  onSessionEnd(): void {
    this.connected = false;
    this.writeFn = null;
  }

  /**
   * Variant precedence: pick `ade` only when 0x8A21 is *absent* and 0x8A24 is
   * present. Any other combination defaults to `trisa`, which preserves the
   * original handshake. A hypothetical hybrid firmware exposing both chars
   * would be driven as Trisa (the safer default: known protocol, known
   * challenge response).
   */
  private detectVariant(available: ReadonlySet<string>): Variant {
    const hasTrisa = available.has(CHR_MEASUREMENT_TRISA);
    const hasAde = available.has(CHR_MEASUREMENT_ADE);
    if (!hasTrisa && hasAde) return 'ade';
    return 'trisa';
  }

  /**
   * Dispatch notifications from different characteristics.
   *
   * Trisa:
   *   - 0x8A82: password (0xA0) and challenge (0xA1) frames
   *   - 0x8A21: measurement data
   * ADE BA 1600:
   *   - 0x8A82: challenge (0xA1), no password frame; response algo unknown
   *   - 0x8A24: measurement data (Trisa-compatible weight encoding)
   *   - 0x8A22: body-composition push (encoding TBD)
   */
  parseCharNotification(charUuid: string, data: Buffer): ScaleReading | null {
    if (charUuid === CHR_UPLOAD) {
      this.handleUploadChannel(data);
      return null;
    }
    if (charUuid === CHR_MEASUREMENT_TRISA || charUuid === CHR_MEASUREMENT_ADE) {
      return this.parseMeasurement(data);
    }
    if (charUuid === CHR_BODYCOMP_ADE) {
      // fitvigo's BE1615 protocol stubs out addBodyAnalysis (empty native
      // function), so even the official app does not decode this frame from
      // BLE; it derives body composition on-phone from weight + user
      // profile. We follow the same approach via Deurenberg in computeMetrics.
      // Logging the raw bytes still helps if a later firmware variant
      // surfaces an actual encoding here.
      bleLog.debug(`ADE body-comp frame on 0x8A22 (ignored, see comment): ${data.toString('hex')}`);
      return null;
    }
    return null;
  }

  /**
   * Fallback for legacy single-char path. Parses measurement data only.
   */
  parseNotification(data: Buffer): ScaleReading | null {
    return this.parseMeasurement(data);
  }

  isComplete(reading: ScaleReading): boolean {
    return reading.weight > 0;
  }

  computeMetrics(reading: ScaleReading, profile: UserProfile): BodyComposition {
    const comp: ScaleBodyComp = {};
    return buildPayload(reading.weight, reading.impedance, comp, profile);
  }

  /**
   * Handle password and challenge frames from the upload channel (0x8A82).
   *
   * Trisa flow: scale sends 0xA0 (password), then 0xA1 (challenge); host
   * responds with [0xA1, XOR(challenge, password)].
   *
   * ADE BA 1600 flow: scale sends 0xA1 (challenge) directly without a
   * password frame. fitvigo's native protocol (`corelib::VBaseA2PairingProtocol`
   * + `ProtocolUtils::sendVerificationCode`) computes the response as
   * `[0x20, LE32(savedPassword XOR challengeInt)]`, where `challengeInt` is
   * the four bytes after the opcode read as little-endian uint32. Because
   * BE1615 never receives a 0xA0 frame, `savedPassword` stays at its default
   * zero, so the response collapses to `[0x20]` followed by an echo of the
   * same four bytes.
   */
  private handleUploadChannel(data: Buffer): void {
    if (data.length < 2) return;
    const opcode = data[0];

    // On Linux the CCCD write and onConnected() run in parallel, so the scale's
    // challenge can arrive before this adapter has a connection at all. Neither
    // the write function nor the detected variant exists yet, and the frame used
    // to be dropped without so much as a log line: the scale then waited for an
    // ack that never came, once per cycle, forever (#138). Hold the raw frame
    // and replay it from onConnected(), where both are known.
    if (opcode === OP_CHALLENGE && !this.connected) {
      this.pendingChallenge = Buffer.from(data);
      bleLog.debug('Challenge arrived before connect completed; queued for replay');
      return;
    }

    if (this.variant === 'ade') {
      if (opcode === OP_CHALLENGE && data.length >= 5) {
        // Echo the four bytes that follow the opcode (XOR with savedPassword=0).
        const response = Buffer.from([OP_RESPONSE_ADE, data[1], data[2], data[3], data[4]]);
        this.sendResponse(
          response,
          `ADE challenge ack sent: ${response.toString('hex')}`,
          Buffer.from(data),
        );
      } else {
        bleLog.debug(`ADE upload frame (unhandled opcode): ${data.toString('hex')}`);
      }
      return;
    }

    if (opcode === OP_PASSWORD) {
      this.password = Buffer.from(data.subarray(1));
    } else if (opcode === OP_CHALLENGE && this.password) {
      const challenge = data.subarray(1);
      const response = Buffer.alloc(challenge.length + 1);
      response[0] = OP_RESPONSE_TRISA;
      for (let i = 0; i < challenge.length; i++) {
        response[i + 1] = challenge[i] ^ (this.password[i % this.password.length] ?? 0);
      }
      this.sendResponse(response, undefined, Buffer.from(data));
    }
  }

  /**
   * Write a challenge response without awaiting it, but WITH a rejection
   * handler.
   *
   * A bare `void writeFn(...)` here is what took the whole process down in
   * #138: BlueZ answered the write with `org.bluez.Error.InProgress`, nothing
   * was attached to the rejected promise, and Node killed the app on the
   * unhandled rejection. In continuous mode that ends the service; only a
   * container restart policy brought it back.
   */
  private sendResponse(response: Buffer, successLog?: string, replayOnFailure?: Buffer): void {
    const write = this.writeFn;
    if (!write) return;
    const attempt = (retriesLeft: number): void => {
      write(CHR_DOWNLOAD, response, true).then(
        () => {
          if (successLog) bleLog.debug(successLog);
        },
        (err: unknown) => {
          // `org.bluez.Error.InProgress` is what #138 actually hit, and it is
          // transient: another D-Bus operation was in flight on the same
          // adapter. Retrying in-session is what answers the scale on THIS
          // link; queueing for the next one answers a nonce it has forgotten.
          if (retriesLeft > 0 && this.connected) {
            bleLog.debug(`Challenge response write failed, retrying: ${errMsg(err)}`);
            setTimeout(() => attempt(retriesLeft - 1), CHALLENGE_RETRY_MS);
            return;
          }
          bleLog.debug(`Challenge response write failed: ${errMsg(err)}`);
          // Out of retries: the link is most likely already gone. Keep the frame
          // only while no newer one is waiting, so a late failure cannot clobber
          // a fresher challenge.
          if (replayOnFailure && !this.pendingChallenge) this.pendingChallenge = replayOnFailure;
        },
      );
    };
    attempt(CHALLENGE_WRITE_RETRIES);
  }

  /**
   * Parse a Trisa measurement frame.
   *
   * Layout (verified for Trisa 0x8A21 and ADE BA 1600 0x8A24, weight only):
   *   [0]      info flags
   *             bit 0: timestamp present (7 bytes at offset 5)
   *             bit 1: resistance1 present (4 bytes base-10 float)
   *             bit 2: resistance2 present (4 bytes base-10 float)
   *   [1-3]    weight mantissa, unsigned 24-bit little-endian
   *   [4]      weight exponent, signed int8
   *   [5+]     optional timestamp (7 bytes if bit0 set)
   *   then:    optional resistance1 (4 bytes if bit1 set)
   *   then:    optional resistance2 (4 bytes if bit2 set)
   *
   * Weight = mantissa * 10^exponent.
   * Impedance from resistance2: r2 < 410 ? 3.0 : 0.3 * (r2 - 400).
   *
   * NOTE: only the Trisa branch walks the optional-field table. For ADE the
   * post-weight layout is unverified (timestamp may be 8 bytes instead of 7)
   * and body comp arrives on a separate 0x8A22 push, so the parser
   * short-circuits to weight-only after computing the weight.
   */
  private parseMeasurement(data: Buffer): ScaleReading | null {
    if (data.length < 5) return null;

    const flags = data[0];
    const hasTimestamp = (flags & 0x01) !== 0;
    const hasResistance1 = (flags & 0x02) !== 0;
    const hasResistance2 = (flags & 0x04) !== 0;

    // Skip frames that are just timestamps (only bit0 set, no weight data expected)
    if (hasTimestamp && !hasResistance1 && !hasResistance2) {
      const mantissa = data[1] | (data[2] << 8) | (data[3] << 16);
      if (mantissa === 0) return null;
    }

    // Weight: 24-bit unsigned LE mantissa + signed exponent
    const mantissa = data[1] | (data[2] << 8) | (data[3] << 16);
    const exponent = data.readInt8(4);
    const weight = mantissa * Math.pow(10, exponent);

    if (weight <= 0 || !Number.isFinite(weight)) return null;

    // ADE BA 1600: only the weight bytes are verified (single capture frame in
    // #138). The post-weight layout (timestamp width, resistance encoding)
    // is not confirmed and body-comp values arrive on a separate 0x8A22 push
    // anyway. Don't walk the offset table; return weight only until more
    // captures are available.
    if (this.variant === 'ade') return { weight, impedance: 0 };

    // Walk through optional fields to find resistance2.
    let offset = 5;
    if (hasTimestamp) offset += 7;
    if (hasResistance1) offset += 4;

    let impedance = 0;
    if (hasResistance2 && offset + 4 <= data.length) {
      const r2Mantissa = data[offset] | (data[offset + 1] << 8) | (data[offset + 2] << 16);
      const r2Exponent = data.readInt8(offset + 3);
      const r2 = r2Mantissa * Math.pow(10, r2Exponent);

      if (r2 < 410) {
        impedance = 3.0;
      } else {
        impedance = 0.3 * (r2 - 400);
      }
    }

    return { weight, impedance };
  }
}
