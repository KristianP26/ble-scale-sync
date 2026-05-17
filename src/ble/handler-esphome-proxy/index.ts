export { scanAndReadRaw, scanAndRead, scanDevices } from './scan.js';
export { ReadingWatcher } from './watcher.js';

import { formatMacAddress, parseManufacturerId, extractBytes, toBleDeviceInfo } from './advert.js';

// Helpers exported for tests (parity with the pre-split single-file module).
export const _internals = {
  formatMacAddress,
  parseManufacturerId,
  extractBytes,
  toBleDeviceInfo,
};
