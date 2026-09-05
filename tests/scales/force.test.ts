import { describe, it, expect } from 'vitest';
import { applyForcedAdapter, UnknownAdapterError } from '../../src/scales/force.js';
import { adapters } from '../../src/scales/index.js';
import { resolveAdapter } from '../../src/scales/resolve.js';
import { hasParseableBroadcastSource } from '../../src/ble/shared.js';
import type { BleDeviceInfo } from '../../src/interfaces/scale-adapter.js';

const anyDevice: BleDeviceInfo = {
  localName: 'something else entirely',
  serviceUuids: [],
  characteristicUuids: [],
};

describe('force_scale_adapter', () => {
  it('returns the full registry when nothing is forced', () => {
    expect(applyForcedAdapter(adapters, undefined)).toHaveLength(adapters.length);
    expect(applyForcedAdapter(adapters, null)).toHaveLength(adapters.length);
  });

  // The override used to replace matches() outright, which skipped the variant
  // latching two adapters do inside it (#384).
  it('still runs the real matcher, so a name-driven variant is latched', () => {
    const forced = applyForcedAdapter(adapters, 'Yunmai')[0] as unknown as {
      matches: (d: BleDeviceInfo) => boolean;
      isMini?: boolean;
    };
    expect(forced.matches({ ...anyDevice, localName: 'YUNMAI-ISM-XXXX' })).toBe(true);
    expect(forced.isMini).toBe(true);
  });

  it('claims the device even when the real matcher says no', () => {
    const forced = applyForcedAdapter(adapters, 'Yunmai')[0];
    expect(forced.matches(anyDevice)).toBe(true);
  });

  it('narrows the registry to the named adapter, case-insensitively', () => {
    const forced = applyForcedAdapter(adapters, 'hutbit');
    expect(forced).toHaveLength(1);
    expect(forced[0].name).toBe('Hutbit');
  });

  it('claims a device the real adapter would reject', () => {
    // The point of the override: the user overrules detection.
    const real = adapters.find((a) => a.name === 'Hutbit')!;
    expect(real.matches(anyDevice)).toBe(false);
    const forced = applyForcedAdapter(adapters, 'Hutbit');
    expect(forced[0].matches(anyDevice)).toBe(true);
    expect(resolveAdapter(anyDevice, forced)?.name).toBe('Hutbit');
  });

  it('does not mutate the shared registry singleton', () => {
    applyForcedAdapter(adapters, 'Hutbit');
    const real = adapters.find((a) => a.name === 'Hutbit')!;
    expect(real.matches(anyDevice)).toBe(false);
  });

  it('keeps the wrapped adapter behaving like itself', () => {
    const forced = applyForcedAdapter(adapters, 'QN Scale')[0];
    const real = adapters.find((a) => a.name === 'QN Scale')!;
    expect(forced.name).toBe(real.name);
    expect(forced.charNotifyUuid).toBe(real.charNotifyUuid);
    // Methods must still run against the real instance and its private state.
    const weight = Buffer.alloc(10);
    weight[0] = 0x10;
    weight[1] = 0x0a;
    weight[2] = 0x01;
    weight.writeUInt16BE(8000, 3);
    weight[5] = 1;
    weight.writeUInt16BE(500, 6);
    weight.writeUInt16BE(500, 8);
    expect(forced.parseNotification?.(weight)?.weight).toBeGreaterThan(0);
  });

  // A forced dual-mode adapter did not earn its device by matching the
  // advertisement, so "this device advertises manufacturer data" is no longer
  // evidence that the adapter can parse it. Without the marker, the broadcast
  // gate returns "wait" forever and the GATT path never runs.
  it('marks itself as a forced override so the broadcast gate demands a real parse', () => {
    const forced = applyForcedAdapter(adapters, 'QN Scale')[0];
    expect(forced.isForcedOverride).toBe(true);
    expect(adapters.find((a) => a.name === 'QN Scale')!.isForcedOverride).toBeUndefined();

    const unparseable: BleDeviceInfo = {
      localName: '',
      serviceUuids: [],
      manufacturerData: { id: 0x1234, data: Buffer.from('deadbeef', 'hex') },
    };
    expect(hasParseableBroadcastSource(forced, unparseable)).toBe(false);
    // The un-forced adapter keeps the cheap shortcut.
    expect(
      hasParseableBroadcastSource(
        adapters.find((a) => a.name === 'QN Scale')!,
        unparseable,
      ),
    ).toBe(true);
  });

  it('still reports a broadcast source when the forced adapter can parse it', () => {
    const forced = applyForcedAdapter(adapters, 'QN Scale')[0];
    const aabb = Buffer.alloc(23);
    aabb[0] = 0xaa;
    aabb[1] = 0xbb;
    aabb[15] = 0x23;
    aabb.writeUInt16LE(7550, 17);
    expect(
      hasParseableBroadcastSource(forced, {
        localName: '',
        serviceUuids: [],
        manufacturerData: { id: 0xffff, data: aabb },
      }),
    ).toBe(true);
  });

  it('rejects an unknown name with the list of valid ones', () => {
    expect(() => applyForcedAdapter(adapters, 'Nope')).toThrow(UnknownAdapterError);
    try {
      applyForcedAdapter(adapters, 'Nope');
    } catch (e) {
      expect((e as Error).message).toContain('QN Scale');
    }
  });
});
