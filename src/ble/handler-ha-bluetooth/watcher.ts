import type { ScaleAdapter, BleDeviceInfo, UserProfile } from '../../interfaces/scale-adapter.js';
import type { HaBluetoothConfig } from '../../config/schema.js';
import type { RawReading } from '../shared.js';
import { resolveAdapter } from '../../scales/resolve.js';
import { evaluateAdvertisement, GraceTimers, DedupWindow, logAdvert } from '../advertisement.js';
import type { Watcher, WatcherConfig } from '../reading-source.js';
import { bleLog, IMPEDANCE_GRACE_MS } from '../types.js';
import { AsyncQueue } from '../async-queue.js';
import { HaBluetoothClient } from './client.js';
import { logTransportCapabilities } from './scan.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const DEDUP_WINDOW_MS = 30_000;
/** Cap for the once-per-scale "needs GATT" warning tracker. */
const GATT_WARN_MAX = 256;

// ─── ReadingWatcher (continuous mode) ────────────────────────────────────────

/**
 * Persistent event-driven watcher for continuous mode over Home Assistant's
 * Bluetooth advertisement stream. Broadcast scales parse from advertisements;
 * there is no GATT path, so scales that need one are warned about once.
 *
 * Home Assistant already merges the advertisement and its scan response into
 * one device record, so unlike the ESPHome proxy no name caching is needed.
 */
export class ReadingWatcher implements Watcher {
  private queue = new AsyncQueue<RawReading>();
  private started = false;
  private adapters: ScaleAdapter[];
  private targetMac?: string;
  private profile?: UserProfile;
  private config: HaBluetoothConfig;
  private readonly dedup = new DedupWindow(DEDUP_WINDOW_MS);
  private client: HaBluetoothClient | null = null;
  private unsub: (() => void) | null = null;
  /** Set at start and on every advertisement; the proxy liveness signal (#281). */
  private lastAdvertAt: number | null = null;
  private readonly gattWarned = new Set<string>();

  /** Weight-only fallback timer per address; on elapse the held reading is
   *  queued directly (no dedup, matching the other proxy watchers). */
  private readonly grace = new GraceTimers(IMPEDANCE_GRACE_MS, (address, gr) => {
    bleLog.info(
      `Matched: ${gr.adapter.name} (${address}), weight only, no impedance within ${IMPEDANCE_GRACE_MS / 1000}s`,
    );
    bleLog.info(`Broadcast reading: ${gr.reading.weight} kg`);
    this.queue.push(gr);
  });

  constructor(
    config: HaBluetoothConfig,
    adapters: ScaleAdapter[],
    targetMac?: string,
    profile?: UserProfile,
  ) {
    this.config = config;
    this.adapters = adapters;
    this.targetMac = targetMac?.toLowerCase();
    this.profile = profile;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    try {
      this.client = new HaBluetoothClient(this.config);
      await this.client.start();
      logTransportCapabilities(this.adapters);
      // Stamped here rather than inside handleAd, which returns early on a
      // targetMac mismatch: the transport is proven alive by traffic from ANY
      // device, and the scale only advertises while somebody is on it (#281).
      this.lastAdvertAt = Date.now();
      this.unsub = this.client.onAdvertisement((info, mac) => {
        this.lastAdvertAt = Date.now();
        this.handleAd(info, mac);
      });
      bleLog.info('Home Assistant ReadingWatcher started, listening for advertisements');
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
    this.lastAdvertAt = null;
    bleLog.info('Home Assistant ReadingWatcher stopped');
  }

  nextReading(signal?: AbortSignal): Promise<RawReading> {
    return this.queue.shift(signal);
  }

  /** Epoch ms of the last advertisement from any device (#281). */
  lastTransportActivityMs(): number | null {
    return this.lastAdvertAt;
  }

  updateConfig(config: WatcherConfig): void {
    this.adapters = config.adapters;
    this.targetMac = config.targetMac?.toLowerCase();
    if (config.profile) this.profile = config.profile;
  }

  private handleAd(info: BleDeviceInfo, address: string): void {
    const addrLc = address.toLowerCase();
    if (this.targetMac && addrLc !== this.targetMac) return;

    logAdvert(address, info);
    const adapter = resolveAdapter(info, this.adapters);
    if (!adapter) return;

    // Default waitForBroadcast: a device with a parseable broadcast source keeps
    // waiting for a stable frame; only devices with no broadcast path at all
    // fall through to 'gatt', which this transport cannot serve.
    const decision = evaluateAdvertisement(adapter, info);

    if (decision.kind === 'complete') {
      this.grace.cancel(address);
      this.pushDeduped(address, { reading: decision.reading, adapter }, decision.reading.weight);
      return;
    }
    if (decision.kind === 'partial') {
      this.grace.hold(address, { reading: decision.reading, adapter });
      return;
    }
    if (decision.kind === 'gatt') this.warnGatt(adapter, address);
  }

  private pushDeduped(address: string, raw: RawReading, weight: number): void {
    if (!this.dedup.shouldEmit(address, weight)) {
      bleLog.debug(`Dedup skip: ${address}:${weight.toFixed(1)}`);
      return;
    }
    bleLog.info(`Matched: ${raw.adapter.name} (${address})`);
    bleLog.info(`Reading: ${weight} kg`);
    this.queue.push(raw);
  }

  private warnGatt(adapter: ScaleAdapter, address: string): void {
    if (this.gattWarned.has(address)) return;
    if (this.gattWarned.size >= GATT_WARN_MAX) {
      const oldest = this.gattWarned.values().next().value;
      if (oldest !== undefined) this.gattWarned.delete(oldest);
    }
    this.gattWarned.add(address);
    bleLog.warn(
      `${adapter.name} at ${address} needs a GATT connection, which Home Assistant's ` +
        'advertisement stream cannot provide; use a local adapter or an ESPHome proxy',
    );
  }

  private async teardown(): Promise<void> {
    this.grace.clear();
    if (this.unsub) {
      this.unsub();
      this.unsub = null;
    }
    if (this.client) {
      await this.client.stop();
      this.client = null;
    }
  }
}
