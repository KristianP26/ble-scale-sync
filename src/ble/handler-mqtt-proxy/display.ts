import type { MqttProxyConfig } from '../../config/schema.js';
import type { ScaleAdapter } from '../../interfaces/scale-adapter.js';
import { bleLog } from '../types.js';
import { readsFromAdvertisement } from '../advertisement.js';
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
  isPassiveMac,
  addPassiveMac,
  removePassiveMac,
  getPassiveMacs,
} from './client.js';

export async function publishConfig(
  config: MqttProxyConfig,
  scales: string[],
  users?: DisplayUser[],
  passive?: string[],
): Promise<void> {
  const t = topics(config.topic_prefix, config.device_id);
  const { client, ephemeral } = await getClient(config);
  try {
    const payload: Record<string, unknown> = { scales };
    if (users && users.length > 0) {
      payload.users = users;
    }
    // Scales read from their advertisements (#422). Firmware that knows the
    // key skips its autonomous connect for these MACs and keeps beeping for
    // them; older firmware ignores it. Only MACs in `scales` are meaningful.
    const passiveKnown = (passive ?? []).filter((mac) => scales.includes(mac));
    if (passiveKnown.length > 0) payload.passive = passiveKnown;
    // Forward autoConnect opt-out to the ESP32 firmware (#201). Default is true,
    // so it is only sent when disabled: explicitly by config, or because every
    // known scale is read from advertisements and there is nothing to connect
    // to. The second case is what stops firmware that predates `passive` from
    // connecting to a Mi Scale 2 on every weigh-in (#422).
    const allPassive = scales.length > 0 && passiveKnown.length === scales.length;
    if (config.auto_connect === false || allPassive) {
      payload.autoConnect = false;
      bleLog.debug(
        config.auto_connect === false
          ? 'publishConfig: autoConnect disabled, sending opt-out to ESP32'
          : 'publishConfig: every known scale is read from advertisements, sending autoConnect opt-out',
      );
    }
    // Advertise host-ordered (lazy) notify enable so the firmware enables BLE
    // notify only on a per-char subscribe command, after the host has subscribed
    // to the MQTT notify topic. This closes the #231 QN/Renpho 0x12 kickoff race.
    // New firmware honors it; old firmware ignores it and stays eager.
    payload.lazy_notify = true;
    await client.publishAsync(t.config, JSON.stringify(payload), { retain: true });
  } finally {
    await releaseClient(client, ephemeral);
  }
}

/**
 * Register a discovered scale MAC and publish the updated set to the ESP32.
 * Called after a successful adapter match so the ESP32 can beep on future scans.
 *
 * With an adapter, the MAC's passive flag is set to whether that adapter reads
 * from advertisements, and a change re-publishes even for a known MAC: the
 * startup seed registers `ble.scale_mac` before anything is known about it, and
 * a config reload can swap the forced adapter (#422). Without one, the flag is
 * left as it is.
 */
export async function registerScaleMac(
  config: MqttProxyConfig,
  mac: string,
  adapter?: ScaleAdapter,
): Promise<void> {
  const upper = mac.toUpperCase();
  const known = hasDiscoveredMac(upper);
  const passive = adapter ? readsFromAdvertisement(adapter) : undefined;
  const passiveChanged = passive !== undefined && passive !== isPassiveMac(upper);
  if (known && !passiveChanged) return;
  if (!known) {
    addDiscoveredMac(upper);
    bleLog.info(`Registered scale MAC ${upper} for ESP32 beep (${discoveredMacsCount()} total)`);
  }
  if (passiveChanged) {
    if (passive) {
      addPassiveMac(upper);
      bleLog.info(`Scale ${upper} is read from its advertisements; ESP32 will not connect to it`);
    } else {
      removePassiveMac(upper);
    }
  }
  await publishConfig(config, getDiscoveredMacs(), getDisplayUsers(), getPassiveMacs());
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
