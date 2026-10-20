import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ScaleAdapter } from '../../../src/interfaces/scale-adapter.js';
import type { Adapter } from '../../../src/ble/handler-node-ble/dbus.js';
import {
  armFreshAdvertLatch,
  cachePolicyFor,
  forgetReadingAdapter,
  rememberReadingAdapter,
  _resetDeviceCacheForTests,
  type FreshAdvertLatch,
} from '../../../src/ble/handler-node-ble/device-cache.js';
import { applyForcedAdapter } from '../../../src/scales/force.js';

/**
 * When a MAC-pinned scale's BlueZ object is kept between node-ble cycles, and
 * the latch that has to hear it before a kept object is used (#425, D060).
 */

const MAC = 'AA:BB:CC:DD:EE:FF';

function adapter(name: string, overrides: Partial<ScaleAdapter> = {}): ScaleAdapter {
  return {
    name,
    match: { priority: 10, serviceUuids: ['fff0'] },
    matches: () => true,
    parseNotification: () => null,
    isComplete: () => true,
    computeMetrics: () => ({}) as never,
    ...overrides,
  } as unknown as ScaleAdapter;
}

const gattOnly = adapter('Gatt Only');
// The shape of QN and Eufy P2: a broadcast parser, but read over GATT on node-ble.
const hybrid = adapter('Hybrid', { parseBroadcast: () => null });
const passive = adapter('Passive', { preferPassive: true, parseServiceData: () => null });
const bonding = adapter('Bonding', { requiresBonding: true });
const all = [gattOnly, hybrid, passive, bonding];

describe('cachePolicyFor (D060)', () => {
  beforeEach(() => _resetDeviceCacheForTests());

  it('removes the object of a scale not read yet in this run', () => {
    expect(cachePolicyFor(MAC, all).keep).toBe(false);
  });

  it('keeps it after a reading through a GATT-only adapter', () => {
    rememberReadingAdapter(MAC, gattOnly);
    expect(cachePolicyFor(MAC, all)).toMatchObject({ keep: true, adapter: gattOnly });
  });

  it('keys the memory on the formatted MAC', () => {
    rememberReadingAdapter('aa-bb-cc-dd-ee-ff', gattOnly);
    expect(cachePolicyFor(MAC, all).keep).toBe(true);
  });

  it('removes it for an adapter that parses broadcasts but reads over GATT', () => {
    rememberReadingAdapter(MAC, hybrid);
    expect(cachePolicyFor(MAC, all).keep).toBe(false);
  });

  it('removes it for a passive service data adapter', () => {
    rememberReadingAdapter(MAC, passive);
    expect(cachePolicyFor(MAC, all).keep).toBe(false);
  });

  it('removes it for a GATT-only adapter that requires bonding', () => {
    rememberReadingAdapter(MAC, bonding);
    expect(cachePolicyFor(MAC, all).keep).toBe(false);
  });

  it('keeps it for a forced GATT-only adapter from the first cycle, and not for a forced parser', () => {
    expect(cachePolicyFor(MAC, applyForcedAdapter(all, 'Gatt Only')).keep).toBe(true);
    expect(cachePolicyFor(MAC, applyForcedAdapter(all, 'Hybrid')).keep).toBe(false);
  });

  it('removes it when the remembered adapter is not in the list', () => {
    rememberReadingAdapter(MAC, gattOnly);
    expect(cachePolicyFor(MAC, [hybrid, passive]).keep).toBe(false);
  });

  it('follows the latest reading and forgets on request', () => {
    rememberReadingAdapter(MAC, gattOnly);
    rememberReadingAdapter(MAC, passive);
    expect(cachePolicyFor(MAC, all).keep).toBe(false);
    rememberReadingAdapter(MAC, gattOnly);
    forgetReadingAdapter(MAC);
    expect(cachePolicyFor(MAC, all).keep).toBe(false);
  });
});

/** A node-ble Device as far as the latch uses it. */
function heldDevice(paired: () => Promise<boolean>) {
  const helper = Object.assign(new EventEmitter(), { removeListeners: vi.fn() });
  return { helper, isPaired: paired };
}

function btAdapterWith(getDevice: () => Promise<unknown>): Adapter {
  return { getDevice } as unknown as Adapter;
}

