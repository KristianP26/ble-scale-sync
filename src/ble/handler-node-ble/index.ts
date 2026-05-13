// Public API of the node-ble handler. Sub-modules are private; import here.

import { connectWithRecovery } from './connect.js';
import { broadcastScanNodeBle } from './broadcast.js';

export { scanAndReadRaw, scanAndRead, scanDevices } from './scan.js';
export { isPeerFresh, startPeerFreshnessTracker } from './freshness.js';

/** Test-only exports of private helpers (#143 / #163). */
export const _internals = { connectWithRecovery, broadcastScanNodeBle };
