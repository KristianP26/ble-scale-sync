import type { BleDeviceInfo, ScaleAdapter } from '../interfaces/scale-adapter.js';
import { adapters as defaultRegistry } from './index.js';
import { nameClaimHits } from './match-descriptor.js';
import { StandardGattScaleAdapter } from './standard-gatt.js';

/**
 * Select the adapter for a device. Candidates in the GIVEN registry are ordered
 * by descriptor `priority` (higher wins) rather than array position, then the
 * first whose `matches()` returns true is returned. A missing `match` defaults
 * to priority 0; `Array.prototype.sort` is STABLE in V8/Node, so adapters that
 * tie (e.g. mock lists in tests where none declare a `match`) keep their input
 * order, making this behaviorally identical to the old
 * `registry.find((a) => a.matches(info))`. This is the single precedence
 * authority that replaces the scattered `adapters.find(...)` calls.
 */
export function resolveAdapter(
  device: BleDeviceInfo,
  registry: readonly ScaleAdapter[] = defaultRegistry,
): ScaleAdapter | undefined {
  const prio = (a: ScaleAdapter): number => a.match?.priority ?? 0;
  const ordered = [...registry].sort((a, b) => prio(b) - prio(a));
  return ordered.find((a) => a.matches(device));
}

/** What GATT discovery found on a connected device. */
export interface GattDiscovery {
  /** Primary services found by discovery. Omit when the transport does not enumerate them. */
  serviceUuids?: readonly string[];
  /** Characteristics found by discovery. */
  characteristicUuids: readonly string[];
  /**
   * False when the transport cannot see the ADVERTISED service list, so the
   * advertised record carries an empty one that means "unknown", not "none".
   * node-ble is the case: the pre-connect record never has service UUIDs
   * (scan-stages.ts, resolvePreConnectAdapter). Defaults to true.
   */
  advertisedServicesKnown?: boolean;
}

function unionUuids(a: readonly string[], b: readonly string[] | undefined): string[] {
  return [...new Set([...a, ...(b ?? [])])];
}

/**
 * Whether an adapter was picked on something the advertisement itself says
 * about the device: its name, or the manufacturer company id it claims.
 */
function groundedInAdvertisement(adapter: ScaleAdapter, device: BleDeviceInfo): boolean {
  const m = adapter.match;
  if (!m) return false;
  if (nameClaimHits(m, device.localName)) return true;
  return m.manufacturerId !== undefined && device.manufacturerData?.id === m.manufacturerId;
}

/**
 * Select the adapter once GATT discovery has run.
 *
 * Adapter matchers read `serviceUuids` as the ADVERTISED service list, and a
 * GATT primary service is not an advertisement. Merging the two let discovery
 * overturn a pick the advertisement had already made by name:
 *
 *  - Digoo ("Mengii", priority 80) exposes 0xFFF2, so Inlife (90) took it on
 *    its post-discovery char rule;
 *  - Hoffen BS-8107 / ProfiCare (20) exposes the 0xFFB0 service, so MGB (30)
 *    took it on its bare service claim;
 *  - Renpho ES-WBE28 hosts its vendor chars in a 0xFFE0 GATT service, so its
 *    own "does not advertise a QN service" rule declined it and QN (250) won.
 *
 * The rule: let `advertised` pick first (A), then `full` (advertised plus
 * every discovered service and characteristic) pick (G). If they agree, or the
 * advertisement picked nothing, G stands, which is the old behaviour. When they
 * differ, A is kept only if all of these hold:
 *
 *  1. A still accepts the device once its characteristics are known, judged
 *     against the advertised services only. Characteristics are evidence the
 *     matchers were written for (#177, #229, #436 demote an adapter on them);
 *     a discovered service read as an advertised one is not.
 *  2. A was identified by name. A pick made on a bare service (MGB on 0xFFB0
 *     for a nameless Robi S9) or by the generic Standard GATT fallback is what
 *     discovery exists to refine, so it still yields.
 *  3. G is not itself grounded in the advertisement (name or claimed company
 *     id) while accepting the device on advertised services plus
 *     characteristics. That keeps a SWAN-branded Hutbit on node-ble, where the
 *     advertised services are unknown and MGB claims the "swan" name first:
 *     the Hutbit's 0x02AC company id is advertisement evidence for it (#278).
 *
 * Where `advertisedServicesKnown` is false (node-ble), rule 1 and rule 3 judge
 * against the full service list, because nothing better exists there. This rule
 * alone cannot settle the ES-WBE28 on node-ble: with no advertised services the
 * pre-connect record picks QN on the shared "renpho" name. The Renpho and QN
 * matchers settle it instead, by characteristics (the SIG 0x2A9F + 0x2A9D pair
 * and no QN pair means Renpho).
 */
export function resolveAfterDiscovery(
  advertised: BleDeviceInfo,
  gatt: GattDiscovery,
  registry: readonly ScaleAdapter[] = defaultRegistry,
): ScaleAdapter | undefined {
  const characteristicUuids = [...gatt.characteristicUuids];
  const full: BleDeviceInfo = {
    ...advertised,
    serviceUuids: unionUuids(advertised.serviceUuids, gatt.serviceUuids),
    characteristicUuids,
  };
  const fromGatt = resolveAdapter(full, registry);

  const { characteristicUuids: _drop, ...advertOnly } = advertised;
  const fromAdvert = resolveAdapter(advertOnly, registry);
  if (!fromAdvert || fromAdvert === fromGatt) return fromGatt;

  const servicesKnown = gatt.advertisedServicesKnown ?? true;
  const withChars: BleDeviceInfo = servicesKnown ? { ...advertOnly, characteristicUuids } : full;

  if (!fromAdvert.matches(withChars)) return fromGatt;
  if (fromAdvert instanceof StandardGattScaleAdapter) return fromGatt;
  if (!fromAdvert.match || !nameClaimHits(fromAdvert.match, advertised.localName)) return fromGatt;
  if (fromGatt && groundedInAdvertisement(fromGatt, advertised) && fromGatt.matches(withChars)) {
    return fromGatt;
  }
  return fromAdvert;
}