async function armed(device: ReturnType<typeof heldDevice>): Promise<FreshAdvertLatch> {
  const held = await armFreshAdvertLatch(
    btAdapterWith(async () => device),
    MAC,
  );
  if (held.kind !== 'armed') throw new Error(`expected armed, got ${held.kind}`);
  return held.latch;
}

describe('armFreshAdvertLatch (D060)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('holds nothing when BlueZ has no object for the scale', async () => {
    const held = await armFreshAdvertLatch(
      btAdapterWith(async () => {
        throw new Error('Device not found');
      }),
      MAC,
    );
    expect(held.kind).toBe('absent');
  });

  it('answers unknown for any other lookup failure', async () => {
    const held = await armFreshAdvertLatch(
      btAdapterWith(async () => {
        throw new Error('org.freedesktop.DBus.Error.NoReply');
      }),
      MAC,
    );
    expect(held).toMatchObject({ kind: 'unknown' });
  });

  it('answers unknown and releases the proxy when Paired cannot be read', async () => {
    const device = heldDevice(async () => {
      throw new Error('org.freedesktop.DBus.Error.NoReply');
    });
    const held = await armFreshAdvertLatch(
      btAdapterWith(async () => device),
      MAC,
    );
    expect(held.kind).toBe('unknown');
    expect(device.helper.removeListeners).toHaveBeenCalledTimes(1);
    expect(device.helper.listenerCount('PropertiesChanged')).toBe(0);
  });

  it('answers paired without a listener for a paired scale', async () => {
    const device = heldDevice(async () => true);
    const held = await armFreshAdvertLatch(
      btAdapterWith(async () => device),
      MAC,
    );
    expect(held.kind).toBe('paired');
    expect(device.helper.removeListeners).toHaveBeenCalledTimes(1);
    expect(device.helper.listenerCount('PropertiesChanged')).toBe(0);
  });

  it('remembers a report that arrived before anyone asked', async () => {
    const device = heldDevice(async () => false);
    const latch = await armed(device);
    device.helper.emit('PropertiesChanged', { RSSI: { value: -60 } });
    let done = false;
    void latch.heard(120_000, MAC).then(() => (done = true));
    await Promise.resolve();
    await Promise.resolve();
    expect(done).toBe(true);
    latch.release();
  });

  it('opens on manufacturer or service data, and not on anything else', async () => {
    for (const fresh of ['ManufacturerData', 'ServiceData']) {
      const device = heldDevice(async () => false);
      const latch = await armed(device);
      let done = false;
      void latch.heard(120_000, MAC).then(() => (done = true));
      device.helper.emit('PropertiesChanged', { Connected: { value: false } });
      device.helper.emit('PropertiesChanged', {});
      await vi.advanceTimersByTimeAsync(1_000);
      expect(done, `opened before ${fresh}`).toBe(false);
      device.helper.emit('PropertiesChanged', { [fresh]: { value: {} } });
      await vi.advanceTimersByTimeAsync(0);
      expect(done, fresh).toBe(true);
      latch.release();
    }
  });

  it('times out with the usual no-show message', async () => {
    const latch = await armed(heldDevice(async () => false));
    let settled = false;
    const result = latch.heard(120_000, MAC).catch((e: unknown) => e);
    void result.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(119_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(((await result) as Error).message).toBe(`Device ${MAC} not found within 120s`);
    latch.release();
  });

  it('rejects with the abort reason and leaves no timer or abort listener behind', async () => {
    const latch = await armed(heldDevice(async () => false));
    const ctrl = new AbortController();
    const removeSpy = vi.spyOn(ctrl.signal, 'removeEventListener');
    const result = latch.heard(120_000, MAC, ctrl.signal).catch((e: unknown) => e);
    ctrl.abort(new Error('shutdown'));
    expect(((await result) as Error).message).toBe('shutdown');
    expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
    latch.release();
  });

  it('releases once, however often it is asked to', async () => {
    const device = heldDevice(async () => false);
    const latch = await armed(device);
    expect(device.helper.listenerCount('PropertiesChanged')).toBe(1);
    latch.release();
    latch.release();
    expect(device.helper.listenerCount('PropertiesChanged')).toBe(0);
    expect(device.helper.removeListeners).toHaveBeenCalledTimes(1);
  });
});
