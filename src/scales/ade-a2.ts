/**
 * @experimental NOT YET FUNCTIONAL — see #159 for status.
 *
 * Reverse-engineered scaffolding for ADE A2-family scales:
 *   BA1400, BA1401, BE1511, BE1512, BA1501, BA1502
 *
 * This adapter is intentionally NOT registered in `src/scales/index.ts`.
 * `matches()` always returns `false`, so it cannot be selected at runtime
 * without manual registration. The class exists in the repo as a reference
 * point for testers / future contributors who own the hardware.
 *
 * ## What's known (from fitvigo 1.2.2 APK reverse engineering)
 *
 * - Service UUID: **0x7802** (confirmed via
 *   `corelib::VScaleA2CollectionProtocol::serviceId()` returning `0x7802`).
 * - Single-char measurement dispatch (`onCharacteristicChanged` matches
 *   only one char index from `config->[0x18]`); no separate body-composition
 *   push frame. Body composition is computed on-phone from weight + impedance
 *   + user profile (`addBodyAnalysysTo(IScaleRecord, float, float)`), so the
 *   BLE frame carries weight + impedance only.
 * - Pairing handshake inherits `VBaseA2PairingProtocol`, identical to what
 *   the Trisa adapter already implements:
 *     - Scale → host: `0xA0` (password) on the upload channel
 *     - Scale → host: `0xA1` (challenge)
 *     - Host → scale: `[0xA1, XOR(challenge, password)]` on the write channel
 * - A `writeTimeOffset()` step exists in `VScalesA2PairingProtocol` that
 *   issues a time-sync command before measurement is unlocked. The opcode
 *   has not been confirmed (Trisa uses `0x02` followed by 4-byte LE
 *   seconds-since-2010 — A2 is likely the same).
 *
 * ## What's NOT known yet
 *
 * - **BLE local name prefix.** Trisa uses `01257B` / `11257B`. A2 family
 *   advertises differently — could be a different vendor prefix or fitvigo
 *   may rely on the service UUID alone. Until we see one in a scan, the
 *   adapter cannot match a real device.
 * - **Characteristic UUIDs inside service `0x7802`.** Native code resolves
 *   chars through a runtime config struct. Need an HCI capture or symbol
 *   cross-reference to pin them down.
 * - **Weight + impedance frame layout.** `saveMeasurements(vector, bool)`
 *   is ~2.1 KB of optimized code with multiple flag-driven branches. A
 *   single decoded frame from a real device would unlock the offsets.
 *
 * ## How to finish this adapter
 *
 * 1. Run `npm run scan --debug` against the target scale; capture the BLE
 *    name + advertised service UUIDs.
 * 2. Capture an HCI snoop log of a complete fitvigo weigh-in (instructions
 *    in #138 thread).
 * 3. Update `matches()` with the observed name prefix.
 * 4. Replace the placeholder UUIDs below with the actual char UUIDs.
 * 5. Implement `parseMeasurement()` against frames from the capture.
 * 6. Add fixture tests, register in `src/scales/index.ts`, drop the
 *    `@experimental` flag.
 */

import type {
  BleDeviceInfo,
  CharacteristicBinding,
  ConnectionContext,
  ScaleAdapter,
  ScaleReading,
  UserProfile,
  BodyComposition,
} from '../interfaces/scale-adapter.js';
import { uuid16, buildPayload } from './body-comp-helpers.js';
import { bleLog } from '../ble/types.js';

// Service UUID confirmed from libcorelib.so: VScaleA2CollectionProtocol::serviceId() = 0x7802.
// Characteristic UUIDs are placeholders — need an HCI capture to confirm. The
// values below match the layout used by the A3 family (Trisa) so the same
// upload/download/measurement char roles apply if A2 mirrors the layout, but
// this is unverified.
const SVC_ADE_A2 = uuid16(0x7802);
const CHR_MEASUREMENT_PLACEHOLDER = uuid16(0x8a21);
const CHR_UPLOAD_PLACEHOLDER = uuid16(0x8a82);
const CHR_DOWNLOAD_PLACEHOLDER = uuid16(0x8a81);

// Inherited handshake opcodes from VBaseA2PairingProtocol (same as Trisa).
const OP_PASSWORD = 0xa0;
const OP_CHALLENGE = 0xa1;
const OP_RESPONSE = 0xa1;
const OP_TIME_SYNC = 0x02;
const EPOCH_2010 = 1262304000;

