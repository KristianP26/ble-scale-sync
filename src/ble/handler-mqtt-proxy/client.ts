import type { MqttProxyConfig } from '../../config/schema.js';
import { withTimeout } from '../types.js';
import { COMMAND_TIMEOUT_MS } from './topics.js';

export type MqttClient = Awaited<ReturnType<typeof import('mqtt').connectAsync>>;

export interface DisplayUser {
  slug: string;
  name: string;
  weight_range: { min: number; max: number };
}

/**
 * Resolve the broker URL from config, throwing a helpful error if neither an
 * external broker nor the embedded broker has provided one.
 */
function requireBrokerUrl(config: MqttProxyConfig): string {
  if (!config.broker_url) {
    throw new Error(
      'mqtt_proxy.broker_url is not set and the embedded broker has not been started. ' +
        'Either configure an external broker URL, or run through the mqtt-proxy bootstrap ' +
        'which starts the embedded broker automatically.',
    );
  }
  return config.broker_url;
}

export async function createMqttClient(config: MqttProxyConfig): Promise<MqttClient> {
  const { connectAsync } = await import('mqtt');
  const brokerUrl = requireBrokerUrl(config);
  const clientId = `ble-scale-sync-${config.device_id}`;
  const client = await withTimeout(
    connectAsync(brokerUrl, {
      clientId,
      username: config.username ?? undefined,
      password: config.password ?? undefined,
      clean: true,
    }),
    COMMAND_TIMEOUT_MS,
    `MQTT broker unreachable at ${brokerUrl}. Check your mqtt_proxy.broker_url config.`,
  );
  return client;
}

// ─── Shared proxy state (module-private) ─────────────────────────────────────

/**
 * Module-level state shared across MQTT proxy functions.
 * Owned exclusively by this module; other modules go through the accessor
 * helpers below so the mutable state stays explicit and resettable in tests.
 */
const proxyState = {
  persistentClient: null as MqttClient | null,
  discoveredScaleMacs: new Set<string>(),
  displayUsers: [] as DisplayUser[],
};

/** Reset all module-level proxy state (for testing only). */
export function _resetProxyState(): void {
  proxyState.persistentClient = null;
  proxyState.discoveredScaleMacs.clear();
  proxyState.displayUsers = [];
}

/** @deprecated Use _resetProxyState() instead. */
export function _resetPersistentClient(): void {
  proxyState.persistentClient = null;
}

/** @deprecated Use _resetProxyState() instead. */
export function _resetDiscoveredMacs(): void {
  proxyState.discoveredScaleMacs.clear();
}

// ─── Persistent MQTT client (for continuous mode) ────────────────────────────

export async function getOrCreatePersistentClient(config: MqttProxyConfig): Promise<MqttClient> {
  if (proxyState.persistentClient?.connected) return proxyState.persistentClient;
  if (proxyState.persistentClient) {
    try {
      await proxyState.persistentClient.endAsync();
    } catch {
      /* ignore */
    }
  }
  const { connectAsync } = await import('mqtt');
  const brokerUrl = requireBrokerUrl(config);
  proxyState.persistentClient = await withTimeout(
    connectAsync(brokerUrl, {
      clientId: `ble-scale-sync-${config.device_id}`,
      username: config.username ?? undefined,
      password: config.password ?? undefined,
      clean: false,
      reconnectPeriod: 5000,
    }),
    COMMAND_TIMEOUT_MS,
    `MQTT broker unreachable at ${brokerUrl}. Check your mqtt_proxy.broker_url config.`,
  );
  return proxyState.persistentClient;
}

/** Get the persistent client if connected, otherwise create an ephemeral one. */
export async function getClient(
  config: MqttProxyConfig,
): Promise<{ client: MqttClient; ephemeral: boolean }> {
  if (proxyState.persistentClient?.connected) {
    return { client: proxyState.persistentClient, ephemeral: false };
  }
  return { client: await createMqttClient(config), ephemeral: true };
}

/** End an ephemeral client; no-op for the persistent client. */
export async function releaseClient(client: MqttClient, ephemeral: boolean): Promise<void> {
  if (!ephemeral) return;
  try {
    await client.endAsync();
  } catch {
    /* ignore */
  }
}

// ─── State accessors (used by display.ts and watcher.ts) ─────────────────────

export function getDisplayUsers(): DisplayUser[] {
  return proxyState.displayUsers;
}

export function setDisplayUsers(users: DisplayUser[]): void {
  proxyState.displayUsers = users;
}

export function hasDiscoveredMac(mac: string): boolean {
  return proxyState.discoveredScaleMacs.has(mac.toUpperCase());
}

export function addDiscoveredMac(mac: string): void {
  proxyState.discoveredScaleMacs.add(mac.toUpperCase());
}

export function getDiscoveredMacs(): string[] {
  return [...proxyState.discoveredScaleMacs];
}

export function discoveredMacsCount(): number {
  return proxyState.discoveredScaleMacs.size;
}
