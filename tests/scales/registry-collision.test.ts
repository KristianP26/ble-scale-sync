import { describe, it, expect } from 'vitest';
import { adapters } from '../../src/scales/index.js';
import { resolveAdapter, resolveAfterDiscovery } from '../../src/scales/resolve.js';
import type { GattDiscovery } from '../../src/scales/resolve.js';
import { uuid16 } from '../../src/scales/body-comp-helpers.js';
import type { BleDeviceInfo } from '../../src/interfaces/scale-adapter.js';

/**
 * Registry collision guard for #182.
 *
 * Production resolves a scale with `resolveAdapter()` (src/scales/resolve.ts),
 * which orders the registry by `match.priority`, highest first, and returns
 * the first adapter whose `matches()` accepts the device; array position only
 * breaks priority ties (#245). Precedence is what stops a broad `matches()`
 * from shadowing a more specific adapter, the root cause of #168 (BF720 vs Mi
 * Scale 2), #177 (T9146 vs Inlife) and #135 (Lefu).
 *
 * The winner is taken from `resolveAdapter()`, i.e. in priority order exactly
 * as production picks, not from the first match in registry array order.
 *
 * This test pins one representative advertisement per registered adapter and
 * asserts the FIRST matching adapter is the
 * intended one. It fails the moment a new or widened `matches()` shadows an
 * existing adapter, and names every colliding adapter so the offender is
 * obvious. Each fixture mirrors that adapter's own per-adapter test (incl.
 * post-discovery `characteristicUuids` for the 0xFFF0 / 0x181B families).
 *
 * NOTE: strict mutual exclusion is intentionally NOT asserted —
 * `StandardGattScaleAdapter` is a deliberately broad BCS/WSS fallback that
 * overlaps many specific adapters by design; precedence (priority 0, and last
 * in the array) is the mechanism. First-match correctness is the real
 * invariant.
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
  // #385: the advertised name is the only thing separating this from the Inlife
  // and 1byone families on the shared FFF0 service.
  'Etekcity ESF-551': {
    localName: 'Etekcity Smart Fitness Scale',
    serviceUuids: ['fff0'],
  },
  'Beurer BF720/BF105': { localName: 'BF720', serviceUuids: [] },
  'Xiaomi Mi Smart Scale 2 (XMTZC04HM)': {
    localName: '',
    serviceUuids: ['181d'],
    manufacturerData: { id: 0x0157, data: Buffer.from('70879eede5e7', 'hex') },
    serviceData: [{ uuid: '181d', data: Buffer.from('238e4eea070818103913', 'hex') }],
  },
  // Broadcast-only, non-connectable. Claims on the invented company id 0xA0AC
  // plus the exact 12-byte payload and its checksum; the name "108" is ignored.
  'Silvergear Smart Scale 108': {
    localName: '108',
    serviceUuids: ['ffb0'],
    manufacturerData: { id: 0xa0ac, data: Buffer.from('4fe9916185a0202d07600da1', 'hex') },
  },
  // Broadcast-only, non-connectable. The real #423 advertisement: company id
  // 0x0100, the 17-byte frame, and the device's own MAC echoed at [3..8].
  'Senssun IF_B7': {
    localName: 'IF_B7',
    address: '64:FB:01:2D:92:50',
    serviceUuids: [],
    manufacturerData: {
      id: 0x0100,
      data: Buffer.from('02031164fb012d925001221a00000190ce', 'hex'),
    },
  },
  'Xiaomi Mi Scale 2': { localName: 'MIBFS', serviceUuids: [] },
  'Xiaomi Mijia Scale S800': { localName: 'Mijia Scale S800 A1AB', serviceUuids: [] },
  // Same FE95 service as the S800; the product id (0x3bd5 here) tells them apart.
  'Xiaomi Body Composition Scale S400': {
    localName: '',
    serviceUuids: [],
    serviceData: [{ uuid: 'fe95', data: Buffer.from('305ad53b00530870acea1c08', 'hex') }],
  },
  Yunmai: { localName: 'Yunmai', serviceUuids: [] },
  'Beurer / Sanitas': { localName: 'Beurer BF700', serviceUuids: [] },
  'Sanitas SBF72/73': { localName: 'SBF72', serviceUuids: [] },
  'Soehnle Shape/Style': { localName: 'Shape200', serviceUuids: [] },
  'Medisana BS44x': { localName: '013197', serviceUuids: [] },
  Trisa: { localName: '01257B1234', serviceUuids: [] },
  'ES-CS20M': { localName: 'es-cs20m', serviceUuids: [] },
  // #117/#265: routes by exact name; outranks ES-CS20M (priority 235 > 130) even
  // though a real unit also advertises service 0x1A10 (not claimed here).
  'Renpho R-MSC04': { localName: 'R-MSC04', serviceUuids: [] },
  'Exingtech Y1': { localName: 'vscale', serviceUuids: [] },
  'Excelvan CF369': { localName: 'electronic scale', serviceUuids: [] },
  Hesley: { localName: 'yunchen', serviceUuids: [] },
  // #270: a Koogeek advertises the bare 0xFFF0 service, so its name must beat
  // Inlife's pre-connect service fallback.
  'Koogeek-S1': { localName: 'Koogeek-S1', serviceUuids: [uuid16(0xfff0)] },
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
  Speediance: { localName: 'SPEED_S_E60EJE', serviceUuids: ['ffb0'] },
  Hutbit: { localName: 'Hutbit Scale', serviceUuids: ['ffb0'] },
  'MGB (Swan/Icomon/YG)': { localName: 'icomon', serviceUuids: [] },
  'Hoffen BS-8107': { localName: 'hoffen bs-8107', serviceUuids: [] },
  // Real advertisement from a SALTER-SA00656-BK: the advertised service UUID is
  // the byte-swapped form (0xCCFF) of the 0xFFCC service the device exposes
  // over GATT.
  Salter: { localName: 'SALTER-SA00656-BK', serviceUuids: ['ccff'] },
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
      // Every collider, in priority order, so the failure message can name them.
      const matched = [...adapters]
        .sort((a, b) => (b.match?.priority ?? 0) - (a.match?.priority ?? 0))
        .filter((a) => a.matches(info));
      const first = resolveAdapter(info, adapters)?.name;

      expect(
        first,
        `Fixture for "${name}" resolved to "${first ?? '(none)'}", expected ` +
          `"${expected}". Colliding adapters (in priority order): ` +
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

/**
 * Post-discovery collision guard.
 *
 * The table above is advertisements only. On the connect paths the resolver
 * runs again once GATT discovery is done, with the device's services and
 * characteristics, and that is where Digoo fell to Inlife, Hoffen to MGB and
 * the Renpho ES-WBE28 to QN Scale: none of those collisions exists in an
 * advertisement, so the table above could never see them.
 *
 * Each case is the record a transport hands `resolveAfterDiscovery()`:
 * `noble` and the proxies know the advertised service list, `node-ble` does
 * not (`advertisedServicesKnown: false`). Provenance of every GATT shape is
 * noted per entry. Where no capture exists the shape is the one the adapter
 * itself declares and drives (its `charNotifyUuid` / `charWriteUuid`, ported
 * from openScale), read from the registry rather than retyped, so a fixture
 * cannot drift from what the adapter would subscribe to.
 */
