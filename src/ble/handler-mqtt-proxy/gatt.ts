import type { BleChar, BleDevice } from '../shared.js';
import { withTimeout, bleLog } from '../types.js';
import { COMMAND_TIMEOUT_MS, type Topics } from './topics.js';
import type { MqttClient } from './client.js';

/** Implements BleChar from shared.ts over MQTT topics. */
export class MqttBleChar implements BleChar {
  constructor(
    private client: MqttClient,
    private base: string,
    private uuid: string,
  ) {}

  async subscribe(onData: (data: Buffer) => void): Promise<() => void> {
    const topic = `${this.base}/notify/${this.uuid}`;
    const handler = (t: string, payload: Buffer) => {
      if (t === topic) onData(payload);
    };
    this.client.on('message', handler);
    await this.client.subscribeAsync(topic);
    return () => {
      this.client.removeListener('message', handler);
    };
  }

  async write(data: Buffer, _withResponse: boolean): Promise<void> {
    await this.client.publishAsync(`${this.base}/write/${this.uuid}`, data);
  }

  async read(): Promise<Buffer> {
    const responseTopic = `${this.base}/read/${this.uuid}/response`;
    const handler = (t: string, payload: Buffer) => {
      if (t === responseTopic) {
        this.client.removeListener('message', handler);
        resolveOuter(payload);
      }
    };
    let resolveOuter!: (buf: Buffer) => void;
    const promise = new Promise<Buffer>((resolve) => {
      resolveOuter = resolve;
    });
    this.client.on('message', handler);
    try {
      await this.client.subscribeAsync(responseTopic);
      await this.client.publishAsync(`${this.base}/read/${this.uuid}`, '');
      return await withTimeout(
        promise,
        COMMAND_TIMEOUT_MS,
        `Read response timeout for ${this.uuid}`,
      );
    } finally {
      this.client.removeListener('message', handler);
      this.client.unsubscribeAsync(responseTopic).catch(() => {});
    }
  }
}

/** Implements BleDevice from shared.ts. Watches for MQTT disconnect events. */
export class MqttBleDevice implements BleDevice {
  private disconnectCb?: () => void;
  private handler?: (topic: string, payload: Buffer) => void;

  constructor(
    private client: MqttClient,
    private disconnectedTopic: string,
  ) {
    this.handler = (topic) => {
      if (topic === this.disconnectedTopic) this.disconnectCb?.();
    };
    client.on('message', this.handler);
  }

  onDisconnect(callback: () => void): void {
    this.disconnectCb = callback;
  }

  cleanup(): void {
    if (this.handler) this.client.removeListener('message', this.handler);
  }
}

/** Send GATT connect command over MQTT and wait for the connected response with char list. */
export async function mqttGattConnect(
  client: MqttClient,
  t: Topics,
  address: string,
  addrType: number,
): Promise<{ charMap: Map<string, BleChar>; device: MqttBleDevice }> {
  await client.subscribeAsync(t.connected);
  await client.subscribeAsync(t.disconnected);
  await client.subscribeAsync(t.error);

  const response = await withTimeout(
    new Promise<{ chars: Array<{ uuid: string; properties: string[] }> }>((resolve, reject) => {
      const handler = (topic: string, payload: Buffer) => {
        if (topic === t.connected) {
          let data: Record<string, unknown>;
          try {
            data = JSON.parse(payload.toString());
          } catch (err) {
            client.removeListener('message', handler);
            reject(new Error(`Invalid connected payload from ESP32: ${err}`));
            return;
          }
          // Ignore autonomous connects from ESP32 — those are handled by
          // ReadingWatcher.handleAutonomousConnect, not mqttGattConnect (#201).
          if (data.autonomous) return;
          client.removeListener('message', handler);
          resolve(data as { chars: Array<{ uuid: string; properties: string[] }> });
        }
        if (topic === t.error) {
          client.removeListener('message', handler);
          // Older firmware (and MicroPython exceptions like asyncio.TimeoutError
          // whose str() is empty) can publish a blank payload — surface a
          // placeholder so the host log is not a dangling "ESP32 error:".
          const detail = payload.toString() || '(no detail)';
          reject(new Error(`ESP32 error: ${detail}`));
        }
      };
      client.on('message', handler);
      client
        .publishAsync(t.connect, JSON.stringify({ address, addr_type: addrType }))
        .catch(reject);
    }),
    COMMAND_TIMEOUT_MS,
    `GATT connect timeout for ${address}`,
  );

  const charMap = new Map<string, BleChar>();
  for (const char of response.chars) {
    // Normalize the key to lowercase so adapter lookups match regardless of case.
    // The MQTT topic uses the original UUID from the ESP32.
    charMap.set(char.uuid.toLowerCase(), new MqttBleChar(client, t.base, char.uuid));
  }

  const device = new MqttBleDevice(client, t.disconnected);
  return { charMap, device };
}

/** Send GATT disconnect command over MQTT. */
export async function mqttGattDisconnect(client: MqttClient, t: Topics): Promise<void> {
  await client.publishAsync(t.disconnect, '');
}

/**
 * Build charMap and MqttBleDevice from an autonomous connect payload.
 *
 * When the ESP32 auto-connects to a known scale (#201), it publishes the
 * same `connected` payload with an extra `autonomous: true` flag. The host
 * skips mqttGattConnect() and uses this helper to set up the GATT abstractions.
 */
export function buildCharMapFromPayload(
  client: MqttClient,
  t: Topics,
  chars: Array<{ uuid: string; properties: string[] }>,
): { charMap: Map<string, BleChar>; device: MqttBleDevice } {
  const charMap = new Map<string, BleChar>();
  for (const char of chars) {
    charMap.set(char.uuid.toLowerCase(), new MqttBleChar(client, t.base, char.uuid));
  }
  const device = new MqttBleDevice(client, t.disconnected);
  bleLog.debug(
    `buildCharMapFromPayload: ${chars.length} chars (${chars.map((c) => c.uuid).join(', ')})`,
  );
  return { charMap, device };
}
