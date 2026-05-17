import type {
  ScaleAdapter,
  ScaleReading,
  BodyComposition,
} from '../../interfaces/scale-adapter.js';
import type { EsphomeProxyConfig } from '../../config/schema.js';
import type { ScanOptions, ScanResult } from '../types.js';
import { type RawReading, waitForRawReading } from '../shared.js';
import { bleLog, errMsg, withTimeout, IMPEDANCE_GRACE_MS } from '../types.js';
import {
  createEsphomeClient,
  waitForConnected,
  safeDisconnect,
  type EsphomeBleAdvertisement,
} from './client.js';
import { toBleDeviceInfo, formatMacAddress } from './advert.js';
import { EsphomeProxyPool } from './pool.js';

// ─── Constants ────────────────────────────────────────────────────────────────

// 60s matches the native BLE handlers and gives slow-advertising scales (e.g. Mi,
// some Renpho) enough time to emit a broadcast frame after the user steps on.
const BROADCAST_WAIT_MS = 60_000;
const SCAN_DEFAULT_MS = 15_000;

// ─── Scan-and-read (broadcast + GATT) ────────────────────────────────────────

/**
 * Emit a one-line summary of how each configured adapter will be serviced over
 * the ESPHome proxy transport: broadcast adapters parse advertisements
 * directly, GATT adapters are connected on demand via the proxy (Phase 2,
 * #116). Informational only; both paths are supported.
 */
export function logTransportCapabilities(adapters: ScaleAdapter[]): void {
  const broadcast: string[] = [];
  const gatt: string[] = [];
  for (const a of adapters) {
    if (typeof a.parseBroadcast === 'function' || typeof a.parseServiceData === 'function') {
      broadcast.push(a.name);
    } else if (a.charNotifyUuid) {
      gatt.push(a.name);
    }
  }
  if (broadcast.length === 0 && gatt.length === 0) return;

  const parts: string[] = ['ESPHome proxy transport ready (broadcast + GATT).'];
  if (broadcast.length > 0) {
    parts.push(`Broadcast adapters: ${broadcast.join(', ')}.`);
  }
  if (gatt.length > 0) {
    parts.push(`GATT adapters (connected on demand): ${gatt.join(', ')}.`);
  }
  bleLog.info(parts.join(' '));
}

/**
 * Subscribe to BLE advertisements across the ESPHome proxy pool, match against
 * adapters, and return the first reading. Broadcast scales parse from the
 * advertisement; GATT scales are connected on demand through the proxy that
 * last saw them and read via the shared waitForRawReading() seam.
 */
export async function scanAndReadRaw(opts: ScanOptions): Promise<RawReading> {
  const config = opts.esphomeProxy;
  if (!config) throw new Error('esphome_proxy config is required for esphome-proxy handler');

  const { targetMac, adapters } = opts;
  const targetLc = targetMac?.toLowerCase();
  const pool = new EsphomeProxyPool(config);

  // Boxed so TS does not narrow it to `never` in the finally (it is only
  // assigned inside the Promise executor callback).
  const sub: { unsub: (() => void) | null } = { unsub: null };

  try {
    await pool.start();
    logTransportCapabilities(adapters);

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
          // GATT is connected on demand; guard so repeated advertisements for
          // the same scale do not open parallel sessions.
          const gattInFlight = new Set<string>();

          sub.unsub = pool.onAdvertisement((info, address) => {
            const addrLc = address.toLowerCase();
            if (targetLc && addrLc !== targetLc) return;

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
            // non-null reading is already stable, so emit immediately to avoid
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

            // Partial frame for a passive adapter: start grace timer keyed on
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
                      `Matched: ${gr.adapter.name} (${address}), weight only, no impedance within ${IMPEDANCE_GRACE_MS / 1000}s`,
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

            // Adapter advertises nothing broadcast-able and no GATT
            // characteristic either: nothing we can do, keep waiting.
            if (!adapter.charNotifyUuid) {
              bleLog.debug(
                `${adapter.name} matched at ${address} but has no broadcast or GATT path`,
              );
              return;
            }

            // GATT adapter: connect on demand through the proxy that saw it.
            if (gattInFlight.has(addrLc)) return;
            gattInFlight.add(addrLc);
            bleLog.info(`Matched: ${adapter.name} (${address}); opening GATT via ESPHome proxy`);
            void (async () => {
              let session: Awaited<ReturnType<typeof pool.connectGatt>> | null = null;
              try {
                session = await pool.connectGatt(address);
                const raw = await waitForRawReading(
                  session.charMap,
                  session.device,
                  adapter,
                  opts.profile,
                  address.replace(/[:-]/g, '').toUpperCase(),
                  opts.weightUnit,
                  opts.onLiveData,
                  opts.scaleAuth,
                );
                resolve(raw);
              } catch (e) {
                reject(e instanceof Error ? e : new Error(errMsg(e)));
              } finally {
                if (session) await session.close();
                gattInFlight.delete(addrLc);
              }
            })();
          });
        }),
        BROADCAST_WAIT_MS,
        targetMac
          ? `Timed out waiting for ${targetMac} via ESPHome proxy.`
          : `Timed out waiting for any recognized scale via ESPHome proxy.`,
      );
    } finally {
      clearGrace();
    }
  } finally {
    if (sub.unsub) sub.unsub();
    await pool.stop();
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
