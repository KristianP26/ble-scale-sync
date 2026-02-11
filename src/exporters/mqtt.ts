import { createRequire } from 'node:module';
import { createLogger } from '../logger.js';
import type { BodyComposition } from '../interfaces/scale-adapter.js';
import type { Exporter, ExportResult } from '../interfaces/exporter.js';
import type { MqttConfig } from './config.js';
import { withRetry } from '../utils/retry.js';
import { errMsg } from '../utils/error.js';

const require = createRequire(import.meta.url);
const pkg = require('../../package.json') as { version: string };

const log = createLogger('MQTT');

const CONNECT_TIMEOUT_MS = 10_000;

interface HaMetricDef {
  key: keyof BodyComposition;
  name: string;
  unit?: string;
  deviceClass?: string;
  icon?: string;
  precision?: number;
  entityCategory?: string;
}

const HA_METRICS: HaMetricDef[] = [
  { key: 'weight', name: 'Weight', unit: 'kg', deviceClass: 'weight', precision: 2 },
  {
    key: 'impedance',
    name: 'Impedance',
    unit: 'Ω',
    icon: 'mdi:flash',
    entityCategory: 'diagnostic',
  },
  { key: 'bmi', name: 'BMI', icon: 'mdi:human', precision: 1 },
  { key: 'bodyFatPercent', name: 'Body Fat', unit: '%', icon: 'mdi:percent', precision: 1 },
  { key: 'waterPercent', name: 'Water', unit: '%', icon: 'mdi:water-percent', precision: 1 },
  { key: 'boneMass', name: 'Bone Mass', unit: 'kg', deviceClass: 'weight', precision: 1 },
  { key: 'muscleMass', name: 'Muscle Mass', unit: 'kg', deviceClass: 'weight', precision: 1 },
  { key: 'visceralFat', name: 'Visceral Fat', icon: 'mdi:stomach' },
  {
    key: 'physiqueRating',
    name: 'Physique Rating',
    icon: 'mdi:human-handsup',
    entityCategory: 'diagnostic',
  },
  { key: 'bmr', name: 'BMR', unit: 'kcal', icon: 'mdi:fire' },
  { key: 'metabolicAge', name: 'Metabolic Age', unit: 'yr', icon: 'mdi:calendar-clock' },
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MqttClient = { publishAsync: any; endAsync: any };

export class MqttExporter implements Exporter {
  readonly name = 'mqtt';
  private readonly config: MqttConfig;

  constructor(config: MqttConfig) {
    this.config = config;
  }

  private async publishDiscovery(client: MqttClient): Promise<void> {
    const device = {
      identifiers: ['ble-scale-sync'],
      name: this.config.haDeviceName,
      manufacturer: 'BLE Scale Sync',
      model: 'Smart Scale',
      sw_version: pkg.version,
    };

    const statusTopic = `${this.config.topic}/status`;

    for (const metric of HA_METRICS) {
      const topic = `homeassistant/sensor/ble-scale-sync/${metric.key}/config`;
      const payload: Record<string, unknown> = {
        name: metric.name,
        unique_id: `ble-scale-sync_${metric.key}`,
        state_topic: this.config.topic,
        value_template: `{{ value_json.${metric.key} }}`,
        state_class: 'measurement',
        availability: [{ topic: statusTopic }],
        device,
      };
      if (metric.unit) payload.unit_of_measurement = metric.unit;
      if (metric.deviceClass) payload.device_class = metric.deviceClass;
      if (metric.icon) payload.icon = metric.icon;
      if (metric.precision !== undefined) payload.suggested_display_precision = metric.precision;
      if (metric.entityCategory) payload.entity_category = metric.entityCategory;

      await client.publishAsync(topic, JSON.stringify(payload), { qos: 1, retain: true });
    }

    await client.publishAsync(statusTopic, 'online', { qos: 1, retain: true });
    log.info(`Published HA discovery for ${HA_METRICS.length} metrics.`);
  }

  async healthcheck(): Promise<ExportResult> {
    try {
      const { connectAsync } = await import('mqtt');
      const client = await connectAsync(this.config.brokerUrl, {
        clientId: `${this.config.clientId}-healthcheck`,
        username: this.config.username,
        password: this.config.password,
        connectTimeout: CONNECT_TIMEOUT_MS,
      });
      await client.endAsync();
      return { success: true };
    } catch (err) {
      return { success: false, error: errMsg(err) };
    }
  }

  async export(data: BodyComposition): Promise<ExportResult> {
    const { connectAsync } = await import('mqtt');
    const { brokerUrl, topic, qos, retain, username, password, clientId, haDiscovery } =
      this.config;

    const statusTopic = haDiscovery ? `${topic}/status` : undefined;

    return withRetry(
      async () => {
        const client = await connectAsync(brokerUrl, {
          clientId,
          username,
          password,
          connectTimeout: CONNECT_TIMEOUT_MS,
          ...(statusTopic && {
            will: { topic: statusTopic, payload: Buffer.from('offline'), qos: 1, retain: true },
          }),
        });

        try {
          if (haDiscovery) {
            await this.publishDiscovery(client);
          }

          const payload = JSON.stringify(data);
          await client.publishAsync(topic, payload, { qos, retain });
          log.info(`Published to ${topic} (qos=${qos}, retain=${retain}).`);
          return { success: true };
        } finally {
          await client.endAsync();
        }
      },
      { log, label: 'MQTT publish' },
    );
  }
}
