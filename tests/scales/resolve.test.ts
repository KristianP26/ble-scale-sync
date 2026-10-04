import { describe, it, expect } from 'vitest';
import { adapters } from '../../src/scales/index.js';
import { resolveAdapter, resolveAfterDiscovery } from '../../src/scales/resolve.js';
import { StandardGattScaleAdapter } from '../../src/scales/standard-gatt.js';
import { uuid16 } from '../../src/scales/body-comp-helpers.js';
import type { BleDeviceInfo, ScaleAdapter } from '../../src/interfaces/scale-adapter.js';

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
});
