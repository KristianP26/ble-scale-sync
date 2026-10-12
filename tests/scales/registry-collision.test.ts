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
  // Broadcast, the name only in the scan response. The real locked 100.10 kg
  // frame of a C20, BC:0F:B7:00:9C:9D, from the Home Assistant log woodsb02
  // posted in bdr99/eufylife-ble-client#5 (comment 2564606224, line 19), here
  // without its name: claimed by the address echo in the company id 0xBC64 and
  // [0..4].
  'Eufy Smart Scale C20/P3': {
    localName: '',
    address: 'BC:0F:B7:00:9C:9D',
    serviceUuids: [],
    manufacturerData: {
      id: 0xbc64,
      data: Buffer.from('0fb7009c9d00c5c9706705001a2700000000', 'hex'),
    },
  },
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
  // Broadcast-only, nameless. The real stable 147.00 kg advert from openScale
  // #1191 (NIX Home, btsnoop record #439): a C0 frame under the rotating
  // company id 0x10C0, with the device's own MAC echoed at [7..12].
  'OKOK (Chipsea broadcast)': {
    localName: '',
    address: '08:B8:D0:DE:B5:3A',
    serviceUuids: [],
    manufacturerData: {
      id: 0x10c0,
      data: Buffer.from('396c17700a012508b8d0deb53a', 'hex'),
    },
  },
  // Broadcast-only, nameless. The real first stable frame (72.27 kg) from
  // oliexdev/openScale#1472, scale-capture-72.25kg-filtered.pcapng #27: company
  // id 0x06D0, which other VeSync devices share, the 20-byte frame carrying the
  // device's own MAC reversed at [1..6], and service 0xFFD0.
  'Etekcity Fit 8S': {
    localName: '',
    address: 'A8:89:57:8C:A1:CE',
    serviceUuids: ['ffd0'],
    manufacturerData: {
      id: 0x06d0,
      data: Buffer.from('01cea18c5789a8c0a8014e1a010e020100020300', 'hex'),
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
 * AC 27 family (#458, #462, #466): Active Era must win the FFB0 advertisement
 * when it carries the 0x27AC company id, ahead of MGB's bare FFB0 claim.
 *
 * The bytes are the ALPHA Smart Scale PRO 3 advertisement from openScale PR
 * #1534 (hci_snoop20260920232857_btsnoop.log, sha256 3e512091..., capture 1
 * 23:30:30.015): ADV_IND `0201060303b0ff10ffac273891018ed3e001010030000001`
 * from E0:D3:8E:01:91:38, scan response name `MY_SCALE`. The Runstar
 * FG2431WB (#466) reports the same company id and FFB0, but its payload is
 * not public, so no fixture pretends to know it: where a case needs a payload
 * WITHOUT the MAC echo, it is the ALPHA payload heard from another address
 * (a made-up one), and the entry says so.
 */
const ALPHA_MAC = 'E0:D3:8E:01:91:38';
const ALPHA_MSD = { id: 0x27ac, data: Buffer.from('3891018ed3e001010030000001', 'hex') };
const OTHER_MAC = '02:00:00:00:27:AC'; // made up: any address but the ALPHA's
const AE = 'Active Era BS-06';

const AC27_ADVERTS: Array<{ label: string; info: BleDeviceInfo; expected: string | undefined }> = [
  {
    label: 'ALPHA, ADV_IND + scan response (noble, proxies)',
    info: {
      localName: 'MY_SCALE',
      address: ALPHA_MAC,
      serviceUuids: ['ffb0'],
      manufacturerData: ALPHA_MSD,
    },
    expected: AE,
  },
  {
    label: 'ALPHA, ADV_IND only (ESPHome proxy, no name)',
    info: {
      localName: '',
      address: ALPHA_MAC,
      serviceUuids: ['ffb0'],
      manufacturerData: ALPHA_MSD,
    },
    expected: AE,
  },
  {
    label: 'ALPHA, node-ble before connecting (MAC echo, no services)',
    info: {
      localName: 'MY_SCALE',
      address: ALPHA_MAC,
      serviceUuids: [],
      manufacturerData: ALPHA_MSD,
    },
    expected: AE,
  },
  // T2: the "0x27AC + FFB0, no echo" branch, the shape noble on macOS hands over
  {
    label: 'ALPHA, noble on macOS (no address)',
    info: { localName: 'MY_SCALE', serviceUuids: ['ffb0'], manufacturerData: ALPHA_MSD },
    expected: AE,
  },
  {
    label: 'ALPHA, scan response only (a generic name, nothing else)',
    info: { localName: 'MY_SCALE', address: ALPHA_MAC, serviceUuids: [] },
    expected: undefined,
  },
  {
    label: 'ALPHA payload from another address, no FFB0 (no echo, nothing vouches)',
    info: { localName: '', address: OTHER_MAC, serviceUuids: [], manufacturerData: ALPHA_MSD },
    expected: undefined,
  },
  // Accepted and pinned (plan review F8): no captured Robi, Hutbit, Speediance or
  // MGB advertisement carries 0x27AC, and a 0x27AC unit speaks AC 27. If a named
  // neighbour ever shows up with it, the fix is a bow-out on its name.
  {
    label: 'named "Robi S9" with the ALPHA company id and FFB0',
    info: { localName: 'Robi S9', serviceUuids: ['ffb0'], manufacturerData: ALPHA_MSD },
    expected: AE,
  },
  {
    label: 'named "icomon" with the ALPHA company id and FFB0',
    info: { localName: 'icomon', serviceUuids: ['ffb0'], manufacturerData: ALPHA_MSD },
    expected: AE,
  },
  // The neighbours that must not move.
  {
    label: 'Lefu SWAN 0x02AC + FFB0 (#278) stays Hutbit',
    info: {
      localName: 'SWAN',
      serviceUuids: ['ffb0', 'd618'],
      manufacturerData: { id: 0x02ac, data: Buffer.from('7eb893ecb30301', 'hex') },
    },
    expected: 'Hutbit',
  },
  {
    label: 'Silvergear 108 0xA0AC + FFB0 stays Silvergear',
    info: FIXTURES['Silvergear Smart Scale 108'],
    expected: 'Silvergear Smart Scale 108',
  },
  // openScale #1341 (foryond.log record #74): a Foryond FG263LB named AAA002,
  // settled 68.75 kg. openScale loses these AAA0xx units to MGB through FFB0.
  {
    label: 'AAA002 0xA0AC + FFB0 (openScale #1341) stays Silvergear',
    info: {
      localName: 'AAA002',
      address: 'A0:91:61:03:98:31',
      serviceUuids: ['ffb0'],
      manufacturerData: { id: 0xa0ac, data: Buffer.from('3198036191a0202dac2e0db4', 'hex') },
    },
    expected: 'Silvergear Smart Scale 108',
  },
  {
    label: 'bare FFB0, no company id, stays MGB',
    info: { localName: '', serviceUuids: ['ffb0'] },
    expected: 'MGB (Swan/Icomon/YG)',
  },
];

describe('AC 27 advertisements (#458, #462, #466)', () => {
  it.each(AC27_ADVERTS)('$label', ({ info, expected }) => {
    expect(resolveAdapter(info, adapters)?.name).toBe(expected);
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
  expected: string | undefined;
}

// PICOOC Mini (#408): the real ADV_IND from oliexdev/openScale#401 (artsight,
// btsnoop_hci.log, 2019-02-16 14:53:44.187): flags 0x06, service 0xFFF0, name
// PICOOC-CQ, manufacturer data 0x000A + the unit's own address, from the public
// address D0:49:00:30:0F:5D, an empty scan response. GATT in the same capture:
// 0x2A00 to 0x2A05 on 0x1800 / 0x1801, 0xFFF1 (read + indicate) and 0xFFF2
// (write with response) on 0xFFF0. No adapter reads this scale, so nothing may
// claim it.
const PICOOC_CQ: BleDeviceInfo = {
  localName: 'PICOOC-CQ',
  address: 'D0:49:00:30:0F:5D',
  serviceUuids: ['fff0'],
  manufacturerData: { id: 0x000a, data: Buffer.from('d04900300f5d', 'hex') },
};
const PICOOC_CQ_GATT = {
  serviceUuids: [0x1800, 0x1801, 0xfff0].map(uuid16),
  characteristicUuids: [0x2a00, 0x2a01, 0x2a02, 0x2a03, 0x2a04, 0x2a05, 0xfff1, 0xfff2].map(uuid16),
};

describe('PICOOC connection-based scales (#408)', () => {
  it('claims nothing from the advertisement, with or without its services', () => {
    expect(resolveAdapter(PICOOC_CQ, adapters)?.name).toBeUndefined();
    expect(resolveAdapter({ ...PICOOC_CQ, serviceUuids: [] }, adapters)?.name).toBeUndefined();
  });
});

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
  // AC 27 family (#458, #462, #466), ALPHA bytes from openScale PR #1534 (see
  // AC27_ADVERTS above). GATT: FFB0 hosting FFB2 notify and FFB1 write, the
  // handles 0x0e/0x11 of the ALPHA capture and of the #466 log.
  {
    label: 'ALPHA on node-ble with scale_mac (target MAC, services unknown)',
    advertised: {
      localName: 'MY_SCALE',
      address: ALPHA_MAC,
      serviceUuids: [],
      manufacturerData: ALPHA_MSD,
    },
    gatt: {
      serviceUuids: [0xffb0, 0x1800, 0x1801].map(uuid16),
      characteristicUuids: [0xffb1, 0xffb2].map(uuid16),
      advertisedServicesKnown: false,
    },
    expected: AE,
  },
  {
    label: 'AC 27 over the ESPHome proxy, payload without the echo (#466 shape)',
    advertised: {
      localName: '',
      address: OTHER_MAC,
      serviceUuids: ['ffb0'],
      manufacturerData: ALPHA_MSD,
    },
    gatt: { serviceUuids: [uuid16(0xffb0)], characteristicUuids: [0xffb1, 0xffb2].map(uuid16) },
    expected: AE,
  },
  {
    label: 'AC 27 named "icomon" on node-ble (MGB name, 0x27AC company id)',
    advertised: { localName: 'icomon', serviceUuids: [], manufacturerData: ALPHA_MSD },
    gatt: {
      serviceUuids: [uuid16(0xffb0)],
      characteristicUuids: [0xffb1, 0xffb2].map(uuid16),
      advertisedServicesKnown: false,
    },
    expected: AE,
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
  // #408: Inlife used to claim it on the bare 0xFFF0 and then on 0xFFF2 without
  // 0xFFF4, and hold the connection while the scale kept asking for the time.
  ...[true, false].map((known) => ({
    label: `PICOOC-CQ (advertised services ${known ? 'known' : 'unknown'})`,
    advertised: known ? PICOOC_CQ : { ...PICOOC_CQ, serviceUuids: [] },
    gatt: { ...PICOOC_CQ_GATT, advertisedServicesKnown: known },
    expected: undefined,
  })),
];

describe('post-discovery collision guard', () => {
  it.each(POST_DISCOVERY)('$label resolves to $expected', ({ advertised, gatt, expected }) => {
    expect(resolveAfterDiscovery(advertised, gatt, adapters)?.name).toBe(expected);
  });
});
