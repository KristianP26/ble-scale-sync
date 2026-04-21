import type { ScaleAdapter, BleDeviceInfo, BodyComposition } from '../interfaces/scale-adapter.js';
import type { EsphomeProxyConfig } from '../config/schema.js';
import type { ScanOptions, ScanResult } from './types.js';
import type { RawReading } from './shared.js';
import { bleLog, errMsg, normalizeUuid, withTimeout } from './types.js';
import { AsyncQueue } from './async-queue.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const CONNECT_TIMEOUT_MS = 30_000;
const SCAN_DEFAULT_MS = 15_000;
const DEDUP_WINDOW_MS = 30_000;

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Shape emitted by `@2colors/esphome-native-api`'s `ble` event. The library
 * merges the legacy structured path and the raw-advertisement path into the
 * same event, so fields overlap: `legacyDataList` (raw path, array of bytes)
 * OR `data` (legacy path, base64 string). We accept both.
 */
interface EsphomeServiceData {
  uuid: string;
  legacyDataList?: number[];
  data?: string;
}

interface EsphomeBleAdvertisement {
  address: number; // uint64 MAC packed as JS number (48-bit so safe)
  name: string;
  rssi: number;
  serviceUuidsList?: string[];
  serviceDataList?: EsphomeServiceData[];
  manufacturerDataList?: EsphomeServiceData[];
  addressType?: number;
}

interface EsphomeClient {
  connect(): void;
  disconnect(): void;
  on(event: 'connected' | 'disconnected' | 'reconnect', listener: () => void): EsphomeClient;
  on(event: 'ble', listener: (msg: EsphomeBleAdvertisement) => void): EsphomeClient;
  on(event: 'error', listener: (err: unknown) => void): EsphomeClient;
  off(event: string, listener: (...args: unknown[]) => void): EsphomeClient;
  removeListener(event: string, listener: (...args: unknown[]) => void): EsphomeClient;
  connected: boolean;
}

// ─── Client factory ──────────────────────────────────────────────────────────

async function createEsphomeClient(config: EsphomeProxyConfig): Promise<EsphomeClient> {
  const mod = (await import('@2colors/esphome-native-api')) as unknown as {
    Client: new (options: Record<string, unknown>) => EsphomeClient;
  };

  const options: Record<string, unknown> = {
    host: config.host,
    port: config.port,
    clientInfo: config.client_info,
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

async function waitForConnected(
  client: EsphomeClient,
  hostPort: string = 'host:port',
): Promise<void> {
  if (client.connected) return;
  await withTimeout(
    new Promise<void>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
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
    }),
    CONNECT_TIMEOUT_MS,
    `Timed out connecting to ESPHome proxy at ${hostPort}.`,
  );
}

async function safeDisconnect(client: EsphomeClient): Promise<void> {
  try {
    client.disconnect();
  } catch {
    /* ignore */
  }
}

// ─── Advertisement normalization ─────────────────────────────────────────────

/**
 * Convert a uint64 MAC (as JS number) to the canonical XX:XX:XX:XX:XX:XX form.
 * Defensive: returns a sentinel if the library ever hands us a non-numeric or
 * negative value so the caller can skip the advertisement instead of crashing.
 */
function formatMacAddress(addr: unknown): string {
  if (typeof addr !== 'number' || !Number.isFinite(addr) || addr < 0) {
    return '00:00:00:00:00:00';
  }
  const hex = Math.trunc(addr).toString(16).padStart(12, '0');
  return (hex.match(/.{2}/g) ?? []).join(':').toUpperCase();
}

/**
 * Parse the manufacturer ID from a BluetoothServiceData `uuid` field.
 * The library exposes the 16-bit company ID either as `"0xAABB"` (legacy
 * parsed path) or as a full 128-bit UUID like `"0000aabb-0000-1000-8000-...`
 * (after `ensureFullUuid`). Both are supported.
 */
