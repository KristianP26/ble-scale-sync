import type { ScaleAdapter, ScaleReading } from '../../interfaces/scale-adapter.js';
import type { EsphomeProxyConfig } from '../../config/schema.js';
import type { RawReading } from '../shared.js';
import { bleLog, errMsg, IMPEDANCE_GRACE_MS } from '../types.js';
import { AsyncQueue } from '../async-queue.js';
import {
  createEsphomeClient,
  waitForConnected,
  safeDisconnect,
  type EsphomeClient,
  type EsphomeBleAdvertisement,
} from './client.js';
import { toBleDeviceInfo, formatMacAddress } from './advert.js';
import { logTransportCapabilities } from './scan.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const DEDUP_WINDOW_MS = 30_000;
// Cap for the "already warned about this GATT scale" tracker used in continuous
// mode. Old entries are evicted LRU-style so dedup persists long-term instead of
// flapping every 256 warnings.
const GATT_WARN_LRU_MAX = 256;

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
      logTransportCapabilities(this.adapters);

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

    // Same passive-vs-immediate split as scanAndReadRaw. See comment there.
    const requiresStable = adapter.preferPassive === true;
    if (reading && (!requiresStable || adapter.isComplete(reading))) {
      // Cancel any pending grace timer for this address. We got the full reading.
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

    // Partial broadcast frame for a passive adapter: start grace timer so
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
              `Matched: ${gr.adapter.name} (${address}), weight only, no impedance within ${IMPEDANCE_GRACE_MS / 1000}s`,
            );
            bleLog.info(`Broadcast reading: ${gr.reading.weight} kg`);
            this.queue.push(gr);
          }, IMPEDANCE_GRACE_MS),
        );
      }
      return;
    }

    // Adapter matched but broadcast path yielded nothing usable (reading is null).
    // If the adapter has a GATT path, Phase 1 cannot service it. Warn once per
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
