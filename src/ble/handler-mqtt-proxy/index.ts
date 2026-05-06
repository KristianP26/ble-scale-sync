// Public API of the mqtt-proxy handler. Sub-modules are private.
//
// Original src/ble/handler-mqtt-proxy.ts (946 lines) was split into a focused
// directory in #131 so each concern (client, topics, gatt, scan, watcher,
// display) sits in its own file. Callers import the same names from the same
// path (handler-mqtt-proxy/index.js) so behaviour is unchanged.

export { scanAndReadRaw, scanAndRead, scanDevices } from './scan.js';
export {
  publishConfig,
  registerScaleMac,
  publishBeep,
  publishDisplayReading,
  publishDisplayResult,
} from './display.js';
export { ReadingWatcher } from './watcher.js';

// Re-exported for backward compatibility with earlier imports.
export { AsyncQueue } from '../async-queue.js';

// State accessors and reset hooks (test surface + display setter).
export {
  type DisplayUser,
  setDisplayUsers,
  _resetProxyState,
  _resetPersistentClient,
  _resetDiscoveredMacs,
} from './client.js';
