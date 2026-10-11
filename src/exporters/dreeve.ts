import { createLogger } from '../logger.js';
import type { BodyComposition } from '../interfaces/scale-adapter.js';
import type { Exporter, ExportContext, ExportResult } from '../interfaces/exporter.js';
import type { ExporterSchema } from '../interfaces/exporter-schema.js';
import type { DreeveConfig } from './config.js';
import { toLocalDate } from './intervals.js';
import { withRetry, httpError, httpHealthcheck, NonRetryableError } from '../utils/retry.js';

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
    return httpHealthcheck(() =>
      fetch(this.statusUrl, {
        headers: { Authorization: `Bearer ${this.config.token}` },
        signal: AbortSignal.timeout(5000),
      }),
    );
  }

  async export(data: BodyComposition, context?: ExportContext): Promise<ExportResult> {
    const on = toLocalDate(context?.timestamp ?? new Date());
    const weight =
      this.config.unitSystem === 'metric' ? data.weight : data.weight * POUNDS_PER_KILOGRAM;
    const body = JSON.stringify({ on, weight: Number(weight.toFixed(2)) });

    return withRetry(
      async () => {
        const response = await fetch(this.weightsUrl, {
          method: 'POST',
          headers: this.headers(),
          body,
          signal: AbortSignal.timeout(10_000),
        });

        if (response.status === 404) {
          // Dreeve 5.3.0-5.3.2 already answer /api/v1/status, so the
          // healthcheck passes, but have no weight endpoint yet.
          throw new NonRetryableError(
            'HTTP 404: no weight API here, it needs Dreeve 5.3.3 or newer (or base_url is wrong)',
          );
        }
        if (!response.ok) {
          throw httpError(response.status);
        }

        log.info(`Dreeve weight recorded for ${on}.`);
        return { success: true };
      },
      { log, label: 'Dreeve weight update' },
    );
  }
}
