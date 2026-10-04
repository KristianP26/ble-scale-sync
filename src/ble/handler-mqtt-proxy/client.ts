import { randomBytes } from 'node:crypto';
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

/** Client id of the persistent continuous-mode session. */
function persistentClientId(config: MqttProxyConfig): string {
  return `ble-scale-sync-${config.device_id}`;
}

/**
 * Client id for a short-lived connection: unique per connection.
 *
 * A broker closes the older of two connections that present the same client
 * id ([MQTT-3.1.4-2], aedes `registerClient`). These used to share the
 * persistent session's id, so a register or display publish while that
 * session was briefly offline kicked it (and, being `clean: true`, wiped its
 * queued QoS 1 messages), and in single-shot mode the publish kicked the scan's
 * own client mid-wait and dropped its QoS 0 replies (B-06).
 */
function ephemeralClientId(config: MqttProxyConfig): string {
  return `${persistentClientId(config)}-tx-${randomBytes(4).toString('hex')}`;
}

export async function createMqttClient(config: MqttProxyConfig): Promise<MqttClient> {
  const { connectAsync } = await import('mqtt');
  const brokerUrl = requireBrokerUrl(config);
  const clientId = ephemeralClientId(config);
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
  pendingConnect: null as Promise<MqttClient> | null,
  discoveredScaleMacs: new Set<string>(),
  /**
   * Subset of discoveredScaleMacs read from advertisements, never over GATT
   * (#422). Sent to the ESP32 so it stops autonomously connecting to them.
   */
  passiveScaleMacs: new Set<string>(),
  displayUsers: [] as DisplayUser[],
};

/** Reset all module-level proxy state (for testing only). */
export function _resetProxyState(): void {
  proxyState.persistentClient = null;
  proxyState.pendingConnect = null;
  proxyState.discoveredScaleMacs.clear();
  proxyState.passiveScaleMacs.clear();
  proxyState.displayUsers = [];
}

/** @deprecated Use _resetProxyState() instead. */
export function _resetPersistentClient(): void {
  proxyState.persistentClient = null;
  proxyState.pendingConnect = null;
}

/** @deprecated Use _resetProxyState() instead. */
export function _resetDiscoveredMacs(): void {
  proxyState.discoveredScaleMacs.clear();
  proxyState.passiveScaleMacs.clear();
}

// ─── Persistent MQTT client (for continuous mode) ────────────────────────────

export async function getOrCreatePersistentClient(config: MqttProxyConfig): Promise<MqttClient> {
  if (proxyState.persistentClient?.connected) return proxyState.persistentClient;
  // Coalesce concurrent first calls onto a single connectAsync. Without this,
  // two simultaneous callers each pass the `connected` check, both spawn a new
  // connection and one ends up orphaned (leaked socket + listeners).
  if (proxyState.pendingConnect) return proxyState.pendingConnect;
  if (proxyState.persistentClient) {
    try {
      await proxyState.persistentClient.endAsync();
    } catch {
      /* ignore */
    }
    proxyState.persistentClient = null;
  }
  const brokerUrl = requireBrokerUrl(config);
  proxyState.pendingConnect = (async () => {
    try {
      const { connectAsync } = await import('mqtt');
      const client = await withTimeout(
        connectAsync(brokerUrl, {
          clientId: persistentClientId(config),
          username: config.username ?? undefined,
          password: config.password ?? undefined,
          clean: false,
          reconnectPeriod: 5000,
        }),
        COMMAND_TIMEOUT_MS,
        `MQTT broker unreachable at ${brokerUrl}. Check your mqtt_proxy.broker_url config.`,
      );
      proxyState.persistentClient = client;
      return client;
    } finally {
      proxyState.pendingConnect = null;
    }
  })();
  return proxyState.pendingConnect;
}

/**
 * End the persistent client, if there is one, and forget it.
 *
 * Nothing else ever closes it: left open, its socket to an external broker (or
 * mqtt.js's reconnect timer once the embedded broker is gone) keeps the event
 * loop alive, and every shutdown on this transport waited out the hard exit
 * (B-16). Forced, because by the time this runs the watcher has unsubscribed
 * and nothing is waiting on an in-flight publish. A connect still in flight is
 * ended once it lands rather than awaited, so a slow broker cannot hold the
 * shutdown either.
 */
export async function closePersistentClient(): Promise<void> {
  const pending = proxyState.pendingConnect;
  if (pending) {
    pending
      .then(async (late) => {
        if (proxyState.persistentClient === late) proxyState.persistentClient = null;
        await late.endAsync(true);
      })
      .catch(() => {
        /* a connect that failed left nothing to close */
      });
  }
  const client = proxyState.persistentClient;
  proxyState.persistentClient = null;
  if (!client) return;
  try {
    await client.endAsync(true);
  } catch {
    /* already closed */
  }
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

export function isPassiveMac(mac: string): boolean {
  return proxyState.passiveScaleMacs.has(mac.toUpperCase());
}

export function addPassiveMac(mac: string): void {
  proxyState.passiveScaleMacs.add(mac.toUpperCase());
}

export function removePassiveMac(mac: string): void {
  proxyState.passiveScaleMacs.delete(mac.toUpperCase());
}

export function getPassiveMacs(): string[] {
  return [...proxyState.passiveScaleMacs];
}
