import type { BleDeviceInfo, ScaleAdapter, UserProfile } from '../../interfaces/scale-adapter.js';
import type { MqttProxyConfig } from '../../config/schema.js';
import type { RawReading } from '../shared.js';
import { waitForRawReading } from '../shared.js';
import { resolveAdapter } from '../../scales/resolve.js';
import { evaluateAdvertisement, GraceTimers, DedupWindow, logAdvert } from '../advertisement.js';
import type { Watcher, WatcherConfig } from '../reading-source.js';
import { bleLog, withIdleTimeout, errMsg, IMPEDANCE_GRACE_MS } from '../types.js';
import { AsyncQueue } from '../async-queue.js';
import { topics } from './topics.js';
import {
  type MqttClient,
  getOrCreatePersistentClient,
  addDiscoveredMac,
  getDiscoveredMacs,
  getDisplayUsers,
} from './client.js';
import {
  mqttGattConnect,
  mqttGattDisconnect,
  buildCharMapFromPayload,
  type MqttBleDevice,
} from './gatt.js';
import { registerScaleMac, publishConfig } from './display.js';
import { type ScanResultEntry, toBleDeviceInfo } from './scan.js';

const DEDUP_WINDOW_MS = 30_000;
/** Seconds of scale silence that end a GATT reading session. */
const GATT_READING_IDLE_MS = 60_000;

/** Bluetooth Base UUID for expanding 16-bit UUIDs to 128-bit form. */
const BT_BASE_UUID = '00000000-0000-1000-8000-00805f9b34fb';

/**
 * Normalize a BLE UUID to lowercase 128-bit form for reliable comparison.
 * Handles 16-bit ("fff4"), 32-bit, and full 128-bit UUIDs with or without dashes.
 */
function normalizeUuid(uuid: string): string {
  const lower = uuid.toLowerCase().replace(/-/g, '');
  if (lower.length === 4) {
    // 16-bit → expand into base UUID
    return BT_BASE_UUID.replace('00000000', `0000${lower}`);
  }
  if (lower.length === 8) {
    // 32-bit → expand into base UUID
    return BT_BASE_UUID.replace('00000000', lower);
  }
  // Already 128-bit (32 hex chars) — insert dashes if missing
  if (lower.length === 32) {
    return `${lower.slice(0, 8)}-${lower.slice(8, 12)}-${lower.slice(12, 16)}-${lower.slice(16, 20)}-${lower.slice(20)}`;
  }
  // Already formatted 128-bit
  return lower;
}

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
export class ReadingWatcher implements Watcher {
  private queue = new AsyncQueue<RawReading>();
  private started = false;
  private adapters: ScaleAdapter[];
  private targetMac?: string;
  private config: MqttProxyConfig;
  private profile?: UserProfile;
  private gattInProgress = false;
  /** Monotonic id of the newest GATT session, so a superseded one cannot tear down its successor (#296). */
  private gattSessionSeq = 0;
  private currentDevice: MqttBleDevice | null = null;
  private gattStartedAt = 0;
  private readonly dedup = new DedupWindow(DEDUP_WINDOW_MS);
  /**
   * Last scan result seen per address, keyed lowercase.
   *
   * The ESP32's `connected` payload carries only the address and the discovered
   * characteristics, so an autonomous connect used to resolve against a device
   * with no name and no services at all. Adapters that identify by name then
   * cannot match, and selection fell through to a priority-ordered notify-char
   * scan: a Renpho ES-26BB (2a10 notify, no 2a12) was handed to the R-MSC04
   * adapter purely because it has the higher priority and claims the same
   * notify characteristic (#317). The scan results that precede the connect
   * carry the name; keeping the last one makes the autonomous path resolve on
   * the same information as every other transport.
   */
  private readonly lastScanEntry = new Map<string, ScanResultEntry>();
  /** Weight-only fallback timer per address; on elapse the held reading is queued. */
  private readonly grace = new GraceTimers(IMPEDANCE_GRACE_MS, (address, gr) => {
    bleLog.info(
      `Matched: ${gr.adapter.name} (${address}), weight only, no impedance within ${IMPEDANCE_GRACE_MS / 1000}s`,
    );
    bleLog.info(`Broadcast reading: ${gr.reading.weight} kg`);
    registerScaleMac(this.config, address).catch(() => {});
    this.queue.push(gr);
  });
  private _client: MqttClient | null = null;
  private _lifecycleHandlers: LifecycleHandler[] = [];
  private _messageHandler: ((topic: string, payload: Buffer) => void) | null = null;
  private _subscribedTopics: string[] = [];
  /** Per-MAC count of consecutive scan deferrals with no autonomous connect (#231). */
  private deferCounts = new Map<string, number>();

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
      // Subscribe to disconnected so MqttBleDevice instances (which only add a
      // message listener, not a broker subscription) receive disconnect events
      // during autonomous connects. Not handled by _messageHandler itself.
      await client.subscribeAsync(t.disconnected);
      this._subscribedTopics = [t.scanResults, t.status, t.connected, t.disconnected];
      bleLog.info('ReadingWatcher started, listening for scan results');

