import type {
  ScaleAdapter,
  ScaleReading,
  BleDeviceInfo,
  BodyComposition,
  UserProfile,
} from '../interfaces/scale-adapter.js';
import type { MqttProxyConfig } from '../config/schema.js';
import type { ScanOptions, ScanResult } from './types.js';
import type { BleChar, BleDevice, RawReading } from './shared.js';
import { waitForRawReading } from './shared.js';
import { bleLog, normalizeUuid, withTimeout, errMsg, IMPEDANCE_GRACE_MS } from './types.js';
import { AsyncQueue } from './async-queue.js';

// Re-exported for backward compatibility with earlier imports.
export { AsyncQueue } from './async-queue.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const COMMAND_TIMEOUT_MS = 30_000;

// ─── Types ────────────────────────────────────────────────────────────────────

interface ScanResultEntry {
  address: string;
  name: string;
  rssi: number;
  services: string[];
  addr_type?: number;
  manufacturer_id?: number | null;
  manufacturer_data?: string | null;
  /** Array of {uuid, data} service-data entries (hex-encoded data). */
  service_data?: Array<{ uuid: string; data: string }> | null;
}

/** Build BleDeviceInfo from a scan result entry, including manufacturer and service data. */
function toBleDeviceInfo(entry: ScanResultEntry): BleDeviceInfo {
  const info: BleDeviceInfo = {
    localName: entry.name,
    serviceUuids: entry.services.map(normalizeUuid),
  };
  if (entry.manufacturer_id != null && entry.manufacturer_data) {
    info.manufacturerData = {
      id: entry.manufacturer_id,
      data: Buffer.from(entry.manufacturer_data, 'hex'),
    };
  }
  if (entry.service_data && entry.service_data.length > 0) {
    info.serviceData = entry.service_data.map((sd) => ({
      uuid: normalizeUuid(sd.uuid),
      data: Buffer.from(sd.data, 'hex'),
    }));
  }
  return info;
}

// ─── Topic helpers ────────────────────────────────────────────────────────────

function topics(prefix: string, deviceId: string) {
  const base = `${prefix}/${deviceId}`;
  return {
    base,
    status: `${base}/status`,
    scanResults: `${base}/scan/results`,
    config: `${base}/config`,
    beep: `${base}/beep`,
    // GATT proxy topics
    connect: `${base}/connect`,
    connected: `${base}/connected`,
    disconnect: `${base}/disconnect`,
    disconnected: `${base}/disconnected`,
    error: `${base}/error`,
  };
}

// ─── MQTT client helpers ──────────────────────────────────────────────────────

type MqttClient = Awaited<ReturnType<typeof import('mqtt').connectAsync>>;

/**
 * Resolve the broker URL from config, throwing a helpful error if neither an
 * external broker nor the embedded broker has provided one.
 */
function requireBrokerUrl(config: MqttProxyConfig): string {
  if (!config.broker_url) {
    throw new Error(
      'mqtt_proxy.broker_url is not set and the embedded broker has not been started. ' +
        'Either configure an external broker URL, or run through the mqtt-proxy bootstrap ' +
        'which starts the embedded broker automatically.',
    );
  }
  return config.broker_url;
}

async function createMqttClient(config: MqttProxyConfig): Promise<MqttClient> {
  const { connectAsync } = await import('mqtt');
  const brokerUrl = requireBrokerUrl(config);
  const clientId = `ble-scale-sync-${config.device_id}`;
  const client = await withTimeout(
    connectAsync(brokerUrl, {
      clientId,
      username: config.username ?? undefined,
      password: config.password ?? undefined,
      clean: true,
    }),
    COMMAND_TIMEOUT_MS,
    `MQTT broker unreachable at ${brokerUrl}. Check your mqtt_proxy.broker_url config.`,
  );
  return client;
}

// ─── Shared proxy state (grouped for testability and encapsulation) ──────────

