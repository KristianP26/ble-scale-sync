import type { ScaleAdapter, BodyComposition } from '../interfaces/scale-adapter.js';
import type { ScanOptions, ScanResult } from './types.js';
import type { RawReading } from './shared.js';
import { bleLog } from './types.js';

export type { ScanOptions, ScanResult } from './types.js';
export type { RawReading } from './shared.js';

type NobleDriver = 'abandonware' | 'stoprocent';

/** Resolve NOBLE_DRIVER env var to a specific noble driver, or null for OS default. */
function resolveNobleDriver(): NobleDriver | null {
  const driver = process.env.NOBLE_DRIVER?.toLowerCase();
  if (driver === 'abandonware') return 'abandonware';
  if (driver === 'stoprocent') return 'stoprocent';
  return null;
}

/** Determine which BLE handler will be used and return its name for logging. */
function resolveHandlerName(driver: NobleDriver | null): string {
  if (driver === 'abandonware') return 'noble-legacy (@abandonware/noble)';
  if (driver === 'stoprocent') return 'noble (@stoprocent/noble)';
  if (process.platform === 'linux') return 'node-ble (BlueZ D-Bus)';
  if (process.platform === 'win32') return 'noble-legacy (@abandonware/noble)';
  return 'noble (@stoprocent/noble)';
}

/**
 * Scan for a BLE scale and return the raw weight/impedance reading + matched adapter.
 * Does NOT compute body composition metrics — use scanAndRead() for the full flow,
 * or call adapter.computeMetrics(reading, profile) on the result.
 *
 * Used by the multi-user flow to match a user by weight before computing metrics.
 */
export async function scanAndReadRaw(opts: ScanOptions): Promise<RawReading> {
  if (opts.bleHandler === 'mqtt-proxy') {
    bleLog.debug('BLE handler: mqtt-proxy (ESP32)');
    const { scanAndReadRaw: impl } = await import('./handler-mqtt-proxy.js');
    return impl(opts);
  }

  const driver = resolveNobleDriver();
  bleLog.debug(`BLE handler: ${resolveHandlerName(driver)}`);

  if (driver === 'abandonware') {
    const { scanAndReadRaw: impl } = await import('./handler-noble-legacy.js');
    return impl(opts);
  }
  if (driver === 'stoprocent') {
    const { scanAndReadRaw: impl } = await import('./handler-noble.js');
    return impl(opts);
  }

  // OS defaults (no NOBLE_DRIVER override)
  if (process.platform === 'linux') {
    const { scanAndReadRaw: impl } = await import('./handler-node-ble.js');
    return impl(opts);
  }
  if (process.platform === 'win32') {
    const { scanAndReadRaw: impl } = await import('./handler-noble-legacy.js');
    return impl(opts);
  }
  // macOS and other platforms
  const { scanAndReadRaw: impl } = await import('./handler-noble.js');
  return impl(opts);
}

/**
 * Scan for a BLE scale, read weight + impedance, and compute body composition.
 *
 * OS detection selects the BLE handler at runtime:
 * - Linux → node-ble (BlueZ D-Bus)
 * - Windows → @abandonware/noble
 * - macOS → @stoprocent/noble
 *
 * Override with NOBLE_DRIVER=abandonware|stoprocent on any platform.
 * Dynamic import() ensures the unused library is never loaded.
 */
export async function scanAndRead(opts: ScanOptions): Promise<BodyComposition> {
  if (opts.bleHandler === 'mqtt-proxy') {
    bleLog.debug('BLE handler: mqtt-proxy (ESP32)');
    const { scanAndRead: impl } = await import('./handler-mqtt-proxy.js');
    return impl(opts);
  }

  const driver = resolveNobleDriver();
  bleLog.debug(`BLE handler: ${resolveHandlerName(driver)}`);

  if (driver === 'abandonware') {
    const { scanAndRead: impl } = await import('./handler-noble-legacy.js');
    return impl(opts);
  }
  if (driver === 'stoprocent') {
    const { scanAndRead: impl } = await import('./handler-noble.js');
    return impl(opts);
  }

  // OS defaults (no NOBLE_DRIVER override)
  if (process.platform === 'linux') {
    const { scanAndRead: impl } = await import('./handler-node-ble.js');
    return impl(opts);
  }
  if (process.platform === 'win32') {
    const { scanAndRead: impl } = await import('./handler-noble-legacy.js');
    return impl(opts);
  }
  // macOS and other platforms
  const { scanAndRead: impl } = await import('./handler-noble.js');
  return impl(opts);
}

/**
 * Scan for nearby BLE devices and identify recognized scales.
 * Uses the OS-appropriate BLE handler (with NOBLE_DRIVER override support).
 */
export async function scanDevices(
  adapters: ScaleAdapter[],
  durationMs?: number,
  bleHandler?: 'auto' | 'mqtt-proxy',
  mqttProxy?: import('../config/schema.js').MqttProxyConfig,
): Promise<ScanResult[]> {
  if (bleHandler === 'mqtt-proxy') {
    bleLog.debug('BLE handler: mqtt-proxy (ESP32)');
    const { scanDevices: impl } = await import('./handler-mqtt-proxy.js');
    return impl(adapters, durationMs, mqttProxy!);
  }

  const driver = resolveNobleDriver();
  bleLog.debug(`BLE handler: ${resolveHandlerName(driver)}`);

  if (driver === 'abandonware') {
    const { scanDevices: impl } = await import('./handler-noble-legacy.js');
    return impl(adapters, durationMs);
  }
  if (driver === 'stoprocent') {
    const { scanDevices: impl } = await import('./handler-noble.js');
    return impl(adapters, durationMs);
  }

  // OS defaults (no NOBLE_DRIVER override)
  if (process.platform === 'linux') {
    const { scanDevices: impl } = await import('./handler-node-ble.js');
    return impl(adapters, durationMs);
  }
  if (process.platform === 'win32') {
    const { scanDevices: impl } = await import('./handler-noble-legacy.js');
    return impl(adapters, durationMs);
  }
  // macOS and other platforms
  const { scanDevices: impl } = await import('./handler-noble.js');
  return impl(adapters, durationMs);
}
