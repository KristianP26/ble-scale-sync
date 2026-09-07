import type { Peripheral } from '@stoprocent/noble';

/** Convert Noble's raw manufacturer data buffer to {id, data} format. */
export function parseMfgData(raw: Buffer | undefined): { id: number; data: Buffer } | undefined {
  if (!raw || raw.length < 2) return undefined;
  return { id: raw.readUInt16LE(0), data: raw.subarray(2) };
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
