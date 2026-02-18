import type { ScaleAdapter, BleDeviceInfo, BodyComposition } from '../interfaces/scale-adapter.js';
import type { MqttProxyConfig } from '../config/schema.js';
import type { ScanOptions, ScanResult } from './types.js';
import type { BleChar, BleDevice, RawReading } from './shared.js';
import { waitForRawReading } from './shared.js';
import { bleLog, normalizeUuid, withTimeout } from './types.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const COMMAND_TIMEOUT_MS = 30_000;

// ─── Types ────────────────────────────────────────────────────────────────────

interface ScanResultEntry {
  address: string;
  name: string;
  rssi: number;
  services: string[];
  addr_type?: number;
  manufacturer_id?: number | null;
  manufacturer_data?: string | null;
}

interface ConnectedPayload {
  chars: Array<{ uuid: string; properties: string[] }>;
}

/** Build BleDeviceInfo from a scan result entry, including manufacturer data. */
function toBleDeviceInfo(entry: ScanResultEntry): BleDeviceInfo {
  const info: BleDeviceInfo = {
    localName: entry.name,
    serviceUuids: entry.services.map(normalizeUuid),
  };
  if (entry.manufacturer_id != null && entry.manufacturer_data) {
    info.manufacturerData = {
      id: entry.manufacturer_id,
      data: Buffer.from(entry.manufacturer_data, 'hex'),
    };
  }
  return info;
}

// ─── Topic helpers ────────────────────────────────────────────────────────────

function topics(prefix: string, deviceId: string) {
  const base = `${prefix}/${deviceId}`;
  return {
    status: `${base}/status`,
    scanResults: `${base}/scan/results`,
    connect: `${base}/connect`,
    connected: `${base}/connected`,
    disconnect: `${base}/disconnect`,
    disconnected: `${base}/disconnected`,
    config: `${base}/config`,
    beep: `${base}/beep`,
    notify: (uuid: string) => `${base}/notify/${uuid}`,
    write: (uuid: string) => `${base}/write/${uuid}`,
    read: (uuid: string) => `${base}/read/${uuid}`,
    readResponse: (uuid: string) => `${base}/read/${uuid}/response`,
  };
}

// ─── MQTT client helpers ──────────────────────────────────────────────────────

type MqttClient = Awaited<ReturnType<typeof import('mqtt').connectAsync>>;

async function createMqttClient(config: MqttProxyConfig): Promise<MqttClient> {
  const { connectAsync } = await import('mqtt');
  const clientId = `ble-scale-sync-${config.device_id}`;
  const client = await withTimeout(
    connectAsync(config.broker_url, {
      clientId,
      username: config.username ?? undefined,
      password: config.password ?? undefined,
      clean: true,
    }),
    COMMAND_TIMEOUT_MS,
    `MQTT broker unreachable at ${config.broker_url}. Check your mqtt_proxy.broker_url config.`,
  );
  return client;
}

async function waitForEsp32Online(client: MqttClient, t: ReturnType<typeof topics>): Promise<void> {
  const onMessage = (topic: string, payload: Buffer) => {
    if (topic === t.status) {
      const msg = payload.toString();
      if (msg === 'online') resolve();
      else if (msg === 'offline')
        reject(new Error('ESP32 proxy is offline. Check the device and its WiFi/MQTT connection.'));
    }
  };
  let resolve!: () => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  client.on('message', onMessage);
  await client.subscribeAsync(t.status);
  try {
    return await withTimeout(
      promise,
      COMMAND_TIMEOUT_MS,
      'ESP32 proxy did not respond. Check that it is powered on and connected to MQTT.',
    );
  } finally {
    client.removeListener('message', onMessage);
  }
}

// ─── BLE abstractions over MQTT ───────────────────────────────────────────────

