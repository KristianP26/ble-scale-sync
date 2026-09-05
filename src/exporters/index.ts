import type { Exporter } from '../interfaces/exporter.js';
import type { ExporterConfig, ExporterName } from './config.js';
import { GarminExporter } from './garmin.js';
import { MqttExporter } from './mqtt.js';
import { WebhookExporter } from './webhook.js';
import { InfluxDbExporter } from './influxdb.js';
import { NtfyExporter } from './ntfy.js';
import { FileExporter } from './file.js';
import { StravaExporter } from './strava.js';
import { TelegramExporter } from './telegram.js';
import { IntervalsExporter } from './intervals.js';
import { RunalyzeExporter } from './runalyze.js';
import { WgerExporter } from './wger.js';

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
      case 'file':
        exporters.push(new FileExporter(config.file!));
        break;
      case 'strava':
        exporters.push(new StravaExporter(config.strava!));
        break;
      case 'telegram':
        exporters.push(new TelegramExporter(config.telegram!));
        break;
      case 'intervals':
        exporters.push(new IntervalsExporter(config.intervals!));
        break;
      case 'runalyze':
        exporters.push(new RunalyzeExporter(config.runalyze!));
        break;
      case 'wger':
        exporters.push(new WgerExporter(config.wger!));
        break;
      default: {
        const _exhaustive: never = name;
        throw new Error(`Unhandled exporter: ${_exhaustive as ExporterName}`);
      }
    }
  }

  return exporters;
}
