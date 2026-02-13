import { createLogger } from '../logger.js';
import type { BodyComposition } from '../interfaces/scale-adapter.js';
import type { Exporter, ExportContext, ExportResult } from '../interfaces/exporter.js';
import type { ExporterSchema } from '../interfaces/exporter-schema.js';
import type { InfluxDbConfig } from './config.js';
import { withRetry } from '../utils/retry.js';
import { errMsg } from '../utils/error.js';

const log = createLogger('InfluxDB');

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

// Compile-time check: fails if a field is added to BodyComposition but not covered above
const _fieldCheck: Record<keyof BodyComposition, true> = {
  weight: true,
  bmi: true,
  bodyFatPercent: true,
  waterPercent: true,
  boneMass: true,
  muscleMass: true,
  impedance: true,
  visceralFat: true,
  physiqueRating: true,
  bmr: true,
  metabolicAge: true,
};
void _fieldCheck;

export const influxdbSchema: ExporterSchema = {
  name: 'influxdb',
  displayName: 'InfluxDB',
  description: 'Write body composition data to InfluxDB v2 time-series database',
  fields: [
    {
      key: 'url',
      label: 'InfluxDB URL',
      type: 'string',
      required: true,
      description: 'e.g., http://localhost:8086',
    },
    { key: 'token', label: 'API Token', type: 'password', required: true },
    { key: 'org', label: 'Organization', type: 'string', required: true },
    { key: 'bucket', label: 'Bucket', type: 'string', required: true },
    {
      key: 'measurement',
      label: 'Measurement',
      type: 'string',
      required: false,
      default: 'body_composition',
    },
  ],
  supportsGlobal: true,
  supportsPerUser: false,
};

export function toLineProtocol(
  data: BodyComposition,
  measurement: string,
  userSlug?: string,
): string {
  const tags = userSlug ? `,user=${userSlug}` : '';
  const fields: string[] = [];

  for (const key of FLOAT_FIELDS) {
    fields.push(`${key}=${(data[key] as number).toFixed(2)}`);
  }
  for (const key of INT_FIELDS) {
    fields.push(`${key}=${Math.round(data[key] as number)}i`);
  }

  return `${measurement}${tags} ${fields.join(',')} ${Date.now()}`;
}

export class InfluxDbExporter implements Exporter {
  readonly name = 'influxdb';
  private readonly config: InfluxDbConfig;

  constructor(config: InfluxDbConfig) {
    this.config = config;
  }

  async healthcheck(): Promise<ExportResult> {
    try {
      const response = await fetch(`${this.config.url.replace(/\/+$/, '')}/health`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) {
        return { success: false, error: `HTTP ${response.status}` };
      }
      return { success: true };
    } catch (err) {
      return { success: false, error: errMsg(err) };
    }
  }

  async export(data: BodyComposition, context?: ExportContext): Promise<ExportResult> {
    const { url, token, org, bucket, measurement } = this.config;
    const lineProtocol = toLineProtocol(data, measurement, context?.userSlug);
    const writeUrl = `${url.replace(/\/+$/, '')}/api/v2/write?org=${encodeURIComponent(org)}&bucket=${encodeURIComponent(bucket)}&precision=ms`;

    return withRetry(
      async () => {
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
      },
      { log, label: 'InfluxDB write' },
    );
  }
}
