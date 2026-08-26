import type {
  ScaleAdapter,
  BleDeviceInfo,
  UserProfile,
  ScaleAuth,
} from '../../interfaces/scale-adapter.js';
import type { EsphomeProxyConfig } from '../../config/schema.js';
import { type RawReading, waitForRawReading } from '../shared.js';
import { resolveAdapter } from '../../scales/resolve.js';
import { evaluateAdvertisement, GraceTimers, DedupWindow, logAdvert } from '../advertisement.js';
import type { Watcher, WatcherConfig } from '../reading-source.js';
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
export class ReadingWatcher implements Watcher {
  private queue = new AsyncQueue<RawReading>();
  private started = false;
  private adapters: ScaleAdapter[];
  private targetMac?: string;
  private profile?: UserProfile;
  private scaleAuth?: ScaleAuth;
  private config: EsphomeProxyConfig;
  private readonly dedup = new DedupWindow(DEDUP_WINDOW_MS);
  private pool: EsphomeProxyPool | null = null;
  private unsub: (() => void) | null = null;
  private gattInFlight = new Set<string>();
  /** Set at start and on every advertisement; the proxy liveness signal (#281). */
  private lastAdvertAt: number | null = null;

  /**
   * Last non-empty local name seen per address, so a later nameless frame from
   * the same device still resolves against the name.
   *
   * The ESPHome proxy delivers the advertisement and its scan response as two
   * separate events, and only the scan response carries the local name, so the
   * same device arrives here twice: once nameless, once named. Every adapter in
   * this codebase that has to tell sibling protocols apart uses the name to do
   * it, and a device that lands on the nameless frame is matched as if it had
   * no name at all. For the Lefu FFB0 family that is the difference between the
   * Hutbit adapter and the MGB one, whose parser rejects every frame the Lefu
   * units send (#322). The mqtt-proxy watcher already reuses its cached scan
   * entry for the same reason.
   *
   * Bounded so a busy radio cannot grow it without limit; entries are cheap and
   * a scale re-advertises constantly, so eviction costs at most one cycle.
   */
  private readonly lastAdvertName = new Map<string, string>();
  private static readonly MAX_CACHED_NAMES = 64;

