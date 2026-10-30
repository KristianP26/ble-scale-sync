import { createLogger } from '../logger.js';
import type { BodyComposition } from '../interfaces/scale-adapter.js';
import type { Exporter, ExportContext, ExportResult } from '../interfaces/exporter.js';
import type { ExporterSchema } from '../interfaces/exporter-schema.js';
import type { DreeveConfig } from './config.js';
import { toLocalDate } from './intervals.js';
import { NonRetryableError } from '../utils/retry.js';
import { sendWithRetry, probe } from './http.js';

const log = createLogger('Dreeve');
/** Exact: 1 lb = 0.45359237 kg by definition, the factor Dreeve converts back with. */
const POUNDS_PER_KILOGRAM = 1 / 0.45359237;

export const dreeveSchema: ExporterSchema = {
  name: 'dreeve',
  displayName: 'Dreeve',
  description: 'Push weight to a self-hosted Dreeve instance (5.3.3 or newer)',
  fields: [
    {
      key: 'base_url',
      label: 'Base URL',
      type: 'string',
      required: true,
      description: 'Your Dreeve APP_URL, e.g. https://dreeve.example',
    },
    {
      key: 'token',
      label: 'API Token',
      type: 'password',
      required: true,
      description: 'API key (drv_...) from Dreeve Settings -> Security -> API access',
    },
    {
      key: 'unit_system',
      label: 'Dreeve unit system',
      type: 'select',
      required: true,
      description: 'Must match Dreeve Settings -> Appearance -> Unit system',
      choices: [
        { label: 'Metric (kilograms)', value: 'metric' },
        { label: 'Imperial (pounds)', value: 'imperial' },
      ],
    },
  ],
  supportsGlobal: false,
  supportsPerUser: true,
};

export class DreeveExporter implements Exporter {
  readonly name = 'dreeve';
  readonly supportsBackdate = true;
  private readonly config: DreeveConfig;
  private readonly statusUrl: string;
  private readonly weightsUrl: string;

  constructor(config: DreeveConfig) {
    this.config = config;
    const apiBase = `${config.baseUrl.replace(/\/+$/, '')}/api/v1`;
    this.statusUrl = `${apiBase}/status`;
    this.weightsUrl = `${apiBase}/athlete/weights`;
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.config.token}`,
      'Content-Type': 'application/json',
    };
  }

  async healthcheck(): Promise<ExportResult> {
    return probe(this.statusUrl, { headers: { Authorization: `Bearer ${this.config.token}` } });
  }

  async export(data: BodyComposition, context?: ExportContext): Promise<ExportResult> {
    const on = toLocalDate(context?.timestamp ?? new Date());
    const weight =
      this.config.unitSystem === 'metric' ? data.weight : data.weight * POUNDS_PER_KILOGRAM;
    const body = JSON.stringify({ on, weight: Number(weight.toFixed(2)) });

    return sendWithRetry(
      this.weightsUrl,
      { method: 'POST', headers: this.headers(), body },
      {
        log,
        label: 'Dreeve weight update',
        onStatus: (response) => {
          // Dreeve 5.3.0-5.3.2 already answer /api/v1/status, so the
          // healthcheck passes, but have no weight endpoint yet.
          if (response.status === 404) {
            throw new NonRetryableError(
              'HTTP 404: no weight API here, it needs Dreeve 5.3.3 or newer (or base_url is wrong)',
            );
          }
        },
        onOk: () => log.info(`Dreeve weight recorded for ${on}.`),
      },
    );
  }
}
