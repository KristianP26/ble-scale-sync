import { createLogger } from '../logger.js';
import type { BodyComposition } from '../interfaces/scale-adapter.js';
import type { Exporter, ExportContext, ExportResult } from '../interfaces/exporter.js';
import type { ExporterSchema } from '../interfaces/exporter-schema.js';
import type { DreeveConfig } from './config.js';
import { toLocalDate } from './intervals.js';
import { withRetry, httpError, httpHealthcheck } from '../utils/retry.js';

const log = createLogger('Dreeve');
const POUNDS_PER_KILOGRAM = 2.2046226218;

export const dreeveSchema: ExporterSchema = {
  name: 'dreeve',
  displayName: 'Dreeve',
  description: 'Push weight to a self-hosted Dreeve instance',
  fields: [
    {
      key: 'base_url',
      label: 'Base URL',
      type: 'string',
      required: true,
      description: 'Dreeve instance URL, e.g. https://fit.example.com',
    },
    {
      key: 'token',
      label: 'API Token',
      type: 'password',
      required: true,
      description: 'Bearer token from Dreeve API settings (drv_...)',
    },
    {
      key: 'unit_system',
      label: 'Dreeve Appearance unit system',
      type: 'select',
      required: true,
      description: 'Must match Dreeve Appearance settings; readings are converted from kilograms',
      choices: [
        { label: 'Metric (kilograms)', value: 'metric' },
        { label: 'Imperial (pounds)', value: 'imperial' },
      ],
    },
  ],
  supportsGlobal: true,
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