      // Seed the ESP32 known-scale set with the statically configured target MAC
      // so autonomous GATT connect can bootstrap a GATT-only scale that never
      // emits a broadcast reading (#231). Without this, the ESP32 _scale_macs
      // gate stays empty and the autonomous-connect path never fires, which
      // deadlocks the watcher (it defers forever, waiting for a connect that
      // can never come).
      if (this.targetMac) {
        addDiscoveredMac(this.targetMac);
        await publishConfig(this.config, getDiscoveredMacs(), getDisplayUsers()).catch((err) =>
          bleLog.warn(`Failed to seed ESP32 scale config for ${this.targetMac}: ${errMsg(err)}`),
        );
      }
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
        bleLog.debug(`Connected payload received (${payload.length} bytes)`);
        try {
          const data = JSON.parse(payload.toString());
          if (!data.autonomous || !data.address) {
            bleLog.debug(
              'Connected payload is not an autonomous connect, ignoring (host-initiated response)',
            );
          }
          if (data.autonomous && data.address) {
            // The ESP32 fired its autonomous connect, so stop counting
            // deferrals for this MAC. This keeps the host fallback from racing
            // a working autonomous path (#231).
            this.deferCounts.delete(data.address);
            bleLog.info(
              `Received autonomous connect from ESP32 for ${data.address} (${data.chars?.length ?? 0} chars)`,
            );
            this.handleAutonomousConnect(data).catch((err) => {
              bleLog.warn(`Autonomous GATT reading failed for ${data.address}: ${errMsg(err)}`);
            });
          }
        } catch {
          bleLog.debug('Connected payload was not JSON, ignoring');
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
          this.rememberScanEntry(entry);
          const info = toBleDeviceInfo(entry);
          logAdvert(entry.address, info);
          const adapter = resolveAdapter(info, this.adapters);
          if (!adapter) continue;

          const decision = evaluateAdvertisement(adapter, info);

          if (decision.kind === 'complete') {
            // Got the full reading; cancel any pending grace timer for this addr.
            this.grace.cancel(entry.address);

            if (!this.dedup.shouldEmit(entry.address, decision.reading.weight)) {
              bleLog.debug(`Dedup skip: ${entry.address}:${decision.reading.weight.toFixed(1)}`);
              continue; // Don't block other candidates in this scan batch
            }

            bleLog.info(`Matched: ${adapter.name} (${entry.address})`);
            bleLog.info(`Broadcast reading: ${decision.reading.weight} kg`);
            registerScaleMac(this.config, entry.address).catch(() => {});
            this.queue.push({ reading: decision.reading, adapter });
            continue;
          }

          // Partial frame for a passive adapter: hold for an impedance frame.
          if (decision.kind === 'partial') {
            this.grace.hold(entry.address, { reading: decision.reading, adapter });
            continue;
          }

          // Device still carries broadcast data this adapter parses — a usable
          // reading just hasn't arrived yet. Keep waiting for a stable frame.
          if (decision.kind === 'wait') continue;

          // No broadcast source for this device. GATT-connect if the adapter
          // has a GATT path (#201: dual-mode adapters like QN Scale must reach
          // this even though they declare parseBroadcast).
          if (decision.kind === 'none') continue; // no charNotifyUuid

          // When auto_connect is enabled (default), the ESP32 connects
          // autonomously and publishes a `connected` payload handled by
          // handleAutonomousConnect(). Defer the host-initiated GATT path so
          // both sides do not try to connect simultaneously and time out
          // (#201), but fall back to it after a few deferrals so a never-firing
          // autonomous path cannot deadlock the scale (#231).
          if (this.config.auto_connect !== false) {
            // The ESP32 connects autonomously when it sees a known scale MAC.
            // But if it never fires (its known-scale set was never seeded, or
            // the autonomous connect keeps failing), deferring forever
            // deadlocks a GATT-only scale (#231). After a few deferrals with no
            // autonomous `connected` event, fall back to host-initiated GATT.
            const deferred = (this.deferCounts.get(entry.address) ?? 0) + 1;
            this.deferCounts.set(entry.address, deferred);
            if (deferred < ReadingWatcher.AUTO_CONNECT_FALLBACK_DEFERS) {
              bleLog.debug(
                `Skipping host-initiated GATT for ${entry.address}: auto_connect enabled, ` +
                  `waiting for autonomous connect (defer ${deferred}/${ReadingWatcher.AUTO_CONNECT_FALLBACK_DEFERS})`,
              );
              continue;
            }
            bleLog.warn(
              `No autonomous connect from ESP32 for ${entry.address} after ${deferred} scans; ` +
                `falling back to host-initiated GATT (#231)`,
            );
            // fall through to the host-initiated GATT path below
          }

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

    this.grace.clear();

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

  /** Update matching config (e.g. after SIGHUP config reload). scaleAuth is
   *  ignored: the mqtt-proxy GATT path does not thread per-user auth. */
  updateConfig(config: WatcherConfig): void {
    this.adapters = config.adapters;
    this.targetMac = config.targetMac;
    if (config.profile) this.profile = config.profile;
  }

  private static readonly GATT_STALE_MS = 90_000;

  /** Upper bound on remembered advertisements (see rememberScanEntry). */
  private static readonly SCAN_CACHE_MAX = 64;

  /**
   * Number of consecutive auto_connect deferrals for one MAC before the watcher
   * falls back to a host-initiated GATT connect (#231). Generous enough that a
   * seeded ESP32 (config seed on start) autonomously connects first; only a
   * never-firing autonomous path (auto-discovery / no scale_mac) reaches it.
   */
  private static readonly AUTO_CONNECT_FALLBACK_DEFERS = 3;

  /**
   * Remember the newest advertisement for an address, evicting the oldest entry
   * past the cap. A busy room can put hundreds of devices through this handler
   * every few seconds and the watcher runs for weeks at a time.
   */
  private rememberScanEntry(entry: ScanResultEntry): void {
    const key = entry.address.toLowerCase();
    this.lastScanEntry.delete(key);
    this.lastScanEntry.set(key, entry);
    while (this.lastScanEntry.size > ReadingWatcher.SCAN_CACHE_MAX) {
      const oldest = this.lastScanEntry.keys().next().value;
      if (oldest === undefined) break;
      this.lastScanEntry.delete(oldest);
    }
  }

  /**
   * Pick the adapter that drives the read once the characteristics are known.
   * Falls back to the pre-discovery choice when nothing matches.
   *
   * Not a guaranteed improvement: `matchesDescriptor` is a pure OR of positive
   * claims, so adding characteristics can only make MORE adapters match, and the
   * highest-priority one of them wins. That is the same trade the node-ble and
   * esphome paths already make, and it is what lets a structural matcher correct
   * an advertisement-time guess.
   */
  private reresolveAfterDiscovery(
    info: BleDeviceInfo,
    fallback: ScaleAdapter,
    address: string,
  ): ScaleAdapter {
    const resolved = resolveAdapter(info, this.adapters) ?? fallback;
    if (resolved.name !== fallback.name) {
      bleLog.info(
        `Re-resolved adapter after GATT discovery: ${fallback.name} -> ${resolved.name} (${address})`,
      );
    }
    return resolved;
  }

  private async handleGattReading(entry: ScanResultEntry, adapter: ScaleAdapter): Promise<void> {
    if (this.gattInProgress) {
      if (Date.now() - this.gattStartedAt > ReadingWatcher.GATT_STALE_MS) {
        bleLog.warn('gattInProgress stuck for >90s, auto-resetting');
        this.gattInProgress = false;
      } else {
        bleLog.info(`GATT connection already in progress, skipping ${entry.address}`);
        return;
      }
    }
    this.gattInProgress = true;
    this.gattStartedAt = Date.now();
    const seq = ++this.gattSessionSeq;

    const t = topics(this.config.topic_prefix, this.config.device_id);
    let client: MqttClient | undefined;
    let device: MqttBleDevice | undefined;
    // Hoisted so the caller's failure log can name the adapter that actually
    // drove the read, which is the fact #317/#319 were both missing.
    let gattAdapter: ScaleAdapter = adapter;
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
      this.currentDevice = device;
      // Re-resolve char-aware now that GATT discovery is complete (#319). The
      // advertisement-time match sees a bare vendor service and can land on an
      // adapter wanting characteristics the device does not expose: a Eufy A1
      // (fff1 + fff4, no fff2) was driven by Inlife or QN and died on the
      // missing write char. Every other transport already does this (#177
      // node-ble, #251 esphome, #258 this handler's autonomous path); the
      // host-initiated path was the one that was missed.
      //
      // The scan entry is spread in first: dropping name and services here
      // would strip every name-matched adapter of its match and collapse
      // resolution onto structural matchers only.
      gattAdapter = this.reresolveAfterDiscovery(
        { ...toBleDeviceInfo(entry), characteristicUuids: [...connected.charMap.keys()] },
        adapter,
        entry.address,
      );
      bleLog.debug(`GATT read driven by adapter: ${gattAdapter.name} (${entry.address})`);
      const raw = await withIdleTimeout(
        (onActivity) =>
          waitForRawReading(
            connected.charMap,
            connected.device,
            gattAdapter,
            profile,
            entry.address.replace(/[:-]/g, '').toUpperCase(),
            undefined,
            undefined,
            undefined,
            onActivity,
          ),
        GATT_READING_IDLE_MS,
        `GATT reading timeout for ${entry.address}`,
      );
      registerScaleMac(this.config, entry.address).catch(() => {});
      this.queue.push(raw);
      this.deferCounts.delete(entry.address);
    } finally {
      // End the reading session before dropping the disconnect relay: after a
      // timeout the abandoned waitForRawReading still holds its notification
      // listeners on the persistent MQTT client, and only its own disconnect
      // path removes them. Without this, every timed-out session leaked one
      // notify listener, and each leaked listener re-processed every later
      // notification frame (duplicate handshake writes, eventually a write
      // storm that killed live sessions). Harmless after a completed reading:
      // the disconnect callback returns immediately once resolved.
      device?.fireDisconnect();
      device?.cleanup();
      // A superseded session must not tear down the one that replaced it (#296).
      if (seq === this.gattSessionSeq) {
        this.gattInProgress = false;
        this.currentDevice = null;
        if (client) await mqttGattDisconnect(client, t).catch(() => {});
      }
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
      // Never skip an autonomous connect. The ESP32 holds exactly one BLE
      // connection and disconnects before every auto-connect, so a newer
      // autonomous event means the older session is already dead on the proxy;
      // dropping it left the reporter with nothing happening for up to 90s
      // while the stale-reset ran down (#296).
      bleLog.warn(
        `Newer autonomous connect for ${data.address} supersedes the in-flight GATT session`,
      );
      this.currentDevice?.fireDisconnect();
    }
    this.gattInProgress = true;
    this.gattStartedAt = Date.now();
    const seq = ++this.gattSessionSeq;

    const t = topics(this.config.topic_prefix, this.config.device_id);
    let client: MqttClient | undefined;
    let device: MqttBleDevice | undefined;
    try {
      client = await getOrCreatePersistentClient(this.config);

      // Match the address to an adapter. The ESP32 already discovered the GATT
      // characteristics, so populate them and resolve char-aware FIRST, exactly
      // like the node-ble post-discovery re-resolution (#177). This lets a
      // structural matcher win over a generic-notify-char collision: e.g. a
      // QN-family Elis 1 exposes ae01/ae02 (a positive QN signature) plus the
      // generic fff1/fff2 pair; without the structural pass the higher-priority
      // Eufy P2 adapter stole it via its fff2 notify char and then failed on the
      // missing fff4 (#258).
      const cached = this.lastScanEntry.get(data.address.toLowerCase());
      const info = toBleDeviceInfo(
        cached ?? { address: data.address, name: '', rssi: 0, services: [] },
      );
      info.characteristicUuids = data.chars.map((c) => c.uuid.toLowerCase());
      logAdvert(data.address, info);
      if (cached?.name) {
        bleLog.debug(`Autonomous connect: using cached advertisement name "${cached.name}"`);
      }
      let adapter = resolveAdapter(info, this.adapters);
      if (!adapter) {
        // No structural match: fall back to a priority-ordered notify-char scan
        // so name/notify-only adapters still resolve when nothing matches by
        // descriptor. A stable sort keeps input order for ties.
        adapter = [...this.adapters]
          .sort((a, b) => (b.match?.priority ?? 0) - (a.match?.priority ?? 0))
          .find((a) => {
            if (a.charNotifyUuid) {
              // Normalize both sides (case + 16-bit vs 128-bit) to avoid silent mismatches.
              const normalized = normalizeUuid(a.charNotifyUuid);
              return data.chars.some((c) => normalizeUuid(c.uuid) === normalized);
            }
            return false;
          });
      }

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
      this.currentDevice = device;
      bleLog.debug(
        `Autonomous connect: charMap built with ${charMap.size} chars, waiting for reading...`,
      );

      const raw = await withIdleTimeout(
        (onActivity) =>
          waitForRawReading(
            charMap,
            dev,
            adapter,
            profile,
            data.address.replace(/[:-]/g, '').toUpperCase(),
            undefined,
            undefined,
            undefined,
            onActivity,
          ),
        GATT_READING_IDLE_MS,
        `GATT reading timeout for ${data.address} (autonomous)`,
      );
      registerScaleMac(this.config, data.address).catch(() => {});
      bleLog.info(
        `Autonomous GATT reading complete: ${raw.reading.weight} kg from ${data.address}`,
      );
      this.queue.push(raw);
    } finally {
      // Same teardown as the host-initiated path: end the session so a timed-out
      // reading releases its notification listeners.
      device?.fireDisconnect();
      device?.cleanup();
      if (seq === this.gattSessionSeq) {
        this.gattInProgress = false;
        this.currentDevice = null;
        if (client) await mqttGattDisconnect(client, t).catch(() => {});
      }
    }
  }
}