export interface DisplayUser {
  slug: string;
  name: string;
  weight_range: { min: number; max: number };
}

/**
 * Module-level state shared across MQTT proxy functions.
 * Grouped into a single object so it can be reset atomically in tests
 * and to make the shared mutable state explicit.
 */
const proxyState = {
  persistentClient: null as MqttClient | null,
  discoveredScaleMacs: new Set<string>(),
  displayUsers: [] as DisplayUser[],
};

/** Reset all module-level proxy state (for testing only). */
export function _resetProxyState(): void {
  proxyState.persistentClient = null;
  proxyState.discoveredScaleMacs.clear();
  proxyState.displayUsers = [];
}

/** @deprecated Use _resetProxyState() instead. */
export function _resetPersistentClient(): void {
  proxyState.persistentClient = null;
}

/** @deprecated Use _resetProxyState() instead. */
export function _resetDiscoveredMacs(): void {
  proxyState.discoveredScaleMacs.clear();
}

// ─── Persistent MQTT client (for continuous mode) ────────────────────────────

async function getOrCreatePersistentClient(config: MqttProxyConfig): Promise<MqttClient> {
  if (proxyState.persistentClient?.connected) return proxyState.persistentClient;
  if (proxyState.persistentClient) {
    try {
      await proxyState.persistentClient.endAsync();
    } catch {
      /* ignore */
    }
  }
  const { connectAsync } = await import('mqtt');
  const brokerUrl = requireBrokerUrl(config);
  proxyState.persistentClient = await withTimeout(
    connectAsync(brokerUrl, {
      clientId: `ble-scale-sync-${config.device_id}`,
      username: config.username ?? undefined,
      password: config.password ?? undefined,
      clean: false,
      reconnectPeriod: 5000,
    }),
    COMMAND_TIMEOUT_MS,
    `MQTT broker unreachable at ${brokerUrl}. Check your mqtt_proxy.broker_url config.`,
  );
  return proxyState.persistentClient;
}

/** Get the persistent client if connected, otherwise create an ephemeral one. */
async function getClient(
  config: MqttProxyConfig,
): Promise<{ client: MqttClient; ephemeral: boolean }> {
  if (proxyState.persistentClient?.connected) {
    return { client: proxyState.persistentClient, ephemeral: false };
  }
  return { client: await createMqttClient(config), ephemeral: true };
}

/** End an ephemeral client; no-op for the persistent client. */
async function releaseClient(client: MqttClient, ephemeral: boolean): Promise<void> {
  if (!ephemeral) return;
  try {
    await client.endAsync();
  } catch {
    /* ignore */
  }
}

async function waitForEsp32Online(client: MqttClient, t: ReturnType<typeof topics>): Promise<void> {
  let resolve!: () => void;
  let sawOffline = false;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  const onMessage = (topic: string, payload: Buffer) => {
    if (topic === t.status) {
      const msg = payload.toString();
      if (msg === 'online') resolve();
      else if (msg === 'offline') sawOffline = true;
      // If 'offline', keep waiting — ESP32 may come back before timeout
    }
  };
  client.on('message', onMessage);
  await client.subscribeAsync(t.status);

  // If we get the retained offline within 2s, fail fast rather than waiting 30s.
  // The main loop's backoff handles retries. But if online arrives within that
  // window we still succeed. Full timeout only applies when no status received.
  const OFFLINE_GRACE_MS = 2_000;

  try {
    return await withTimeout(
      Promise.race([
        promise,
        // After grace period, if we saw offline, reject early
        new Promise<never>((_res, rej) =>
          setTimeout(() => {
            if (sawOffline)
              rej(
                new Error('ESP32 proxy is offline. Check the device and its WiFi/MQTT connection.'),
              );
          }, OFFLINE_GRACE_MS),
        ),
      ]),
      COMMAND_TIMEOUT_MS,
      'ESP32 proxy did not respond. Check that it is powered on and connected to MQTT.',
    );
  } finally {
    client.removeListener('message', onMessage);
  }
}

