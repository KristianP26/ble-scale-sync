import type { ScaleAdapter, ScaleReading, UserProfile } from '../../interfaces/scale-adapter.js';
import type { MqttProxyConfig } from '../../config/schema.js';
import type { RawReading } from '../shared.js';
import { waitForRawReading, hasParseableBroadcastSource } from '../shared.js';
import { bleLog, withTimeout, errMsg, IMPEDANCE_GRACE_MS } from '../types.js';
import { AsyncQueue } from '../async-queue.js';
import { topics } from './topics.js';
import { type MqttClient, getOrCreatePersistentClient } from './client.js';
import {
  mqttGattConnect,
  mqttGattDisconnect,
  buildCharMapFromPayload,
  type MqttBleDevice,
} from './gatt.js';
import { registerScaleMac } from './display.js';
import { type ScanResultEntry, toBleDeviceInfo } from './scan.js';

const DEDUP_WINDOW_MS = 30_000;

type LifecycleHandler =
  | { event: 'reconnect'; handler: () => void }
  | { event: 'offline'; handler: () => void }
  | { event: 'connect'; handler: () => void }
  | { event: 'error'; handler: (err: Error) => void };

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
  private _lifecycleHandlers: LifecycleHandler[] = [];
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

      // Lifecycle logging: store references for cleanup
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
      // Subscribe to connected for autonomous ESP32 connects (#201)
      await client.subscribeAsync(t.connected);
      await client.subscribeAsync(t.disconnected);
      this._subscribedTopics = [t.scanResults, t.status, t.connected, t.disconnected];
      bleLog.info('ReadingWatcher started, listening for scan results');
    } catch (err) {
      this.started = false;
      throw err;
    }

    // Message handler: store reference for cleanup
    this._messageHandler = (topic: string, payload: Buffer) => {
      if (topic === t.status) {
        bleLog.info(`ESP32 status: ${payload.toString()}`);
        return;
      }

      // Handle autonomous GATT connect from ESP32 (#201).
      // The ESP32 publishes the same `connected` payload with an extra
      // `autonomous: true` flag when it auto-connects to a known scale MAC.
      if (topic === t.connected) {
        try {
          const data = JSON.parse(payload.toString());
          if (data.autonomous && data.address) {
            bleLog.info(
              `Received autonomous connect from ESP32 for ${data.address} (${data.chars?.length ?? 0} chars)`,
            );
            this.handleAutonomousConnect(data).catch((err) => {
              bleLog.warn(`Autonomous GATT reading failed for ${data.address}: ${errMsg(err)}`);
            });
          }
        } catch {
          // Not JSON or missing fields — ignore (could be a host-initiated connect response)
        }
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
            const requiresStable = adapter.preferPassive === true;
            if (reading && (!requiresStable || adapter.isComplete(reading))) {
              // Cancel any pending grace timer. We got the full reading.
              const gt = this.graceTimers.get(entry.address);
              if (gt) {
                clearTimeout(gt);
                this.graceTimers.delete(entry.address);
                this.graceReadings.delete(entry.address);
              }

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

            // Partial frame for a passive adapter: start grace timer for impedance.
            if (reading && requiresStable) {
              this.graceReadings.set(entry.address, { reading, adapter });
              if (!this.graceTimers.has(entry.address)) {
                const addr = entry.address;
                this.graceTimers.set(
                  addr,
                  setTimeout(() => {
                    this.graceTimers.delete(addr);
                    const gr = this.graceReadings.get(addr);
                    this.graceReadings.delete(addr);
                    if (!gr) return;
                    bleLog.info(
                      `Matched: ${gr.adapter.name} (${addr}), weight only, no impedance within ${IMPEDANCE_GRACE_MS / 1000}s`,
                    );
                    bleLog.info(`Broadcast reading: ${gr.reading.weight} kg`);
                    registerScaleMac(this.config, addr).catch(() => {});
                    this.queue.push(gr);
                  }, IMPEDANCE_GRACE_MS),
                );
              }
              continue;
            }
          }

          // Device still carries broadcast data this adapter parses — a usable
          // reading just hasn't arrived yet. Keep waiting for a stable frame.
          if (hasParseableBroadcastSource(adapter, info)) continue;

          // No broadcast source for this device. GATT-connect if the adapter
          // has a GATT path (#201: dual-mode adapters like QN Scale must reach
          // this even though they declare parseBroadcast).
          if (!adapter.charNotifyUuid) continue;

          this.handleGattReading(entry, adapter).catch((err) => {
            bleLog.warn(`GATT reading failed for ${entry.address}: ${errMsg(err)}`);
          });
        }
        // No match this scan, keep listening
      } catch (err) {
        bleLog.warn(`Failed to parse scan results: ${err instanceof Error ? err.message : err}`);
      }
    };
    client.on('message', this._messageHandler);
  }

  /** Stop the watcher: remove listeners and unsubscribe from topics. */
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

    // Remove lifecycle handlers. mqtt's EventEmitter overload list does not
    // accept the discriminated union as a single call shape, so dispatch by
    // event tag to keep types tight without `any`.
    for (const entry of this._lifecycleHandlers) {
      switch (entry.event) {
        case 'reconnect':
        case 'offline':
        case 'connect':
          this._client.removeListener(entry.event, entry.handler);
          break;
        case 'error':
          this._client.removeListener('error', entry.handler);
          break;
      }
    }
    this._lifecycleHandlers = [];

    // Unsubscribe from topics
    for (const topic of this._subscribedTopics) {
      try {
        await this._client.unsubscribeAsync(topic);
      } catch {
        /* ignore: client may already be disconnected */
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
        bleLog.warn('gattInProgress stuck for >90s, auto-resetting');
        this.gattInProgress = false;
      } else {
        bleLog.debug(`GATT connection already in progress, skipping ${entry.address}`);
        return;
      }
    }
    this.gattInProgress = true;
    this.gattStartedAt = Date.now();

    const t = topics(this.config.topic_prefix, this.config.device_id);
    let client: MqttClient | undefined;
    let device: MqttBleDevice | undefined;
    // Guard the whole connect+read sequence: if mqttGattConnect (or the client
    // lookup) throws, the finally must still clear gattInProgress — otherwise a
    // single failed connect blocks every later GATT retry until the 90s
    // stale-reset (#201).
    try {
      client = await getOrCreatePersistentClient(this.config);
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
      const connected = await mqttGattConnect(client, t, entry.address, entry.addr_type ?? 0);
      device = connected.device;
      const raw = await withTimeout(
        waitForRawReading(
          connected.charMap,
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
      device?.cleanup();
      if (client) await mqttGattDisconnect(client, t).catch(() => {});
    }
  }

  /**
   * Handle an autonomous GATT connect from the ESP32 (#201).
   *
   * The ESP32 already connected and discovered services. We just need to set up
   * the MQTT char abstractions and run the adapter's reading protocol — no
   * mqttGattConnect() needed, saving the entire MQTT round-trip.
   */
  private async handleAutonomousConnect(data: {
    address: string;
    chars: Array<{ uuid: string; properties: string[] }>;
  }): Promise<void> {
    if (this.gattInProgress) {
      if (Date.now() - this.gattStartedAt > ReadingWatcher.GATT_STALE_MS) {
        bleLog.warn('gattInProgress stuck for >90s, auto-resetting');
        this.gattInProgress = false;
      } else {
        bleLog.debug(`GATT connection already in progress, skipping autonomous ${data.address}`);
        return;
      }
    }
    this.gattInProgress = true;
    this.gattStartedAt = Date.now();

    const t = topics(this.config.topic_prefix, this.config.device_id);
    let client: MqttClient | undefined;
    let device: MqttBleDevice | undefined;
    try {
      client = await getOrCreatePersistentClient(this.config);

      // Match the address to an adapter
      const info = toBleDeviceInfo({ address: data.address, name: '', rssi: 0, services: [] });
      // For autonomous connect, we match by scanning the chars for known notify UUIDs
      const adapter = this.adapters.find((a) => {
        // Try matching by device info first
        if (a.matches(info)) return true;
        // Also match by charNotifyUuid: the ESP32 already connected, so the
        // adapter may match only by its GATT characteristic.
        if (a.charNotifyUuid) {
          return data.chars.some((c) => c.uuid === a.charNotifyUuid);
        }
        return false;
      });

      if (!adapter) {
        bleLog.warn(
          `Autonomous connect from ${data.address}: no adapter matched ` +
            `(${data.chars.length} chars: ${data.chars.map((c) => c.uuid).join(', ')}), disconnecting`,
        );
        await mqttGattDisconnect(client, t).catch(() => {});
        return;
      }

      if (!this.profile) {
        bleLog.warn(
          'No user profile configured for GATT reading. Body composition will be inaccurate.',
        );
      }
      const profile: UserProfile = this.profile ?? {
        height: 170,
        age: 30,
        gender: 'male',
        isAthlete: false,
      };

      bleLog.info(`Autonomous GATT connect from ESP32: ${adapter.name} (${data.address})`);
      const { charMap, device: dev } = buildCharMapFromPayload(client, t, data.chars);
      device = dev;
      bleLog.debug(
        `Autonomous connect: charMap built with ${charMap.size} chars, waiting for reading...`,
      );

      const raw = await withTimeout(
        waitForRawReading(
          charMap,
          device,
          adapter,
          profile,
          data.address.replace(/[:-]/g, '').toUpperCase(),
        ),
        60_000,
        `GATT reading timeout for ${data.address} (autonomous)`,
      );
      registerScaleMac(this.config, data.address).catch(() => {});
      bleLog.info(
        `Autonomous GATT reading complete: ${raw.reading.weight} kg from ${data.address}`,
      );
      this.queue.push(raw);
    } finally {
      this.gattInProgress = false;
      device?.cleanup();
      if (client) await mqttGattDisconnect(client, t).catch(() => {});
    }
  }

  private pruneDedup(now: number): void {
    for (const [key, ts] of this.dedup) {
      if (now - ts >= DEDUP_WINDOW_MS) this.dedup.delete(key);
    }
  }
}
