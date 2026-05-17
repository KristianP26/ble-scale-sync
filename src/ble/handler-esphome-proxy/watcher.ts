import type {
  ScaleAdapter,
  ScaleReading,
  BleDeviceInfo,
  UserProfile,
  ScaleAuth,
} from '../../interfaces/scale-adapter.js';
import type { EsphomeProxyConfig } from '../../config/schema.js';
import { type RawReading, waitForRawReading } from '../shared.js';
import { bleLog, errMsg, IMPEDANCE_GRACE_MS } from '../types.js';
import { AsyncQueue } from '../async-queue.js';
import { EsphomeProxyPool } from './pool.js';
import { logTransportCapabilities } from './scan.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const DEDUP_WINDOW_MS = 30_000;
// Cap for the "already warned about this scale's GATT failure" tracker. Old
// entries are evicted LRU-style so dedup persists long-term in continuous mode.
const GATT_WARN_LRU_MAX = 256;

// ─── ReadingWatcher (continuous mode) ────────────────────────────────────────

/**
 * Persistent event-driven watcher for continuous mode over an ESPHome proxy
 * pool. Broadcast scales parse from advertisements; GATT scales are connected
 * on demand through the proxy that last saw them and read via the shared
 * waitForRawReading() seam, then disconnected immediately so no proxy slot is
 * held between weigh-ins.
 */
export class ReadingWatcher {
  private queue = new AsyncQueue<RawReading>();
  private started = false;
  private adapters: ScaleAdapter[];
  private targetMac?: string;
  private profile?: UserProfile;
  private scaleAuth?: ScaleAuth;
  private config: EsphomeProxyConfig;
  private dedup = new Map<string, number>();
  private pool: EsphomeProxyPool | null = null;
  private unsub: (() => void) | null = null;
  private gattInFlight = new Set<string>();
  // LRU map (insertion-ordered): scales whose on-demand GATT connect failed,
  // so we warn once instead of on every advertisement.
  private gattWarnedFor = new Map<string, true>();
  private graceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private graceReadings = new Map<string, RawReading>();

  constructor(
    config: EsphomeProxyConfig,
    adapters: ScaleAdapter[],
    targetMac?: string,
    profile?: UserProfile,
    scaleAuth?: ScaleAuth,
  ) {
    this.config = config;
    this.adapters = adapters;
    this.targetMac = targetMac?.toLowerCase();
    this.profile = profile;
    this.scaleAuth = scaleAuth;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    try {
      this.pool = new EsphomeProxyPool(this.config);
      await this.pool.start();
      logTransportCapabilities(this.adapters);
      this.unsub = this.pool.onAdvertisement((info, mac) => this.handleAd(info, mac));
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

  updateConfig(
    adapters: ScaleAdapter[],
    targetMac?: string,
    profile?: UserProfile,
    scaleAuth?: ScaleAuth,
  ): void {
    this.adapters = adapters;
    this.targetMac = targetMac?.toLowerCase();
    if (profile) this.profile = profile;
    if (scaleAuth) this.scaleAuth = scaleAuth;
  }

  private handleAd(info: BleDeviceInfo, address: string): void {
    const addrLc = address.toLowerCase();
    if (this.targetMac && addrLc !== this.targetMac) return;

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
      const gt = this.graceTimers.get(address);
      if (gt) {
        clearTimeout(gt);
        this.graceTimers.delete(address);
        this.graceReadings.delete(address);
      }
      this.pushDeduped(address, { reading, adapter }, reading.weight);
      return;
    }

    // Partial broadcast frame for a passive adapter: grace timer fallback.
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

    // Broadcast yielded nothing usable. If the adapter has a GATT path, connect
    // on demand through the proxy pool.
    if (adapter.charNotifyUuid) {
      this.readViaGatt(adapter, address, addrLc);
    }
  }

  private pushDeduped(address: string, raw: RawReading, weight: number): void {
    const key = `${address}:${weight.toFixed(1)}`;
    const now = Date.now();
    this.pruneDedup(now);
    const lastSeen = this.dedup.get(key);
    if (lastSeen && now - lastSeen < DEDUP_WINDOW_MS) {
      bleLog.debug(`Dedup skip: ${key}`);
      return;
    }
    this.dedup.set(key, now);
    bleLog.info(`Matched: ${raw.adapter.name} (${address})`);
    bleLog.info(`Reading: ${weight} kg`);
    this.queue.push(raw);
  }

  private readViaGatt(adapter: ScaleAdapter, address: string, addrLc: string): void {
    if (this.gattInFlight.has(addrLc)) return;
    if (!this.pool) return;
    const pool = this.pool;
    this.gattInFlight.add(addrLc);
    bleLog.info(`Matched: ${adapter.name} (${address}); opening GATT via ESPHome proxy`);
    void (async () => {
      let session: Awaited<ReturnType<typeof pool.connectGatt>> | null = null;
      try {
        session = await pool.connectGatt(address);
        const raw = await waitForRawReading(
          session.charMap,
          session.device,
          adapter,
          this.profile ?? { height: 170, age: 30, gender: 'male', isAthlete: false },
          address.replace(/[:-]/g, '').toUpperCase(),
          undefined,
          undefined,
          this.scaleAuth,
        );
        this.pushDeduped(address, raw, raw.reading.weight);
      } catch (e) {
        this.warnGattFailure(adapter.name, address, errMsg(e));
      } finally {
        if (session) await session.close();
        this.gattInFlight.delete(addrLc);
      }
    })();
  }

  private warnGattFailure(adapterName: string, address: string, reason: string): void {
    if (this.gattWarnedFor.has(address)) {
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
      `${adapterName} at ${address}: GATT read over the ESPHome proxy failed (${reason}). ` +
        `Will retry on the next advertisement.`,
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
    if (this.unsub) {
      this.unsub();
      this.unsub = null;
    }
    if (this.pool) {
      await this.pool.stop();
      this.pool = null;
    }
  }
}