// ─── Core scan flow ──────────────────────────────────────────────────────────

async function mqttScan(
  client: MqttClient,
  t: ReturnType<typeof topics>,
): Promise<ScanResultEntry[]> {
  let resolveResults!: (entries: ScanResultEntry[]) => void;
  let rejectResults!: (err: Error) => void;
  const promise = new Promise<ScanResultEntry[]>((res, rej) => {
    resolveResults = res;
    rejectResults = rej;
  });
  const handler = (topic: string, payload: Buffer) => {
    if (topic === t.scanResults) {
      try {
        resolveResults(JSON.parse(payload.toString()) as ScanResultEntry[]);
      } catch (err) {
        rejectResults(new Error(`ESP32 sent invalid scan results: ${err}`));
      }
    }
  };
  client.on('message', handler);
  await client.subscribeAsync(t.scanResults);
  // ESP32 scans autonomously — just wait for the next result
  try {
    return await withTimeout(
      promise,
      COMMAND_TIMEOUT_MS,
      'No scan results received from ESP32. Check that it is powered on and scanning.',
    );
  } finally {
    client.removeListener('message', handler);
  }
}

// ─── GATT over MQTT ──────────────────────────────────────────────────────────

/** Implements BleChar from shared.ts over MQTT topics. */
class MqttBleChar implements BleChar {
  constructor(
    private client: MqttClient,
    private base: string,
    private uuid: string,
  ) {}

  async subscribe(onData: (data: Buffer) => void): Promise<() => void> {
    const topic = `${this.base}/notify/${this.uuid}`;
    const handler = (t: string, payload: Buffer) => {
      if (t === topic) onData(payload);
    };
    this.client.on('message', handler);
    await this.client.subscribeAsync(topic);
    return () => {
      this.client.removeListener('message', handler);
    };
  }

  async write(data: Buffer, _withResponse: boolean): Promise<void> {
    await this.client.publishAsync(`${this.base}/write/${this.uuid}`, data);
  }

  async read(): Promise<Buffer> {
    const responseTopic = `${this.base}/read/${this.uuid}/response`;
    const handler = (t: string, payload: Buffer) => {
      if (t === responseTopic) {
        this.client.removeListener('message', handler);
        resolveOuter(payload);
      }
    };
    let resolveOuter!: (buf: Buffer) => void;
    const promise = new Promise<Buffer>((resolve) => {
      resolveOuter = resolve;
    });
    this.client.on('message', handler);
    try {
      await this.client.subscribeAsync(responseTopic);
      await this.client.publishAsync(`${this.base}/read/${this.uuid}`, '');
      return await withTimeout(
        promise,
        COMMAND_TIMEOUT_MS,
        `Read response timeout for ${this.uuid}`,
      );
    } finally {
      this.client.removeListener('message', handler);
      this.client.unsubscribeAsync(responseTopic).catch(() => {});
    }
  }
}

/** Implements BleDevice from shared.ts — watches for MQTT disconnect events. */
class MqttBleDevice implements BleDevice {
  private disconnectCb?: () => void;
  private handler?: (topic: string, payload: Buffer) => void;

  constructor(
    private client: MqttClient,
    private disconnectedTopic: string,
  ) {
    this.handler = (topic) => {
      if (topic === this.disconnectedTopic) this.disconnectCb?.();
    };
    client.on('message', this.handler);
  }

  onDisconnect(callback: () => void): void {
    this.disconnectCb = callback;
  }

  cleanup(): void {
    if (this.handler) this.client.removeListener('message', this.handler);
  }
}

