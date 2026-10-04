import type { ExporterSlot } from '../config/resolve.js';
import type { Exporter } from '../interfaces/exporter.js';

/**
 * Which config entry an exporter instance was built from (D029).
 *
 * Kept beside the instance rather than on it: `Exporter` is the contract every
 * exporter implements, and where an instance came from is the runtime's
 * bookkeeping, not the exporter's. Weak, so a cache cleared on reload frees
 * its entries.
 */
const slots = new WeakMap<Exporter, ExporterSlot>();

export function setExporterSlot(exporter: Exporter, slot: ExporterSlot): void {
  slots.set(exporter, { list: slot.list, index: slot.index });
}

/** The slot an instance was built from, or undefined for one built elsewhere (tests, legacy). */
export function exporterSlot(exporter: Exporter): ExporterSlot | undefined {
  return slots.get(exporter);
}
