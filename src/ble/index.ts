import type {
  ScaleAdapter,
  BodyComposition,
  UserProfile,
  ScaleAuth,
} from '../interfaces/scale-adapter.js';
import type { MqttProxyConfig, EsphomeProxyConfig, HaBluetoothConfig } from '../config/schema.js';
import type { ScanOptions, ScanResult, BleHandlerName } from './types.js';
import type { RawReading } from './shared.js';
import type { Watcher } from './reading-source.js';
import { bleLog } from './types.js';
import { ReadingWatcher } from './handler-mqtt-proxy/index.js';
import { HANDLER_LABELS, rethrowAsTransportError } from './transport-availability.js';
import type { HandlerKey } from './transport-availability.js';

export type { ScanOptions, ScanResult } from './types.js';
export type { RawReading } from './shared.js';
export type { Watcher, WatcherConfig } from './reading-source.js';

/**
 * Resolved BLE handler identifier. The transport switch in this file used to
 * be triplicated across `scanAndReadRaw`, `scanAndRead`, and `scanDevices`;
 * `resolveHandlerKey()` is now the single source of truth (#130). The type and
 * the labels live in ./transport-availability.js, next to the package map that
 * answers "is this transport's npm package even installed here" (#364).
 */
export type { HandlerKey } from './transport-availability.js';

type NobleDriver = 'abandonware' | 'stoprocent';

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
  if (bleHandler === 'ha-bluetooth') return 'ha-bluetooth';
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

function importHandler(key: HandlerKey): Promise<CommonHandler> {
  switch (key) {
    case 'mqtt-proxy':
      return import('./handler-mqtt-proxy/index.js');
    case 'esphome-proxy':
      return import('./handler-esphome-proxy/index.js');
    case 'ha-bluetooth':
      return import('./handler-ha-bluetooth/index.js');
    case 'noble-legacy':
      return import('./handler-noble-legacy.js');
    case 'noble':
      return import('./handler-noble.js');
    case 'node-ble':
      return import('./handler-node-ble/index.js');
    default: {
      // Defensive: unreachable with the strict union, but a future caller
      // that bypasses resolveHandlerKey() (e.g. hand-typed cast) would land
      // here. Throw a clear error instead of silently returning undefined.
      const _exhaustive: never = key;
      throw new Error(`Unknown BLE handler key: ${String(_exhaustive)}`);
    }
  }
}