/** Send GATT connect command over MQTT and wait for the connected response with char list. */
async function mqttGattConnect(
  client: MqttClient,
  t: ReturnType<typeof topics>,
  address: string,
  addrType: number,
): Promise<{ charMap: Map<string, BleChar>; device: MqttBleDevice }> {
  await client.subscribeAsync(t.connected);
  await client.subscribeAsync(t.disconnected);
  await client.subscribeAsync(t.error);

  const response = await withTimeout(
    new Promise<{ chars: Array<{ uuid: string; properties: string[] }> }>((resolve, reject) => {
      const handler = (topic: string, payload: Buffer) => {
        if (topic === t.connected) {
          client.removeListener('message', handler);
          try {
            resolve(JSON.parse(payload.toString()));
          } catch (err) {
            reject(new Error(`Invalid connected payload from ESP32: ${err}`));
          }
        }
        if (topic === t.error) {
          client.removeListener('message', handler);
          reject(new Error(`ESP32 error: ${payload.toString()}`));
        }
      };
      client.on('message', handler);
      client
        .publishAsync(t.connect, JSON.stringify({ address, addr_type: addrType }))
        .catch(reject);
    }),
    COMMAND_TIMEOUT_MS,
    `GATT connect timeout for ${address}`,
  );

  const charMap = new Map<string, BleChar>();
  for (const char of response.chars) {
    charMap.set(char.uuid, new MqttBleChar(client, t.base, char.uuid));
  }

  const device = new MqttBleDevice(client, t.disconnected);
  return { charMap, device };
}

/** Send GATT disconnect command over MQTT. */
async function mqttGattDisconnect(client: MqttClient, t: ReturnType<typeof topics>): Promise<void> {
  await client.publishAsync(t.disconnect, '');
}

// ─── Exports ──────────────────────────────────────────────────────────────────

/**
 * Scan for a BLE scale via ESP32 MQTT proxy and extract a broadcast reading.
 * Returns the raw reading + adapter WITHOUT computing body composition metrics.
 */
export async function scanAndReadRaw(opts: ScanOptions): Promise<RawReading> {
  const { targetMac, adapters } = opts;
  const config = opts.mqttProxy;
  if (!config) throw new Error('mqtt_proxy config is required for mqtt-proxy handler');

  const t = topics(config.topic_prefix, config.device_id);
  const client = await createMqttClient(config);

  try {
    await waitForEsp32Online(client, t);
    bleLog.info('ESP32 proxy is online');

    const scanResults = await mqttScan(client, t);

    // If targetMac is set, filter to just that device
    const candidates = targetMac
      ? scanResults.filter((e) => e.address.toLowerCase() === targetMac.toLowerCase())
      : scanResults;

    // Find a matching adapter
    let weightOnlyFallback: RawReading | null = null;

    for (const entry of candidates) {
      const info = toBleDeviceInfo(entry);
      const adapter = adapters.find((a) => a.matches(info));
      if (!adapter) continue;

      bleLog.info(`Matched: ${adapter.name} (${entry.name || entry.address})`);

      // Extract reading from broadcast advertisement data
      {
        let reading: ScaleReading | null = null;
        if (adapter.parseBroadcast && entry.manufacturer_data) {
          reading = adapter.parseBroadcast(Buffer.from(entry.manufacturer_data, 'hex'));
        }
        if (!reading && adapter.parseServiceData) {
          for (const sd of info.serviceData ?? []) {
            reading = adapter.parseServiceData(sd.uuid, sd.data);
            if (reading) break;
          }
        }
        if (reading && adapter.isComplete(reading)) {
          bleLog.info(`Broadcast reading: ${reading.weight} kg`);
          registerScaleMac(config, entry.address).catch(() => {});
          return { reading, adapter };
        }
        // Save weight-only as a fallback in case no impedance-bearing frame is found.
        if (reading && !weightOnlyFallback) {
          weightOnlyFallback = { reading, adapter };
        }
      }

      // Broadcast-capable or broadcast-only adapters — wait for next scan with data
      if (weightOnlyFallback || adapter.parseBroadcast || adapter.parseServiceData || !adapter.charNotifyUuid) {
        bleLog.debug(`${adapter.name} supports broadcast, waiting for stable reading...`);
        continue;
      }

      // GATT fallback — adapter matched but no broadcast support
      bleLog.info(`No broadcast data for ${adapter.name}; connecting via GATT proxy...`);
      const { charMap, device } = await mqttGattConnect(
        client,
        t,
        entry.address,
        entry.addr_type ?? 0,
      );
      try {
        const raw = await waitForRawReading(
          charMap,
          device,
          adapter,
          opts.profile,
          entry.address.replace(/[:-]/g, '').toUpperCase(),
          opts.weightUnit,
          opts.onLiveData,
        );
        registerScaleMac(config, entry.address).catch(() => {});
        return raw;
      } finally {
        device.cleanup();
        await mqttGattDisconnect(client, t).catch(() => {});
      }
    }

    if (weightOnlyFallback) {
      bleLog.info(`Broadcast reading (weight only, impedance not yet available): ${weightOnlyFallback.reading.weight} kg`);
      registerScaleMac(config, candidates[0]?.address ?? '').catch(() => {});
      return weightOnlyFallback;
    }

    throw new Error(
      targetMac
        ? `Target device ${targetMac} not found in scan results (${scanResults.length} device(s)).`
        : `No recognized scale found via ESP32 proxy. ` +
            `Scanned ${scanResults.length} device(s). ` +
            `Adapters: ${adapters.map((a) => a.name).join(', ')}`,
    );
  } finally {
    try {
      await client.endAsync();
    } catch {
      /* ignore */
    }
  }
}

