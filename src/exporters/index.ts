import type { Exporter } from '../interfaces/exporter.js';
import type { ExporterConfig } from './config.js';
import { GarminExporter } from './garmin.js';
import { MqttExporter } from './mqtt.js';
import { WebhookExporter } from './webhook.js';
import { InfluxDbExporter } from './influxdb.js';
import { NtfyExporter } from './ntfy.js';

export { loadExporterConfig } from './config.js';

export function createExporters(config: ExporterConfig): Exporter[] {
  const exporters: Exporter[] = [];

  for (const name of config.exporters) {
    switch (name) {
      case 'garmin':
        exporters.push(new GarminExporter());
        break;
      case 'mqtt':
        exporters.push(new MqttExporter(config.mqtt!));
        break;
      case 'webhook':
        exporters.push(new WebhookExporter(config.webhook!));
        break;
      case 'influxdb':
        exporters.push(new InfluxDbExporter(config.influxdb!));
        break;
      case 'ntfy':
        exporters.push(new NtfyExporter(config.ntfy!));
        break;
    }
  }

  return exporters;
}
