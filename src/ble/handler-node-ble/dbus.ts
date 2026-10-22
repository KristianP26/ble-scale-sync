// D-Bus surface typings used across the node-ble handler.
// node-ble does not expose typings for the internal `helper` BusHelper field
// or for dbus-next Variant wrappers, so we declare the minimum surface we use.
// Replaces eight `eslint-disable @typescript-eslint/no-explicit-any` cast sites
// (#162) with one typed access pattern.

import type NodeBle from 'node-ble';
import { bleLog, errMsg } from '../types.js';

export type Adapter = NodeBle.Adapter;
export type Device = NodeBle.Device;

export type Variant<T = unknown> = { signature?: string; value: T };

export type PropsChangedHandler = (props: Record<string, unknown>) => void;

export interface BluezHelper {
  on(event: 'PropertiesChanged', handler: PropsChangedHandler): void;
  removeListener(event: 'PropertiesChanged', handler: PropsChangedHandler): void;
  /**
   * node-ble's own teardown for a BusHelper: drops our PropertiesChanged
   * listeners AND the ones its `_prepare()` registered on the underlying
   * dbus-next properties proxy. Releasing a throwaway Device proxy is the only
   * thing that unwinds the D-Bus match rule and the entry on the bus-wide
   * `_signals` emitter that creating it added (#396, #397).
   *
   * Safe on a discarded proxy and only on a discarded proxy: `getProxyObject`
   * builds a fresh ProxyObject per call with no cache, so the props proxy is
   * private to this Device and a live session's subscriptions are untouched.
   */
  removeListeners(): void;
  prop(name: string): Promise<unknown>;
  set(name: string, value: Variant): Promise<void>;
  callMethod(method: string, ...args: unknown[]): Promise<unknown>;
  object: string;
  /** The dbus-next bus the object lives on; node-ble keeps it untyped. */
  dbus?: RawCallBus;
}

/** The one MessageBus method a raw call needs: no proxy, no match rule. */
export interface RawCallBus {
  call(msg: unknown): Promise<{ body: unknown[] } | null>;
  /**
   * dbus-next MessageBus.getProxyObject: one Introspect, and no match rule
   * until a listener is added for a signal the introspection declared.
   */
  getProxyObject?(name: string, path: string): Promise<ProxyObjectLike>;
}

/** The part of a dbus-next ProxyInterface the link observer subscribes through. */
export interface SignalInterface {
  /** The signals this interface declared in its introspection. */
  $signals?: ReadonlyArray<{ name: string }>;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  removeListener(event: string, listener: (...args: unknown[]) => void): unknown;
}

/** dbus-next ProxyObject; getInterface throws for an interface the object does not export. */
export interface ProxyObjectLike {
  getInterface(name: string): SignalInterface;
}

export interface DbusMessageFields {
  destination: string;
  path: string;
  interface: string;
  member: string;
  signature?: string;
  body?: unknown[];
}

type WithHelper<T> = T & { helper: BluezHelper };

export interface DbusNextModule {
  Variant: new <T>(signature: string, value: T) => Variant<T>;
  Message: new (fields: DbusMessageFields) => unknown;
}

export const helperOf = <T>(obj: T): BluezHelper => (obj as WithHelper<T>).helper;

/**
 * Whether BlueZ still lists this device as bonded.
 *
 * node-ble types `isPaired()` loosely; BusHelper.prop unwraps the Variant to a
 * real boolean at runtime, so the cast goes through unknown. Any failure
 * answers false: every caller uses this to gate a destructive or accusatory
 * step, so an unknown bond state must not read as "bonded".
 *
 * This lived as four separate copies with three different failure semantics -
 * one of which let a transient D-Bus error propagate out of the bonding path -
 * and one of those copies carried a comment saying it was written by copying
 * another (#406).
 */
export async function isBonded(device: Device | undefined): Promise<boolean> {
  try {
    return ((await device?.isPaired()) as unknown as boolean) === true;
  } catch {
    return false;
  }
}

/**
 * Release a node-ble Device proxy we created only to read a property off.
 *
 * `Adapter.getDevice()` returns a BRAND NEW Device, and its BusHelper is built
 * with `usePropsEvents: true`, so the first property read registers a
 * PropertiesChanged listener on the bus-wide signal emitter and adds a D-Bus
 * match rule. Scanning a busy room re-created one of these per nearby device
 * per cycle and never gave it back, which is the
 * `MaxListenersExceededWarning ... 11 listeners added` a reporter saw once per
 * device path (#397) and one half of the match-rule growth that ends in
 * `LimitsExceeded` (#396).
 *
 * Only ever call this on a proxy nothing else holds. Never on the device a
 * session is using.
 */
export function releaseDeviceProxy(device: Device): void {
  try {
    helperOf(device).removeListeners();
  } catch (err) {
    // Nothing prepared yet (no property was read) or the helper is already torn
    // down, which are both normal. Logged rather than silently dropped so a
    // release that fails for a real reason is not indistinguishable from those.
    bleLog.debug(`Could not release a BlueZ device proxy: ${errMsg(err)}`);
  }
}

let _dbusNext: DbusNextModule | null = null;

export async function getDbusNext(): Promise<DbusNextModule> {
  if (_dbusNext) return _dbusNext;
  _dbusNext = (await import('dbus-next')) as unknown as DbusNextModule;
  return _dbusNext;
}

/**
 * Read one Device1 property through a raw org.freedesktop.DBus.Properties.Get.
 *
 * node-ble's BusHelper.prop() calls through a dbus-next proxy built from the
 * object's introspection. BlueZ does not list org.freedesktop.DBus.Properties
 * on the passive advertisement Device1 objects it creates during filtered
 * discovery, so that proxy has no Get method and every call rejects with
 * `Method "Get" with signature "ss" on interface
 * "org.freedesktop.DBus.Properties" doesn't exist`. A raw message does not
 * depend on that introspection - it is exactly what `busctl get-property` does
 * successfully on the same object - so it is the only way to poll ServiceData
 * for a device that is never connected.
 *
 * The fallback keeps transports that hand us a Device without a dbus-next bus
 * on their existing property path.
 */
export async function readDeviceProp<T>(device: Device, propName: string): Promise<T> {
  const helper = helperOf(device);
  const bus = helper.dbus;
  if (!bus) return (await helper.prop(propName)) as T;

  const { Message } = await getDbusNext();
  const reply = await bus.call(
    new Message({
      destination: 'org.bluez',
      path: helper.object,
      interface: 'org.freedesktop.DBus.Properties',
      member: 'Get',
      signature: 'ss',
      body: ['org.bluez.Device1', propName],
    }),
  );
  const variant = reply?.body?.[0] as Variant<T> | undefined;
  if (!variant || typeof variant !== 'object' || !('value' in variant)) {
    throw new Error(`Unexpected Properties.Get reply for ${propName}`);
  }
  return variant.value;
}
