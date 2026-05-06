/**
 * @experimental NOT YET FUNCTIONAL. See #159 for status.
 *
 * Reverse-engineered scaffolding for ADE A2-family scales:
 *   BA1400, BA1401, BE1511, BE1512, BA1501, BA1502
 *
 * The {@link AdeA2Adapter} class is intentionally NOT registered in
 * `src/scales/index.ts` and an automated test guards that. Its `matches()`
 * always returns `false`, every characteristic UUID is the empty-string
 * sentinel `UUID_TBD`, and `onConnected()` is a no-op, so the class cannot
 * write anything to a real device, even if a future contributor manually
 * adds it to the registry without finishing the protocol decode.
 *
 * The reverse-engineered protocol pieces that ARE verified live as exported
 * pure helpers ({@link buildAdeA2TimeSyncCommand},
 * {@link buildAdeA2ChallengeResponse}) so they can be tested independently
 * and reused once the missing pieces are filled in.
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
 * - Pairing handshake inherits `VBaseA2PairingProtocol` (same as Trisa):
 *     - Scale → host: `0xA0` (password) on the upload channel
 *     - Scale → host: `0xA1` (challenge)
 *     - Host → scale: `[0xA1, XOR(challenge, password)]` on the write channel
 * - A `writeTimeOffset()` step in `VScalesA2PairingProtocol` issues a
 *   time-sync command before measurement is unlocked. The frame layout
 *   matches Trisa: `[0x02, <4-byte LE seconds-since-2010>]`.
 *
 * ## What's NOT known yet
 *
 * - **BLE local name prefix.** Trisa uses `01257B` / `11257B`. A2 family
 *   advertises differently. Possibly a different vendor prefix, or fitvigo
 *   may rely on the service UUID alone.
 * - **Characteristic UUIDs inside service `0x7802`.** Native code resolves
 *   chars through a runtime config struct; an HCI capture is needed to pin
 *   them down.
 * - **Weight + impedance frame layout.** `saveMeasurements(vector, bool)`
 *   is ~2.1 KB of optimized native code with multiple flag-driven branches.
 *
 * ## How to finish this adapter
 *
 * 1. Run `DEBUG=true npm run scan` against the target scale; capture the
 *    BLE name + advertised service UUIDs.
 * 2. Capture an HCI snoop log of a complete fitvigo weigh-in (instructions
 *    in #138 thread).
 * 3. Replace each `UUID_TBD` constant with the observed UUID.
 * 4. Update `matches()` with the observed name prefix.
 * 5. Implement `parseMeasurement()` against frames from the capture.
 * 6. Wire `onConnected()` to call {@link buildAdeA2TimeSyncCommand} and
 *    forward `buildAdeA2ChallengeResponse` from the upload-channel handler.
 * 7. Add fixture tests, register in `src/scales/index.ts`, drop the
 *    `@experimental` flag.
 */

import type {
  BleDeviceInfo,
  ConnectionContext,
  ScaleAdapter,
  ScaleReading,
  UserProfile,
  BodyComposition,
} from '../interfaces/scale-adapter.js';
import { buildPayload } from './body-comp-helpers.js';
import { bleLog } from '../ble/types.js';

/**
 * Sentinel for characteristic UUIDs we have not yet decoded. Empty string is
 * deliberately invalid: any handler lookup will return undefined and
 * fail-fast with a "characteristic not found" error rather than silently
 * subscribing to the wrong char.
 */
const UUID_TBD = '';

// Pairing handshake opcodes (from VBaseA2PairingProtocol). The password
// frame opcode 0xA0 is documented here for future implementers but is not
// used by the helpers below; it identifies inbound frames on the upload
// channel and is the responsibility of the (yet-to-be-written) char
// notification handler.
const OP_CHALLENGE = 0xa1;
const OP_TIME_SYNC = 0x02;
const EPOCH_2010 = 1262304000;
const TIME_SYNC_FRAME_LENGTH = 5;

const NOT_IMPLEMENTED_MSG =
  'AdeA2Adapter is scaffolding (#159). Characteristic UUIDs and BLE name ' +
  'prefix are not yet known. Do not register before completing the decode.';

/**
 * Build the time-sync command frame written to the scale at the start of a
 * pairing session. Layout (5 bytes): `[OP_TIME_SYNC, <uint32 LE>]` where the
 * uint32 is the number of seconds elapsed since 2010-01-01 UTC.
 *
 * Identical to the Trisa adapter's time-sync write. The underlying native
 * implementation (`VScalesA2PairingProtocol::writeTimeOffset`) is shared
 * between A2 and A3 protocol families.
 */
export function buildAdeA2TimeSyncCommand(now: Date = new Date()): Buffer {
  const buf = Buffer.alloc(TIME_SYNC_FRAME_LENGTH);
  buf[0] = OP_TIME_SYNC;
  buf.writeUInt32LE(Math.floor(now.getTime() / 1000) - EPOCH_2010, 1);
  return buf;
}

/**
 * Compute the response to an A2 pairing challenge: `[OP_CHALLENGE, XOR(...)]`,
 * where each byte of the challenge is XORed with the corresponding byte of
 * the previously-received password (cycled if the lengths differ).
 *
 * Mirrors `VBaseA2PairingProtocol::onRandomReceived` in `libcorelib.so`.
 */
export function buildAdeA2ChallengeResponse(challenge: Buffer, password: Buffer): Buffer {
  if (password.length === 0) {
    throw new Error('buildAdeA2ChallengeResponse: password buffer is empty');
  }
  const response = Buffer.alloc(challenge.length + 1);
  response[0] = OP_CHALLENGE;
  for (let i = 0; i < challenge.length; i++) {
    response[i + 1] = challenge[i] ^ password[i % password.length];
  }
  return response;
}

/**
 * Adapter scaffold for ADE A2-family scales. See file-level JSDoc for status.
 *
 * All adapter methods are inert: `matches()` returns false, `onConnected()`
 * is a no-op, the upload channel handler stores nothing, and
 * `parseMeasurement()` returns null. The verified protocol formulas live in
 * the exported helpers above and can be wired in once the missing pieces
 * (BLE name prefix, real char UUIDs, weight frame layout) are known.
 */
export class AdeA2Adapter implements ScaleAdapter {
  readonly name = 'ADE A2 (experimental)';
  readonly charNotifyUuid = UUID_TBD;
  readonly charWriteUuid = UUID_TBD;
  readonly normalizesWeight = true;
  readonly unlockCommand: number[] = [];
  readonly unlockIntervalMs = 0;

  matches(_device: BleDeviceInfo): boolean {
    return false;
  }

  onConnected(_ctx: ConnectionContext): void {
    bleLog.warn(NOT_IMPLEMENTED_MSG);
  }

  parseCharNotification(_charUuid: string, data: Buffer): ScaleReading | null {
    bleLog.debug(`ADE A2 frame (TBD encoding): ${data.toString('hex')}`);
    return null;
  }

  parseNotification(data: Buffer): ScaleReading | null {
    bleLog.debug(`ADE A2 frame (TBD encoding): ${data.toString('hex')}`);
    return null;
  }

  isComplete(reading: ScaleReading): boolean {
    return reading.weight > 0;
  }

  computeMetrics(reading: ScaleReading, profile: UserProfile): BodyComposition {
    return buildPayload(reading.weight, reading.impedance, {}, profile);
  }
}
