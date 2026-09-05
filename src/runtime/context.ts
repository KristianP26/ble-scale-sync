import type {
  AppConfig,
  MqttProxyConfig,
  EsphomeProxyConfig,
  WeightUnit,
} from '../config/schema.js';
import type { BleHandlerName } from '../ble/types.js';
import type { ConfigSource } from '../config/load.js';
import type { ResolvedRuntimeConfig } from '../config/resolve.js';
import type { EmbeddedBrokerHandle } from '../ble/embedded-broker.js';
import type { Exporter } from '../interfaces/exporter.js';
import type { DisplayNotifier } from '../interfaces/display-notifier.js';

export interface AppContext {
  // Hot-swappable on reload
  config: AppConfig;
  scaleMac: string | undefined;
  weightUnit: WeightUnit;
  dryRun: boolean;
  mqttProxy: MqttProxyConfig | undefined;

  // Frozen for process lifetime
  readonly configSource: ConfigSource;
  readonly configPath: string | undefined;
  readonly bleHandler: BleHandlerName;
  readonly bleAdapter: string | undefined;
  readonly esphomeProxy: EsphomeProxyConfig | undefined;
  readonly signal: AbortSignal;
  readonly exporterCache: Map<string, Exporter[]>;

  /**
   * Per-user runtime anchor of the last successfully-exported weight, keyed by
   * user slug. Single-user mode uses this (not config) as its #164 replay-dedup
   * anchor, since it never writes last_known_weight. Survives config reload (it
   * is process-lifetime dedup state, NOT a hot-swap field), so setConfig must
   * not clear it.
   */
  readonly lastExportedWeights: Map<string, number>;

  // Lifecycle handle (mqtt-proxy only; set after bootstrapMqttProxy)
  embeddedBroker: EmbeddedBrokerHandle | null;

  /** Display/beep capability (mqtt-proxy only; set after bootstrapMqttProxy). */
  display?: DisplayNotifier;

  /** Replace hot-swap fields after reloading config.yaml. */
  setConfig(next: AppConfig, resolved: ResolvedRuntimeConfig): void;

  /**
   * Request graceful shutdown of the app from a subsystem (e.g. consecutive-
   * failure watchdog). Triggers the same path as SIGTERM: aborts the loop,
   * runs main()'s finally for heartbeat-stop and broker cleanup. Caller
   * should also set process.exitCode if a non-zero exit is required.
   */
  abortApp(reason?: unknown): void;
}

export interface AppContextInit {
  config: AppConfig;
  resolved: ResolvedRuntimeConfig;
  configSource: ConfigSource;
  configPath: string | undefined;
  signal: AbortSignal;
  abortApp: (reason?: unknown) => void;
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
    lastExportedWeights: new Map(),

    embeddedBroker: null,

    abortApp: init.abortApp,

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
