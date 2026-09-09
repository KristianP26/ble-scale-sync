import { createLogger } from '../logger.js';
import type { BodyComposition } from '../interfaces/scale-adapter.js';
import type { Exporter, ExportContext, ExportResult } from '../interfaces/exporter.js';
import type { ExporterSchema } from '../interfaces/exporter-schema.js';
import type { WgerConfig } from './config.js';
import { toLocalDate } from './intervals.js';
import { withRetry, httpError, httpHealthcheck } from '../utils/retry.js';
import { errMsg } from '../utils/error.js';

const log = createLogger('Wger');

export const wgerSchema: ExporterSchema = {
  name: 'wger',
  displayName: 'Wger',
  description: 'Push weight and body composition to a self-hosted or hosted Wger instance',
  fields: [
    {
      key: 'base_url',
      label: 'Base URL',
      type: 'string',
      required: true,
      description: 'Wger instance URL, e.g. https://wger.de or your self-hosted address',
    },
    {
      key: 'token',
      label: 'API Token',
      type: 'password',
      required: true,
      description: 'Permanent API key from Wger account settings (<base_url>/en/user/api-key)',
    },
    {
      key: 'sync_measurements',
      label: 'Sync body composition',
      type: 'boolean',
      required: false,
      default: true,
      description:
        'Also push body-fat/water/muscle/bone as Wger custom measurements, not just weight',
    },
  ],
  supportsGlobal: false,
  supportsPerUser: true,
};

/** Body-composition metrics mapped onto Wger custom measurement categories. */
const MEASUREMENT_CATEGORIES: ReadonlyArray<{
  name: string;
  unit: string;
  value: (d: BodyComposition) => number;
}> = [
  { name: 'Body Fat', unit: '%', value: (d) => d.bodyFatPercent },
  { name: 'Body Water', unit: '%', value: (d) => d.waterPercent },
  { name: 'Muscle Mass', unit: 'kg', value: (d) => d.muscleMass },
  { name: 'Bone Mass', unit: 'kg', value: (d) => d.boneMass },
];

interface CategoryListResponse {
  next: string | null;
  results: Array<{ id: number; name: string; unit: string }>;
}

export class WgerExporter implements Exporter {
  readonly name = 'wger';
  readonly supportsBackdate = true;
  private readonly config: WgerConfig;
  private readonly apiBase: string;
  /** name -> category id, resolved lazily on first export and cached. */
  private categories: Map<string, number> | null = null;

  constructor(config: WgerConfig) {
    this.config = config;
    this.apiBase = `${config.baseUrl.replace(/\/+$/, '')}/api/v2`;
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Token ${this.config.token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
  }

  async export(data: BodyComposition, context?: ExportContext): Promise<ExportResult> {
    const date = toLocalDate(context?.timestamp ?? new Date());

    // Weight is the primary result: its failure fails the export.
    const weightResult = await withRetry(
      async () => {
        const response = await fetch(`${this.apiBase}/weightentry/`, {
          method: 'POST',
          headers: this.headers(),
          body: JSON.stringify({ date, weight: Number(data.weight.toFixed(2)) }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) {
          throw httpError(response.status);
        }
        return { success: true };
      },
      { log, label: 'Wger weight entry' },
    );

    if (!weightResult.success) {
      return weightResult;
    }
    log.info(`Wger weight entry pushed for ${date}.`);

    // Body composition is best-effort: a failure here is logged, not fatal.
    if (this.config.syncMeasurements) {
      try {
        await this.pushMeasurements(data, date);
      } catch (err) {
        log.warn(`Wger measurements skipped: ${errMsg(err)}`);
      }
    }

    return { success: true };
  }

  private async pushMeasurements(data: BodyComposition, date: string): Promise<void> {
    const categories = await this.resolveCategories();
    for (const cat of MEASUREMENT_CATEGORIES) {
      const value = cat.value(data);
      if (!Number.isFinite(value) || value <= 0) continue;
      const categoryId = categories.get(cat.name);
      if (categoryId === undefined) continue;

      const result = await withRetry(
        async () => {
          const response = await fetch(`${this.apiBase}/measurement/`, {
            method: 'POST',
            headers: this.headers(),
            body: JSON.stringify({ category: categoryId, date, value: Number(value.toFixed(2)) }),
            signal: AbortSignal.timeout(10_000),
          });
          if (!response.ok) {
            throw httpError(response.status);
          }
          return { success: true };
        },
        { log, label: `Wger ${cat.name} measurement` },
      );
      if (!result.success) {
        log.warn(`Wger ${cat.name} measurement failed: ${result.error}`);
      }
    }
  }

  /** List existing measurement categories, create any missing ones, cache name->id. */
  private async resolveCategories(): Promise<Map<string, number>> {
    if (this.categories) return this.categories;

    const map = new Map<string, number>();
    let url: string | null = `${this.apiBase}/measurement-category/`;
    let pages = 0;
    while (url && pages < 50) {
      const response = await fetch(url, {
        headers: this.headers(),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        throw httpError(response.status);
      }
      const json = (await response.json()) as CategoryListResponse;
      for (const c of json.results) {
        if (!map.has(c.name)) map.set(c.name, c.id);
      }
      url = json.next;
      pages++;
    }

    for (const cat of MEASUREMENT_CATEGORIES) {
      if (map.has(cat.name)) continue;
      const response = await fetch(`${this.apiBase}/measurement-category/`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ name: cat.name, unit: cat.unit }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        throw httpError(response.status);
      }
      const created = (await response.json()) as { id: number };
      map.set(cat.name, created.id);
    }

    this.categories = map;
    return map;
  }

  async healthcheck(): Promise<ExportResult> {
    return httpHealthcheck(() =>
      fetch(`${this.apiBase}/userprofile/`, {
        headers: this.headers(),
        signal: AbortSignal.timeout(5000),
      }),
    );
  }
}
