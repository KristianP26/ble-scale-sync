import { createLogger } from '../logger.js';
import type { BodyComposition } from '../interfaces/scale-adapter.js';
import type { Exporter, ExportContext, ExportResult } from '../interfaces/exporter.js';
import type { ExporterSchema } from '../interfaces/exporter-schema.js';
import type { IntervalsConfig } from './config.js';
import { withRetry, httpError, httpHealthcheck } from '../utils/retry.js';

const log = createLogger('Intervals');

const API_BASE = 'https://intervals.icu';

export const intervalsSchema: ExporterSchema = {
  name: 'intervals',
  displayName: 'Intervals.icu',
  description: 'Push weight and body fat to Intervals.icu wellness records',
  fields: [
    {
      key: 'athlete_id',
      label: 'Athlete ID',
      type: 'string',
      required: true,
      description: 'Intervals.icu athlete ID from Settings → Developer (e.g. i123456)',
    },
    {
      key: 'api_key',
      label: 'API Key',
      type: 'password',
      required: true,
      description: 'API key from Intervals.icu Settings → Developer',
    },
  ],
  supportsGlobal: false,
  supportsPerUser: true,
};

/** Format a Date as a local `YYYY-MM-DD` calendar day (the Intervals.icu wellness key). */
export function toLocalDate(d: Date): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export class IntervalsExporter implements Exporter {
  readonly name = 'intervals';
  readonly supportsBackdate = true;
  private readonly config: IntervalsConfig;

  constructor(config: IntervalsConfig) {
    this.config = config;
  }

  // Intervals.icu uses HTTP Basic auth with the literal username "API_KEY".
  private authHeader(): string {
    return `Basic ${btoa(`API_KEY:${this.config.apiKey}`)}`;
  }

  private wellnessUrl(date: string): string {
    return `${API_BASE}/api/v1/athlete/${encodeURIComponent(
      this.config.athleteId,
    )}/wellness/${date}`;
  }

  async healthcheck(): Promise<ExportResult> {
    // GET today's wellness record: validates the API key and the athlete id.
    return httpHealthcheck(() =>
      fetch(this.wellnessUrl(toLocalDate(new Date())), {
        headers: { Authorization: this.authHeader() },
        signal: AbortSignal.timeout(5000),
      }),
    );
  }

  async export(data: BodyComposition, context?: ExportContext): Promise<ExportResult> {
    // Wellness records are keyed by calendar day; back-date historical replays.
    const date = toLocalDate(context?.timestamp ?? new Date());
    const body = JSON.stringify({
      weight: Number(data.weight.toFixed(2)),
      bodyFat: Number(data.bodyFatPercent.toFixed(1)),
    });

    return withRetry(
      async () => {
        const response = await fetch(this.wellnessUrl(date), {
          method: 'PUT',
          headers: {
            Authorization: this.authHeader(),
            'Content-Type': 'application/json',
          },
          body,
          signal: AbortSignal.timeout(10_000),
        });

        if (!response.ok) {
          throw httpError(response.status);
        }

        log.info(`Intervals.icu wellness updated for ${date}.`);
        return { success: true };
      },
      { log, label: 'Intervals.icu wellness update' },
    );
  }
}