  /** Remember a name, and merge the remembered one into a nameless frame. */
  private withCachedName(info: BleDeviceInfo, addrLc: string): BleDeviceInfo {
    if (info.localName) {
      if (this.lastAdvertName.get(addrLc) !== info.localName) {
        if (this.lastAdvertName.size >= ReadingWatcher.MAX_CACHED_NAMES) {
          const oldest = this.lastAdvertName.keys().next().value;
          if (oldest !== undefined) this.lastAdvertName.delete(oldest);
        }
        this.lastAdvertName.set(addrLc, info.localName);
      }
      return info;
    }
    const cached = this.lastAdvertName.get(addrLc);
    if (!cached) return info;
    bleLog.debug(`Nameless advertisement for ${addrLc}: using cached name "${cached}"`);
    return { ...info, localName: cached };
  }
  // LRU map (insertion-ordered): scales whose on-demand GATT connect failed,
  // so we warn once instead of on every advertisement.
  private gattWarnedFor = new Map<string, true>();
  /** Weight-only fallback timer per address; on elapse the held reading is
   *  queued directly (no dedup — matches the prior grace-timer body). */
  private readonly grace = new GraceTimers(IMPEDANCE_GRACE_MS, (address, gr) => {
    bleLog.info(
      `Matched: ${gr.adapter.name} (${address}), weight only, no impedance within ${IMPEDANCE_GRACE_MS / 1000}s`,
    );
    bleLog.info(`Broadcast reading: ${gr.reading.weight} kg`);
    this.queue.push(gr);
  });

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
      // Stamped here rather than inside handleAd, which returns early on a
      // targetMac mismatch: the transport is proven alive by traffic from ANY
      // device, and the scale only advertises while somebody is on it (#281).
      this.lastAdvertAt = Date.now();
      this.unsub = this.pool.onAdvertisement((info, mac) => {
        this.lastAdvertAt = Date.now();
        this.handleAd(info, mac);
      });
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
    this.lastAdvertAt = null;
    bleLog.info('ESPHome ReadingWatcher stopped');
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
    if (config.scaleAuth) this.scaleAuth = config.scaleAuth;
  }

  private handleAd(rawInfo: BleDeviceInfo, address: string): void {
    const addrLc = address.toLowerCase();
    if (this.targetMac && addrLc !== this.targetMac) return;

    logAdvert(address, rawInfo);
    const info = this.withCachedName(rawInfo, addrLc);
    const adapter = resolveAdapter(info, this.adapters);
    if (!adapter) return;

    // waitForBroadcast:false — this watcher GATT-connects devices whose
    // broadcast yields nothing (QN Elis 1) from its per-advertisement stream
    // rather than waiting (see the hasParseableBroadcastSource doc comment).
    const decision = evaluateAdvertisement(adapter, info, { waitForBroadcast: false });

    if (decision.kind === 'complete') {
      this.grace.cancel(address);
      this.pushDeduped(address, { reading: decision.reading, adapter }, decision.reading.weight);
      return;
    }

    // Partial broadcast frame for a passive adapter: grace timer fallback.
    if (decision.kind === 'partial') {
      this.grace.hold(address, { reading: decision.reading, adapter });
      return;
    }

    // Broadcast yielded nothing usable. If the adapter has a GATT path, connect
    // on demand through the proxy pool. (decision is 'gatt' or 'none'.)
    if (decision.kind === 'gatt') {
      this.readViaGatt(adapter, info, address, addrLc);
    }
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

  private readViaGatt(
    adapter: ScaleAdapter,
    info: BleDeviceInfo,
    address: string,
    addrLc: string,
  ): void {
    if (this.gattInFlight.has(addrLc)) return;
    if (!this.pool) return;
    const pool = this.pool;
    this.gattInFlight.add(addrLc);
    bleLog.info(`Matched: ${adapter.name} (${address}); opening GATT via ESPHome proxy`);
    void (async () => {
      let session: Awaited<ReturnType<typeof pool.connectGatt>> | null = null;
      // Adapter that actually drives the read; may be re-resolved below once the
      // characteristics are known. Kept in the outer scope so a failure warning
      // names the adapter that ran, not the pre-discovery guess.
      let gattAdapter = adapter;
      try {
        session = await pool.connectGatt(address);
        // Re-resolve char-aware now that GATT discovery is complete, mirroring
        // the node-ble post-discovery pass (#177). The advertisement-time match
        // keyed only on name + advertised service UUIDs, which lets a generic-
        // service adapter (e.g. Inlife on the bare fff0 vendor service) win over
        // the correct char-specific one. On a Eufy P1 "T9147" (fff1 + fff4, no
        // fff2) Inlife matched then failed writing fff2; with the discovered
        // chars, Inlife rejects (no fff2) and 1byone (Eufy) wins on fff4 (#251).
        const discovered = { ...info, characteristicUuids: [...session.charMap.keys()] };
        logAdvert(address, discovered);
        gattAdapter = resolveAdapter(discovered, this.adapters) ?? adapter;
        if (gattAdapter.name !== adapter.name) {
          bleLog.info(
            `Re-resolved adapter after GATT discovery: ${adapter.name} -> ${gattAdapter.name} (${address})`,
          );
        }
        const raw = await waitForRawReading(
          session.charMap,
          session.device,
          gattAdapter,
          this.profile ?? { height: 170, age: 30, gender: 'male', isAthlete: false },
          address.replace(/[:-]/g, '').toUpperCase(),
          undefined,
          undefined,
          this.scaleAuth,
        );
        this.pushDeduped(address, raw, raw.reading.weight);
      } catch (e) {
        this.warnGattFailure(gattAdapter.name, address, errMsg(e));
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

  private async teardown(): Promise<void> {
    this.grace.clear();
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
