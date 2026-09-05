export { scanAndReadRaw, scanAndRead, scanDevices } from './scan.js';
export { ReadingWatcher } from './watcher.js';
export {
  HaBluetoothClient,
  HaBluetoothPermanentError,
  toWebSocketUrl,
  STALE_ADVERT_MS,
} from './client.js';
export type { WsLike, WsFactory, AdvertCallback } from './client.js';
export { toBleDeviceInfo } from './advert.js';
export type { HaAdvertisement } from './advert.js';