export async function scanAndRead(opts: ScanOptions): Promise<BodyComposition> {
  const { reading, adapter } = await scanAndReadRaw(opts);
  return adapter.computeMetrics(reading, opts.profile);
}

// ─── ReadingWatcher (always-on message handler with async queue) ─────────────

const DEDUP_WINDOW_MS = 30_000;

/**
 * Persistent event-driven scan watcher for continuous mode.
 * Subscribes once and keeps the message handler attached permanently,
 * queuing matched readings so none are missed during processing or cooldown.
 */
export class ReadingWatcher {
  private queue = new AsyncQueue<RawReading>();
  private started = false;
  private adapters: ScaleAdapter[];
  private targetMac?: string;
  private config: MqttProxyConfig;
  private profile?: UserProfile;
  private dedup = new Map<string, number>();
  private gattInProgress = false;
  private gattStartedAt = 0;
  private graceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private graceReadings = new Map<string, RawReading>();
  private _client: MqttClient | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _lifecycleHandlers: Array<{ event: string; handler: (...args: any[]) => void }> = [];
  private _messageHandler: ((topic: string, payload: Buffer) => void) | null = null;
  private _subscribedTopics: string[] = [];

  constructor(
    config: MqttProxyConfig,
    adapters: ScaleAdapter[],
    targetMac?: string,
    profile?: UserProfile,
  ) {
    this.config = config;
    this.adapters = adapters;
    this.targetMac = targetMac;
    this.profile = profile;
  }