const byName = (name: string) => {
  const a = adapters.find((x) => x.name === name);
  if (!a) throw new Error(`adapter "${name}" not registered`);
  return a;
};
const digoo = byName('Digoo');
const hoffen = byName('Hoffen BS-8107');

interface PostDiscoveryCase {
  label: string;
  advertised: BleDeviceInfo;
  gatt: GattDiscovery;
  expected: string;
}

// Renpho ES-WBE28 (#267): the advertisement is the one renpho.test.ts matches
// on; the characteristics are that test's ALL_CHARS from the btsnoop capture.
// 0xFFE0 is the GATT service hosting the vendor 0xFFE1/0xFFE2 pair and 0x181C
// hosts the User Data chars (0x2A8C, 0x2A8E, 0x2A85, 0x2A80).
const WBE28_ADVERT: BleDeviceInfo = { localName: 'Renpho-Scale', serviceUuids: ['181b', '181d'] };
const WBE28_GATT_SERVICES = [0x181b, 0x181d, 0x181c, 0xffe0].map(uuid16);
const WBE28_CHARS = [
  0x2a9d, 0x2a9c, 0x2a9f, 0xffe1, 0xffe2, 0x2a8c, 0x2a8e, 0x2a85, 0x2a80, 0x2aff,
].map(uuid16);

