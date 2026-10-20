import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';

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

/**
 * #472. The Disconnect deadline exists because of three library behaviours.
 * They pass today and are here to fail CI when a bump changes one, since the
 * deadline would then be fixing something else, or nothing.
 */
describe('library behaviour the #472 deadlines rest on', () => {
  it('node-ble Device.disconnect releases its listeners only after BlueZ answers', () => {
    const Device = nodeRequire('node-ble/src/Device.js') as {
      prototype: Record<string, unknown>;
    };
    const src = String(Device.prototype.disconnect);
    const call = src.indexOf("callMethod('Disconnect')");
    const release = src.indexOf('removeListeners()');
    expect(call).toBeGreaterThanOrEqual(0);
    expect(release).toBeGreaterThan(call);
    // And with no timeout of its own.
    expect(src).not.toMatch(/setTimeout|timeout/i);
  });

  it('node-ble GattServer.init waits for ServicesResolved with no limit', () => {
    const GattServer = nodeRequire('node-ble/src/GattServer.js') as {
      prototype: Record<string, unknown>;
    };
    const src = String(GattServer.prototype.init);
    expect(src).toContain("waitPropChange('ServicesResolved')");
    expect(src).not.toMatch(/setTimeout|timeout/i);
  });

  it('dbus-next MessageBus.disconnect leaves pending method calls unanswered', () => {
    const MessageBus = nodeRequire('dbus-next/lib/bus.js') as {
      prototype: Record<string, unknown>;
    };
    const src = String(MessageBus.prototype.disconnect);
    expect(src).toContain('stream.end()');
    expect(src).not.toContain('_methodReturnHandlers');
  });
});

/**
 * #471, D066. The link observer subscribes to Device1.Disconnected through a
 * ProxyObject of its own and relies on dbus-next to add a match rule only for
 * a signal the introspection declared, to drop it with the last listener, and
 * to deliver (reason, message) only from the name's current owner.
 */
describe('library behaviour the D066 reason subscription rests on', () => {
  const ProxyInterface = nodeRequire('dbus-next/lib/client/proxy-interface.js') as {
    _fromXml(object: unknown, xml: unknown): (EventEmitter & { $signals: unknown[] }) | null;
  };

  function makeObject() {
    const signals = new EventEmitter();
    const bus = {
      _addMatch: vi.fn(async () => undefined),
      _removeMatch: vi.fn(async () => undefined),
      _signals: signals,
      _nameOwners: { 'org.bluez': ':1.7' } as Record<string, string>,
      emit: vi.fn(),
    };
    return { bus, name: 'org.bluez', path: '/org/bluez/hci0/dev_AA_BB_CC_DD_EE_FF' };
  }

  const device1Xml = (withSignal: boolean) => ({
    $: { name: 'org.bluez.Device1' },
    ...(withSignal
      ? {
          signal: [
            { $: { name: 'Disconnected' }, arg: [{ $: { type: 's' } }, { $: { type: 's' } }] },
          ],
        }
      : {}),
  });

  it('adds no match rule for a signal the introspection did not declare (BlueZ 5.82)', () => {
    const object = makeObject();
    const iface = ProxyInterface._fromXml(object, device1Xml(false));
    iface?.on('Disconnected', () => {});
    expect(object.bus._addMatch).not.toHaveBeenCalled();
  });

  it('adds one match rule for a declared signal, removes it with the last listener, and delivers only from the owner', () => {
    const object = makeObject();
    const iface = ProxyInterface._fromXml(object, device1Xml(true));
    expect(iface?.$signals).toEqual([{ name: 'Disconnected', signature: 'ss' }]);
    const heard: unknown[][] = [];
    const listener = (...args: unknown[]) => heard.push(args);
    iface?.on('Disconnected', listener);
    expect(object.bus._addMatch).toHaveBeenCalledTimes(1);
    expect(String(object.bus._addMatch.mock.calls[0][0])).toContain("member='Disconnected'");

    const detailed = JSON.stringify({
      path: object.path,
      interface: 'org.bluez.Device1',
      member: 'Disconnected',
    });
    const body = ['org.bluez.Reason.Authentication', 'Connection terminated'];
    object.bus._signals.emit(detailed, { body, signature: 'ss', sender: ':1.99' });
    object.bus._signals.emit(detailed, { body, signature: 'ss', sender: ':1.7' });
    expect(heard).toEqual([body]);

    iface?.removeListener('Disconnected', listener);
    expect(object.bus._removeMatch).toHaveBeenCalledTimes(1);
    expect(object.bus._signals.listenerCount(detailed)).toBe(0);
  });
});