function parseManufacturerId(uuid: string): number | null {
  if (!uuid) return null;
  if (uuid.startsWith('0x')) {
    const n = Number.parseInt(uuid.slice(2), 16);
    return Number.isFinite(n) ? n : null;
  }
  // Full UUID: take the 16-bit segment from the first 8 hex chars
  const firstSegment = uuid.split('-')[0];
  if (!firstSegment) return null;
  const n = Number.parseInt(firstSegment, 16);
  return Number.isFinite(n) ? n : null;
}

/** Extract a manufacturer_data entry's raw bytes, preferring `legacyDataList`. */
function extractBytes(entry: EsphomeServiceData): Buffer {
  if (entry.legacyDataList && entry.legacyDataList.length > 0) {
    return Buffer.from(entry.legacyDataList);
  }
  if (entry.data) {
    return Buffer.from(entry.data, 'base64');
  }
  return Buffer.alloc(0);
}

/** Build a BleDeviceInfo from an ESPHome advertisement payload. */
function toBleDeviceInfo(ad: EsphomeBleAdvertisement): BleDeviceInfo {
  const info: BleDeviceInfo = {
    localName: ad.name || '',
    serviceUuids: (ad.serviceUuidsList ?? []).map(normalizeUuid),
  };
  const md = ad.manufacturerDataList?.[0];
  if (md) {
    const id = parseManufacturerId(md.uuid);
    const data = extractBytes(md);
    if (id != null && data.length > 0) {
      info.manufacturerData = { id, data };
    }
  }
  return info;
}

// ─── Single-shot scan-and-read (broadcast only) ──────────────────────────────

function gattNotSupportedError(adapterName: string, address: string): Error {
  return new Error(
    `Scale ${adapterName} (${address}) requires a GATT connection, which is not yet ` +
      `supported by the ESPHome proxy transport (Phase 1 is broadcast-only). ` +
      `Use the ESP32 MQTT proxy or native BLE for this scale until Phase 2 lands.`,
  );
}

/**
 * Subscribe to BLE advertisements via an ESPHome proxy, match against adapters,
 * and return the first broadcast reading that parses successfully.
 *
 * Phase 1 scope: broadcast-only. If a matched adapter requires GATT the
 * function throws a descriptive error (see {@link throwGattNotSupported}).
 */
export async function scanAndReadRaw(opts: ScanOptions): Promise<RawReading> {
  const config = opts.esphomeProxy;
  if (!config) throw new Error('esphome_proxy config is required for esphome-proxy handler');

  const { targetMac, adapters } = opts;
  const client = await createEsphomeClient(config);
  const targetLc = targetMac?.toLowerCase();
  const hostPort = `${config.host}:${config.port}`;

  // Hoisted so the outer `finally` can always remove it, even on timeout.
  let adListener: ((ad: EsphomeBleAdvertisement) => void) | null = null;

  try {
    await waitForConnected(client, hostPort);
    bleLog.info(`ESPHome proxy connected at ${hostPort}`);

    return await withTimeout(
      new Promise<RawReading>((resolve, reject) => {
        const seenAddrs = new Set<string>();

        adListener = (ad: EsphomeBleAdvertisement): void => {
          const address = formatMacAddress(ad.address);
          if (targetLc && address.toLowerCase() !== targetLc) return;

          const info = toBleDeviceInfo(ad);
          const adapter = adapters.find((a) => a.matches(info));
          if (!adapter) {
            if (!seenAddrs.has(address)) {
              seenAddrs.add(address);
              bleLog.debug(`Unmatched device: ${address} (${info.localName || 'no name'})`);
            }
            return;
          }

          if (adapter.parseBroadcast && info.manufacturerData) {
            const reading = adapter.parseBroadcast(info.manufacturerData.data);
            if (reading) {
              bleLog.info(`Matched: ${adapter.name} (${address})`);
              bleLog.info(`Broadcast reading: ${reading.weight} kg`);
              resolve({ reading, adapter });
              return;
            }
          }

          // Broadcast-capable adapter but the frame isn't stable yet
          if (adapter.parseBroadcast || !adapter.charNotifyUuid) {
            bleLog.debug(
              `${adapter.name} matched at ${address} but broadcast frame is not stable yet`,
            );
            return;
          }

          reject(gattNotSupportedError(adapter.name, address));
        };

        client.on('ble', adListener);
      }),
      CONNECT_TIMEOUT_MS,
      targetMac
        ? `Timed out waiting for broadcast from ${targetMac} via ESPHome proxy.`
        : `Timed out waiting for any recognized scale broadcast via ESPHome proxy.`,
    );
  } finally {
    if (adListener) {
      client.removeListener('ble', adListener as (...args: unknown[]) => void);
    }
    await safeDisconnect(client);
  }
}