function wrapChar(client: MqttClient, t: ReturnType<typeof topics>, uuid: string): BleChar {
  return {
    subscribe: async (onData) => {
      const topic = t.notify(uuid);
      const handler = (msgTopic: string, payload: Buffer) => {
        if (msgTopic === topic) onData(payload);
      };
      client.on('message', handler);
      await client.subscribeAsync(topic);
      return () => {
        client.removeListener('message', handler);
        client.unsubscribe(topic);
      };
    },
    write: async (data, _withResponse) => {
      await client.publishAsync(t.write(uuid), data);
    },
    read: async () => {
      const responseTopic = t.readResponse(uuid);
      let resolveRead!: (buf: Buffer) => void;
      const promise = new Promise<Buffer>((res) => {
        resolveRead = res;
      });
      const handler = (msgTopic: string, payload: Buffer) => {
        if (msgTopic === responseTopic) resolveRead(payload);
      };
      client.on('message', handler);
      await client.subscribeAsync(responseTopic);
      await client.publishAsync(t.read(uuid), '');
      try {
        return await withTimeout(
          promise,
          COMMAND_TIMEOUT_MS,
          `Read response timeout for characteristic ${uuid}`,
        );
      } finally {
        client.removeListener('message', handler);
        client.unsubscribe(responseTopic);
      }
    },
  };
}

async function wrapDevice(
  client: MqttClient,
  t: ReturnType<typeof topics>,
): Promise<BleDevice & { destroy: () => void }> {
  const callbacks: Array<() => void> = [];
  let fired = false;

  const fire = () => {
    if (fired) return;
    fired = true;
    for (const cb of callbacks) cb();
  };

  const handler = (topic: string, payload: Buffer) => {
    if (topic === t.disconnected) fire();
    if (topic === t.status && payload.toString() === 'offline') fire();
  };

  client.on('message', handler);
  await client.subscribeAsync(t.disconnected);

  return {
    onDisconnect: (callback) => {
      callbacks.push(callback);
      if (fired) callback();
    },
    destroy: () => {
      client.removeListener('message', handler);
    },
  };
}

// ─── Core scan/connect flow ───────────────────────────────────────────────────

async function mqttScan(
  client: MqttClient,
  t: ReturnType<typeof topics>,
): Promise<ScanResultEntry[]> {
  let resolveResults!: (entries: ScanResultEntry[]) => void;
  let rejectResults!: (err: Error) => void;
  const promise = new Promise<ScanResultEntry[]>((res, rej) => {
    resolveResults = res;
    rejectResults = rej;
  });
  const handler = (topic: string, payload: Buffer) => {
    if (topic === t.scanResults) {
      try {
        resolveResults(JSON.parse(payload.toString()) as ScanResultEntry[]);
      } catch (err) {
        rejectResults(new Error(`ESP32 sent invalid scan results: ${err}`));
      }
    }
  };
  client.on('message', handler);
  await client.subscribeAsync(t.scanResults);
  // ESP32 scans autonomously — just wait for the next result
  try {
    return await withTimeout(
      promise,
      COMMAND_TIMEOUT_MS,
      'No scan results received from ESP32. Check that it is powered on and scanning.',
    );
  } finally {
    client.removeListener('message', handler);
  }
}

async function mqttConnect(
  client: MqttClient,
  t: ReturnType<typeof topics>,
  address: string,
  addrType = 0,
): Promise<ConnectedPayload> {
  let resolveConn!: (payload: ConnectedPayload) => void;
  let rejectConn!: (err: Error) => void;
  const promise = new Promise<ConnectedPayload>((res, rej) => {
    resolveConn = res;
    rejectConn = rej;
  });
  const handler = (topic: string, payload: Buffer) => {
    if (topic === t.connected) {
      try {
        resolveConn(JSON.parse(payload.toString()) as ConnectedPayload);
      } catch (err) {
        rejectConn(new Error(`ESP32 sent invalid connect response: ${err}`));
      }
    }
  };
  client.on('message', handler);
  await client.subscribeAsync(t.connected);
  await client.publishAsync(t.connect, JSON.stringify({ address, addr_type: addrType }));
  try {
    return await withTimeout(
      promise,
      COMMAND_TIMEOUT_MS,
      `ESP32 failed to connect to BLE device ${address}. Check that the scale is powered on and in range.`,
    );
  } finally {
    client.removeListener('message', handler);
  }
}

