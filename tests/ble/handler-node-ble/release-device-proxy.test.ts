import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

/**
 * Pins the mechanism, not just the call sites.
 *
 * Every other test around the #396 / #397 leak fix mocks `releaseDeviceProxy`
 * away and asserts only that it was reached. That leaves the load-bearing part
 * unguarded: if node-ble renamed `removeListeners`, or if `Device` stopped being
 * built with `usePropsEvents: true`, releasing would quietly stop unwinding
 * anything and the whole remedy would become a no-op with a green suite.
 */

const nodeRequire = createRequire(import.meta.url);

const { releaseDeviceProxy } = await import('../../../src/ble/handler-node-ble/dbus.js');

describe('releaseDeviceProxy', () => {
  it('calls the helper teardown that actually drops the listener', () => {
    const removeListeners = vi.fn();
    releaseDeviceProxy({ helper: { removeListeners } } as never);
    expect(removeListeners).toHaveBeenCalledTimes(1);
  });

  it('survives a device whose helper has no teardown', () => {
    expect(() => releaseDeviceProxy({ helper: {} } as never)).not.toThrow();
  });

  it('survives a device with no helper at all', () => {
    expect(() => releaseDeviceProxy({} as never)).not.toThrow();
  });
});

describe('node-ble internals the release depends on', () => {
  it('BusHelper.removeListeners still exists and drops the props-proxy listener', () => {
    const BusHelper = nodeRequire('node-ble/src/BusHelper.js') as {
      prototype: Record<string, unknown>;
    };
    expect(typeof BusHelper.prototype.removeListeners).toBe('function');

    const src = String(BusHelper.prototype.removeListeners);
    // Removing only our own 'PropertiesChanged' listeners would leave the one
    // _prepare() registered on the props proxy, which is the one that holds the
    // match rule.
    expect(src).toContain('_propsProxy');
    expect(src).toContain('removeAllListeners');
  });

  it('Device is still constructed with usePropsEvents, which is why it leaks', () => {
    const src = readFileSync(nodeRequire.resolve('node-ble/src/Device.js'), 'utf-8');
    expect(src).toContain('usePropsEvents: true');
  });

  it('BusHelper still registers that listener on the first property read', () => {
    const BusHelper = nodeRequire('node-ble/src/BusHelper.js') as {
      prototype: Record<string, unknown>;
    };
    const prepare = String(BusHelper.prototype._prepare);
    expect(prepare).toContain('usePropsEvents');
    expect(prepare).toContain("on('PropertiesChanged'");
  });
});