  async start(): Promise<void> {
    if (this.started) return;
    // Mark immediately to guard against concurrent start() calls
    this.started = true;

    const t = topics(this.config.topic_prefix, this.config.device_id);
    let client: Awaited<ReturnType<typeof getOrCreatePersistentClient>>;
    try {
      client = await getOrCreatePersistentClient(this.config);
      this._client = client;

      // Lifecycle logging — store references for cleanup
      const onReconnect = () => bleLog.info('MQTT reconnecting...');
      const onOffline = () => bleLog.warn('MQTT client offline');
      const onError = (err: Error) => bleLog.warn(`MQTT error: ${err.message}`);
      const onConnect = () => bleLog.info('MQTT connected');
      client.on('reconnect', onReconnect);
      client.on('offline', onOffline);
      client.on('error', onError);
      client.on('connect', onConnect);
      this._lifecycleHandlers = [
        { event: 'reconnect', handler: onReconnect },
        { event: 'offline', handler: onOffline },
        { event: 'error', handler: onError },
        { event: 'connect', handler: onConnect },
      ];

      // Subscribe to scan results with QoS 1
      await client.subscribeAsync(t.scanResults, { qos: 1 });
      // Subscribe to status for logging only
      await client.subscribeAsync(t.status);
      this._subscribedTopics = [t.scanResults, t.status];
      bleLog.info('ReadingWatcher started — listening for scan results');
    } catch (err) {
      this.started = false;
      throw err;
    }

    // Message handler — store reference for cleanup
    this._messageHandler = (topic: string, payload: Buffer) => {
      if (topic === t.status) {
        bleLog.info(`ESP32 status: ${payload.toString()}`);
        return;
      }
      if (topic !== t.scanResults) return;

      try {
        const results: ScanResultEntry[] = JSON.parse(payload.toString());
        const candidates = this.targetMac
          ? results.filter((e) => e.address.toLowerCase() === this.targetMac!.toLowerCase())
          : results;

        for (const entry of candidates) {
          const info = toBleDeviceInfo(entry);
          const adapter = this.adapters.find((a) => a.matches(info));
          if (!adapter) continue;

          {
            let reading: ScaleReading | null = null;
            if (adapter.parseBroadcast && entry.manufacturer_data) {
              reading = adapter.parseBroadcast(Buffer.from(entry.manufacturer_data, 'hex'));
            }
            if (!reading && adapter.parseServiceData) {
              for (const sd of info.serviceData ?? []) {
                reading = adapter.parseServiceData(sd.uuid, sd.data);
                if (reading) break;
              }
            }
            if (reading && adapter.isComplete(reading)) {
              // Cancel any pending grace timer — we got the full reading.
              const gt = this.graceTimers.get(entry.address);
              if (gt) { clearTimeout(gt); this.graceTimers.delete(entry.address); this.graceReadings.delete(entry.address); }

              // Dedup check
              const key = `${entry.address}:${reading.weight.toFixed(1)}`;
              const now = Date.now();
              this.pruneDedup(now);
              const lastSeen = this.dedup.get(key);
              if (lastSeen && now - lastSeen < DEDUP_WINDOW_MS) {
                bleLog.debug(`Dedup skip: ${key} (${((now - lastSeen) / 1000).toFixed(1)}s ago)`);
                continue; // Don't block other candidates in this scan batch
              }
              this.dedup.set(key, now);

              bleLog.info(`Matched: ${adapter.name} (${entry.address})`);
              bleLog.info(`Broadcast reading: ${reading.weight} kg`);
              registerScaleMac(this.config, entry.address).catch(() => {});
              this.queue.push({ reading, adapter });
              continue;
            }

            // Partial frame — start grace timer for impedance to arrive.
            if (reading) {
              this.graceReadings.set(entry.address, { reading, adapter });
              if (!this.graceTimers.has(entry.address)) {
                const addr = entry.address;
                this.graceTimers.set(addr, setTimeout(() => {
                  this.graceTimers.delete(addr);
                  const gr = this.graceReadings.get(addr);
                  this.graceReadings.delete(addr);
                  if (!gr) return;
                  bleLog.info(
                    `Matched: ${gr.adapter.name} (${addr}) — weight only, no impedance within ${IMPEDANCE_GRACE_MS / 1000}s`,
                  );
                  bleLog.info(`Broadcast reading: ${gr.reading.weight} kg`);
                  registerScaleMac(this.config, addr).catch(() => {});
                  this.queue.push(gr);
                }, IMPEDANCE_GRACE_MS));
              }
              continue;
            }
          }

          // Broadcast-capable or broadcast-only — skip, wait for stable advertisement
          if (adapter.parseBroadcast || adapter.parseServiceData || !adapter.charNotifyUuid) continue;

          // GATT fallback — adapter matched but no broadcast support
          this.handleGattReading(entry, adapter).catch((err) => {
            bleLog.warn(`GATT reading failed for ${entry.address}: ${errMsg(err)}`);
          });
        }
        // No match this scan — keep listening
      } catch (err) {
        bleLog.warn(`Failed to parse scan results: ${err instanceof Error ? err.message : err}`);
      }
    };
    client.on('message', this._messageHandler);
  }

