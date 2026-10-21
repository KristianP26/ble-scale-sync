import { describe, it, expect } from 'vitest';
import { adapters } from '../../src/scales/index.js';
import { resolveAdapter, resolveAfterDiscovery } from '../../src/scales/resolve.js';
import { StandardGattScaleAdapter } from '../../src/scales/standard-gatt.js';
import { uuid16 } from '../../src/scales/body-comp-helpers.js';
import type { BleDeviceInfo, ScaleAdapter } from '../../src/interfaces/scale-adapter.js';
import { matchesDescriptor, uuidClaimHits } from '../../src/scales/match-descriptor.js';
import { M1690_ADVERT } from '../helpers/yunmai-m1690.js';

describe('resolveAdapter', () => {
  // A spread of fixtures from registry-collision.test.ts; resolveAdapter MUST
  // agree with adapters.find((a) => a.matches(info)) for each.
  const fixtures: BleDeviceInfo[] = [
    { localName: 'eufy T9149', serviceUuids: [] },
    { localName: 'QN-Scale', serviceUuids: ['fff0'] },
    { localName: 'Fit Plus', serviceUuids: [uuid16(0xfff0), uuid16(0xae00)] },
    {
      localName: 'eufy T9146',
      serviceUuids: [uuid16(0xfff0)],
      characteristicUuids: [uuid16(0xfff1), uuid16(0xfff4)],
    },
    {
      localName: '000fatscale01',
      serviceUuids: [uuid16(0xfff0)],
      characteristicUuids: [uuid16(0xfff1), uuid16(0xfff2)],
    },
    { localName: 'BF720', serviceUuids: [uuid16(0x181b)] },
    { localName: 'MIBFS', serviceUuids: [] },
    { localName: 'GenericScale', serviceUuids: ['181d'] },
    { localName: 'icomon', serviceUuids: [] },
    { localName: 'Robi S9', serviceUuids: [] },
  ];

  it('agrees with adapters.find(matches) on every fixture', () => {
    for (const info of fixtures) {
      const viaFind = adapters.find((a) => a.matches(info));
      const viaResolve = resolveAdapter(info);
      expect(viaResolve?.name, `mismatch for ${info.localName}`).toBe(viaFind?.name);
    }
  });

  it('returns undefined when nothing matches', () => {
    expect(resolveAdapter({ localName: 'totally-unknown', serviceUuids: [] })).toBeUndefined();
  });

  it('selects strictly by priority, independent of registry array order', () => {
    const shuffled = [...adapters].reverse();
    const info: BleDeviceInfo = { localName: 'QN-Scale', serviceUuids: ['fff0'] };
    expect(resolveAdapter(info, shuffled)?.name).toBe(resolveAdapter(info, adapters)?.name);
  });

  // The order is kept per registry array (A-14): a second array, such as the
  // forced one, must not be served the first one's order.
  it('orders each registry array on its own', () => {
    const mock = (name: string, priority: number) =>
      ({ name, match: { priority }, matches: () => true }) as unknown as ScaleAdapter;
    const lo = mock('lo', 1);
    const hi = mock('hi', 2);
    const info: BleDeviceInfo = { localName: 'x', serviceUuids: [] };
    expect(resolveAdapter(info, [lo, hi])).toBe(hi);
    expect(resolveAdapter(info, [lo])).toBe(lo);
    expect(resolveAdapter(info, [hi, lo])).toBe(hi);
  });
});

/**
 * Policy of the post-discovery resolver on a mock registry. The real-device
 * shapes (Digoo, Hoffen, ES-WBE28, Hutbit, Robi) live in
 * registry-collision.test.ts; these pin the branches that need no device.
 */
