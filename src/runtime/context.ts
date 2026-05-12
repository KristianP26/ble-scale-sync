import type {
  AppConfig,
  MqttProxyConfig,
  EsphomeProxyConfig,
  WeightUnit,
} from '../config/schema.js';
import type { BleHandlerName } from '../ble/types.js';
import type { ResolvedRuntimeConfig } from '../config/resolve.js';
import type { EmbeddedBrokerHandle } from '../ble/embedded-broker.js';
import type { Exporter } from '../interfaces/exporter.js';

/**
 * Mutable record that bundles the runtime state previously held as top-level
 * `let` bindings in `src/index.ts`. Loop and processor pull from this on every
 * iteration; reload mutates the hot-swap fields in place via `setConfig`.
 *
 * Frozen-for-lifetime fields (handler, adapter, signal) are read once at
 * startup and never reassigned.
 */
export interface AppContext {
  // Hot-swappable on reload
  config: AppConfig;
  scaleMac: string | undefined;
  weightUnit: WeightUnit;
  dryRun: boolean;
  mqttProxy: MqttProxyConfig | undefined;

  // Frozen for process lifetime
  readonly configSource: 'env' | 'yaml' | 'none';
  readonly configPath: string | undefined;
  readonly bleHandler: BleHandlerName;
  readonly bleAdapter: string | undefined;
  readonly esphomeProxy: EsphomeProxyConfig | undefined;
  readonly signal: AbortSignal;
  readonly exporterCache: Map<string, Exporter[]>;

  // Lifecycle handle (mqtt-proxy only; set after bootstrapMqttProxy)
  embeddedBroker: EmbeddedBrokerHandle | null;

  /** Replace hot-swap fields after reloading config.yaml. */
  setConfig(next: AppConfig, resolved: ResolvedRuntimeConfig): void;
}

export interface AppContextInit {
  config: AppConfig;
  resolved: ResolvedRuntimeConfig;
  configSource: 'env' | 'yaml' | 'none';
  configPath: string | undefined;
  signal: AbortSignal;
}

export function createAppContext(init: AppContextInit): AppContext {
  const ctx: AppContext = {
    config: init.config,
    scaleMac: init.resolved.scaleMac,
    weightUnit: init.resolved.weightUnit,
    dryRun: init.resolved.dryRun,
    mqttProxy: init.resolved.mqttProxy,

    configSource: init.configSource,
    configPath: init.configPath,
    bleHandler: init.resolved.bleHandler,
    bleAdapter: init.resolved.bleAdapter,
    esphomeProxy: init.resolved.esphomeProxy,
    signal: init.signal,
    exporterCache: new Map(),

    embeddedBroker: null,

    setConfig(next, resolved) {
      this.config = next;
      this.scaleMac = resolved.scaleMac;
      this.weightUnit = resolved.weightUnit;
      this.dryRun = resolved.dryRun;
      // mqttProxy is hot-swappable but `bleHandler` decides whether it is
      // actually used. Restart-required diff warns on handler changes.
      this.mqttProxy = resolved.mqttProxy;
      this.exporterCache.clear();
    },
  };
  return ctx;
}
