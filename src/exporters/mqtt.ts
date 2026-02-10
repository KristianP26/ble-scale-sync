import { createLogger } from '../logger.js';
import type { BodyComposition } from '../interfaces/scale-adapter.js';
import type { Exporter, ExportResult } from '../interfaces/exporter.js';
import type { MqttConfig } from './config.js';

const log = createLogger('MQTT');

const CONNECT_TIMEOUT_MS = 10_000;
const MAX_RETRIES = 2;

interface HaMetricDef {
  key: keyof BodyComposition;
  name: string;
  unit?: string;
  deviceClass?: string;
  icon?: string;
}

const HA_METRICS: HaMetricDef[] = [
  { key: 'weight', name: 'Weight', unit: 'kg', deviceClass: 'weight' },
  { key: 'impedance', name: 'Impedance', unit: 'Ω', icon: 'mdi:flash' },
  { key: 'bmi', name: 'BMI', icon: 'mdi:human' },
  { key: 'bodyFatPercent', name: 'Body Fat', unit: '%', icon: 'mdi:percent' },
  { key: 'waterPercent', name: 'Water', unit: '%', icon: 'mdi:water-percent' },
  { key: 'boneMass', name: 'Bone Mass', unit: 'kg', deviceClass: 'weight' },
  { key: 'muscleMass', name: 'Muscle Mass', unit: 'kg', deviceClass: 'weight' },
  { key: 'visceralFat', name: 'Visceral Fat', icon: 'mdi:stomach' },
  { key: 'physiqueRating', name: 'Physique Rating', icon: 'mdi:human-handsup' },
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
      name: 'BLE Scale',
      manufacturer: 'BLE Scale Sync',
      model: 'Smart Scale',
    };

    for (const metric of HA_METRICS) {
      const topic = `homeassistant/sensor/ble-scale-sync/${metric.key}/config`;
      const payload: Record<string, unknown> = {
        name: metric.name,
        unique_id: `ble-scale-sync_${metric.key}`,
        state_topic: this.config.topic,
        value_template: `{{ value_json.${metric.key} }}`,
        state_class: 'measurement',
        device,
      };
      if (metric.unit) payload.unit_of_measurement = metric.unit;
      if (metric.deviceClass) payload.device_class = metric.deviceClass;
      if (metric.icon) payload.icon = metric.icon;

      await client.publishAsync(topic, JSON.stringify(payload), { qos: 1, retain: true });
    }

    log.info(`Published HA discovery for ${HA_METRICS.length} metrics.`);
  }

  async export(data: BodyComposition): Promise<ExportResult> {
    const { connectAsync } = await import('mqtt');
    const { brokerUrl, topic, qos, retain, username, password, clientId, haDiscovery } =
      this.config;

    let lastError: string | undefined;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        log.info(`Retrying MQTT publish (${attempt}/${MAX_RETRIES})...`);
      }

      try {
        const client = await connectAsync(brokerUrl, {
          clientId,
          username,
          password,
          connectTimeout: CONNECT_TIMEOUT_MS,
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
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        log.error(`MQTT publish failed: ${lastError}`);
      }
    }

    return { success: false, error: lastError ?? 'All MQTT publish attempts failed' };
  }
}
