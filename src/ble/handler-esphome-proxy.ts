import type {
  ScaleAdapter,
  ScaleReading,
  BleDeviceInfo,
  BodyComposition,
} from '../interfaces/scale-adapter.js';
import type { EsphomeProxyConfig } from '../config/schema.js';
import type { ScanOptions, ScanResult } from './types.js';
import type { RawReading } from './shared.js';
import { bleLog, errMsg, normalizeUuid, withTimeout, IMPEDANCE_GRACE_MS } from './types.js';
import { AsyncQueue } from './async-queue.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const CONNECT_TIMEOUT_MS = 30_000;
// 60s matches the native BLE handlers and gives slow-advertising scales (e.g. Mi,
// some Renpho) enough time to emit a broadcast frame after the user steps on.
const BROADCAST_WAIT_MS = 60_000;
const SCAN_DEFAULT_MS = 15_000;
const DEDUP_WINDOW_MS = 30_000;
// Cap for the "already warned about this GATT scale" tracker used in continuous
// mode. Old entries are evicted LRU-style so dedup persists long-term instead of
// flapping every 256 warnings.
const GATT_WARN_LRU_MAX = 256;

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

async function waitForConnected(
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
  if (ad.serviceDataList && ad.serviceDataList.length > 0) {
    info.serviceData = ad.serviceDataList
      .map((sd) => ({ uuid: normalizeUuid(sd.uuid), data: extractBytes(sd) }))
      .filter((sd) => sd.data.length > 0);
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
 * Emit a one-line summary of which configured adapters can actually produce
 * readings over the Phase 1 (broadcast-only) ESPHome proxy transport, so
 * users see the constraint on startup instead of waiting for a 60s timeout.
 * Classifies each adapter by whether it defines parseBroadcast().
 */
function logPhase1Capabilities(adapters: ScaleAdapter[]): void {
  const broadcast: string[] = [];
  const gattOnly: string[] = [];
  for (const a of adapters) {
    if (typeof a.parseBroadcast === 'function' || typeof a.parseServiceData === 'function') {
      broadcast.push(a.name);
    } else if (a.charNotifyUuid) {
      gattOnly.push(a.name);
    }
  }
  if (broadcast.length === 0 && gattOnly.length === 0) return;

  const parts: string[] = ['ESPHome proxy transport is broadcast-only in Phase 1.'];
  if (broadcast.length > 0) {
    parts.push(`Broadcast-capable adapters: ${broadcast.join(', ')}.`);
  }
  if (gattOnly.length > 0) {
    parts.push(
      `GATT-only adapters will not produce readings on this transport: ${gattOnly.join(', ')}.`,
    );
    parts.push(
      'If your scale matches a GATT-only adapter, switch ble.handler to "native" or "mqtt-proxy". Phase 2 tracking: #116.',
    );
  }
  bleLog.warn(parts.join(' '));
}

/**
 * Subscribe to BLE advertisements via an ESPHome proxy, match against adapters,
 * and return the first broadcast reading that parses successfully.
 *
 * Phase 1 scope: broadcast-only. If a matched adapter requires GATT the
 * function throws a descriptive error (see {@link gattNotSupportedError}).
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
    logPhase1Capabilities(adapters);

    // Per-address grace state so two scales advertising partial frames in the
    // same scan window do not clobber each other's pending fallback (#161).
    const graceTimers = new Map<string, ReturnType<typeof setTimeout>>();
    const graceReadings = new Map<string, RawReading>();
    const clearGrace = (): void => {
      for (const t of graceTimers.values()) clearTimeout(t);
      graceTimers.clear();
      graceReadings.clear();
    };

    try {
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

            let reading: ScaleReading | null = null;

            if (adapter.parseBroadcast && info.manufacturerData) {
              reading = adapter.parseBroadcast(info.manufacturerData.data);
            }

            if (!reading && adapter.parseServiceData && info.serviceData) {
              for (const sd of info.serviceData) {
                reading = adapter.parseServiceData(sd.uuid, sd.data);
                if (reading) break;
              }
            }

            // Adapters that prefer passive scanning (e.g. Mi Scale 2) emit a
            // weight-only frame first and a weight+impedance frame moments later.
            // Gate on isComplete + grace-timer for those. Other broadcast adapters
            // (Eufy, QN-scale) embed a "final" flag in the frame itself, so any
            // non-null reading is already stable — emit immediately to avoid
            // adding a 12s latency penalty on the existing path.
            const requiresStable = adapter.preferPassive === true;
            if (reading && (!requiresStable || adapter.isComplete(reading))) {
              const pending = graceTimers.get(address);
              if (pending) {
                clearTimeout(pending);
                graceTimers.delete(address);
                graceReadings.delete(address);
              }
              bleLog.info(`Matched: ${adapter.name} (${address})`);
              bleLog.info(`Broadcast reading: ${reading.weight} kg`);
              resolve({ reading, adapter });
              return;
            }

            // Partial frame for a passive adapter — start grace timer keyed on
            // this address so a second scale's partial frame cannot overwrite.
            if (reading && requiresStable) {
              bleLog.debug(
                `${adapter.name} matched at ${address} but broadcast frame is not stable yet`,
              );
              graceReadings.set(address, { reading, adapter });
              if (!graceTimers.has(address)) {
                graceTimers.set(
                  address,
                  setTimeout(() => {
                    graceTimers.delete(address);
                    const gr = graceReadings.get(address);
                    graceReadings.delete(address);
                    if (!gr) return;
                    bleLog.info(
                      `Matched: ${gr.adapter.name} (${address}) — weight only, no impedance within ${IMPEDANCE_GRACE_MS / 1000}s`,
                    );
                    bleLog.info(`Broadcast reading: ${gr.reading.weight} kg`);
                    resolve(gr);
                  }, IMPEDANCE_GRACE_MS),
                );
              }
              return;
            }

            // Adapter supports broadcast but no parseable frame yet: keep waiting.
            if (adapter.parseBroadcast || adapter.parseServiceData) {
              bleLog.debug(
                `${adapter.name} matched at ${address} but broadcast frame is not stable yet`,
              );
              return;
            }

            // Adapter advertises nothing broadcast-able and no GATT characteristic
            // either: nothing we can do, keep waiting in case another device matches.
            if (!adapter.charNotifyUuid) {
              bleLog.debug(
                `${adapter.name} matched at ${address} but has no broadcast or GATT path`,
              );
              return;
            }

            // GATT-only adapter: Phase 1 cannot service it in single-shot mode.
            reject(gattNotSupportedError(adapter.name, address));
          };

          client.on('ble', adListener);
        }),
        BROADCAST_WAIT_MS,
        targetMac
          ? `Timed out waiting for broadcast from ${targetMac} via ESPHome proxy.`
          : `Timed out waiting for any recognized scale broadcast via ESPHome proxy.`,
      );
    } finally {
      clearGrace();
    }
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

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let timer: NodeJS.Timeout | null = null;
      const cleanup = () => {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        client.removeListener('ble', onAd as (...args: unknown[]) => void);
        client.removeListener('error', onError as (...args: unknown[]) => void);
        client.removeListener('disconnected', onDisconnect as (...args: unknown[]) => void);
      };
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
      const onError = (err: unknown): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err instanceof Error ? err : new Error(errMsg(err)));
      };
      const onDisconnect = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error('ESPHome proxy disconnected during scan'));
      };
      client.on('ble', onAd);
      client.on('error', onError);
      client.on('disconnected', onDisconnect);
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      }, duration);
    });

    return [...results.values()];
  } finally {
    await safeDisconnect(client);
  }
}

// ─── ReadingWatcher (continuous mode) ────────────────────────────────────────

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
  // LRU map (insertion-ordered): tracks which GATT-only scales we've already
  // warned about. Once the map hits GATT_WARN_LRU_MAX we evict the oldest entry
  // so dedup survives long-running continuous mode without a periodic flush.
  private gattWarnedFor = new Map<string, true>();
  private graceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private graceReadings = new Map<string, RawReading>();

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
      logPhase1Capabilities(this.adapters);

      this.onAdHandler = (ad) => this.handleAd(ad);
      this.client.on('ble', this.onAdHandler);

      bleLog.info('ESPHome ReadingWatcher started, listening for advertisements');
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

    let reading: ScaleReading | null = null;

    if (adapter.parseBroadcast && info.manufacturerData) {
      reading = adapter.parseBroadcast(info.manufacturerData.data);
    }

    if (!reading && adapter.parseServiceData && info.serviceData) {
      for (const sd of info.serviceData) {
        reading = adapter.parseServiceData(sd.uuid, sd.data);
        if (reading) break;
      }
    }

    // Same passive-vs-immediate split as scanAndReadRaw — see comment there.
    const requiresStable = adapter.preferPassive === true;
    if (reading && (!requiresStable || adapter.isComplete(reading))) {
      // Cancel any pending grace timer for this address — we got the full reading.
      const gt = this.graceTimers.get(address);
      if (gt) {
        clearTimeout(gt);
        this.graceTimers.delete(address);
        this.graceReadings.delete(address);
      }

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

    // Partial broadcast frame for a passive adapter — start grace timer so
    // we fall back to weight-only if the impedance frame never arrives.
    if (reading && requiresStable) {
      this.graceReadings.set(address, { reading, adapter });
      if (!this.graceTimers.has(address)) {
        this.graceTimers.set(
          address,
          setTimeout(() => {
            this.graceTimers.delete(address);
            const gr = this.graceReadings.get(address);
            this.graceReadings.delete(address);
            if (!gr) return;
            bleLog.info(
              `Matched: ${gr.adapter.name} (${address}) — weight only, no impedance within ${IMPEDANCE_GRACE_MS / 1000}s`,
            );
            bleLog.info(`Broadcast reading: ${gr.reading.weight} kg`);
            this.queue.push(gr);
          }, IMPEDANCE_GRACE_MS),
        );
      }
      return;
    }

    // Adapter matched but broadcast path yielded nothing usable (reading is null).
    // If the adapter has a GATT path, Phase 1 cannot service it — warn once per
    // address. This covers both GATT-only adapters and dual-mode adapters whose
    // broadcast frames are non-weight-bearing (e.g. Elis 1 MAC beacons).
    if (adapter.charNotifyUuid) {
      this.warnGattNotSupported(adapter.name, address);
    }
  }

  private warnGattNotSupported(adapterName: string, address: string): void {
    if (this.gattWarnedFor.has(address)) {
      // Refresh recency so the entry survives LRU eviction.
      this.gattWarnedFor.delete(address);
      this.gattWarnedFor.set(address, true);
      return;
    }
    if (this.gattWarnedFor.size >= GATT_WARN_LRU_MAX) {
      const oldest = this.gattWarnedFor.keys().next().value;
      if (oldest !== undefined) this.gattWarnedFor.delete(oldest);
    }
    this.gattWarnedFor.set(address, true);
    bleLog.warn(
      `${adapterName} at ${address} needs a GATT connection for weight data, which the ` +
        `ESPHome proxy transport does not yet support (Phase 1 is broadcast-only). ` +
        `Use the native BLE handler or the ESP32 MQTT proxy for this scale until Phase 2 lands.`,
    );
  }

  private pruneDedup(now: number): void {
    for (const [key, ts] of this.dedup) {
      if (now - ts >= DEDUP_WINDOW_MS) this.dedup.delete(key);
    }
  }

  private async teardown(): Promise<void> {
    for (const t of this.graceTimers.values()) clearTimeout(t);
    this.graceTimers.clear();
    this.graceReadings.clear();

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

// ─── Helpers exported for tests ──────────────────────────────────────────────

export const _internals = {
  formatMacAddress,
  parseManufacturerId,
  extractBytes,
  toBleDeviceInfo,
};
