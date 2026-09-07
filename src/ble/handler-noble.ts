import noble from '@stoprocent/noble';
import { createNobleHandler } from './handler-noble-shared/index.js';

/**
 * BLE handler backed by `@stoprocent/noble` (macOS default; Linux/Windows via
 * NOBLE_DRIVER=stoprocent). Shared logic lives in handler-noble-shared.ts (#181).
 *
 * `@stoprocent/noble` exposes a `get state()` accessor that lazily initializes
 * the bindings on first read — that init is intended, so read `.state`.
 */
const handler = createNobleHandler({
  noble,
  getState: () => noble.state,
});

export const scanAndReadRaw = handler.scanAndReadRaw;
export const scanAndRead = handler.scanAndRead;
export const scanDevices = handler.scanDevices;
export const _internals = handler._internals;
