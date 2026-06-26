import { describe, it, expect } from 'vitest';
import { adapters } from '../../src/scales/index.js';
import { uuid16 } from '../../src/scales/body-comp-helpers.js';
import type { BleDeviceInfo } from '../../src/interfaces/scale-adapter.js';

/**
 * Registry collision guard for #182.
 *
 * Production resolves a scale with `adapters.find(a => a.matches(info))`
 * (uniformly across handler-noble*, handler-mqtt-proxy/*,
 * handler-esphome-proxy/*). Precedence (registry array order) is the ONLY
 * thing stopping a broad `matches()` from shadowing a more specific adapter —
 * the root cause of #168 (BF720↔Mi Scale 2), #177 (T9146↔Inlife), #135 (Lefu).
 *
 * This test pins one representative advertisement per registered adapter and
 * asserts the FIRST matching adapter (i.e. what production picks) is the
 * intended one. It fails the moment a new or widened `matches()` shadows an
 * existing adapter, and names every colliding adapter so the offender is
 * obvious. Each fixture mirrors that adapter's own per-adapter test (incl.
 * post-discovery `characteristicUuids` for the 0xFFF0 / 0x181B families).
 *
 * NOTE: strict mutual exclusion is intentionally NOT asserted —
 * `StandardGattScaleAdapter` is a deliberately broad BCS/WSS fallback that
 * overlaps many specific adapters by design; precedence (it is last) is the
 * mechanism. First-match correctness is the real invariant.
 */

/** One representative BleDeviceInfo per registered adapter, keyed by name. */
const FIXTURES: Record<string, BleDeviceInfo> = {
  'Eufy Smart Scale P2/P2 Pro': { localName: 'eufy T9149', serviceUuids: [] },
  'Senssun Fat Scale': { localName: 'senssun fat', serviceUuids: [] },
  'QN Scale': { localName: 'QN-Scale', serviceUuids: ['fff0'] },
  // #191: a real ES-WBE28 advertises SIG WSS/BCS (0x181D/0x181B) and no QN
  // vendor service, so QN now defers and it resolves to RenphoScaleAdapter.
  'Renpho ES-WBE28': { localName: 'Renpho Body Scale', serviceUuids: ['181b', '181d'] },
  'Renpho ES-26BB': { localName: 'es-26bb-b', serviceUuids: [] },
  'Renpho R-MSC04': { localName: 'R-MSC04', serviceUuids: [] },
  'Beurer BF720/BF105': { localName: 'BF720', serviceUuids: [] },
  'Xiaomi Mi Scale 2': { localName: 'MIBFS', serviceUuids: [] },
  'Xiaomi Mijia Scale S800': { localName: 'Mijia Scale S800 A1AB', serviceUuids: [] },
  Yunmai: { localName: 'Yunmai', serviceUuids: [] },
  'Beurer / Sanitas': { localName: 'Beurer BF700', serviceUuids: [] },
  'Sanitas SBF72/73': { localName: 'SBF72', serviceUuids: [] },
  'Soehnle Shape/Style': { localName: 'Shape200', serviceUuids: [] },
  'Medisana BS44x': { localName: '013197', serviceUuids: [] },
  Trisa: { localName: '01257B1234', serviceUuids: [] },
  'ES-CS20M': { localName: 'es-cs20m', serviceUuids: [] },
  'Exingtech Y1': { localName: 'vscale', serviceUuids: [] },
  'Excelvan CF369': { localName: 'electronic scale', serviceUuids: [] },
  Hesley: { localName: 'yunchen', serviceUuids: [] },
  // #177: real Inlife resolves by its exact known name.
  Inlife: { localName: '000fatscale01', serviceUuids: [uuid16(0xfff0)] },
  Digoo: { localName: 'mengii', serviceUuids: [] },
  // #177: a nameless/named T9146 must reach 1byone, not Inlife. Post-discovery
  // chars (0xFFF1 + 0xFFF4, no 0xFFF2) are what disambiguates the shared 0xFFF0.
  '1byone (Eufy)': {
    localName: 'eufy T9146',
    serviceUuids: [uuid16(0xfff0)],
    characteristicUuids: [uuid16(0xfff1), uuid16(0xfff4)],
  },
  '1byone Scale (new)': { localName: '1byone scale', serviceUuids: [] },
  'Active Era BS-06': { localName: 'AE BS-06', serviceUuids: [] },
  'Robi S9': { localName: 'Robi S9', serviceUuids: [] },
  'MGB (Swan/Icomon/YG)': { localName: 'icomon', serviceUuids: [] },
  'Hoffen BS-8107': { localName: 'hoffen bs-8107', serviceUuids: [] },
  // Generic fallback: a non-excluded name + bare Weight Scale Service (0x181D).
  'Standard GATT (BCS/WSS)': { localName: 'GenericScale', serviceUuids: ['181d'] },
};

/**
 * Adapters that are KNOWN to be shadowed by an earlier adapter under the
 * current registry order — a pre-existing condition, not a regression this
 * test should fail on. Maps shadowed adapter -> the adapter that legitimately
 * wins. Tracked separately on GitHub. The test still pins the *observed*
 * resolution, so if the shadowing relationship itself changes, it surfaces.
 *
 * Currently empty: the Renpho ES-WBE28 ↔ QN shadow (#191) was fixed by
 * tightening QnScaleAdapter.matches(). The mechanism is kept for any future
 * shadow that cannot be fixed immediately.
 */
const KNOWN_SHADOWS: Record<string, string> = {};

describe('registry collision guard (#182)', () => {
  it.each(adapters.map((a) => ({ name: a.name })))(
    'first-match for "$name" fixture resolves to the intended adapter',
    ({ name }) => {
      const info = FIXTURES[name];
      expect(
        info,
        `No fixture for registered adapter "${name}". Every adapter in ` +
          `src/scales/index.ts must have a representative BleDeviceInfo here.`,
      ).toBeDefined();

      const expected = KNOWN_SHADOWS[name] ?? name;
      // filter (not find) preserves order AND collects every collider so the
      // failure message can name them.
      const matched = adapters.filter((a) => a.matches(info));
      const first = matched[0]?.name;

      expect(
        first,
        `Fixture for "${name}" resolved to "${first ?? '(none)'}", expected ` +
          `"${expected}". Colliding adapters (in registry order): ` +
          `[${matched.map((m) => m.name).join(', ')}]. A matches() change ` +
          `likely shadowed an adapter — fix precedence or tighten matches().`,
      ).toBe(expected);
    },
  );

  it('has no fixture for an adapter that is not registered', () => {
    const registered = new Set(adapters.map((a) => a.name));
    const stale = Object.keys(FIXTURES).filter((n) => !registered.has(n));
    expect(stale, `Stale fixtures (adapter removed/renamed): ${stale.join(', ')}`).toEqual([]);
  });
});
