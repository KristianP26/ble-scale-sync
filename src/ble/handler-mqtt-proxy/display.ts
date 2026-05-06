import type { MqttProxyConfig } from '../../config/schema.js';
import { bleLog } from '../types.js';
import { topics } from './topics.js';
import {
  type DisplayUser,
  getClient,
  releaseClient,
  getDisplayUsers,
  hasDiscoveredMac,
  addDiscoveredMac,
  getDiscoveredMacs,
  discoveredMacsCount,
} from './client.js';

export async function publishConfig(
  config: MqttProxyConfig,
  scales: string[],
  users?: DisplayUser[],
): Promise<void> {
  const t = topics(config.topic_prefix, config.device_id);
  const { client, ephemeral } = await getClient(config);
  try {
    const payload: Record<string, unknown> = { scales };
    if (users && users.length > 0) {
      payload.users = users;
    }
    await client.publishAsync(t.config, JSON.stringify(payload), { retain: true });
  } finally {
    await releaseClient(client, ephemeral);
  }
}

/**
 * Register a discovered scale MAC and publish the updated set to the ESP32.
 * Called after a successful adapter match so the ESP32 can beep on future scans.
 */
export async function registerScaleMac(config: MqttProxyConfig, mac: string): Promise<void> {
  const upper = mac.toUpperCase();
  if (hasDiscoveredMac(upper)) return; // already known
  addDiscoveredMac(upper);
  bleLog.info(`Registered scale MAC ${upper} for ESP32 beep (${discoveredMacsCount()} total)`);
  await publishConfig(config, getDiscoveredMacs(), getDisplayUsers());
}

export async function publishBeep(
  config: MqttProxyConfig,
  freq?: number,
  duration?: number,
  repeat?: number,
): Promise<void> {
  const t = topics(config.topic_prefix, config.device_id);
  const { client, ephemeral } = await getClient(config);
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
    await releaseClient(client, ephemeral);
  }
}

export async function publishDisplayReading(
  config: MqttProxyConfig,
  slug: string,
  name: string,
  weight: number,
  impedance: number | undefined,
  exporterNames: string[],
): Promise<void> {
  const t = topics(config.topic_prefix, config.device_id);
  const { client, ephemeral } = await getClient(config);
  try {
    const payload: Record<string, unknown> = { slug, name, weight, exporters: exporterNames };
    if (impedance != null) payload.impedance = impedance;
    await client.publishAsync(`${t.base}/display/reading`, JSON.stringify(payload));
  } finally {
    await releaseClient(client, ephemeral);
  }
}

export async function publishDisplayResult(
  config: MqttProxyConfig,
  slug: string,
  name: string,
  weight: number,
  exports: Array<{ name: string; ok: boolean }>,
): Promise<void> {
  const t = topics(config.topic_prefix, config.device_id);
  const { client, ephemeral } = await getClient(config);
  try {
    const payload = { slug, name, weight, exports };
    await client.publishAsync(`${t.base}/display/result`, JSON.stringify(payload));
  } finally {
    await releaseClient(client, ephemeral);
  }
}
