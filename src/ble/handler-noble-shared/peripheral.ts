import type { Peripheral } from '@stoprocent/noble';
import { normalizeUuid } from '../types.js';

/** Convert Noble's raw manufacturer data buffer to {id, data} format. */
export function parseMfgData(raw: Buffer | undefined): { id: number; data: Buffer } | undefined {
  if (!raw || raw.length < 2) return undefined;
  return { id: raw.readUInt16LE(0), data: raw.subarray(2) };
}

/**
 * Advertised service data with normalized UUIDs, the form every other transport
 * hands the adapter resolver. Undefined when the advertisement carries none.
 *
 * Without it, the pre-connect resolution (auto-discovery and the target-MAC
 * broadcast-vs-GATT decision) and the post-connect one never saw service
 * data, so adapters that recognise a scale by it (Xiaomi S400 / S800 on FE95,
 * the nameless Mi Scale 2 branch) could not match on Windows or macOS (B-10).
 */
export function parseServiceData(
  peripheral: Peripheral,
): Array<{ uuid: string; data: Buffer }> | undefined {
  const list = peripheral.advertisement?.serviceData ?? [];
  const out = list
    .filter((sd) => typeof sd?.uuid === 'string' && Buffer.isBuffer(sd.data))
    .map((sd) => ({ uuid: normalizeUuid(sd.uuid), data: sd.data }));
  return out.length > 0 ? out : undefined;
}

/** Get a stable device address: MAC on Windows/Linux, peripheral.id on macOS. */
export function peripheralAddress(peripheral: Peripheral): string {
  // On macOS, peripheral.address is often empty or '<unknown>'.
  // peripheral.id is the CoreBluetooth UUID and is always available.
  if (peripheral.address && !['', 'unknown', '<unknown>'].includes(peripheral.address)) {
    return peripheral.address.toUpperCase();
  }
  return peripheral.id;
}

/** Check whether a peripheral matches a target identifier (MAC or CoreBluetooth UUID). */
export function matchesTarget(peripheral: Peripheral, target: string): boolean {
  const normalizedTarget = target.replace(/[:-]/g, '').toUpperCase();
  const addr = peripheral.address?.replace(/[:-]/g, '').toUpperCase() ?? '';
  const id = peripheral.id?.toUpperCase() ?? '';
  return addr === normalizedTarget || id === normalizedTarget;
}
