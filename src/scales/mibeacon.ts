import { createDecipheriv } from 'node:crypto';

/**
 * Shared MiBeacon (Xiaomi 0xFE95 service data) helpers used by the broadcast
 * adapters for Xiaomi scales that publish encrypted MiBeacon v5 frames (S800,
 * S400). Kept protocol-only: no adapter state, no logging.
 *
 * Frame layout (MiBeacon v4/v5):
 *
 *   FC(2 LE) | PID(2 LE) | cnt(1) | [MAC(6) if FC&0x10] | [cap(1) [+io(1)] if FC&0x20]
 *   | payload | [extCnt(3) | MIC(4) if FC&0x08]
 *
 * The payload is a sequence of objects, each `type(2 LE) | len(1) | value(len)`.
 * Encrypted frames use AES-128-CCM with a 4-byte tag, nonce =
 * `MAC(frame order, 6) || PID(2) || cnt(1) || extCnt(3)` and AAD `0x11`.
 */

/** Xiaomi MiService advertisement service UUID (normalized 32-char form). */
export const SVC_FE95 = '0000fe9500001000800000805f9b34fb';

/** MiBeacon frame-control bits (low byte). */
export const FC_ENCRYPTED = 0x08;
export const FC_MAC_INCLUDED = 0x10;
export const FC_CAPABILITY_INCLUDED = 0x20;
export const FC_OBJECT_INCLUDED = 0x40;

/** Capability-byte bit that adds a second (I/O) capability byte. */
const CAP_IO_INCLUDED = 0x20;

/** Minimum frame: FC + PID + cnt. */
const HEADER_MIN = 5;

/** Normalize a service-data UUID (short, dashed, or 128-bit) to 32-char hex. */
export function normUuid(uuid: string): string {
  const s = uuid.toLowerCase().replace(/[-{}]/g, '');
  if (s.length === 4) return `0000${s}00001000800000805f9b34fb`;
  if (s.length === 8) return `${s}00001000800000805f9b34fb`;
  return s;
}

/** Product id (device type) from a FE95 frame, or null when the frame is too short. */
export function miBeaconProductId(data: Buffer): number | null {
  return data.length >= 4 ? data.readUInt16LE(2) : null;
}

/** Return the 6-byte frame-order MAC if the FE95 frame includes it, else null. */
export function macFrameOrderFromFrame(data: Buffer): Buffer | null {
  if (data.length < 11) return null;
  const fc = data.readUInt16LE(0);
  if ((fc & FC_MAC_INCLUDED) === 0) return null;
  return data.subarray(5, 11);
}

/**
 * Convert a human-readable BLE address (`AA:BB:CC:DD:EE:FF`, dashes or bare hex
 * accepted) into the 6-byte frame-order (reversed) MAC that MiBeacon frames and
 * the CCM nonce use. Returns null for anything that is not 12 hex digits, e.g.
 * a macOS CoreBluetooth UUID.
 */
export function macFrameOrderFromAddress(address: string): Buffer | null {
  const hex = address.replace(/[:\-\s]/g, '').toLowerCase();
  if (!/^[0-9a-f]{12}$/.test(hex)) return null;
  return Buffer.from(hex, 'hex').reverse();
}

/**
 * Offset of the payload (object list, or ciphertext when encrypted) within a
 * FE95 frame, accounting for the optional MAC and capability bytes. Returns
 * null when the frame is shorter than its own header claims.
 */
export function miBeaconPayloadOffset(data: Buffer): number | null {
  if (data.length < HEADER_MIN) return null;
  const fc = data.readUInt16LE(0);
  let i = HEADER_MIN;
  if ((fc & FC_MAC_INCLUDED) !== 0) i += 6;
  if ((fc & FC_CAPABILITY_INCLUDED) !== 0) {
    if (data.length < i + 1) return null;
    const cap = data[i];
    i += 1;
    if ((cap & CAP_IO_INCLUDED) !== 0) i += 1;
  }
  return data.length >= i ? i : null;
}

/**
 * Decrypt a MiBeacon v5 FE95 advertisement. Returns the decrypted object list
 * (`type(2 LE) | len | value`, repeated) or null when the frame is unencrypted,
 * malformed, or fails the AES-CCM tag (wrong key / wrong MAC).
 *
 * `macFrameOrder` is the device MAC in frame byte order (reversed), taken from
 * the frame itself when FC&0x10 is set, else from an earlier MAC-included frame
 * or the configured `ble.scale_mac`.
 */
export function decryptMiBeaconV5(
  data: Buffer,
  bindKey: Buffer,
  macFrameOrder: Buffer,
): Buffer | null {
  if (data.length < 12 || bindKey.length !== 16 || macFrameOrder.length !== 6) return null;
  const fc = data.readUInt16LE(0);
  if ((fc & FC_ENCRYPTED) === 0) return null;
  const cipherStart = miBeaconPayloadOffset(data);
  if (cipherStart === null || data.length < cipherStart + 7) return null;
  const cipher = data.subarray(cipherStart, data.length - 7);
  const extCnt = data.subarray(data.length - 7, data.length - 4);
  const mic = data.subarray(data.length - 4);
  const nonce = Buffer.concat([macFrameOrder, data.subarray(2, 5), extCnt]);
  try {
    const dec = createDecipheriv('aes-128-ccm', bindKey, nonce, { authTagLength: 4 });
    dec.setAuthTag(mic);
    dec.setAAD(Buffer.from([0x11]), { plaintextLength: cipher.length });
    return Buffer.concat([dec.update(cipher), dec.final()]);
  } catch {
    return null;
  }
}

/** One decoded MiBeacon object: numeric type id plus its raw value bytes. */
export interface MiBeaconObject {
  id: number;
  value: Buffer;
}

/**
 * Split a (decrypted) MiBeacon payload into its objects. Stops at the first
 * object whose declared length overruns the buffer, so a truncated or
 * mis-decrypted payload yields only the objects that fit.
 */
export function iterateMiBeaconObjects(payload: Buffer): MiBeaconObject[] {
  const objects: MiBeaconObject[] = [];
  let i = 0;
  while (payload.length >= i + 3) {
    const id = payload.readUInt16LE(i);
    const len = payload[i + 2];
    const next = i + 3 + len;
    if (payload.length < next) break;
    objects.push({ id, value: payload.subarray(i + 3, next) });
    i = next;
  }
  return objects;
}
