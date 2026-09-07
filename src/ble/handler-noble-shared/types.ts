import type { Peripheral } from '@stoprocent/noble';

/**
 * Minimal structural surface of a Noble instance that the shared handler calls.
 * Both `@stoprocent/noble` and `@abandonware/noble` (cast) satisfy it at runtime;
 * typed event overloads keep this eslint-clean (no `any`).
 */
export interface NobleApi {
  on(event: 'stateChange', listener: (state: string) => void): unknown;
  on(event: 'discover', listener: (peripheral: Peripheral) => void): unknown;
  removeListener(event: 'stateChange', listener: (state: string) => void): unknown;
  removeListener(event: 'discover', listener: (peripheral: Peripheral) => void): unknown;
  startScanningAsync(serviceUuids?: string[], allowDuplicates?: boolean): Promise<void>;
  stopScanningAsync(): Promise<void>;
}

/** Dependencies injected per Noble driver. */
export interface NobleHandlerDeps {
  noble: NobleApi;
  /**
   * Read the adapter state WITHOUT changing the driver's init semantics.
   * `@stoprocent/noble` reads `.state` (triggers lazy init, intended);
   * `@abandonware/noble` reads the raw `._state` field (avoids the init side
   * effect of its `.state` getter).
   */
  getState: () => string;
}
