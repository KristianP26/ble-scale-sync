import type { ScaleAdapter, BleDeviceInfo, BodyComposition } from '../interfaces/scale-adapter.js';
import type { MqttProxyConfig } from '../config/schema.js';
import type { ScanOptions, ScanResult } from './types.js';
import type { RawReading } from './shared.js';
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
    config: `${base}/config`,
    beep: `${base}/beep`,
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

// ─── Core scan flow ──────────────────────────────────────────────────────────

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

// ─── Exports ──────────────────────────────────────────────────────────────────

/**
 * Scan for a BLE scale via ESP32 MQTT proxy and extract a broadcast reading.
 * Returns the raw reading + adapter WITHOUT computing body composition metrics.
 */
export async function scanAndReadRaw(opts: ScanOptions): Promise<RawReading> {
  const { targetMac, adapters } = opts;
  const config = opts.mqttProxy;
  if (!config) throw new Error('mqtt_proxy config is required for mqtt-proxy handler');

  const t = topics(config.topic_prefix, config.device_id);
  const client = await createMqttClient(config);

  try {
    await waitForEsp32Online(client, t);
    bleLog.info('ESP32 proxy is online');

    const scanResults = await mqttScan(client, t);

    // If targetMac is set, filter to just that device
    const candidates = targetMac
      ? scanResults.filter((e) => e.address.toLowerCase() === targetMac.toLowerCase())
      : scanResults;

    // Find a matching adapter
    for (const entry of candidates) {
      const info = toBleDeviceInfo(entry);
      const adapter = adapters.find((a) => a.matches(info));
      if (!adapter) continue;

      bleLog.info(`Matched: ${adapter.name} (${entry.name || entry.address})`);
      registerScaleMac(config, entry.address).catch(() => {});

      // Extract reading from broadcast advertisement data
      if (adapter.parseBroadcast && entry.manufacturer_data) {
        const mfrBuf = Buffer.from(entry.manufacturer_data, 'hex');
        const reading = adapter.parseBroadcast(mfrBuf);
        if (reading) {
          bleLog.info(`Broadcast reading: ${reading.weight} kg`);
          return { reading, adapter };
        }
      }

      throw new Error(
        `Scale ${adapter.name} found at ${entry.address} but no broadcast data available. ` +
          `Ensure the scale is actively transmitting.`,
      );
    }

    throw new Error(
      targetMac
        ? `Target device ${targetMac} not found in scan results (${scanResults.length} device(s)).`
        : `No recognized scale found via ESP32 proxy. ` +
            `Scanned ${scanResults.length} device(s). ` +
            `Adapters: ${adapters.map((a) => a.name).join(', ')}`,
    );
  } finally {
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
