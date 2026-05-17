import type { BleDeviceInfo } from '../../interfaces/scale-adapter.js';
import type { EsphomeProxyConfig } from '../../config/schema.js';
import { bleLog } from '../types.js';
import {
  createEsphomeClient,
  waitForConnected,
  safeDisconnect,
  type EsphomeClient,
  type EsphomeBleAdvertisement,
} from './client.js';
import { toBleDeviceInfo, formatMacAddress } from './advert.js';

/** A sighting kept fresh for this long counts toward proxy selection. */
const SIGHTING_TTL_MS = 60_000;

export interface ProxyEndpoint {
  id: string; // `${host}:${port}`
  host: string;
  port: number;
  encryption_key?: string | null;
  password?: string | null;
  client_info: string;
}

interface Sighting {
  rssi: number;
  ts: number;
}

type AdvertCb = (info: BleDeviceInfo, mac: string) => void;

function endpointsFromConfig(config: EsphomeProxyConfig): ProxyEndpoint[] {
  const mk = (e: {
    host: string;
    port: number;
    encryption_key?: string | null;
    password?: string | null;
    client_info: string;
  }): ProxyEndpoint => ({
    id: `${e.host}:${e.port}`,
    host: e.host,
    port: e.port,
    encryption_key: e.encryption_key,
    password: e.password,
    client_info: e.client_info,
  });
  return [mk(config), ...config.additional_proxies.map(mk)];
}

/**
 * Owns one ESPHome client per configured proxy, aggregates BLE advertisements
 * across all of them, and tracks which proxy last saw each MAC (with RSSI) so
 * GATT connects can be routed to the proxy most likely to reach the scale.
 */
export class EsphomeProxyPool {
  private endpoints: ProxyEndpoint[];
  private clients = new Map<string, EsphomeClient>();
  private adHandlers = new Map<string, (ad: EsphomeBleAdvertisement) => void>();
  // macLc -> proxyId -> latest sighting
  private sightings = new Map<string, Map<string, Sighting>>();
  private subscribers = new Set<AdvertCb>();
  private started = false;

  constructor(config: EsphomeProxyConfig) {
    this.endpoints = endpointsFromConfig(config);
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    for (const ep of this.endpoints) {
      const client = await createEsphomeClient({
        host: ep.host,
        port: ep.port,
        encryption_key: ep.encryption_key,
        password: ep.password,
        client_info: ep.client_info,
        additional_proxies: [],
      } as EsphomeProxyConfig);
      const handler = (ad: EsphomeBleAdvertisement): void => this.onAd(ep.id, ad);
      client.on('ble', handler);
      this.clients.set(ep.id, client);
      this.adHandlers.set(ep.id, handler);
      await waitForConnected(client, ep.id);
      bleLog.info(`ESPHome proxy connected at ${ep.id}`);
    }
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    for (const [id, client] of this.clients) {
      const handler = this.adHandlers.get(id);
      if (handler) client.removeListener('ble', handler as (...args: unknown[]) => void);
      await safeDisconnect(client);
    }
    this.clients.clear();
    this.adHandlers.clear();
    this.sightings.clear();
    this.started = false;
  }

  /** Subscribe to merged advertisements from all proxies. Returns unsubscribe. */
  onAdvertisement(cb: AdvertCb): () => void {
    this.subscribers.add(cb);
    return () => this.subscribers.delete(cb);
  }

  getClient(proxyId: string): EsphomeClient | null {
    return this.clients.get(proxyId) ?? null;
  }

  /** Proxy that most recently saw `mac` (RSSI tiebreak) within the TTL, or null. */
  pickProxyFor(mac: string): string | null {
    const fresh = this.freshSightings(mac);
    return fresh.length > 0 ? fresh[0].id : null;
  }

  /**
   * Proxies ranked best-first for reaching `mac`: those that saw it within the
   * TTL ordered by most-recent sighting (strongest RSSI breaks ties), followed
   * by any remaining endpoints in declaration order as blind fallbacks (used by
   * connectGatt to still attempt a connection when nothing has been seen).
   */
  proxyOrderFor(mac: string): string[] {
    const ranked = this.freshSightings(mac).map((f) => f.id);
    const seen = new Set(ranked);
    for (const ep of this.endpoints) {
      if (!seen.has(ep.id)) ranked.push(ep.id);
    }
    return ranked;
  }

  private freshSightings(mac: string): Array<{ id: string; rssi: number; ts: number }> {
    const perProxy = this.sightings.get(mac.toLowerCase());
    if (!perProxy) return [];
    const now = Date.now();
    const fresh: Array<{ id: string; rssi: number; ts: number }> = [];
    for (const [id, s] of perProxy) {
      if (now - s.ts <= SIGHTING_TTL_MS) fresh.push({ id, rssi: s.rssi, ts: s.ts });
    }
    fresh.sort((a, b) => (b.ts !== a.ts ? b.ts - a.ts : b.rssi - a.rssi));
    return fresh;
  }

  private onAd(proxyId: string, ad: EsphomeBleAdvertisement): void {
    const mac = formatMacAddress(ad.address);
    if (mac === '00:00:00:00:00:00') return;
    const macLc = mac.toLowerCase();
    let perProxy = this.sightings.get(macLc);
    if (!perProxy) {
      perProxy = new Map();
      this.sightings.set(macLc, perProxy);
    }
    perProxy.set(proxyId, { rssi: ad.rssi, ts: Date.now() });

    const info = toBleDeviceInfo(ad);
    for (const cb of this.subscribers) cb(info, mac);
  }
}