const POST_DISCOVERY: PostDiscoveryCase[] = [
  // Service 0xFFF0 with notify 0xFFF1 / write 0xFFF2 (adapter declaration).
  ...[true, false].map((known) => ({
    label: `Digoo "Mengii" (advertised services ${known ? 'known' : 'unknown'})`,
    advertised: { localName: 'Mengii', serviceUuids: [] },
    gatt: {
      serviceUuids: [uuid16(0xfff0)],
      characteristicUuids: [digoo.charNotifyUuid, digoo.charWriteUuid],
      advertisedServicesKnown: known,
    },
    expected: 'Digoo',
  })),
  // Service 0xFFB0 with the single notify+write char 0xFFB2 (adapter declaration).
  ...['Hoffen BS-8107', 'PC-PW 3008 BT'].flatMap((name) =>
    [true, false].map((known) => ({
      label: `${name} (advertised services ${known ? 'known' : 'unknown'})`,
      advertised: { localName: name, serviceUuids: [] },
      gatt: {
        serviceUuids: [uuid16(0xffb0)],
        characteristicUuids: [hoffen.charNotifyUuid],
        advertisedServicesKnown: known,
      },
      expected: 'Hoffen BS-8107',
    })),
  ),
  {
    label: 'Renpho ES-WBE28 on noble / proxy (advertised services known)',
    advertised: WBE28_ADVERT,
    gatt: { serviceUuids: WBE28_GATT_SERVICES, characteristicUuids: WBE28_CHARS },
    expected: 'Renpho ES-WBE28',
  },
  // node-ble cannot see advertised service UUIDs, so the pre-connect record
  // carries only the "renpho" name, which QN Scale (250) claims ahead of the
  // ES-WBE28 (240). It used to stay there after discovery too (review D-04);
  // both matchers now split on the characteristics: QN needs fff1/ffe1 plus
  // fff2/ffe3, and the ES-WBE28 has the SIG consent pair and neither write.
  {
    label: 'Renpho ES-WBE28 on node-ble (advertised services unknown)',
    advertised: { localName: 'Renpho-Scale', serviceUuids: [] },
    gatt: {
      serviceUuids: WBE28_GATT_SERVICES,
      characteristicUuids: WBE28_CHARS,
      advertisedServicesKnown: false,
    },
    expected: 'Renpho ES-WBE28',
  },
  // Already pinned elsewhere, kept here so the rule cannot regress them:
  // #177 / #251 the char-aware demotion of Inlife, #278 the SWAN-branded Hutbit
  // on node-ble, and a nameless Robi S9 refined from MGB by its FFB3 char.
  {
    label: '#177 eufy T9146 (fff1 + fff4 on fff0)',
    advertised: { localName: 'eufy T9146', serviceUuids: [uuid16(0xfff0)] },
    gatt: { serviceUuids: [uuid16(0xfff0)], characteristicUuids: [0xfff1, 0xfff4].map(uuid16) },
    expected: '1byone (Eufy)',
  },
  {
    label: '#278 SWAN-branded Hutbit on node-ble',
    advertised: {
      localName: 'SWAN',
      serviceUuids: [],
      manufacturerData: { id: 0x02ac, data: Buffer.from('7eb893ecb30301', 'hex') },
    },
    gatt: {
      serviceUuids: [0xffb0, 0x1800, 0x180a].map(uuid16),
      characteristicUuids: [0xffb1, 0xffb2, 0xffb3].map(uuid16),
      advertisedServicesKnown: false,
    },
    expected: 'Hutbit',
  },
  {
    label: 'nameless Robi S9 (ffb0 advertised, ffb3 discovered)',
    advertised: { localName: '', serviceUuids: [uuid16(0xffb0)] },
    gatt: {
      serviceUuids: [uuid16(0xffb0)],
      characteristicUuids: [0xffb1, 0xffb2, 0xffb3].map(uuid16),
    },
    expected: 'Robi S9',
  },
];

describe('post-discovery collision guard', () => {
  it.each(POST_DISCOVERY)('$label resolves to $expected', ({ advertised, gatt, expected }) => {
    expect(resolveAfterDiscovery(advertised, gatt, adapters)?.name).toBe(expected);
  });
});
