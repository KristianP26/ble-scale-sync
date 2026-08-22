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
    try {
      await this.client.subscribeAsync(topic);
      // Ordering is the whole point of #231: the MQTT notify subscription and the
      // message handler are in place BEFORE we tell the firmware to enable BLE
      // notify, so the firmware-triggered kickoff frame (QN/Renpho 0x12) always has
      // a listener. New firmware enables notify on this command; old firmware (eager)
      // ignores it and behaves exactly as before.
      await this.client.publishAsync(`${this.base}/subscribe/${this.uuid}`, '');
    } catch (err) {
      // A failed setup returns no unsubscriber, so the listener must not outlive
      // this call: the client is persistent and every leaked listener re-processes
      // all later notifications.
      this.client.removeListener('message', handler);
      throw err;
    }
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

  /**
   * Abandon this session locally, as if the ESP32 had reported a disconnect.
   * Used when a newer autonomous connect supersedes an in-flight one (#296).
   */
  fireDisconnect(): void {
    this.disconnectCb?.();
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

  let resolveResponse!: (v: { chars: Array<{ uuid: string; properties: string[] }> }) => void;
  let rejectResponse!: (err: Error) => void;
  const responsePromise = new Promise<{ chars: Array<{ uuid: string; properties: string[] }> }>(
    (resolve, reject) => {
      resolveResponse = resolve;
      rejectResponse = reject;
    },
  );
  const handler = (topic: string, payload: Buffer) => {
    if (topic === t.connected) {
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(payload.toString());
      } catch (err) {
        rejectResponse(new Error(`Invalid connected payload from ESP32: ${err}`));
        return;
      }
      // Ignore autonomous connects from ESP32 — those are handled by
      // ReadingWatcher.handleAutonomousConnect, not mqttGattConnect (#201).
      if (data.autonomous) return;
      resolveResponse(data as { chars: Array<{ uuid: string; properties: string[] }> });
    }
    if (topic === t.error) {
      // Older firmware (and MicroPython exceptions like asyncio.TimeoutError
      // whose str() is empty) can publish a blank payload — surface a
      // placeholder so the host log is not a dangling "ESP32 error:".
      const detail = payload.toString() || '(no detail)';
      rejectResponse(new Error(`ESP32 error: ${detail}`));
    }
  };
  client.on('message', handler);
  let response: { chars: Array<{ uuid: string; properties: string[] }> };
  try {
    client
      .publishAsync(t.connect, JSON.stringify({ address, addr_type: addrType }))
      .catch(rejectResponse);
    response = await withTimeout(
      responsePromise,
      COMMAND_TIMEOUT_MS,
      `GATT connect timeout for ${address}`,
    );
  } finally {
    // The handler previously removed itself only when a response arrived, so a
    // connect timeout left it on the persistent client forever.
    client.removeListener('message', handler);
  }

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
