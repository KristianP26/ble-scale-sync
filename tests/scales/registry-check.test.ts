import { describe, it, expect } from 'vitest';
import { adapters } from '../../src/scales/index.js';
import {
  checkRegistryIntegrity,
  assertRegistryIntegrity,
} from '../../src/scales/registry-check.js';
import { StandardGattScaleAdapter } from '../../src/scales/standard-gatt.js';
import { QnScaleAdapter } from '../../src/scales/qn-scale/index.js';
import type { ScaleAdapter } from '../../src/interfaces/scale-adapter.js';

describe('registry-check structural guard (#182)', () => {
  it('the live registry passes with no errors', () => {
    const { errors, warnings } = checkRegistryIntegrity(adapters);
    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
    expect(assertRegistryIntegrity(adapters)).toEqual([]);
  });

  it('flags duplicate adapter names', () => {
    const dup: ScaleAdapter[] = [
      new QnScaleAdapter(),
      new QnScaleAdapter(),
      new StandardGattScaleAdapter(),
    ];
    const { errors } = checkRegistryIntegrity(dup);
    expect(errors.some((e) => e.includes('Duplicate adapter name') && e.includes('QN Scale'))).toBe(
      true,
    );
    expect(() => assertRegistryIntegrity(dup)).toThrow(/Duplicate adapter name/);
  });

  it('flags the generic StandardGatt adapter not being last', () => {
    const misordered: ScaleAdapter[] = [new StandardGattScaleAdapter(), new QnScaleAdapter()];
    const { errors } = checkRegistryIntegrity(misordered);
    expect(errors.some((e) => e.includes('must be the last registry entry'))).toBe(true);
    expect(() => assertRegistryIntegrity(misordered)).toThrow(/last registry entry/);
  });

  it('warns (does not throw) when no generic adapter is present', () => {
    const noGeneric: ScaleAdapter[] = [new QnScaleAdapter()];
    const { errors, warnings } = checkRegistryIntegrity(noGeneric);
    expect(errors).toEqual([]);
    expect(warnings.some((w) => w.includes('No StandardGattScaleAdapter'))).toBe(true);
    expect(assertRegistryIntegrity(noGeneric)).toHaveLength(1);
  });

  // Minimal fake adapter: only `name` and `match` matter for the priority /
  // invariant / overlap checks added in #245.
  const fake = (
    name: string,
    priority: number,
    extra: Record<string, unknown> = {},
  ): ScaleAdapter => ({ name, match: { priority, ...extra } }) as unknown as ScaleAdapter;

  it('flags duplicate match.priority', () => {
    const reg = [fake('A', 100), fake('B', 100), new StandardGattScaleAdapter()];
    const { errors } = checkRegistryIntegrity(reg);
    expect(errors.some((e) => e.includes('Duplicate match.priority 100'))).toBe(true);
  });

  it('flags a violated ordering invariant (QN outranking Senssun)', () => {
    const reg = [
      fake('Senssun Fat Scale', 100, { custom: true }),
      fake('QN Scale', 200, { custom: true }),
      new StandardGattScaleAdapter(),
    ];
    const { errors } = checkRegistryIntegrity(reg);
    expect(
      errors.some((e) => e.includes('Ordering invariant violated') && e.includes('Senssun')),
    ).toBe(true);
  });

  // #458, #462, #466: an AC 27 scale carries FFB0, which MGB claims bare and
  // Robi S9 claims nameless; Active Era must outrank both.
  it.each(['MGB (Swan/Icomon/YG)', 'Robi S9'])(
    'flags Active Era BS-06 not outranking %s',
    (lower) => {
      const reg = [
        fake('Active Era BS-06', 10, { custom: true }),
        fake(lower, 90, { custom: true }),
        new StandardGattScaleAdapter(),
      ];
      const { errors } = checkRegistryIntegrity(reg);
      expect(
        errors.some(
          (e) =>
            e.includes('Ordering invariant violated') &&
            e.includes('"Active Era BS-06"') &&
            e.includes(`"${lower}"`),
        ),
      ).toBe(true);
    },
  );

  // #408: AAA0xx units (e.g. AAA002, openScale #1341) send the Silvergear 108
  // broadcast and advertise FFB0, which MGB claims bare.
  it('flags Silvergear Smart Scale 108 not outranking MGB', () => {
    const reg = [
      fake('Silvergear Smart Scale 108', 10, { custom: true }),
      fake('MGB (Swan/Icomon/YG)', 90, { custom: true }),
      new StandardGattScaleAdapter(),
    ];
    const { errors } = checkRegistryIntegrity(reg);
    expect(
      errors.some(
        (e) =>
          e.includes('Ordering invariant violated') &&
          e.includes('"Silvergear Smart Scale 108"') &&
          e.includes('"MGB (Swan/Icomon/YG)"'),
      ),
    ).toBe(true);
  });

  // #408: the mqtt-proxy notify-char fallback takes the highest priority with
  // 0x2A9D; the A&D adapter above the ES-WBE28 would take nameless WSS devices.
  it('flags A&D UC-352BLE outranking Renpho ES-WBE28', () => {
    const reg = [
      fake('Renpho ES-WBE28', 240, { custom: true }),
      fake('A&D UC-352BLE', 245, { names: { startsWith: ['a&d_uc-352ble'] } }),
      new StandardGattScaleAdapter(),
    ];
    const { errors } = checkRegistryIntegrity(reg);
    expect(
      errors.some(
        (e) =>
          e.includes('Ordering invariant violated') &&
          e.includes('"Renpho ES-WBE28"') &&
          e.includes('"A&D UC-352BLE"'),
      ),
    ).toBe(true);
  });

  it('flags a registered adapter that lacks a match descriptor', () => {
    const reg = [{ name: 'NoMatch' } as unknown as ScaleAdapter, new StandardGattScaleAdapter()];
    const { errors } = checkRegistryIntegrity(reg);
    expect(errors.some((e) => e.includes('missing a match descriptor'))).toBe(true);
  });

  it('flags two non-custom adapters claiming the same service uuid', () => {
    const reg = [
      fake('A', 100, { serviceUuids: ['abcd'] }),
      fake('B', 90, { serviceUuids: ['abcd'] }),
      new StandardGattScaleAdapter(),
    ];
    const { errors } = checkRegistryIntegrity(reg);
    expect(errors.some((e) => e.includes('claim the same name/service'))).toBe(true);
  });

  // #408: a deferred binding is enabled only by the adapter's own onConnected.
  const withBindings = (
    name: string,
    characteristics: unknown[],
    onConnected?: () => void,
  ): ScaleAdapter =>
    ({
      name,
      match: { priority: 50 },
      characteristics,
      ...(onConnected ? { onConnected } : {}),
    }) as unknown as ScaleAdapter;

  it('flags a deferred notify binding on an adapter without onConnected', () => {
    const reg = [
      withBindings('Deferred', [{ uuid: '2a9d', type: 'notify', deferred: true }]),
      new StandardGattScaleAdapter(),
    ];
    const { errors } = checkRegistryIntegrity(reg);
    expect(errors.some((e) => e.includes('"Deferred"') && e.includes('no onConnected'))).toBe(true);
  });

  it('flags deferred on a binding that is not a notify binding', () => {
    const reg = [
      withBindings('WriteDeferred', [{ uuid: '2a08', type: 'write', deferred: true }], () => {}),
      new StandardGattScaleAdapter(),
    ];
    const { errors } = checkRegistryIntegrity(reg);
    expect(
      errors.some((e) => e.includes('"WriteDeferred"') && e.includes('only a notify binding')),
    ).toBe(true);
  });

  it('accepts a deferred notify binding on an adapter with onConnected', () => {
    const reg = [
      withBindings('Fine', [{ uuid: '2a9d', type: 'notify', deferred: true }], () => {}),
      new StandardGattScaleAdapter(),
    ];
    expect(checkRegistryIntegrity(reg).errors).toEqual([]);
  });
});
