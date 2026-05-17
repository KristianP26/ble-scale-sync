import type { EsphomeProxyConfig } from '../../config/schema.js';
import { errMsg } from '../types.js';

// ─── Constants ────────────────────────────────────────────────────────────────

export const CONNECT_TIMEOUT_MS = 30_000;

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Shape emitted by `@2colors/esphome-native-api`'s `ble` event. The library
 * merges the legacy structured path and the raw-advertisement path into the
 * same event, so fields overlap: `legacyDataList` (raw path, array of bytes)
 * OR `data` (legacy path, base64 string). We accept both.
 */
export interface EsphomeServiceData {
  uuid: string;
  legacyDataList?: number[];
  data?: string;
}

export interface EsphomeBleAdvertisement {
  address: number; // uint64 MAC packed as JS number (48-bit so safe)
  name: string;
  rssi: number;
  serviceUuidsList?: string[];
  serviceDataList?: EsphomeServiceData[];
  manufacturerDataList?: EsphomeServiceData[];
  addressType?: number;
}

/**
 * Minimal structural view of the `@2colors/esphome-native-api` Client we use.
 * `connection` is the underlying EventEmitter that carries GATT messages
 * (`message.BluetoothGATT*`), used by the Phase 2 GATT bridge.
 */
export interface EsphomeClient {
  connect(): void;
  disconnect(): void;
  on(event: 'connected' | 'disconnected' | 'reconnect', listener: () => void): EsphomeClient;
  on(event: 'ble', listener: (msg: EsphomeBleAdvertisement) => void): EsphomeClient;
  on(event: 'error', listener: (err: unknown) => void): EsphomeClient;
  removeListener(event: string, listener: (...args: unknown[]) => void): EsphomeClient;
  connected: boolean;
  connection: EsphomeConnection;
}

/** Underlying Connection EventEmitter (carries the GATT protobuf messages). */
export interface EsphomeConnection {
  on(event: string, listener: (msg: unknown) => void): void;
  off(event: string, listener: (msg: unknown) => void): void;
  removeListener(event: string, listener: (msg: unknown) => void): void;
  connectBluetoothDeviceService(address: number, addressType?: number): Promise<unknown>;
  disconnectBluetoothDeviceService(address: number): Promise<unknown>;
  listBluetoothGATTServicesService(address: number): Promise<unknown>;
  readBluetoothGATTCharacteristicService(address: number, handle: number): Promise<unknown>;
  writeBluetoothGATTCharacteristicService(
    address: number,
    handle: number,
    value: Uint8Array,
    response: boolean,
  ): Promise<unknown>;
  notifyBluetoothGATTCharacteristicService(address: number, handle: number): Promise<unknown>;
}

// ─── Client factory ──────────────────────────────────────────────────────────

export async function createEsphomeClient(config: EsphomeProxyConfig): Promise<EsphomeClient> {
  const mod = (await import('@2colors/esphome-native-api')) as unknown as {
    Client: new (options: Record<string, unknown>) => EsphomeClient;
  };

  const options: Record<string, unknown> = {
    host: config.host,
    port: config.port,
    clientInfo: config.client_info,
    // Library stores this flag and re-runs subscribeBluetoothAdvertisementService()
    // on every `authorized` event, so BLE advertisements resume automatically
    // after reconnect without any manual action here.
    initializeSubscribeBLEAdvertisements: true,
    // Keep heavy-weight init steps off; we only need BLE advertisements
    initializeDeviceInfo: false,
    initializeListEntities: false,
    initializeSubscribeStates: false,
    initializeSubscribeLogs: false,
    reconnect: true,
  };
  if (config.encryption_key) options.encryptionKey = config.encryption_key;
  if (config.password) options.password = config.password;

  return new mod.Client(options);
}

export async function waitForConnected(
  client: EsphomeClient,
  hostPort: string = 'host:port',
): Promise<void> {
  if (client.connected) return;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      client.removeListener('connected', onConnected as (...args: unknown[]) => void);
      client.removeListener('error', onError as (...args: unknown[]) => void);
    };
    const onConnected = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const onError = (err: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err instanceof Error ? err : new Error(errMsg(err)));
    };
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`Timed out connecting to ESPHome proxy at ${hostPort}.`));
    }, CONNECT_TIMEOUT_MS);
    client.on('connected', onConnected);
    client.on('error', onError);
    try {
      client.connect();
    } catch (err) {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err instanceof Error ? err : new Error(errMsg(err)));
    }
  });
}

export async function safeDisconnect(client: EsphomeClient): Promise<void> {
  try {
    client.disconnect();
  } catch {
    /* ignore */
  }
}
