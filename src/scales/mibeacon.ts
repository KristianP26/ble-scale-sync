import { createDecipheriv } from 'node:crypto';

/**
 * Shared MiBeacon (Xiaomi 0xFE95 service data) helpers for the broadcast
 * adapters of Xiaomi scales that publish encrypted MiBeacon v5 frames. Kept
 * protocol-only: no adapter state, no logging.
 */

/** Xiaomi MiService advertisement service UUID (normalized 32-char form). */
export const SVC_FE95 = '0000fe9500001000800000805f9b34fb';

/** MiBeacon frame-control bits. */
export const FC_ENCRYPTED = 0x08;
export const FC_MAC_INCLUDED = 0x10;

/** Normalize a service-data UUID (short, dashed, or 128-bit) to 32-char hex. */
export function normUuid(uuid: string): string {
  const s = uuid.toLowerCase().replace(/[-{}]/g, '');
  if (s.length === 4) return `0000${s}00001000800000805f9b34fb`;
  if (s.length === 8) return `${s}00001000800000805f9b34fb`;
  return s;
}

/** Return the 6-byte frame-order MAC if the FE95 frame includes it, else null. */
export function macFrameOrderFromFrame(data: Buffer): Buffer | null {
  if (data.length < 11) return null;
  const fc = data.readUInt16LE(0);
  if ((fc & FC_MAC_INCLUDED) === 0) return null;
  return data.subarray(5, 11);
}

/**
 * Decrypt a MiBeacon v5 FE95 advertisement. Returns the decrypted object TLV
 * (`type(2 LE) | len | value`) or null when the frame is unencrypted, malformed,
 * or fails the AES-CCM tag (wrong key / wrong MAC).
 *
 * Layout: FC(2 LE) | PID(2) | cnt(1) | [MAC(6) if FC&0x10] | cipher | extCnt(3) | MIC(4).
 * nonce = macFrameOrder(6) || data[2..5) || extCnt(3); AAD = 0x11; tag = 4 bytes.
 */
export function decryptMiBeaconV5(
  data: Buffer,
  bindKey: Buffer,
  macFrameOrder: Buffer,
): Buffer | null {
  if (data.length < 12 || bindKey.length !== 16 || macFrameOrder.length !== 6) return null;
  const fc = data.readUInt16LE(0);
  if ((fc & FC_ENCRYPTED) === 0) return null;
  const cipherStart = (fc & FC_MAC_INCLUDED) !== 0 ? 11 : 5;
  if (data.length < cipherStart + 7) return null;
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
