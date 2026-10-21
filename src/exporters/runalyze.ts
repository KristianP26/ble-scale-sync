import { createLogger } from '../logger.js';
import type { BodyComposition } from '../interfaces/scale-adapter.js';
import type { Exporter, ExportContext, ExportResult } from '../interfaces/exporter.js';
import type { ExporterSchema } from '../interfaces/exporter-schema.js';
import type { RunalyzeConfig } from './config.js';
import { NonRetryableError } from '../utils/retry.js';
import { sendWithRetry } from './http.js';
import { errMsg } from '../utils/error.js';

const log = createLogger('Runalyze');

const API_BASE = 'https://runalyze.com/api/v1';
const METRIC_PATH = `${API_BASE}/metrics/bodyComposition`;

// A wrong or expired Runalyze token can come back as HTTP 200 with this marker
// in the body (the official bash example greps for it) rather than a 401.
const INVALID_TOKEN_RE = /no valid token/i;

export const runalyzeSchema: ExporterSchema = {
  name: 'runalyze',
  displayName: 'Runalyze',
  description: 'Push weight and body composition to Runalyze health metrics',
  fields: [
    {
      key: 'token',
      label: 'Personal API Token',
      type: 'password',
      required: true,
      description:
        'Personal API token from Runalyze Settings → Personal API (runalyze.com/settings/personal-api)',
    },
  ],
  supportsGlobal: false,
  supportsPerUser: true,
};

/** Runalyze bodyComposition payload. All fields but weight are optional. */
interface BodyCompositionPayload {
  date_time: string;
  weight: number;
  fat_percentage?: number;
  water_percentage?: number;
  muscle_percentage?: number;
  bone_percentage?: number;
}

/** Round to 1 decimal and return undefined for non-finite or non-positive values. */
function optionalPercent(value: number): number | undefined {
  if (!Number.isFinite(value) || value <= 0) return undefined;
  return Number(value.toFixed(1));
}

export class RunalyzeExporter implements Exporter {
  readonly name = 'runalyze';
  readonly supportsBackdate = true;
  private readonly config: RunalyzeConfig;

  constructor(config: RunalyzeConfig) {
    this.config = config;
  }

  private headers(): Record<string, string> {
    return {
      token: this.config.token,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
  }

  /**
   * Map BodyComposition to Runalyze's bodyComposition metric. Runalyze stores
   * muscle and bone as a PERCENT of body weight; this project measures them as
   * mass (kg), so convert. Optional fields are omitted when not measured.
   */
  private buildPayload(data: BodyComposition, timestamp: Date): BodyCompositionPayload {
    const payload: BodyCompositionPayload = {
      date_time: timestamp.toISOString(),
      weight: Number(data.weight.toFixed(2)),
    };

    const fat = optionalPercent(data.bodyFatPercent);
    if (fat !== undefined) payload.fat_percentage = fat;

    const water = optionalPercent(data.waterPercent);
    if (water !== undefined) payload.water_percentage = water;

    if (data.weight > 0) {
      const muscle = optionalPercent((data.muscleMass / data.weight) * 100);
      if (muscle !== undefined) payload.muscle_percentage = muscle;

      const bone = optionalPercent((data.boneMass / data.weight) * 100);
      if (bone !== undefined) payload.bone_percentage = bone;
    }

    return payload;
  }

  async export(data: BodyComposition, context?: ExportContext): Promise<ExportResult> {
    const timestamp = context?.timestamp ?? new Date();
    const body = JSON.stringify(this.buildPayload(data, timestamp));

    return sendWithRetry(
      METRIC_PATH,
      { method: 'POST', headers: this.headers(), body },
      {
        log,
        label: 'Runalyze body composition upload',
        onOk: async (response) => {
          // A valid HTTP 200 can still carry a token-rejection body.
          if (INVALID_TOKEN_RE.test(await response.text())) {
            throw new NonRetryableError('Runalyze rejected the API token');
          }
          log.info(`Runalyze body composition pushed for ${timestamp.toISOString()}.`);
        },
      },
    );
  }

  async healthcheck(): Promise<ExportResult> {
    try {
      const response = await fetch(METRIC_PATH, {
        headers: { token: this.config.token },
        signal: AbortSignal.timeout(5000),
      });
      const text = await response.text().catch(() => '');
      if (INVALID_TOKEN_RE.test(text)) {
        return { success: false, error: 'invalid token' };
      }
      if (response.status === 401) {
        return { success: false, error: 'HTTP 401' };
      }
      // 403 = token accepted but the read endpoint is gated on a paid tier.
      if (response.ok || response.status === 403) {
        return { success: true };
      }
      return { success: false, error: `HTTP ${response.status}` };
    } catch (err) {
      return { success: false, error: errMsg(err) };
    }
  }
}