async function loadHandler(key: HandlerKey): Promise<CommonHandler> {
  bleLog.debug(`BLE handler: ${HANDLER_LABELS[key]}`);
  try {
    // `return await`, not a bare `return`: a bare return hands the rejection
    // to the caller without ever entering this catch.
    return await importHandler(key);
  } catch (err) {
    rethrowAsTransportError(key, err);
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

export { ReadingWatcher };

/** Inputs for {@link createReadingSource}; primitives only (no runtime ctx). */
export interface ReadingSourceOptions {
  bleHandler?: BleHandlerName;
  mqttProxy?: MqttProxyConfig;
  esphomeProxy?: EsphomeProxyConfig;
  haBluetooth?: HaBluetoothConfig;
  adapters: ScaleAdapter[];
  targetMac?: string;
  profile: UserProfile;
  scaleAuth?: ScaleAuth;
}

/**
 * Result of {@link createReadingSource}. The proxy transports return a ready
 * `watcher` (an event-driven {@link Watcher}); native transports return a `poll`
 * plan and the orchestrator builds the poll source itself (it needs the runtime
 * AppContext). `appliesGraceFloor` is the #143 BlueZ post-disconnect grace floor,
 * true only for node-ble.
 */
export type ReadingSourcePlan =
  | { kind: 'watcher'; watcher: Watcher; failureLogPrefix: string }
  | { kind: 'poll'; appliesGraceFloor: boolean };

/**
 * Single factory that owns transport selection for the continuous loop (#246).
 * Returns a watcher for the proxy transports (mqtt-proxy, esphome-proxy) or a
 * poll plan for the native ones, using the same `resolveHandlerKey` precedence
 * as the read-and-compute paths. The orchestrator never branches on handler
 * name. esphome's watcher stays a dynamic import so its deps load only on use.
 */
export async function createReadingSource(opts: ReadingSourceOptions): Promise<ReadingSourcePlan> {
  const key = resolveHandlerKey(opts.bleHandler);

  if (key === 'mqtt-proxy' && opts.mqttProxy) {
    const watcher = new ReadingWatcher(opts.mqttProxy, opts.adapters, opts.targetMac, opts.profile);
    return { kind: 'watcher', watcher, failureLogPrefix: 'Error processing reading' };
  }

  if (key === 'esphome-proxy' && opts.esphomeProxy) {
    const { ReadingWatcher: EsphomeReadingWatcher } =
      await import('./handler-esphome-proxy/index.js');
    const watcher = new EsphomeReadingWatcher(
      opts.esphomeProxy,
      opts.adapters,
      opts.targetMac,
      opts.profile,
      opts.scaleAuth,
    );
    return { kind: 'watcher', watcher, failureLogPrefix: 'Error processing ESPHome reading' };
  }

  if (key === 'ha-bluetooth' && opts.haBluetooth) {
    const { ReadingWatcher: HaReadingWatcher } = await import('./handler-ha-bluetooth/index.js');
    const watcher = new HaReadingWatcher(
      opts.haBluetooth,
      opts.adapters,
      opts.targetMac,
      opts.profile,
    );
    return {
      kind: 'watcher',
      watcher,
      failureLogPrefix: 'Error processing Home Assistant Bluetooth reading',
    };
  }

  return { kind: 'poll', appliesGraceFloor: key === 'node-ble' };
}

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
 * / bleAdapter), so the dispatch is shape-specific. It still needs the same
 * missing-package guard, or `scan` is the one command that reports a bare
 * ERR_MODULE_NOT_FOUND when an optional BLE stack was skipped (#364).
 */
export async function scanDevices(
  adapters: ScaleAdapter[],
  durationMs?: number,
  bleHandler?: BleHandlerName,
  mqttProxy?: MqttProxyConfig,
  bleAdapter?: string,
  esphomeProxy?: EsphomeProxyConfig,
  haBluetooth?: HaBluetoothConfig,
): Promise<ScanResult[]> {
  const key = resolveHandlerKey(bleHandler);
  bleLog.debug(`BLE handler: ${HANDLER_LABELS[key]}`);
  try {
    return await runScanDevices(
      key,
      adapters,
      durationMs,
      mqttProxy,
      bleAdapter,
      esphomeProxy,
      haBluetooth,
    );
  } catch (err) {
    rethrowAsTransportError(key, err);
  }
}

async function runScanDevices(
  key: HandlerKey,
  adapters: ScaleAdapter[],
  durationMs?: number,
  mqttProxy?: MqttProxyConfig,
  bleAdapter?: string,
  esphomeProxy?: EsphomeProxyConfig,
  haBluetooth?: HaBluetoothConfig,
): Promise<ScanResult[]> {
  switch (key) {
    case 'mqtt-proxy': {
      if (!mqttProxy) {
        throw new Error('mqtt_proxy config is required when ble.handler is mqtt-proxy');
      }
      const { scanDevices: impl } = await import('./handler-mqtt-proxy/index.js');
      return impl(adapters, durationMs, mqttProxy);
    }
    case 'esphome-proxy': {
      if (!esphomeProxy) {
        throw new Error('esphome_proxy config is required when ble.handler is esphome-proxy');
      }
      const { scanDevices: impl } = await import('./handler-esphome-proxy/index.js');
      return impl(adapters, durationMs, esphomeProxy);
    }
    case 'ha-bluetooth': {
      if (!haBluetooth) {
        throw new Error('ha_bluetooth config is required when ble.handler is ha-bluetooth');
      }
      const { scanDevices: impl } = await import('./handler-ha-bluetooth/index.js');
      return impl(adapters, durationMs, haBluetooth);
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
      const { scanDevices: impl } = await import('./handler-node-ble/index.js');
      return impl(adapters, durationMs, bleAdapter);
    }
  }
}
