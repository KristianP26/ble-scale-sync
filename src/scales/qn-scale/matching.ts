/**
 * Device matching for the QN family.
 *
 * Every function here is pure over the BleDeviceInfo / ConnectionContext data
 * it is given: none reads a single field of the adapter instance, which is why
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
  QN_COMPANY_IDS,
  SCRAMBLE_CAPABLE_MARKERS,
  SCRAMBLE_FLAG_BIT,
  SCRAMBLE_FLAG_OFFSET,
  SCRAMBLE_MARKER_OFFSET,
  SVC_AE00,
  SVC_SIG_BCS,
  SVC_SIG_WSS,
  SVC_T1,
  SVC_T2,
} from './constants.js';

/**
 * The names QN claims, the descriptor's and `qnMatches`' alike. 'seb-scale' and
 * the exact 'fit plus' come from openScale's QN handler, which annotates the
 * latter as a BTSnoop-confirmed GE CS 10 G (#409, and we have GE CS10G history
 * in #235). 'fit plus' is EXACT on purpose: as a substring it would claim any
 * fitness-branded device whose name contains it.
 */
export const QN_NAMES = {
  includes: ['qn-scale', 'renpho', 'senssun', 'sencor', 'seb-scale'],
  exact: ['fit plus'],
};

/**
 * Whether QN's handshake can run: it needs a notify char (fff1 or ffe1) AND a
 * write char (fff2 or ffe3), exactly the pair subscribeAndInit resolves.
 * `chars` lowercased; RenphoScaleAdapter declines a "renpho"-named device on
 * it too. A nameless one it decides on its own characteristic set instead, as
 * the Renpho A-R003 has this pair next to the SIG stack (#507).
 */
export function qnCanRun(chars: readonly string[]): boolean {
  return (
    (hasChar(chars, 0xfff1) || hasChar(chars, 0xffe1)) &&
    (hasChar(chars, 0xfff2) || hasChar(chars, 0xffe3))
  );
}

/** True when `chars` (lowercased) holds the 16-bit `code` in short or 128-bit form. */
function hasChar(chars: readonly string[], code: number): boolean {
  const short = code.toString(16).padStart(4, '0');
  const full = uuid16(code);
  return chars.some((u) => u === short || u === full);
}

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
  const chars = (device.characteristicUuids || []).map((u) => u.toLowerCase());

  // #436: a 0x1A10 / 55AA-family scale (Renpho ES-CS20M, JieLi revision) can
  // carry the JieLi AE00 service too. QN cannot run there (qnCanRun), and the
  // session would end on "Required characteristics not found". Declining only
  // when the other protocol's pair is present and QN's is not means the outcome
  // changes solely where QN would have failed anyway; an AE00 QN unit (#235 GE
  // CS 10 G, #258/#75 Elis 1, all with fff1+fff2) is untouched. Before GATT
  // discovery `chars` is empty, so no pre-connect decision changes.
  const has55aaPair = hasChar(chars, 0x2a10) && hasChar(chars, 0x2a11);
  if (has55aaPair && !qnCanRun(chars)) return false;

  // AE00 is a JieLi service. On a QN scale it identifies the family even when
  // the device also carries a non-QN name and advertises fff0 (e.g. GE CS 10 G
  // "Fit Plus", #235), so check it before name/fallback logic. It is NOT
  // exclusive to QN: the 55AA-family scale in #436 has it too, which the check
  // above handles. Compare both short 16-bit and full 128-bit forms, mirroring
  // hasQnVendor.
  const hasAe00 =
    uuids.some((u) => u === SVC_AE00 || u === uuid16(0xae00)) ||
    chars.some((u) => u === 'ae01' || u === 'ae02' || u === CHR_AE01 || u === CHR_AE02);
  if (hasAe00) return true;

  const hasQnVendor = uuids.some(
    (u) => u === SVC_T1 || u === SVC_T2 || u === uuid16(0xffe0) || u === uuid16(0xfff0),
  );

  // The GE CS 10 G "Fit Plus" above is caught by its service when AE00 is
  // visible, and by its name when it is not.
  if (QN_NAMES.includes.some((t) => name.includes(t)) || QN_NAMES.exact.includes(name)) {
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
    // D-04: once the characteristics are known they settle it, whatever the
    // service list says. The ES-WBE28 hosts its vendor 0xFFE1/0xFFE2 pair in a
    // 0xFFE0 GATT service, so after discovery it carries the very service the
    // rule above reads as QN, and on node-ble (no advertised services at all)
    // this adapter used to win it on the shared name and priority. The SIG
    // consent pair without a QN pair is an ES-WBE28 (#267 capture), never a
    // scale this handshake can drive. Mirrors RenphoScaleAdapter.matches().
    const hasSigConsentPair = hasChar(chars, 0x2a9f) && hasChar(chars, 0x2a9d);
    if (onlyRenpho && hasSigConsentPair && !qnCanRun(chars)) return false;
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
  // Mirrors the looksLikeWbe28 mutual exclusion above. It also keeps this
  // fallback off the nameless Renpho A-R003 (#507), whose handles imply 0xFFE0
  // and 0xFFF0 services next to the consent pair: QN outranks
  // RenphoScaleAdapter (registry-check.ts), so wherever discovered services
  // reach this matcher QN would take it without the guard.
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

/** What a QN advertisement says about how the scale sends its resistance. */
export interface QnAdvertTraits {
  /** Model number from the marker at [11], or null when it is not one we know. */
  category: number | null;
  /** Bit 2 of [15] on a known marker: the resistance arrives scrambled. */
  scrambled: boolean;
}

/**
 * Read the impedance flag from the advertisement the session matched on
 * (ConnectionContext.manufacturerData), see SCRAMBLE_FLAG_BIT (#461).
 *
 * Null when there is nothing to read: no manufacturer data, a company id the
 * vendor SDK does not use, a payload too short to carry the MAC, or a MAC at
 * [5..10] (little-endian) that is not the connected device's. The MAC check is
 * ours, not the SDK's, and is skipped when the transport has no address (noble
 * on macOS). An advertisement shorter than 12 bytes, like the classic scale's
 * 11, carries no marker and is read as not scrambled.
 */
export function qnAdvertTraits(
  mfg: { id: number; data: Buffer } | undefined,
  deviceAddress: string,
): QnAdvertTraits | null {
  if (!mfg || !QN_COMPANY_IDS.includes(mfg.id)) return null;
  const { data } = mfg;
  if (data.length < 11) return null;
  if (/^[0-9A-F]{12}$/i.test(deviceAddress)) {
    const echoed = Buffer.from(data.subarray(5, 11)).reverse().toString('hex');
    if (echoed.toUpperCase() !== deviceAddress.toUpperCase()) return null;
  }
  const category =
    data.length > SCRAMBLE_MARKER_OFFSET
      ? (SCRAMBLE_CAPABLE_MARKERS.get(data[SCRAMBLE_MARKER_OFFSET]) ?? null)
      : null;
  const scrambled =
    category !== null &&
    data.length > SCRAMBLE_FLAG_OFFSET &&
    (data[SCRAMBLE_FLAG_OFFSET] & SCRAMBLE_FLAG_BIT) !== 0;
  return { category, scrambled };
}