  /** Stop the watcher — remove listeners and unsubscribe from topics. */
  async stop(): Promise<void> {
    if (!this.started || !this._client) return;

    for (const t of this.graceTimers.values()) clearTimeout(t);
    this.graceTimers.clear();
    this.graceReadings.clear();

    // Remove message handler
    if (this._messageHandler) {
      this._client.removeListener('message', this._messageHandler);
      this._messageHandler = null;
    }

    // Remove lifecycle handlers
    for (const { event, handler } of this._lifecycleHandlers) {
      this._client.removeListener(event as 'connect', handler);
    }
    this._lifecycleHandlers = [];

    // Unsubscribe from topics
    for (const topic of this._subscribedTopics) {
      try {
        await this._client.unsubscribeAsync(topic);
      } catch {
        /* ignore — client may already be disconnected */
      }
    }
    this._subscribedTopics = [];

    this.started = false;
    this._client = null;
    bleLog.info('ReadingWatcher stopped');
  }

  /** Consume the next reading from the queue. Blocks until one arrives. */
  nextReading(signal?: AbortSignal): Promise<RawReading> {
    return this.queue.shift(signal);
  }

  /** Update matching config (e.g. after SIGHUP config reload). */
  updateConfig(adapters: ScaleAdapter[], targetMac?: string, profile?: UserProfile): void {
    this.adapters = adapters;
    this.targetMac = targetMac;
    if (profile) this.profile = profile;
  }

  private static readonly GATT_STALE_MS = 90_000;

  private async handleGattReading(entry: ScanResultEntry, adapter: ScaleAdapter): Promise<void> {
    if (this.gattInProgress) {
      if (Date.now() - this.gattStartedAt > ReadingWatcher.GATT_STALE_MS) {
        bleLog.warn('gattInProgress stuck for >90s — auto-resetting');
        this.gattInProgress = false;
      } else {
        bleLog.debug(`GATT connection already in progress, skipping ${entry.address}`);
        return;
      }
    }
    this.gattInProgress = true;
    this.gattStartedAt = Date.now();

    const t = topics(this.config.topic_prefix, this.config.device_id);
    const client = await getOrCreatePersistentClient(this.config);
    if (!this.profile) {
      bleLog.warn(
        'No user profile configured for GATT reading. Body composition will be inaccurate. ' +
          'Set a user profile in config.yaml to get correct results.',
      );
    }
    const profile: UserProfile = this.profile ?? {
      height: 170,
      age: 30,
      gender: 'male',
      isAthlete: false,
    };

    bleLog.info(`Connecting via GATT proxy to ${adapter.name} (${entry.address})...`);
    const { charMap, device } = await mqttGattConnect(
      client,
      t,
      entry.address,
      entry.addr_type ?? 0,
    );
    try {
      const raw = await withTimeout(
        waitForRawReading(
          charMap,
          device,
          adapter,
          profile,
          entry.address.replace(/[:-]/g, '').toUpperCase(),
        ),
        60_000,
        `GATT reading timeout for ${entry.address}`,
      );
      registerScaleMac(this.config, entry.address).catch(() => {});
      this.queue.push(raw);
    } finally {
      this.gattInProgress = false;
      device.cleanup();
      await mqttGattDisconnect(client, t).catch(() => {});
    }
  }

  private pruneDedup(now: number): void {
    for (const [key, ts] of this.dedup) {
      if (now - ts >= DEDUP_WINDOW_MS) this.dedup.delete(key);
    }
  }
}

export function setDisplayUsers(users: DisplayUser[]): void {
  proxyState.displayUsers = users;
}

