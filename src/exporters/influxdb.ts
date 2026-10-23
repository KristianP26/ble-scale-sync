import { createLogger } from '../logger.js';
import type { BodyComposition } from '../interfaces/scale-adapter.js';
import type { Exporter, ExportContext, ExportResult } from '../interfaces/exporter.js';
import type { ExporterSchema } from '../interfaces/exporter-schema.js';
import type { InfluxDbConfig } from './config.js';
import { httpError } from '../utils/retry.js';
import { sendWithRetry, probe } from './http.js';
import { METRICS, METRIC_KEYS } from './metrics.js';

const log = createLogger('InfluxDB');

// Floats are the metrics the CSV writes with decimals; the rest are integers.
const FLOAT_FIELDS = METRIC_KEYS.filter((k) => METRICS[k].decimals !== undefined);
const INT_FIELDS = METRIC_KEYS.filter((k) => METRICS[k].decimals === undefined);

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

  // A metric only some weigh-ins carry is a field only when it is there (#497).
  for (const key of FLOAT_FIELDS) {
    const v = data[key];
    if (v !== undefined) fields.push(`${key}=${v.toFixed(2)}`);
  }
  for (const key of INT_FIELDS) {
    const v = data[key];
    if (v !== undefined) fields.push(`${key}=${Math.round(v)}i`);
  }

  const tsMs = (timestamp ?? new Date()).getTime();
  // Line protocol ends the measurement at the first unescaped comma or space,
  // so `body composition` was a malformed line and every write failed with a
  // 400 (F-18). The `user` tag needs nothing: slugs are `^[a-z0-9-]+$`.
  const escapedMeasurement = measurement.replace(/[, ]/g, '\\$&');
  return `${escapedMeasurement}${tags} ${fields.join(',')} ${tsMs}`;
}

export class InfluxDbExporter implements Exporter {
  readonly name = 'influxdb';
  readonly supportsBackdate = true;
  private readonly config: InfluxDbConfig;

  constructor(config: InfluxDbConfig) {
    this.config = config;
  }

  async healthcheck(): Promise<ExportResult> {
    // The token is sent even though v2 leaves /health unauthenticated: v3
    // rejects an unauthenticated /health with 401, which made the wizard
    // report a working v3 target as broken. v2 ignores the extra header.
    return probe(`${this.config.url.replace(/\/+$/, '')}/health`, {
      headers: { Authorization: `Token ${this.config.token}` },
    });
  }

  async export(data: BodyComposition, context?: ExportContext): Promise<ExportResult> {
    const { url, token, org, bucket, measurement } = this.config;
    const lineProtocol = toLineProtocol(data, measurement, context?.userSlug, context?.timestamp);
    // v3 has no organizations and ignores the parameter, so it is only sent
    // when configured. Built by hand rather than with URLSearchParams to keep
    // percent-encoding for spaces instead of `+`.
    const orgParam = org ? `org=${encodeURIComponent(org)}&` : '';
    const writeUrl = `${url.replace(/\/+$/, '')}/api/v2/write?${orgParam}bucket=${encodeURIComponent(bucket)}&precision=ms`;

    return sendWithRetry(
      writeUrl,
      {
        method: 'POST',
        headers: { Authorization: `Token ${token}`, 'Content-Type': 'text/plain' },
        body: lineProtocol,
      },
      {
        log,
        label: 'InfluxDB write',
        // Only 204 is a stored write; anything else, a 2xx included, is a failure.
        onStatus: (response) => {
          if (response.status !== 204) throw httpError(response.status);
          log.info('InfluxDB write succeeded.');
          return { success: true };
        },
      },
    );
  }
}
