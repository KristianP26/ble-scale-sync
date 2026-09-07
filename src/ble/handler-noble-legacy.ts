import noble from '@abandonware/noble';
import { createNobleHandler, type NobleApi } from './handler-noble-shared/index.js';

/**
 * BLE handler backed by `@abandonware/noble` (Windows default; mature driver).
 * Shared logic lives in handler-noble-shared.ts (#181).
 *
 * `@abandonware/noble`'s `get state()` accessor triggers `bindings.init()` as a
 * side effect on first read, so read the raw `._state` field instead to preserve
 * the original init behaviour. The `_state` field is not in the package typings,
 * hence the cast.
 */
const handler = createNobleHandler({
  noble: noble as unknown as NobleApi,
  getState: () => (noble as unknown as { _state: string })._state,
});

export const scanAndReadRaw = handler.scanAndReadRaw;
export const scanAndRead = handler.scanAndRead;
export const scanDevices = handler.scanDevices;
export const _internals = handler._internals;
