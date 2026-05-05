import type { ScaleAdapter, BodyComposition } from '../interfaces/scale-adapter.js';
import type { ScanOptions, ScanResult, BleHandlerName } from './types.js';
import type { RawReading } from './shared.js';
import { bleLog } from './types.js';

export type { ScanOptions, ScanResult } from './types.js';
export type { RawReading } from './shared.js';

type NobleDriver = 'abandonware' | 'stoprocent';

/**
 * Resolved BLE handler identifier. The transport switch in this file used to
 * be triplicated across `scanAndReadRaw`, `scanAndRead`, and `scanDevices`;
 * `resolveHandlerKey()` is now the single source of truth (#130).
 */
export type HandlerKey = 'mqtt-proxy' | 'esphome-proxy' | 'noble-legacy' | 'noble' | 'node-ble';

const HANDLER_LABELS: Record<HandlerKey, string> = {
  'mqtt-proxy': 'mqtt-proxy (ESP32)',
  'esphome-proxy': 'esphome-proxy',
  'noble-legacy': 'noble-legacy (@abandonware/noble)',
  noble: 'noble (@stoprocent/noble)',
  'node-ble': 'node-ble (BlueZ D-Bus)',
};

/** Resolve NOBLE_DRIVER env var to a specific noble driver, or null for OS default. */
function resolveNobleDriver(): NobleDriver | null {
  const driver = process.env.NOBLE_DRIVER?.toLowerCase();
  if (driver === 'abandonware') return 'abandonware';
  if (driver === 'stoprocent') return 'stoprocent';
  return null;
}

/**
 * Decide which BLE handler module to load. Precedence:
 *   1. Explicit `bleHandler` (mqtt-proxy or esphome-proxy from config)
 *   2. `NOBLE_DRIVER` env var (abandonware or stoprocent)
 *   3. OS platform default (Linux: node-ble, Windows: noble-legacy, else: noble)
 */
export function resolveHandlerKey(bleHandler?: BleHandlerName): HandlerKey {
  if (bleHandler === 'mqtt-proxy') return 'mqtt-proxy';
  if (bleHandler === 'esphome-proxy') return 'esphome-proxy';
  const driver = resolveNobleDriver();
  if (driver === 'abandonware') return 'noble-legacy';
  if (driver === 'stoprocent') return 'noble';
  if (process.platform === 'linux') return 'node-ble';
  if (process.platform === 'win32') return 'noble-legacy';
  return 'noble';
}

/** Common surface every handler module must expose for read-and-compute paths. */
interface CommonHandler {
  scanAndReadRaw: (opts: ScanOptions) => Promise<RawReading>;
  scanAndRead: (opts: ScanOptions) => Promise<BodyComposition>;
}

async function loadHandler(key: HandlerKey): Promise<CommonHandler> {
  bleLog.debug(`BLE handler: ${HANDLER_LABELS[key]}`);
  switch (key) {
    case 'mqtt-proxy':
      return import('./handler-mqtt-proxy.js');
    case 'esphome-proxy':
      return import('./handler-esphome-proxy.js');
    case 'noble-legacy':
      return import('./handler-noble-legacy.js');
    case 'noble':
      return import('./handler-noble.js');
    case 'node-ble':
      return import('./handler-node-ble.js');
    default: {
      // Defensive: unreachable with the strict union, but a future caller
      // that bypasses resolveHandlerKey() (e.g. hand-typed cast) would land
      // here. Throw a clear error instead of silently returning undefined.
      const _exhaustive: never = key;
      throw new Error(`Unknown BLE handler key: ${String(_exhaustive)}`);
    }
  }
}

/**
 * Scan for a BLE scale and return the raw weight/impedance reading + matched adapter.
 * Does NOT compute body composition metrics. Use scanAndRead() for the full flow,
 * or call adapter.computeMetrics(reading, profile) on the result.
 *
 * Used by the multi-user flow to match a user by weight before computing metrics.
 */
export async function scanAndReadRaw(opts: ScanOptions): Promise<RawReading> {
  const handler = await loadHandler(resolveHandlerKey(opts.bleHandler));
  return handler.scanAndReadRaw(opts);
}

export { ReadingWatcher } from './handler-mqtt-proxy.js';

/**
 * Scan for a BLE scale, read weight + impedance, and compute body composition.
 *
 * Handler selection precedence (matches `resolveHandlerKey`):
 * 1. Explicit `opts.bleHandler` (`mqtt-proxy` or `esphome-proxy` from config)
 * 2. `NOBLE_DRIVER` env var (`abandonware` or `stoprocent`)
 * 3. OS-platform default (Linux: node-ble, Windows: noble-legacy, macOS / other: noble)
 *
 * Dynamic import() ensures the unused library is never loaded.
 */
export async function scanAndRead(opts: ScanOptions): Promise<BodyComposition> {
  const handler = await loadHandler(resolveHandlerKey(opts.bleHandler));
  return handler.scanAndRead(opts);
}

/**
 * Scan for nearby BLE devices and identify recognized scales.
 * Uses the OS-appropriate BLE handler (with NOBLE_DRIVER override support).
 *
 * Stays as a switch/case rather than going through `loadHandler` because each
 * handler's `scanDevices` takes different config args (mqttProxy / esphomeProxy
 * / bleAdapter), so the dispatch is shape-specific.
 */
export async function scanDevices(
  adapters: ScaleAdapter[],
  durationMs?: number,
  bleHandler?: BleHandlerName,
  mqttProxy?: import('../config/schema.js').MqttProxyConfig,
  bleAdapter?: string,
  esphomeProxy?: import('../config/schema.js').EsphomeProxyConfig,
): Promise<ScanResult[]> {
  const key = resolveHandlerKey(bleHandler);
  bleLog.debug(`BLE handler: ${HANDLER_LABELS[key]}`);

  switch (key) {
    case 'mqtt-proxy': {
      if (!mqttProxy) {
        throw new Error('mqtt_proxy config is required when ble.handler is mqtt-proxy');
      }
      const { scanDevices: impl } = await import('./handler-mqtt-proxy.js');
      return impl(adapters, durationMs, mqttProxy);
    }
    case 'esphome-proxy': {
      if (!esphomeProxy) {
        throw new Error('esphome_proxy config is required when ble.handler is esphome-proxy');
      }
      const { scanDevices: impl } = await import('./handler-esphome-proxy.js');
      return impl(adapters, durationMs, esphomeProxy);
    }
    case 'noble-legacy': {
      if (bleAdapter) {
        bleLog.warn(
          `ble.adapter='${bleAdapter}' is only supported with node-ble (Linux default). Ignored when using Noble.`,
        );
      }
      const { scanDevices: impl } = await import('./handler-noble-legacy.js');
      return impl(adapters, durationMs);
    }
    case 'noble': {
      if (bleAdapter) {
        bleLog.warn(
          `ble.adapter='${bleAdapter}' is only supported with node-ble (Linux default). Ignored when using Noble.`,
        );
      }
      const { scanDevices: impl } = await import('./handler-noble.js');
      return impl(adapters, durationMs);
    }
    case 'node-ble': {
      const { scanDevices: impl } = await import('./handler-node-ble.js');
      return impl(adapters, durationMs, bleAdapter);
    }
  }
}
