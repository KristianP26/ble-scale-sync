import { createLogger } from '../logger.js';
import type { BodyComposition } from '../interfaces/scale-adapter.js';
import type { Exporter, ExportContext, ExportResult } from '../interfaces/exporter.js';
import type { ExporterSchema } from '../interfaces/exporter-schema.js';
import type { HealthLogConfig } from './config.js';
import { toLocalDate } from './intervals.js';
import { withRetry, httpError, httpHealthcheck } from '../utils/retry.js';
import { errMsg } from '../utils/error.js';

const log = createLogger('HealthLog');

export const healthlogSchema: ExporterSchema = {
  name: 'healthlog',
  displayName: 'HealthLog',
  description: 'Push weight and body composition to a self-hosted HealthLog instance',
  fields: [
    {
      key: 'base_url',
      label: 'Base URL',
      type: 'string',
      required: true,
      description: 'Your HealthLog self-hosted instance URL',
    },
    {
      key: 'token',
      label: 'API Token',
      type: 'password',
      required: true,
      description: 'Permanent measurements API key from HealthLog account settings',
    },
    {
      key: 'sync_measurements',
      label: 'Sync body composition',
      type: 'boolean',
      required: false,
      default: true,
      description:
        'Also push body-fat/water/muscle/bone as HealthLog custom measurements, not just weight',
    },
  ],
  supportsGlobal: false,
  supportsPerUser: true,
};

/** Body-composition metrics mapped onto HealthLog custom measurement categories. */
const MEASUREMENT_CATEGORIES: ReadonlyArray<{
  name: string;
  unit: string;
  value: (d: BodyComposition) => number;
}> = [
  { name: 'BODY_FAT', unit: '%', value: (d) => d.bodyFatPercent },
  { name: 'TOTAL_BODY_WATER', unit: '%', value: (d) => d.waterPercent },
  { name: 'MUSCLE_MASS', unit: 'kg', value: (d) => d.muscleMass },
  { name: 'BONE_MASS', unit: 'kg', value: (d) => d.boneMass },
  { name: 'VISCERAL_FAT', unit: '', value: (d) => d.visceralFat },
];

export class HealthLogExporter implements Exporter {
  readonly name = 'healthlog';
  readonly supportsBackdate = true;
  private readonly config: HealthLogConfig;
  private readonly apiBase: string;

  constructor(config: HealthLogConfig) {
    this.config = config;
    this.apiBase = `${config.baseUrl.replace(/\/+$/, '')}/api`;
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.config.token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
  }

  async export(data: BodyComposition, context?: ExportContext): Promise<ExportResult> {
    const timestamp = (context?.timestamp ?? new Date()).toISOString();

    // Weight is the primary result: its failure fails the export.
    const weightResult = await withRetry(
      async () => {
        const response = await fetch(`${this.apiBase}/measurements`, {
          method: 'POST',
          headers: this.headers(),
          body: JSON.stringify({
            type: 'WEIGHT',
            value: Number(data.weight.toFixed(2)),
            measuredAt: timestamp,
          }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) {
          throw httpError(response.status);
        }
        return { success: true };
      },
      { log, label: 'HealthLog weight entry' },
    );

    if (!weightResult.success) {
      return weightResult;
    }
    log.info(`HealthLog weight entry pushed for ${timestamp}.`);

    // Body composition is best-effort: a failure here is logged, not fatal.
    if (this.config.syncMeasurements) {
      try {
        await this.pushMeasurements(data, timestamp);
      } catch (err) {
        log.warn(`HealthLog measurements skipped: ${errMsg(err)}`);
      }
    }

    return { success: true };
  }

  private async pushMeasurements(data: BodyComposition, timestamp: string): Promise<void> {
    for (const cat of MEASUREMENT_CATEGORIES) {
      const value = cat.value(data);
      if (!Number.isFinite(value) || value <= 0) continue;

      const result = await withRetry(
        async () => {
          const response = await fetch(`${this.apiBase}/measurements`, {
            method: 'POST',
            headers: this.headers(),
            body: JSON.stringify({
              type: cat.name,
              value: Number(value.toFixed(2)),
              measuredAt: timestamp,
            }),
            signal: AbortSignal.timeout(10_000),
          });
          if (!response.ok) {
            throw httpError(response.status);
          }
          return { success: true };
        },
        { log, label: `HealthLog ${cat.name} measurement` },
      );
      if (!result.success) {
        log.warn(`HealthLog ${cat.name} measurement failed: ${result.error}`);
      }
    }
  }

  async healthcheck(): Promise<ExportResult> {
    return httpHealthcheck(() =>
      fetch(`${this.apiBase}/version`, {
        headers: this.headers(),
        signal: AbortSignal.timeout(5000),
      }),
    );
  }
}