export async function publishConfig(
  config: MqttProxyConfig,
  scales: string[],
  users?: DisplayUser[],
): Promise<void> {
  const t = topics(config.topic_prefix, config.device_id);
  const { client, ephemeral } = await getClient(config);
  try {
    const payload: Record<string, unknown> = { scales };
    if (users && users.length > 0) {
      payload.users = users;
    }
    await client.publishAsync(t.config, JSON.stringify(payload), { retain: true });
  } finally {
    await releaseClient(client, ephemeral);
  }
}

/**
 * Register a discovered scale MAC and publish the updated set to the ESP32.
 * Called after a successful adapter match so the ESP32 can beep on future scans.
 */
export async function registerScaleMac(config: MqttProxyConfig, mac: string): Promise<void> {
  const upper = mac.toUpperCase();
  if (proxyState.discoveredScaleMacs.has(upper)) return; // already known
  proxyState.discoveredScaleMacs.add(upper);
  bleLog.info(
    `Registered scale MAC ${upper} for ESP32 beep (${proxyState.discoveredScaleMacs.size} total)`,
  );
  await publishConfig(config, [...proxyState.discoveredScaleMacs], proxyState.displayUsers);
}

export async function publishBeep(
  config: MqttProxyConfig,
  freq?: number,
  duration?: number,
  repeat?: number,
): Promise<void> {
  const t = topics(config.topic_prefix, config.device_id);
  const { client, ephemeral } = await getClient(config);
  try {
    const payload =
      freq != null || duration != null || repeat != null
        ? JSON.stringify({
            ...(freq != null ? { freq } : {}),
            ...(duration != null ? { duration } : {}),
            ...(repeat != null ? { repeat } : {}),
          })
        : '';
    await client.publishAsync(t.beep, payload);
  } finally {
    await releaseClient(client, ephemeral);
  }
}

// ─── Display feedback publishes ──────────────────────────────────────────────

export async function publishDisplayReading(
  config: MqttProxyConfig,
  slug: string,
  name: string,
  weight: number,
  impedance: number | undefined,
  exporterNames: string[],
): Promise<void> {
  const t = topics(config.topic_prefix, config.device_id);
  const { client, ephemeral } = await getClient(config);
  try {
    const payload: Record<string, unknown> = { slug, name, weight, exporters: exporterNames };
    if (impedance != null) payload.impedance = impedance;
    await client.publishAsync(`${t.base}/display/reading`, JSON.stringify(payload));
  } finally {
    await releaseClient(client, ephemeral);
  }
}

export async function publishDisplayResult(
  config: MqttProxyConfig,
  slug: string,
  name: string,
  weight: number,
  exports: Array<{ name: string; ok: boolean }>,
): Promise<void> {
  const t = topics(config.topic_prefix, config.device_id);
  const { client, ephemeral } = await getClient(config);
  try {
    const payload = { slug, name, weight, exports };
    await client.publishAsync(`${t.base}/display/result`, JSON.stringify(payload));
  } finally {
    await releaseClient(client, ephemeral);
  }
}

export async function scanDevices(
  adapters: ScaleAdapter[],
  _durationMs?: number,
  config?: MqttProxyConfig,
): Promise<ScanResult[]> {
  if (!config) throw new Error('mqtt_proxy config is required for mqtt-proxy handler');

  const t = topics(config.topic_prefix, config.device_id);
  const client = await createMqttClient(config);

  try {
    await waitForEsp32Online(client, t);
    const scanResults = await mqttScan(client, t);

    return scanResults.map((entry) => {
      const info = toBleDeviceInfo(entry);
      const matched = adapters.find((a) => a.matches(info));
      return {
        address: entry.address,
        name: entry.name,
        matchedAdapter: matched?.name,
      };
    });
  } finally {
    try {
      await client.endAsync();
    } catch {
      /* ignore */
    }
  }
}