export async function scanAndRead(opts: ScanOptions): Promise<BodyComposition> {
  const { reading, adapter } = await scanAndReadRaw(opts);
  return adapter.computeMetrics(reading, opts.profile);
}

// ─── Device discovery (for setup wizard) ─────────────────────────────────────

export async function scanDevices(
  adapters: ScaleAdapter[],
  durationMs: number | undefined,
  config: EsphomeProxyConfig,
): Promise<ScanResult[]> {
  const client = await createEsphomeClient(config);
  const duration = durationMs ?? SCAN_DEFAULT_MS;
  const results = new Map<string, ScanResult>();
  const hostPort = `${config.host}:${config.port}`;

  try {
    await waitForConnected(client, hostPort);
    bleLog.info(`ESPHome proxy connected at ${hostPort}`);

    await new Promise<void>((resolve) => {
      const onAd = (ad: EsphomeBleAdvertisement): void => {
        const address = formatMacAddress(ad.address);
        if (results.has(address)) return;
        const info = toBleDeviceInfo(ad);
        const adapter = adapters.find((a) => a.matches(info));
        results.set(address, {
          address,
          name: ad.name || '',
          matchedAdapter: adapter?.name,
        });
      };
      client.on('ble', onAd);
      setTimeout(() => {
        client.removeListener('ble', onAd as (...args: unknown[]) => void);
        resolve();
      }, duration);
    });

    return [...results.values()];
  } finally {
    await safeDisconnect(client);
  }
}

// ─── ReadingWatcher — continuous mode ────────────────────────────────────────

/**
 * Persistent event-driven advertisement watcher for continuous mode, matching
 * the shape of the mqtt-proxy `ReadingWatcher`. Phase 1 handles broadcast
 * scales only; GATT-only adapters are logged and skipped.
 */
export class ReadingWatcher {
  private queue = new AsyncQueue<RawReading>();
  private started = false;
  private adapters: ScaleAdapter[];
  private targetMac?: string;
  private config: EsphomeProxyConfig;
  private dedup = new Map<string, number>();
  private client: EsphomeClient | null = null;
  private lifecycleHandlers: Array<{
    event: string;
    handler: (...args: unknown[]) => void;
  }> = [];
  private onAdHandler: ((ad: EsphomeBleAdvertisement) => void) | null = null;
  private gattWarnedFor = new Set<string>();

