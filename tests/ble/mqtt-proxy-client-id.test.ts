import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { startEmbeddedBroker, type EmbeddedBrokerHandle } from '../../src/ble/embedded-broker.js';
import {
  createMqttClient,
  getOrCreatePersistentClient,
  _resetProxyState,
  type MqttClient,
} from '../../src/ble/handler-mqtt-proxy/client.js';
import type { MqttProxyConfig } from '../../src/config/schema.js';

/**
 * Regression guard for B-06, against a real broker on purpose: the other
 * mqtt-proxy suites mock `mqtt`, and a mock cannot show a broker closing the
 * older of two connections that present the same client id ([MQTT-3.1.4-2],
 * aedes `registerClient`).
 */
let broker: EmbeddedBrokerHandle;
const opened: MqttClient[] = [];

beforeAll(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  broker = await startEmbeddedBroker({ port: 0, bindHost: '127.0.0.1' });
});

afterEach(async () => {
  for (const c of opened.splice(0)) await c.endAsync(true).catch(() => {});
  _resetProxyState();
});

afterAll(async () => {
  await broker.close();
  vi.restoreAllMocks();
});

function config(): MqttProxyConfig {
  return {
    device_id: 'esp32-ble-proxy',
    topic_prefix: 'ble-proxy',
    embedded_broker_port: 0,
    embedded_broker_bind: '127.0.0.1',
    broker_url: broker.url,
  } as MqttProxyConfig;
}

/** Resolves true if `client` loses its connection within `ms`. */
function dropsWithin(client: MqttClient, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    client.once('close', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

describe('mqtt-proxy client ids (B-06)', () => {
  it('a short-lived client does not take over the persistent session', async () => {
    const persistent = await getOrCreatePersistentClient(config());
    opened.push(persistent);
    const dropped = dropsWithin(persistent, 500);
    // What registerScaleMac or a display publish does while the persistent
    // client is reconnecting.
    const ephemeral = await createMqttClient(config());
    opened.push(ephemeral);
    expect(await dropped).toBe(false);
    expect(persistent.connected).toBe(true);
  });

  it('two short-lived clients do not knock each other off', async () => {
    // Single-shot scan holds one while registerScaleMac opens another.
    const scan = await createMqttClient(config());
    opened.push(scan);
    const dropped = dropsWithin(scan, 500);
    const other = await createMqttClient(config());
    opened.push(other);
    expect(await dropped).toBe(false);
    expect(scan.connected).toBe(true);
  });
});
