import type {
  ScaleAdapter,
  ScaleReading,
  BodyComposition,
} from '../../interfaces/scale-adapter.js';
import type { EsphomeProxyConfig } from '../../config/schema.js';
import type { ScanOptions, ScanResult } from '../types.js';
import type { RawReading } from '../shared.js';
import { bleLog, errMsg, withTimeout, IMPEDANCE_GRACE_MS } from '../types.js';
import {
  createEsphomeClient,
  waitForConnected,
  safeDisconnect,
  type EsphomeBleAdvertisement,
} from './client.js';
import { toBleDeviceInfo, formatMacAddress } from './advert.js';

// ─── Constants ────────────────────────────────────────────────────────────────

// 60s matches the native BLE handlers and gives slow-advertising scales (e.g. Mi,
// some Renpho) enough time to emit a broadcast frame after the user steps on.
const BROADCAST_WAIT_MS = 60_000;
const SCAN_DEFAULT_MS = 15_000;

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
export function logPhase1Capabilities(adapters: ScaleAdapter[]): void {
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