  constructor(config: EsphomeProxyConfig, adapters: ScaleAdapter[], targetMac?: string) {
    this.config = config;
    this.adapters = adapters;
    this.targetMac = targetMac?.toLowerCase();
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    try {
      this.client = await createEsphomeClient(this.config);
      const hostPort = `${this.config.host}:${this.config.port}`;

      const onReconnect = (): void => bleLog.info('ESPHome proxy reconnecting...');
      const onDisconnect = (): void => bleLog.warn('ESPHome proxy disconnected');
      const onConnect = (): void => bleLog.info('ESPHome proxy connected');
      const onError = (err: unknown): void => bleLog.warn(`ESPHome proxy error: ${errMsg(err)}`);

      this.client.on('connected', onConnect);
      this.client.on('disconnected', onDisconnect);
      this.client.on('reconnect', onReconnect);
      this.client.on('error', onError);
      this.lifecycleHandlers = [
        { event: 'connected', handler: onConnect as (...args: unknown[]) => void },
        { event: 'disconnected', handler: onDisconnect as (...args: unknown[]) => void },
        { event: 'reconnect', handler: onReconnect as (...args: unknown[]) => void },
        { event: 'error', handler: onError as (...args: unknown[]) => void },
      ];

      await waitForConnected(this.client, hostPort);

      this.onAdHandler = (ad) => this.handleAd(ad);
      this.client.on('ble', this.onAdHandler);

      bleLog.info('ESPHome ReadingWatcher started — listening for advertisements');
    } catch (err) {
      this.started = false;
      await this.teardown();
      throw err;
    }
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    await this.teardown();
    this.started = false;
    bleLog.info('ESPHome ReadingWatcher stopped');
  }

  nextReading(signal?: AbortSignal): Promise<RawReading> {
    return this.queue.shift(signal);
  }

  updateConfig(adapters: ScaleAdapter[], targetMac?: string): void {
    this.adapters = adapters;
    this.targetMac = targetMac?.toLowerCase();
  }

  private handleAd(ad: EsphomeBleAdvertisement): void {
    const address = formatMacAddress(ad.address);
    if (this.targetMac && address.toLowerCase() !== this.targetMac) return;

    const info = toBleDeviceInfo(ad);
    const adapter = this.adapters.find((a) => a.matches(info));
    if (!adapter) return;

    if (adapter.parseBroadcast && info.manufacturerData) {
      const reading = adapter.parseBroadcast(info.manufacturerData.data);
      if (reading) {
        const key = `${address}:${reading.weight.toFixed(1)}`;
        const now = Date.now();
        this.pruneDedup(now);
        const lastSeen = this.dedup.get(key);
        if (lastSeen && now - lastSeen < DEDUP_WINDOW_MS) {
          bleLog.debug(`Dedup skip: ${key}`);
          return;
        }
        this.dedup.set(key, now);
        bleLog.info(`Matched: ${adapter.name} (${address})`);
        bleLog.info(`Broadcast reading: ${reading.weight} kg`);
        this.queue.push({ reading, adapter });
        return;
      }
    }

    // GATT-only adapter matched; Phase 1 cannot service it — log once and skip
    if (adapter.charNotifyUuid && !adapter.parseBroadcast) {
      if (!this.gattWarnedFor.has(address)) {
        // Cap the set so it cannot grow unbounded across days of continuous mode
        // when many different GATT-only scales drift in and out of range.
        if (this.gattWarnedFor.size >= 256) this.gattWarnedFor.clear();
        this.gattWarnedFor.add(address);
        bleLog.warn(
          `${adapter.name} at ${address} requires GATT, which the ESPHome proxy transport ` +
            `does not yet support (Phase 1 is broadcast-only). Measurements from this scale ` +
            `are skipped.`,
        );
      }
    }
  }

  private pruneDedup(now: number): void {
    for (const [key, ts] of this.dedup) {
      if (now - ts >= DEDUP_WINDOW_MS) this.dedup.delete(key);
    }
  }

  private async teardown(): Promise<void> {
    if (this.client) {
      if (this.onAdHandler) {
        this.client.removeListener('ble', this.onAdHandler as (...args: unknown[]) => void);
        this.onAdHandler = null;
      }
      for (const { event, handler } of this.lifecycleHandlers) {
        this.client.removeListener(event, handler as (...args: unknown[]) => void);
      }
      this.lifecycleHandlers = [];
      await safeDisconnect(this.client);
      this.client = null;
    }
  }
}

// Re-exported for test-suite import sites that reached in through this handler.
export { AsyncQueue };

// ─── Helpers exported for tests ──────────────────────────────────────────────

export const _internals = {
  formatMacAddress,
  parseManufacturerId,
  extractBytes,
  toBleDeviceInfo,
};
