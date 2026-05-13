// D-Bus surface typings used across the node-ble handler.
// node-ble does not expose typings for the internal `helper` BusHelper field
// or for dbus-next Variant wrappers, so we declare the minimum surface we use.
// Replaces eight `eslint-disable @typescript-eslint/no-explicit-any` cast sites
// (#162) with one typed access pattern.

import type NodeBle from 'node-ble';

export type Adapter = NodeBle.Adapter;
export type Device = NodeBle.Device;

export type Variant<T = unknown> = { signature?: string; value: T };

export type PropsChangedHandler = (props: Record<string, unknown>) => void;

export interface BluezHelper {
  on(event: 'PropertiesChanged', handler: PropsChangedHandler): void;
  removeListener(event: 'PropertiesChanged', handler: PropsChangedHandler): void;
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

let _dbusNext: DbusNextModule | null = null;

export async function getDbusNext(): Promise<DbusNextModule> {
  if (_dbusNext) return _dbusNext;
  _dbusNext = (await import('dbus-next')) as unknown as DbusNextModule;
  return _dbusNext;
}