describe('resolveAfterDiscovery', () => {
  /** An adapter that claims any device exposing the given characteristic. */
  const charClaimer = (priority: number, char: string): ScaleAdapter =>
    ({
      name: `char-${char}`,
      match: { priority, custom: true, charUuids: [char] },
      matches: (d: BleDeviceInfo) => (d.characteristicUuids ?? []).includes(char),
    }) as unknown as ScaleAdapter;
  /** An adapter that claims an exact name. */
  const nameClaimer = (priority: number, name: string): ScaleAdapter =>
    ({
      name: `name-${name}`,
      match: { priority, names: { exact: [name] } },
      matches: (d: BleDeviceInfo) => (d.localName ?? '').toLowerCase() === name,
    }) as unknown as ScaleAdapter;

  it('takes the discovery pick when the advertisement picked nothing', () => {
    const registry = [charClaimer(10, 'aaaa')];
    const got = resolveAfterDiscovery(
      { localName: '', serviceUuids: [] },
      { characteristicUuids: ['aaaa'] },
      registry,
    );
    expect(got?.name).toBe('char-aaaa');
  });

  it('keeps a name-identified pick over a higher adapter that claims on a characteristic', () => {
    const registry = [charClaimer(90, 'aaaa'), nameClaimer(10, 'mine')];
    const got = resolveAfterDiscovery(
      { localName: 'mine', serviceUuids: [] },
      { characteristicUuids: ['aaaa'] },
      registry,
    );
    expect(got?.name).toBe('name-mine');
  });

  it('lets discovery refine the generic Standard GATT fallback even when it hit a name', () => {
    // 'beurer' is one of Standard GATT's own name claims.
    const generic = new StandardGattScaleAdapter();
    const registry = [charClaimer(90, 'aaaa'), generic];
    const advertised: BleDeviceInfo = { localName: 'beurer scale', serviceUuids: [] };
    expect(resolveAdapter(advertised, registry)).toBe(generic);
    const got = resolveAfterDiscovery(advertised, { characteristicUuids: ['aaaa'] }, registry);
    expect(got?.name).toBe('char-aaaa');
  });

  // #474: a MiBeacon product id says which device this is, like a name.
  /** A plain descriptor adapter that claims one MiBeacon product id. */
  const pidClaimer = (priority: number, pid: number): ScaleAdapter => {
    const match = { priority, miBeaconProductIds: [pid] };
    return {
      name: `pid-${pid.toString(16)}`,
      match,
      matches: (d: BleDeviceInfo) => matchesDescriptor(d, match),
    } as unknown as ScaleAdapter;
  };
  /** An adapter that claims any device listing the given service. */
  const serviceClaimer = (priority: number, svc: string): ScaleAdapter =>
    ({
      name: `svc-${svc}`,
      match: { priority, custom: true, serviceUuids: [svc] },
      matches: (d: BleDeviceInfo) => uuidClaimHits([svc], d.serviceUuids),
    }) as unknown as ScaleAdapter;

  // What QN's nameless 0xFFE0 fallback does to a nameless Yunmai once node-ble
  // or noble pass the discovered services.
  it.each([true, false])(
    'keeps a product-id pick over a higher adapter that claims a discovered service (advertised services known: %s)',
    (known) => {
      const registry = [serviceClaimer(90, 'ffe0'), pidClaimer(10, 0x018d)];
      const got = resolveAfterDiscovery(
        M1690_ADVERT,
        {
          serviceUuids: [uuid16(0xffe0)],
          characteristicUuids: [uuid16(0xffe4)],
          advertisedServicesKnown: known,
        },
        registry,
      );
      expect(got?.name).toBe('pid-18d');
    },
  );

  // Rule 3: the discovery pick stands when its own product id is in the
  // advertisement. The name claimer declines on a discovered SERVICE, not a
  // characteristic, so rule 1 keeps it and the decision is left to rule 3.
  it('lets a discovery pick grounded in a claimed product id overturn a name pick', () => {
    const nameMatch = { priority: 90, custom: true, names: { exact: ['mine'] } };
    const nameClaimer = {
      name: 'name-mine',
      match: nameMatch,
      matches: (d: BleDeviceInfo) => d.localName === 'mine' && !d.serviceUuids.includes('eeee'),
    } as unknown as ScaleAdapter;
    const registry = [nameClaimer, pidClaimer(10, 0x018d)];
    const advertised: BleDeviceInfo = { ...M1690_ADVERT, localName: 'mine' };
    expect(resolveAdapter(advertised, registry)).toBe(nameClaimer);
    const got = resolveAfterDiscovery(
      advertised,
      { serviceUuids: ['eeee'], characteristicUuids: ['aaaa'] },
      registry,
    );
    expect(got?.name).toBe('pid-18d');
  });
});