// ─── Exports ──────────────────────────────────────────────────────────────────

/**
 * Scan for a BLE scale via ESP32 MQTT proxy, read weight + impedance.
 * Returns the raw reading + adapter WITHOUT computing body composition metrics.
 */
export async function scanAndReadRaw(opts: ScanOptions): Promise<RawReading> {
  const { targetMac, adapters, profile, weightUnit, onLiveData } = opts;
  const config = opts.mqttProxy;
  if (!config) throw new Error('mqtt_proxy config is required for mqtt-proxy handler');

  const t = topics(config.topic_prefix, config.device_id);
  const client = await createMqttClient(config);
  const bleDevice = await wrapDevice(client, t);

  try {
    await waitForEsp32Online(client, t);
    bleLog.info('ESP32 proxy is online');

    let matchedAdapter: ScaleAdapter;
    let connected: ConnectedPayload | undefined;
    let resolvedMac: string | undefined;

    if (targetMac) {
      // Connect first, then match adapter from GATT characteristics
      resolvedMac = targetMac;
      if (config) registerScaleMac(config, resolvedMac).catch(() => {});
      bleLog.info(`Connecting to ${targetMac} via ESP32 proxy...`);
      connected = await mqttConnect(client, t, targetMac);
      const charUuids = connected.chars.map((c) => normalizeUuid(c.uuid));
      const info: BleDeviceInfo = { localName: '', serviceUuids: charUuids };
      const found = adapters.find((a) => a.matches(info));

      if (!found) {
        // Scan to get the device name for adapter matching
        bleLog.debug('No adapter matched by char UUIDs, scanning for device name...');
        const scanResults = await mqttScan(client, t);
        const device = scanResults.find((d) => d.address.toLowerCase() === targetMac.toLowerCase());
        const name = device?.name ?? '';
        const infoWithName: BleDeviceInfo = { localName: name, serviceUuids: charUuids };
        const byName = adapters.find((a) => a.matches(infoWithName));
        if (!byName) {
          throw new Error(
            `Device found (${name || targetMac}) but no adapter recognized it. ` +
              `Char UUIDs: [${charUuids.join(', ')}]. ` +
              `Adapters: ${adapters.map((a) => a.name).join(', ')}`,
          );
        }
        matchedAdapter = byName;
      } else {
        matchedAdapter = found;
      }
    } else {
      // Auto-discovery: scan, find a matching adapter, then connect
      bleLog.info('Scanning for BLE devices via ESP32 proxy...');
      const scanResults = await mqttScan(client, t);

      let matched: { entry: ScanResultEntry; adapter: ScaleAdapter } | null = null;
      for (const entry of scanResults) {
        const info = toBleDeviceInfo(entry);
        const adapter = adapters.find((a) => a.matches(info));
        if (adapter) {
          matched = { entry, adapter };
          break;
        }
      }

      if (!matched) {
        throw new Error(
          `No recognized scale found via ESP32 proxy. ` +
            `Scanned ${scanResults.length} device(s). ` +
            `Adapters: ${adapters.map((a) => a.name).join(', ')}`,
        );
      }

      matchedAdapter = matched.adapter;
      resolvedMac = matched.entry.address;
      bleLog.info(
        `Auto-discovered: ${matchedAdapter.name} (${matched.entry.name || matched.entry.address})`,
      );

      // Register MAC so ESP32 beeps on future scans (before connect attempt)
      if (config) registerScaleMac(config, resolvedMac).catch(() => {});

      // Broadcast adapter — extract reading directly from advertisement data
      if (matchedAdapter.parseBroadcast && matched.entry.manufacturer_data) {
        const mfrBuf = Buffer.from(matched.entry.manufacturer_data, 'hex');
        const reading = matchedAdapter.parseBroadcast(mfrBuf);
        if (reading) {
          bleLog.info(`Broadcast reading: ${reading.weight} kg (no GATT connection needed)`);
          return { reading, adapter: matchedAdapter };
        }
      }

      bleLog.info(`Connecting to ${matched.entry.address} via ESP32 proxy...`);
      connected = await mqttConnect(client, t, matched.entry.address, matched.entry.addr_type);
    }

    bleLog.info(`Matched adapter: ${matchedAdapter.name}`);

    // Build charMap from the connected payload
    if (!connected) throw new Error('BLE connection was not established');
    const charMap = new Map<string, BleChar>();
    for (const charInfo of connected.chars) {
      const normalized = normalizeUuid(charInfo.uuid);
      charMap.set(normalized, wrapChar(client, t, normalized));
    }

    bleLog.debug(`Characteristics: [${[...charMap.keys()].join(', ')}]`);

    // Wait for a complete reading using shared logic
    const raw = await waitForRawReading(
      charMap,
      bleDevice,
      matchedAdapter,
      profile,
      weightUnit,
      onLiveData,
    );

    // Disconnect the BLE device on the ESP32
    await client.publishAsync(t.disconnect, '');
    return raw;
  } finally {
    bleDevice.destroy();
    try {
      await client.endAsync();
    } catch {
      /* ignore */
    }
  }
}

