import { describe, it, expect } from 'vitest';
import type {
  ScaleAdapter,
  ScaleAdapterCore,
  GattWiring,
  Unlockable,
  BroadcastSource,
  MultiCharNotify,
  AckProtocol,
  HoldForComposition,
  WeightStabilityGate,
  ScaleReading,
  BodyComposition,
  BleDeviceInfo,
} from '../../src/interfaces/scale-adapter.js';

// ─── Compile-time assertions (no runtime effect) ──────────────────────────────

/** Assert that T is assignable to U at compile time. */
type Assignable<T, U> = T extends U ? true : false;
/** Assert exact boolean literal. */
function expectType<T extends true>(): void {
  void 0 as unknown as T;
}

// A bare core-only adapter (no GATT, no unlock, no broadcast) is a valid ScaleAdapter.
const coreOnly: ScaleAdapter = {
  name: 'CoreOnly',
  matches: (_d: BleDeviceInfo) => true,
  parseNotification: (): ScaleReading | null => null,
  isComplete: (r: ScaleReading) => r.weight > 0,
  computeMetrics: (): BodyComposition => ({}) as never,
};

// A GATT + Unlockable adapter is assignable.
const gattUnlock: ScaleAdapter = {
  ...coreOnly,
  charNotifyUuid: 'fff1',
  charWriteUuid: 'fff2',
  unlockCommand: [0x01],
  unlockIntervalMs: 5000,
};

// A multi-capability adapter (GATT + BroadcastSource) is assignable to the SAME
// element type (proves no discriminated union splits it out).
const multi: ScaleAdapter = {
  ...coreOnly,
  charNotifyUuid: 'fff1',
  charWriteUuid: 'fff2',
  parseBroadcast: () => null,
  preferPassive: true,
};

describe('ScaleAdapter capability types', () => {
  it('exposes ScaleAdapter as a superset of ScaleAdapterCore', () => {
    expectType<Assignable<ScaleAdapter, ScaleAdapterCore>>();
    expect(true).toBe(true);
  });

  it('keeps charNotifyUuid optional on the element type (bare object compiles)', () => {
    // coreOnly omits charNotifyUuid yet is a valid ScaleAdapter.
    expect(coreOnly.charNotifyUuid).toBeUndefined();
  });

  it('accepts a GATT + Unlockable literal', () => {
    expect(gattUnlock.unlockIntervalMs).toBe(5000);
  });

  it('accepts a multi-capability literal as the same element type', () => {
    expect(multi.preferPassive).toBe(true);
  });

  it('GattWiring requires the headline char UUIDs', () => {
    const w: GattWiring = { charNotifyUuid: 'a', charWriteUuid: 'b' };
    expect(w.charNotifyUuid).toBe('a');
  });

  it('Unlockable requires command + interval', () => {
    const u: Unlockable = { unlockCommand: [0x01], unlockIntervalMs: 3000 };
    expect(u.unlockIntervalMs).toBe(3000);
  });

  it('AckProtocol requires buildAck', () => {
    const a: AckProtocol = { buildAck: () => null };
    expect(a.buildAck(Buffer.alloc(0))).toBeNull();
  });

  it('MultiCharNotify requires parseCharNotification (GATT dispatch, not broadcast)', () => {
    const m: MultiCharNotify = { parseCharNotification: () => null };
    expect(m.parseCharNotification('fff1', Buffer.alloc(0))).toBeNull();
  });

  it('HoldForComposition is a named all-optional grouping (completionHoldMs may be a getter returning number | undefined)', () => {
    // Empty object is assignable: the mixin is a named grouping, not a hard
    // required-member contract (the beurer-sanitas getter returns
    // `number | undefined`, which only assigns if completionHoldMs is optional).
    const empty: HoldForComposition = {};
    expect(empty.completionHoldMs).toBeUndefined();
    // A getter-typed `number | undefined` value (the exact beurer-sanitas
    // shape) is assignable to completionHoldMs only because it is optional.
    const variant: number | undefined = 4000;
    const h: HoldForComposition = { completionHoldMs: variant };
    expect(h.completionHoldMs).toBe(4000);
  });

  it('BroadcastSource is an all-optional grouping', () => {
    const b: BroadcastSource = {};
    expect(b.parseBroadcast).toBeUndefined();
  });

  it('WeightStabilityGate is an all-optional grouping', () => {
    const empty: WeightStabilityGate = {};
    expect(empty.weightStability).toBeUndefined();
    const gated: WeightStabilityGate = { weightStability: { samples: 2, toleranceKg: 0 } };
    expect(gated.weightStability?.samples).toBe(2);
  });
});
