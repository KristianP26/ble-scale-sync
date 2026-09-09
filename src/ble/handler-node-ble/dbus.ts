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
}

type WithHelper<T> = T & { helper: BluezHelper };

export interface DbusNextModule {
  Variant: new <T>(signature: string, value: T) => Variant<T>;
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
