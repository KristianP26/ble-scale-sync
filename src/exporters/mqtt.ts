import { createRequire } from 'node:module';
import { createLogger } from '../logger.js';
import type { BodyComposition } from '../interfaces/scale-adapter.js';
import type { Exporter, ExportContext, ExportResult } from '../interfaces/exporter.js';
import type { ExporterSchema } from '../interfaces/exporter-schema.js';
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

// Compile-time check: fails if a field is added to BodyComposition but not to HA_METRICS
const _haKeysCheck: Record<keyof BodyComposition, true> = {
  weight: true,
  impedance: true,
  bmi: true,
  bodyFatPercent: true,
  waterPercent: true,
  boneMass: true,
  muscleMass: true,
  visceralFat: true,
  physiqueRating: true,
  bmr: true,
  metabolicAge: true,
};
void _haKeysCheck;

export const mqttSchema: ExporterSchema = {
  name: 'mqtt',
  displayName: 'MQTT',
  description:
    'Publish body composition data to an MQTT broker (supports Home Assistant auto-discovery)',
  fields: [
    {
      key: 'broker_url',
      label: 'Broker URL',
      type: 'string',
      required: true,
      description: 'e.g., mqtts://broker.hivemq.com:8883',
    },
    {
      key: 'topic',
      label: 'Topic',
      type: 'string',
      required: false,
      default: 'scale/body-composition',
    },
    {
      key: 'qos',
      label: 'QoS',
      type: 'select',
      required: false,
      default: 1,
      choices: [
        { label: '0 (At most once)', value: 0 },
        { label: '1 (At least once)', value: 1 },
        { label: '2 (Exactly once)', value: 2 },
      ],
    },
    { key: 'retain', label: 'Retain', type: 'boolean', required: false, default: true },
    { key: 'username', label: 'Username', type: 'string', required: false },
    { key: 'password', label: 'Password', type: 'password', required: false },
    {
      key: 'client_id',
      label: 'Client ID',
      type: 'string',
      required: false,
      default: 'ble-scale-sync',
    },
    {
      key: 'ha_discovery',
      label: 'HA Discovery',
      type: 'boolean',
      required: false,
      default: true,
      description: 'Publish Home Assistant auto-discovery configs',
    },
    {
      key: 'ha_device_name',
      label: 'HA Device Name',
      type: 'string',
      required: false,
      default: 'BLE Scale',
    },
  ],
  supportsGlobal: true,
  supportsPerUser: false,
};

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
      const client = await Promise.race([
        connectAsync(this.config.brokerUrl, {
          clientId: `${this.config.clientId}-healthcheck`,
          username: this.config.username,
          password: this.config.password,
          connectTimeout: CONNECT_TIMEOUT_MS,
        }),
        new Promise<never>((_resolve, reject) =>
          setTimeout(
            () => reject(new Error('MQTT healthcheck timed out')),
            CONNECT_TIMEOUT_MS + 2_000,
          ),
        ),
      ]);
      await client.endAsync();
      return { success: true };
    } catch (err) {
      return { success: false, error: errMsg(err) };
    }
  }

  async export(data: BodyComposition, _context?: ExportContext): Promise<ExportResult> {
    const { connectAsync } = await import('mqtt');
    const { brokerUrl, topic, qos, retain, username, password, clientId, haDiscovery } =
      this.config;

    const statusTopic = haDiscovery ? `${topic}/status` : undefined;

    return withRetry(
      async () => {
        const client = await Promise.race([
          connectAsync(brokerUrl, {
            clientId,
            username,
            password,
            connectTimeout: CONNECT_TIMEOUT_MS,
            ...(statusTopic && {
              will: { topic: statusTopic, payload: Buffer.from('offline'), qos: 1, retain: true },
            }),
          }),
          new Promise<never>((_resolve, reject) =>
            setTimeout(
              () => reject(new Error('MQTT connection timed out')),
              CONNECT_TIMEOUT_MS + 2_000,
            ),
          ),
        ]);

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
