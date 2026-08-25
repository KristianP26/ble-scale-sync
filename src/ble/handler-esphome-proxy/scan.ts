import type { ScaleAdapter, BodyComposition } from '../../interfaces/scale-adapter.js';
import type { EsphomeProxyConfig } from '../../config/schema.js';
import type { ScanOptions, ScanResult } from '../types.js';
import { type RawReading, waitForRawReading } from '../shared.js';
import { resolveAdapter } from '../../scales/resolve.js';
import { evaluateAdvertisement, GraceTimers, logAdvert } from '../advertisement.js';
import { bleLog, errMsg, withTimeout, IMPEDANCE_GRACE_MS } from '../types.js';
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
  const pool = new EsphomeProxyPool(config, { liveness: false });

  // Boxed so TS does not narrow it to `never` in the finally (it is only
  // assigned inside the Promise executor callback).
  const sub: { unsub: (() => void) | null } = { unsub: null };

  try {
    await pool.start();
    logTransportCapabilities(adapters);

    // Per-address grace state so two scales advertising partial frames in the
    // same scan window do not clobber each other's pending fallback (#161).
    // Boxed (like `sub`) because it is only assigned inside the Promise executor,
    // which TS would otherwise narrow to `never` in the finally.
    const graceBox: { grace: GraceTimers | null } = { grace: null };

    try {
      return await withTimeout(
        new Promise<RawReading>((resolve, reject) => {
          const seenAddrs = new Set<string>();
          // GATT is connected on demand; guard so repeated advertisements for
          // the same scale do not open parallel sessions.
          const gattInFlight = new Set<string>();

          const g = new GraceTimers(IMPEDANCE_GRACE_MS, (address, gr) => {
            bleLog.info(
              `Matched: ${gr.adapter.name} (${address}), weight only, no impedance within ${IMPEDANCE_GRACE_MS / 1000}s`,
            );
            bleLog.info(`Broadcast reading: ${gr.reading.weight} kg`);
            resolve(gr);
          });
          graceBox.grace = g;

          // The proxy delivers the advertisement and its scan response as two
          // events and only the second carries the local name, so the same
          // device arrives once nameless and once named. Adapters that tell
          // sibling protocols apart by name would match the nameless frame as
          // if the device had no name (#322), so the last name seen per address
          // is remembered and merged back in. Same reasoning as the watcher.
          const lastAdvertName = new Map<string, string>();
          const MAX_CACHED_NAMES = 64;

          sub.unsub = pool.onAdvertisement((rawInfo, address) => {
            const addrLc = address.toLowerCase();
            if (targetLc && addrLc !== targetLc) return;

            logAdvert(address, rawInfo);
            let info = rawInfo;
            if (info.localName) {
              if (lastAdvertName.size >= MAX_CACHED_NAMES && !lastAdvertName.has(addrLc)) {
                const oldest = lastAdvertName.keys().next().value;
                if (oldest !== undefined) lastAdvertName.delete(oldest);
              }
              lastAdvertName.set(addrLc, info.localName);
            } else {
              const cached = lastAdvertName.get(addrLc);
              if (cached) info = { ...info, localName: cached };
            }
            const adapter = resolveAdapter(info, adapters);
            if (!adapter) {
              if (!seenAddrs.has(address)) {
                seenAddrs.add(address);
                bleLog.debug(`Unmatched device: ${address} (${info.localName || 'no name'})`);
              }
              return;
            }

            const decision = evaluateAdvertisement(adapter, info);

            // Passive adapters (e.g. Mi Scale 2) emit a weight-only frame first
            // and a weight+impedance frame moments later, so they are held on a
            // grace timer; other broadcast adapters resolve immediately.
            if (decision.kind === 'complete') {
              g.cancel(address);
              bleLog.info(`Matched: ${adapter.name} (${address})`);
              bleLog.info(`Broadcast reading: ${decision.reading.weight} kg`);
              resolve({ reading: decision.reading, adapter });
              return;
            }

            // Partial frame for a passive adapter: hold keyed on this address so
            // a second scale's partial frame cannot overwrite.
            if (decision.kind === 'partial') {
              bleLog.debug(
                `${adapter.name} matched at ${address} but broadcast frame is not stable yet`,
              );
              g.hold(address, { reading: decision.reading, adapter });
              return;
            }

            // Device still carries broadcast data this adapter parses but no
            // stable frame yet: keep waiting.
            if (decision.kind === 'wait') {
              bleLog.debug(
                `${adapter.name} matched at ${address} but broadcast frame is not stable yet`,
              );
              return;
            }

            // No broadcast source for this device and no GATT characteristic
            // either: nothing we can do, keep waiting.
            if (decision.kind === 'none') {
              bleLog.debug(
                `${adapter.name} matched at ${address} but has no broadcast or GATT path`,
              );
              return;
            }

            // decision.kind === 'gatt': connect on demand through the proxy that saw it.
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
      graceBox.grace?.clear();
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
  const duration = durationMs ?? SCAN_DEFAULT_MS;
  const pool = new EsphomeProxyPool(config, { liveness: false });
  const results = new Map<string, ScanResult>();

  try {
    await pool.start();
    const unsub = pool.onAdvertisement((info, address) => {
      if (results.has(address)) return;
      const adapter = resolveAdapter(info, adapters);
      results.set(address, {
        address,
        name: info.localName || '',
        matchedAdapter: adapter?.name,
      });
    });
    await new Promise<void>((resolve) => setTimeout(resolve, duration));
    unsub();
    return [...results.values()];
  } finally {
    await pool.stop();
  }
}
