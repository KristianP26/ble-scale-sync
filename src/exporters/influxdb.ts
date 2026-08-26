import { createLogger } from '../logger.js';
import type { BodyComposition } from '../interfaces/scale-adapter.js';
import type { Exporter, ExportContext, ExportResult } from '../interfaces/exporter.js';
import type { ExporterSchema } from '../interfaces/exporter-schema.js';
import type { InfluxDbConfig } from './config.js';
import { withRetry, httpError } from '../utils/retry.js';
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
  description:
    'Write body composition data to InfluxDB (v2, and v3 via its v2-compatible write API)',
  fields: [
    {
      key: 'url',
      label: 'InfluxDB URL',
      type: 'string',
      required: true,
      description: 'e.g., http://localhost:8086',
    },
    { key: 'token', label: 'API Token', type: 'password', required: true },
    {
      key: 'org',
      label: 'Organization',
      type: 'string',
      required: false,
      description:
        'Required on InfluxDB v2. Leave empty on InfluxDB v3, which has no organizations.',
    },
    {
      key: 'bucket',
      label: 'Bucket',
      type: 'string',
      required: true,
      description: 'The bucket name on v2, or the database name on v3.',
    },
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
  timestamp?: Date,
): string {
  const tags = userSlug ? `,user=${userSlug}` : '';
  const fields: string[] = [];

  for (const key of FLOAT_FIELDS) {
    fields.push(`${key}=${(data[key] as number).toFixed(2)}`);
  }
  for (const key of INT_FIELDS) {
    fields.push(`${key}=${Math.round(data[key] as number)}i`);
  }

  const tsMs = (timestamp ?? new Date()).getTime();
  return `${measurement}${tags} ${fields.join(',')} ${tsMs}`;
}

export class InfluxDbExporter implements Exporter {
  readonly name = 'influxdb';
  readonly supportsBackdate = true;
  private readonly config: InfluxDbConfig;

  constructor(config: InfluxDbConfig) {
    this.config = config;
  }

  async healthcheck(): Promise<ExportResult> {
    try {
      // The token is sent even though v2 leaves /health unauthenticated: v3
      // rejects an unauthenticated /health with 401, which made the wizard
      // report a working v3 target as broken. v2 ignores the extra header.
      const response = await fetch(`${this.config.url.replace(/\/+$/, '')}/health`, {
        headers: { Authorization: `Token ${this.config.token}` },
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
    const lineProtocol = toLineProtocol(data, measurement, context?.userSlug, context?.timestamp);
    // v3 has no organizations and ignores the parameter, so it is only sent
    // when configured. Built by hand rather than with URLSearchParams to keep
    // percent-encoding for spaces instead of `+`.
    const orgParam = org ? `org=${encodeURIComponent(org)}&` : '';
    const writeUrl = `${url.replace(/\/+$/, '')}/api/v2/write?${orgParam}bucket=${encodeURIComponent(bucket)}&precision=ms`;

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
          throw httpError(response.status);
        }

        log.info('InfluxDB write succeeded.');
        return { success: true };
      },
      { log, label: 'InfluxDB write' },
    );
  }
}
