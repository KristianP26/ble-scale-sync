import type {
  ScaleAdapter,
  BleDeviceInfo,
  BodyComposition,
} from '../../interfaces/scale-adapter.js';
import type { MqttProxyConfig } from '../../config/schema.js';
import type { ScanOptions, ScanResult } from '../types.js';
import type { RawReading } from '../shared.js';
import { waitForRawReading } from '../shared.js';
import { resolveAdapter } from '../../scales/resolve.js';
import { evaluateAdvertisement, logAdvert } from '../advertisement.js';
import { bleLog, normalizeUuid, withTimeout } from '../types.js';
import { COMMAND_TIMEOUT_MS, topics, type Topics } from './topics.js';
import { type MqttClient, createMqttClient } from './client.js';
import { mqttGattConnect, mqttGattDisconnect } from './gatt.js';
import { registerScaleMac } from './display.js';

export interface ScanResultEntry {
  address: string;
  name: string;
  rssi: number;
  services: string[];
  addr_type?: number;
  manufacturer_id?: number | null;
  manufacturer_data?: string | null;
  /** Array of {uuid, data} service-data entries (hex-encoded data). */
  service_data?: Array<{ uuid: string; data: string }> | null;
}

/** Build BleDeviceInfo from a scan result entry, including manufacturer and service data. */
export function toBleDeviceInfo(entry: ScanResultEntry): BleDeviceInfo {
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
  if (entry.service_data && entry.service_data.length > 0) {
    info.serviceData = entry.service_data.map((sd) => ({
      uuid: normalizeUuid(sd.uuid),
      data: Buffer.from(sd.data, 'hex'),
    }));
  }
  return info;
}

export async function waitForEsp32Online(client: MqttClient, t: Topics): Promise<void> {
  let resolve!: () => void;
  let sawOffline = false;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  const onMessage = (topic: string, payload: Buffer) => {
    if (topic === t.status) {
      const msg = payload.toString();
      if (msg === 'online') resolve();
      else if (msg === 'offline') sawOffline = true;
      // If 'offline', keep waiting. ESP32 may come back before timeout.
    }
  };
  client.on('message', onMessage);
  await client.subscribeAsync(t.status);

  // If we get the retained offline within 2s, fail fast rather than waiting 30s.
  // The main loop's backoff handles retries. But if online arrives within that
  // window we still succeed. Full timeout only applies when no status received.
  const OFFLINE_GRACE_MS = 2_000;

  try {
    return await withTimeout(
      Promise.race([
        promise,
        // After grace period, if we saw offline, reject early
        new Promise<never>((_res, rej) =>
          setTimeout(() => {
            if (sawOffline)
              rej(
                new Error('ESP32 proxy is offline. Check the device and its WiFi/MQTT connection.'),
              );
          }, OFFLINE_GRACE_MS),
        ),
      ]),
      COMMAND_TIMEOUT_MS,
      'ESP32 proxy did not respond. Check that it is powered on and connected to MQTT.',
    );
  } finally {
    client.removeListener('message', onMessage);
  }
}

export async function mqttScan(client: MqttClient, t: Topics): Promise<ScanResultEntry[]> {
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
  // ESP32 scans autonomously, just wait for the next result
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
    let weightOnlyFallback: (RawReading & { address: string }) | null = null;

    for (const entry of candidates) {
      const info = toBleDeviceInfo(entry);
      logAdvert(entry.address, info);
      const adapter = resolveAdapter(info, adapters);
      if (!adapter) continue;

      bleLog.info(`Matched: ${adapter.name} (${entry.name || entry.address})`);

      // Classify the advertisement with the shared decision (#242).
      const decision = evaluateAdvertisement(adapter, info);

      if (decision.kind === 'complete') {
        bleLog.info(`Broadcast reading: ${decision.reading.weight} kg`);
        registerScaleMac(config, entry.address).catch(() => {});
        return { reading: decision.reading, adapter };
      }

      // Save the FIRST weight-only frame as a fallback. Single-shot scan: this
      // processes one scan snapshot and cannot wait for a future frame, so there
      // is no grace timer here (unlike the streaming ReadingWatcher).
      if (decision.kind === 'partial' && !weightOnlyFallback) {
        weightOnlyFallback = { reading: decision.reading, adapter, address: entry.address };
      }

      // A saved weight-only fallback, or a device still carrying broadcast data
      // the adapter parses — keep scanning for a stable reading rather than
      // connecting. (A saved fallback means GATT must NOT be opened, matching the
      // pre-#242 `weightOnlyFallback || hasParseableBroadcastSource` guard.)
      if (weightOnlyFallback || decision.kind === 'wait') {
        // What the scale is showing while it converges. Not a reading, so it
        // never ends the scan (#356).
        if (decision.kind === 'wait' && decision.live) opts.onLiveWeight?.(decision.live);
        bleLog.debug(`${adapter.name} supports broadcast, waiting for stable reading...`);
        continue;
      }

      // No broadcast source for this device and no GATT path either — nothing
      // we can do for this candidate.
      if (decision.kind === 'none') {
        bleLog.debug(`${adapter.name} matched but has no broadcast or GATT path`);
        continue;
      }

      // decision.kind === 'gatt': adapter matched, no broadcast support for this
      // device (#201: dual-mode adapters like QN Scale must reach this).
      bleLog.info(`No broadcast data for ${adapter.name}; connecting via GATT proxy...`);
      const { charMap, device } = await mqttGattConnect(
        client,
        t,
        entry.address,
        entry.addr_type ?? 0,
      );
      try {
        const raw = await waitForRawReading(
          charMap,
          device,
          adapter,
          opts.profile,
          entry.address.replace(/[:-]/g, '').toUpperCase(),
          opts.weightUnit,
          opts.onLiveData,
          opts.scaleAuth,
        );
        registerScaleMac(config, entry.address).catch(() => {});
        return raw;
      } finally {
        device.cleanup();
        await mqttGattDisconnect(client, t).catch(() => {});
      }
    }

    if (weightOnlyFallback) {
      bleLog.info(
        `Broadcast reading (weight only, impedance not yet available): ${weightOnlyFallback.reading.weight} kg`,
      );
      registerScaleMac(config, weightOnlyFallback.address).catch(() => {});
      return { reading: weightOnlyFallback.reading, adapter: weightOnlyFallback.adapter };
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
      const matched = resolveAdapter(info, adapters);
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
