import type { Exporter } from '../interfaces/exporter.js';
import type { ExporterConfig, ExporterName } from './config.js';
import { GarminExporter } from './garmin.js';
import { MqttExporter } from './mqtt.js';
import { WebhookExporter } from './webhook.js';
import { InfluxDbExporter } from './influxdb.js';
import { NtfyExporter } from './ntfy.js';

export { loadExporterConfig } from './config.js';
export { createExporterFromEntry, EXPORTER_SCHEMAS, KNOWN_EXPORTER_NAMES } from './registry.js';

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
      default: {
        const _exhaustive: never = name;
        throw new Error(`Unhandled exporter: ${_exhaustive as ExporterName}`);
      }
    }
  }

  return exporters;
}