export async function scanAndRead(opts: ScanOptions): Promise<BodyComposition> {
  const { reading, adapter } = await scanAndReadRaw(opts);
  return adapter.computeMetrics(reading, opts.profile);
}

/** Tracked scale MACs discovered via adapter matching. */
const discoveredScaleMacs = new Set<string>();

export async function publishConfig(config: MqttProxyConfig, scales: string[]): Promise<void> {
  const t = topics(config.topic_prefix, config.device_id);
  const client = await createMqttClient(config);
  try {
    await client.publishAsync(t.config, JSON.stringify({ scales }), { retain: true });
  } finally {
    try {
      await client.endAsync();
    } catch {
      /* ignore */
    }
  }
}

/**
 * Register a discovered scale MAC and publish the updated set to the ESP32.
 * Called after a successful adapter match so the ESP32 can beep on future scans.
 */
export async function registerScaleMac(config: MqttProxyConfig, mac: string): Promise<void> {
  const upper = mac.toUpperCase();
  if (discoveredScaleMacs.has(upper)) return; // already known
  discoveredScaleMacs.add(upper);
  bleLog.info(`Registered scale MAC ${upper} for ESP32 beep (${discoveredScaleMacs.size} total)`);
  await publishConfig(config, [...discoveredScaleMacs]);
}

export async function publishBeep(
  config: MqttProxyConfig,
  freq?: number,
  duration?: number,
  repeat?: number,
): Promise<void> {
  const t = topics(config.topic_prefix, config.device_id);
  const client = await createMqttClient(config);
  try {
    const payload =
      freq != null || duration != null || repeat != null
        ? JSON.stringify({
            ...(freq != null ? { freq } : {}),
            ...(duration != null ? { duration } : {}),
            ...(repeat != null ? { repeat } : {}),
          })
        : '';
    await client.publishAsync(t.beep, payload);
  } finally {
    try {
      await client.endAsync();
    } catch {
      /* ignore */
    }
  }
}

export async function scanDevices(
  adapters: ScaleAdapter[],
  _durationMs?: number,
  config?: MqttProxyConfig,
): Promise<ScanResult[]> {
  if (!config) throw new Error('mqtt_proxy config is required for mqtt-proxy handler');

  const t = topics(config.topic_prefix, config.device_id);
  const client = await createMqttClient(config);

  try {
    await waitForEsp32Online(client, t);
    const scanResults = await mqttScan(client, t);

    return scanResults.map((entry) => {
      const info = toBleDeviceInfo(entry);
      const matched = adapters.find((a) => a.matches(info));
      return {
        address: entry.address,
        name: entry.name,
        matchedAdapter: matched?.name,
      };
    });
  } finally {
    try {
      await client.endAsync();
    } catch {
      /* ignore */
    }
  }
}
