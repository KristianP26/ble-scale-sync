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
});
