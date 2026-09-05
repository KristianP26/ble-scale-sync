import type { ScaleAdapter, BodyComposition } from '../../interfaces/scale-adapter.js';
import type { HaBluetoothConfig } from '../../config/schema.js';
import type { ScanOptions, ScanResult } from '../types.js';
import type { RawReading } from '../shared.js';
import { resolveAdapter } from '../../scales/resolve.js';
import { evaluateAdvertisement, GraceTimers, logAdvert } from '../advertisement.js';
import { bleLog, withTimeout, IMPEDANCE_GRACE_MS } from '../types.js';
import { HaBluetoothClient } from './client.js';

// ─── Constants ────────────────────────────────────────────────────────────────

// 60s matches the native BLE handlers and gives slow-advertising scales enough
// time to emit a broadcast frame after the user steps on.
const BROADCAST_WAIT_MS = 60_000;
const SCAN_DEFAULT_MS = 15_000;

// ─── Capability summary ───────────────────────────────────────────────────────

/**
 * One line naming which configured adapters this transport can serve. Home
 * Assistant's advertisement stream is passive: broadcast adapters work, GATT
 * adapters never will, so the latter are called out rather than left to time
 * out silently.
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
  bleLog.info(
    'Home Assistant Bluetooth transport ready (broadcast only).' +
      (broadcast.length > 0 ? ` Broadcast adapters: ${broadcast.join(', ')}.` : ''),
  );
  if (gatt.length > 0) {
    bleLog.warn(
      `GATT-only adapters cannot be read over Home Assistant's advertisement stream: ${gatt.join(', ')}.`,
    );
  }
}

// ─── Scan-and-read (broadcast only) ──────────────────────────────────────────

/**
 * Subscribe to Home Assistant's advertisement stream, match against adapters,
 * and return the first complete broadcast reading.
 */
export async function scanAndReadRaw(opts: ScanOptions): Promise<RawReading> {
  const config = opts.haBluetooth;
  if (!config) throw new Error('ha_bluetooth config is required for ha-bluetooth handler');

  const { targetMac, adapters } = opts;
  const targetLc = targetMac?.toLowerCase();
  const client = new HaBluetoothClient(config, { reconnect: false });

  // Boxed so TS does not narrow it to `never` in the finally (it is only
  // assigned inside the Promise executor callback).
  const sub: { unsub: (() => void) | null } = { unsub: null };

  try {
    await client.start();
    logTransportCapabilities(adapters);

    // Per-address grace state so two scales advertising partial frames in the
    // same window do not clobber each other's pending fallback (#161).
    const graceBox: { grace: GraceTimers | null } = { grace: null };

    try {
      return await withTimeout(
        new Promise<RawReading>((resolve) => {
          const seenAddrs = new Set<string>();
          const warnedGatt = new Set<string>();

          const g = new GraceTimers(IMPEDANCE_GRACE_MS, (address, gr) => {
            bleLog.info(
              `Matched: ${gr.adapter.name} (${address}), weight only, no impedance within ${IMPEDANCE_GRACE_MS / 1000}s`,
            );
            bleLog.info(`Broadcast reading: ${gr.reading.weight} kg`);
            resolve(gr);
          });
          graceBox.grace = g;

          sub.unsub = client.onAdvertisement((info, address) => {
            const addrLc = address.toLowerCase();
            if (targetLc && addrLc !== targetLc) return;

            logAdvert(address, info);
            const adapter = resolveAdapter(info, adapters);
            if (!adapter) {
              if (!seenAddrs.has(address)) {
                seenAddrs.add(address);
                bleLog.debug(`Unmatched device: ${address} (${info.localName || 'no name'})`);
              }
              return;
            }

            const decision = evaluateAdvertisement(adapter, info);

            if (decision.kind === 'complete') {
              g.cancel(address);
              bleLog.info(`Matched: ${adapter.name} (${address})`);
              bleLog.info(`Broadcast reading: ${decision.reading.weight} kg`);
              resolve({ reading: decision.reading, adapter });
              return;
            }
            if (decision.kind === 'partial') {
              bleLog.debug(
                `${adapter.name} matched at ${address} but broadcast frame is not stable yet`,
              );
              g.hold(address, { reading: decision.reading, adapter });
              return;
            }
            if (decision.kind === 'wait') {
              if (decision.live) opts.onLiveWeight?.(decision.live);
              bleLog.debug(
                `${adapter.name} matched at ${address} but broadcast frame is not stable yet`,
              );
              return;
            }
            if (decision.kind === 'gatt') {
              if (!warnedGatt.has(address)) {
                warnedGatt.add(address);
                bleLog.warn(
                  `${adapter.name} at ${address} needs a GATT connection, which Home Assistant's ` +
                    'advertisement stream cannot provide; use a local adapter or an ESPHome proxy',
                );
              }
              return;
            }
            bleLog.debug(`${adapter.name} matched at ${address} but has no broadcast path`);
          });
        }),
        BROADCAST_WAIT_MS,
        targetMac
          ? `Timed out waiting for ${targetMac} via Home Assistant Bluetooth.`
          : `Timed out waiting for any recognized scale via Home Assistant Bluetooth.`,
      );
    } finally {
      graceBox.grace?.clear();
    }
  } finally {
    if (sub.unsub) sub.unsub();
    await client.stop();
  }
}

export async function scanAndRead(opts: ScanOptions): Promise<BodyComposition> {
  const { reading, adapter } = await scanAndReadRaw(opts);
  return adapter.computeMetrics(reading, opts.profile);
}

// ─── Device discovery (for `scan` and the setup wizard) ──────────────────────

export async function scanDevices(
  adapters: ScaleAdapter[],
  durationMs: number | undefined,
  config: HaBluetoothConfig,
): Promise<ScanResult[]> {
  const duration = durationMs ?? SCAN_DEFAULT_MS;
  const client = new HaBluetoothClient(config, { reconnect: false });
  const results = new Map<string, ScanResult>();

  try {
    await client.start();
    const unsub = client.onAdvertisement((info, address) => {
      const adapter = resolveAdapter(info, adapters);
      const prev = results.get(address);
      // Keep the entry fresh: a later frame may carry the name or match.
      results.set(address, {
        address,
        name: info.localName || prev?.name || '',
        matchedAdapter: adapter?.name ?? prev?.matchedAdapter,
      });
    });
    await new Promise<void>((resolve) => setTimeout(resolve, duration));
    unsub();
    return [...results.values()];
  } finally {
    await client.stop();
  }
}
