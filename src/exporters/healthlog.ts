import { createLogger } from '../logger.js';
import type { BodyComposition } from '../interfaces/scale-adapter.js';
import type { Exporter, ExportContext, ExportResult } from '../interfaces/exporter.js';
import type { ExporterSchema } from '../interfaces/exporter-schema.js';
import type { HealthLogConfig } from './config.js';
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
      label: 'Measurement ingest token',
      type: 'password',
      required: true,
      description:
        'Measurement ingest token from HealthLog Settings -> API & Tokens (expires after a year)',
    },
    {
      key: 'sync_measurements',
      label: 'Sync body composition',
      type: 'boolean',
      required: false,
      default: true,
      description: 'Also push body fat, body water, muscle, bone and visceral fat, not just weight',
    },
  ],
  supportsGlobal: false,
  supportsPerUser: true,
};

/**
 * Body-composition metrics mapped onto HealthLog measurement types.
 *
 * HealthLog derives the unit from the type on its side, so only the value is
 * sent, and it has to already be in that unit: BODY_FAT is a percentage,
 * MUSCLE_MASS / BONE_MASS / TOTAL_BODY_WATER are kilograms (body water is
 * stored as a mass, not as the percentage we compute), VISCERAL_FAT is a
 * rating.
 *
 * `max` is HealthLog's own accepted upper bound where ours is wider. Our
 * visceral fat rating runs 1-59, HealthLog accepts 0-30 and would answer a
 * higher value with a 422, so such a value is skipped here instead.
 */
const MEASUREMENT_TYPES: ReadonlyArray<{
  type: string;
  value: (d: BodyComposition) => number;
  max?: number;
}> = [
  { type: 'BODY_FAT', value: (d) => d.bodyFatPercent },
  { type: 'TOTAL_BODY_WATER', value: (d) => (d.weight * d.waterPercent) / 100 },
  { type: 'MUSCLE_MASS', value: (d) => d.muscleMass },
  { type: 'BONE_MASS', value: (d) => d.boneMass },
  { type: 'VISCERAL_FAT', value: (d) => d.visceralFat, max: 30 },
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

  async export(data: BodyComposition, context?: ExportContext): Promise<ExportResult> {
    const timestamp = (context?.timestamp ?? new Date()).toISOString();

    // Weight is the primary result: its failure fails the export.
    const weightResult = await this.postMeasurement('WEIGHT', data.weight, timestamp);
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
    for (const metric of MEASUREMENT_TYPES) {
      const value = metric.value(data);
      if (!Number.isFinite(value) || value <= 0) continue;
      if (metric.max !== undefined && value > metric.max) {
        log.debug(
          `HealthLog ${metric.type} ${value} is above the ${metric.max} HealthLog accepts, skipped.`,
        );
        continue;
      }

      const result = await this.postMeasurement(metric.type, value, timestamp);
      if (!result.success) {
        log.warn(`HealthLog ${metric.type} measurement failed: ${result.error}`);
      }
    }
  }

  /**
   * POST one reading. HealthLog keys a measurement on (type, measuredAt,
   * source) and answers a second POST of the same one with 409, so a 409
   * means the value is already stored: a retry after a lost response, or a
   * redelivery from the failed-export queue. That counts as success.
   */
  private postMeasurement(type: string, value: number, timestamp: string): Promise<ExportResult> {
    return withRetry(
      async () => {
        const response = await fetch(`${this.apiBase}/measurements`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.config.token}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify({
            type,
            value: Number(value.toFixed(2)),
            measuredAt: timestamp,
          }),
          signal: AbortSignal.timeout(10_000),
        });
        if (response.status === 409) {
          log.debug(`HealthLog ${type} for ${timestamp} already recorded.`);
          return { success: true };
        }
        if (!response.ok) {
          throw httpError(response.status);
        }
        return { success: true };
      },
      { log, label: `HealthLog ${type} measurement` },
    );
  }

  /**
   * `/api/version` is a public endpoint on HealthLog (no authentication), so
   * this proves the instance is reachable and nothing more: a wrong or expired
   * token still passes here and only shows up on the first export. The token
   * is deliberately not sent, since the probe would not check it anyway, and
   * the ingest token cannot read anything that would.
   */
  async healthcheck(): Promise<ExportResult> {
    return httpHealthcheck(() =>
      fetch(`${this.apiBase}/version`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(5000),
      }),
    );
  }
}
