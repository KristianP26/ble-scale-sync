import { createLogger } from '../logger.js';
import type { BodyComposition } from '../interfaces/scale-adapter.js';
import type { Exporter, ExportContext, ExportResult } from '../interfaces/exporter.js';
import type { ExporterSchema } from '../interfaces/exporter-schema.js';
import type { IntervalsConfig } from './config.js';
import { withRetry, httpError, httpHealthcheck } from '../utils/retry.js';
import { errMsg } from '../utils/error.js';

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

/**
 * The `YYYY-MM-DD` calendar day of `d` in an IANA timezone, or null when the
 * runtime does not know that zone.
 */
export function dateInTimeZone(d: Date, timeZone: string): string | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(d);
    const get = (type: string) => parts.find((p) => p.type === type)?.value;
    const year = get('year');
    const month = get('month');
    const day = get('day');
    return year && month && day ? `${year}-${month}-${day}` : null;
  } catch {
    return null;
  }
}

export class IntervalsExporter implements Exporter {
  readonly name = 'intervals';
  readonly supportsBackdate = true;
  private readonly config: IntervalsConfig;
  /** The athlete's timezone once read; failures are not cached, so a later export tries again. */
  private athleteTimeZone: string | null = null;

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

  /**
   * The timezone set in the athlete's Intervals.icu profile (`GET
   * /api/v1/athlete/{id}`, field `timezone`), which is also where Intervals.icu
   * itself draws the line between days. Null when it cannot be read or is not a
   * zone this runtime knows; the caller then uses the host's day as before.
   */
  private async resolveAthleteTimeZone(): Promise<string | null> {
    if (this.athleteTimeZone) return this.athleteTimeZone;
    try {
      const response = await fetch(
        `${API_BASE}/api/v1/athlete/${encodeURIComponent(this.config.athleteId)}`,
        { headers: { Authorization: this.authHeader() }, signal: AbortSignal.timeout(5000) },
      );
      if (!response.ok) throw httpError(response.status);
      const { timezone } = (await response.json()) as { timezone?: unknown };
      if (typeof timezone !== 'string' || dateInTimeZone(new Date(), timezone) === null) {
        throw new Error(`unusable timezone ${JSON.stringify(timezone)}`);
      }
      this.athleteTimeZone = timezone;
      return timezone;
    } catch (err) {
      log.debug(`Athlete timezone not available (${errMsg(err)}); using this host's date.`);
      return null;
    }
  }

  async export(data: BodyComposition, context?: ExportContext): Promise<ExportResult> {
    // Wellness records are keyed by the athlete's calendar day; back-date
    // historical replays. The day used to come from the host clock alone, and a
    // Docker container without TZ runs in UTC, so a weigh-in shortly after
    // local midnight overwrote the previous day's record.
    const when = context?.timestamp ?? new Date();
    const timeZone = await this.resolveAthleteTimeZone();
    const date = (timeZone && dateInTimeZone(when, timeZone)) || toLocalDate(when);
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
