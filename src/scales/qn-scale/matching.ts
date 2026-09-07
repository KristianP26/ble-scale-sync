/**
 * Device matching for the QN family.
 *
 * Both functions here are pure over the BleDeviceInfo / ConnectionContext they
 * are given: neither reads a single field of the adapter instance, which is why
 * they can live outside the class at all. Keep it that way.
 */

import type { BleDeviceInfo, ConnectionContext } from '../../interfaces/scale-adapter.js';
import { uuid16 } from '../body-comp-helpers.js';
import { bleLog } from '../../ble/types.js';
import {
  CHR_AE01,
  CHR_AE02,
  CHR_NOTIFY_T1,
  CHR_SIG_USER_CONTROL_POINT,
  CHR_SIG_WEIGHT_MEASUREMENT,
  CHR_WRITE,
  CHR_WRITE_T1,
  SVC_AE00,
  SVC_SIG_BCS,
  SVC_SIG_WSS,
  SVC_T1,
  SVC_T2,
} from './constants.js';

/**
 * Name match is sufficient (brand names are unambiguous).
 * UUID fallback covers unnamed devices advertising QN vendor services.
 *
 * Note: openScale requires BOTH name AND UUID, but on Linux (node-ble / BlueZ
 * D-Bus) advertised service UUIDs are not available before connection, so
 * name-only matching is needed for auto-discovery without SCALE_MAC.
 */
export function qnMatches(device: BleDeviceInfo): boolean {
  // AABB broadcast protocol (0xFFFF company ID + 0xAABB magic header)
  if (device.manufacturerData) {
    const { id, data } = device.manufacturerData;
    if (id === 0xffff && data.length >= 19 && data[0] === 0xaa && data[1] === 0xbb) {
      return true;
    }
  }

  const name = (device.localName || '').toLowerCase();
  const uuids = (device.serviceUuids || []).map((u) => u.toLowerCase());

  // AE00 is a QN-only service (Renpho ES-CS20M / newer firmware), never shared
  // with the fff0 Inlife/1byone/Eufy cluster. It positively identifies a QN
  // scale even when the device also carries a non-QN name and advertises fff0
  // (e.g. GE CS 10 G "Fit Plus", #235), so check it before name/fallback logic.
  // Compare both short 16-bit and full 128-bit forms, mirroring hasQnVendor.
  const chars = (device.characteristicUuids || []).map((u) => u.toLowerCase());
  const hasAe00 =
    uuids.some((u) => u === SVC_AE00 || u === uuid16(0xae00)) ||
    chars.some((u) => u === 'ae01' || u === 'ae02' || u === CHR_AE01 || u === CHR_AE02);
  if (hasAe00) return true;

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

  // QN Type-1 structural signature: notify 0xFFE1 + write 0xFFE3. The ESP32
  // autonomous-connect path resolves an adapter from characteristics alone
  // (no advertised name, no service UUIDs), so a Type-1 QN otherwise falls
  // through to the proxy's notify-only fallback and is mis-picked as Yunmai
  // on the shared 0xFFE4 char, then hangs on the missing 0xFFE9 (#272). 0xFFE3
  // as a write char is unique to QN; 0xFFE1 alone is shared with Beurer, so
  // require BOTH. Compare short and dashless-128-bit forms like hasAe00 above.
  const hasQnType1Chars =
    chars.some((u) => u === 'ffe1' || u === CHR_NOTIFY_T1) &&
    chars.some((u) => u === 'ffe3' || u === CHR_WRITE_T1);

  // #229: the Beurer BF7xx/BF9xx diagnostic scales expose a vendor 0xFFF0
  // service alongside their SIG stack (confirmed in the BF788 HCI snoop:
  // services 0x181B, 0x181D, 0x181C AND 0xFFF0), so hasQnVendor is true for
  // them. With no advertised name, which is the norm on the MAC-pinned
  // post-connect path, this fallback claimed the scale at priority 250 and the
  // reporter saw it alternate between QN Scale and Standard GATT, reading
  // nothing either way. The SIG User Control Point is the discriminator: it
  // belongs to the User Data service, which a QN scale does not implement.
  // Mirrors the looksLikeWbe28 mutual exclusion above.
  const hasSigConsent =
    chars.some((u) => u === '2a9f' || u === CHR_SIG_USER_CONTROL_POINT) &&
    chars.some((u) => u === '2a9d' || u === CHR_SIG_WEIGHT_MEASUREMENT);

  // Fallback: match by QN vendor service UUID or the Type-1 char pair, but
  // only for unnamed devices. Named devices (e.g. "eufy T9149") should match
  // their own specific adapter rather than being caught by these generic
  // structural checks.
  if (!name && !hasSigConsent && (hasQnVendor || hasQnType1Chars)) return true;

  return false;
}

/**
 * Warn when the discovered characteristics are structurally 1byone, not QN.
 *
 * Gated on fff4 present AND every QN write characteristic absent, so a
 * genuine QN scale that happens to expose fff4 alongside its own fff2 (or the
 * Type-1 ffe3) is never accused.
 */
export function warnOnOneByoneShape(ctx: ConnectionContext): void {
  const chars = ctx.availableChars;
  if (chars.size === 0) return;
  if (!chars.has(uuid16(0xfff4))) return;
  if (chars.has(CHR_WRITE) || chars.has(CHR_WRITE_T1)) return;
  bleLog.warn(
    'QN: this device exposes fff4 and none of the QN write characteristics ' +
      '(fff2, ffe3), which is the 1byone/Eufy layout rather than a QN scale. ' +
      'The QN adapter most likely claimed it through the nameless fallback, so ' +
      'the handshake below will fail. Work around it with ' +
      "ble.force_scale_adapter: '1byone (Eufy)' plus ble.scale_mac, and please " +
      'report this log on issue #320: a real device of this shape is exactly ' +
      'the evidence needed to narrow the fallback safely.',
  );
}
