// Public API of the node-ble handler. Sub-modules are private.
//
// Mirrors the #131 split applied to handler-mqtt-proxy: the original
// src/ble/handler-node-ble.ts (1186 lines) was broken into focused modules
// (dbus, connection, discovery, freshness, connect, gatt, broadcast, scan)
// so each concern lives in its own file. Callers import from the same path
// (handler-node-ble/index.js) so behaviour is unchanged.

export { scanAndReadRaw, scanAndRead, scanDevices } from './scan.js';
export { isPeerFresh, startPeerFreshnessTracker } from './freshness.js';

import { connectWithRecovery } from './connect.js';
import { broadcastScanNodeBle } from './broadcast.js';

/** Test-only exports of private helpers (#143 / #163). */
export const _internals = { connectWithRecovery, broadcastScanNodeBle };