/**
 * Adapter scaffold for ADE A2-family scales. See file-level JSDoc for status.
 *
 * Once the BLE name prefix and characteristic UUIDs are confirmed via a real
 * device scan, this class can be promoted to a working adapter without
 * structural changes — the handshake logic (password + challenge XOR) is
 * already correct because A2 and A3 share the `VBaseA2PairingProtocol`
 * implementation in `libcorelib.so`.
 */
export class AdeA2Adapter implements ScaleAdapter {
  readonly name = 'ADE A2 (experimental)';
  readonly charNotifyUuid = CHR_MEASUREMENT_PLACEHOLDER;
  readonly charWriteUuid = CHR_DOWNLOAD_PLACEHOLDER;
  readonly normalizesWeight = true;
  readonly unlockCommand: number[] = [];
  readonly unlockIntervalMs = 0;

  readonly characteristics: CharacteristicBinding[] = [
    { service: SVC_ADE_A2, uuid: CHR_MEASUREMENT_PLACEHOLDER, type: 'notify' },
    { service: SVC_ADE_A2, uuid: CHR_UPLOAD_PLACEHOLDER, type: 'notify' },
    { service: SVC_ADE_A2, uuid: CHR_DOWNLOAD_PLACEHOLDER, type: 'write' },
  ];

  private password: Buffer | null = null;
  private writeFn: ConnectionContext['write'] | null = null;

  /**
   * Always returns false — adapter is not active yet. Update this with the
   * real BLE name prefix once a scan output is available.
   */
  matches(_device: BleDeviceInfo): boolean {
    return false;
  }

  async onConnected(ctx: ConnectionContext): Promise<void> {
    this.writeFn = ctx.write;

    // Time sync — opcode + 4-byte LE seconds-since-2010, mirroring Trisa.
    // VScalesA2PairingProtocol::writeTimeOffset uses the same shape per the
    // disassembly. Treat as best-effort until verified against real frames.
    const now = Math.floor(Date.now() / 1000) - EPOCH_2010;
    const tsCmd = Buffer.alloc(5);
    tsCmd[0] = OP_TIME_SYNC;
    tsCmd.writeUInt32LE(now, 1);
    await ctx.write(CHR_DOWNLOAD_PLACEHOLDER, [...tsCmd], true);
  }

  parseCharNotification(charUuid: string, data: Buffer): ScaleReading | null {
    if (charUuid === CHR_UPLOAD_PLACEHOLDER) {
      this.handleUploadChannel(data);
      return null;
    }
    if (charUuid === CHR_MEASUREMENT_PLACEHOLDER) {
      return this.parseMeasurement(data);
    }
    return null;
  }

  parseNotification(data: Buffer): ScaleReading | null {
    return this.parseMeasurement(data);
  }

  isComplete(reading: ScaleReading): boolean {
    return reading.weight > 0;
  }

  computeMetrics(reading: ScaleReading, profile: UserProfile): BodyComposition {
    return buildPayload(reading.weight, reading.impedance, {}, profile);
  }

  /**
   * Password + challenge handler — same algorithm as Trisa because both
   * derive from `VBaseA2PairingProtocol`. Scale sends `0xA0` (password),
   * then `0xA1` (challenge); host responds with `[0xA1, XOR(challenge, password)]`.
   */
  private handleUploadChannel(data: Buffer): void {
    if (data.length < 2) return;
    const opcode = data[0];

    if (opcode === OP_PASSWORD) {
      this.password = Buffer.from(data.subarray(1));
    } else if (opcode === OP_CHALLENGE && this.password && this.writeFn) {
      const challenge = data.subarray(1);
      const response = Buffer.alloc(challenge.length + 1);
      response[0] = OP_RESPONSE;
      for (let i = 0; i < challenge.length; i++) {
        response[i + 1] = challenge[i] ^ (this.password[i % this.password.length] ?? 0);
      }
      void this.writeFn(CHR_DOWNLOAD_PLACEHOLDER, response, true);
    }
  }

  /**
   * Placeholder weight + impedance parser.
   *
   * `VScaleA2CollectionProtocol::saveMeasurements` is ~2.1 KB of optimized
   * code with flag-driven optional fields. Without a real frame to compare
   * against, returning null avoids fabricating fake readings.
   */
  private parseMeasurement(data: Buffer): ScaleReading | null {
    bleLog.debug(`ADE A2 measurement frame (TBD encoding): ${data.toString('hex')}`);
    return null;
  }
}
