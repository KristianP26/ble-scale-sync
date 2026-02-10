import { createLogger } from '../logger.js';
import type { BodyComposition } from '../interfaces/scale-adapter.js';
import type { Exporter, ExportResult } from '../interfaces/exporter.js';
import type { InfluxDbConfig } from './config.js';

const log = createLogger('InfluxDB');

const MAX_RETRIES = 2;

const FLOAT_FIELDS: (keyof BodyComposition)[] = [
  'weight',
  'bmi',
  'bodyFatPercent',
  'waterPercent',
  'boneMass',
  'muscleMass',
];

const INT_FIELDS: (keyof BodyComposition)[] = [
  'impedance',
  'visceralFat',
  'physiqueRating',
  'bmr',
  'metabolicAge',
];

export function toLineProtocol(data: BodyComposition, measurement: string): string {
  const fields: string[] = [];

  for (const key of FLOAT_FIELDS) {
    fields.push(`${key}=${(data[key] as number).toFixed(2)}`);
  }
  for (const key of INT_FIELDS) {
    fields.push(`${key}=${Math.round(data[key] as number)}i`);
  }

  return `${measurement} ${fields.join(',')} ${Date.now()}`;
}

export class InfluxDbExporter implements Exporter {
  readonly name = 'influxdb';
  private readonly config: InfluxDbConfig;

  constructor(config: InfluxDbConfig) {
    this.config = config;
  }

  async export(data: BodyComposition): Promise<ExportResult> {
    const { url, token, org, bucket, measurement } = this.config;
    const lineProtocol = toLineProtocol(data, measurement);
    const writeUrl = `${url}/api/v2/write?org=${encodeURIComponent(org)}&bucket=${encodeURIComponent(bucket)}&precision=ms`;

    let lastError: string | undefined;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        log.info(`Retrying InfluxDB write (${attempt}/${MAX_RETRIES})...`);
      }

      try {
        const response = await fetch(writeUrl, {
          method: 'POST',
          headers: {
            Authorization: `Token ${token}`,
            'Content-Type': 'text/plain',
          },
          body: lineProtocol,
          signal: AbortSignal.timeout(10_000),
        });

        if (response.status !== 204) {
          throw new Error(`HTTP ${response.status}`);
        }

        log.info('InfluxDB write succeeded.');
        return { success: true };
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        log.error(`InfluxDB write failed: ${lastError}`);
      }
    }

    return { success: false, error: lastError ?? 'All InfluxDB write attempts failed' };
  }
}
