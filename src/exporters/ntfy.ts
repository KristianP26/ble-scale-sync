import { createLogger } from '../logger.js';
import type { BodyComposition } from '../interfaces/scale-adapter.js';
import type { Exporter, ExportResult } from '../interfaces/exporter.js';
import type { NtfyConfig } from './config.js';
import { withRetry } from '../utils/retry.js';
import { errMsg } from '../utils/error.js';

const log = createLogger('Ntfy');

function formatMessage(data: BodyComposition): string {
  return [
    `⚖️ ${data.weight.toFixed(2)} kg | BMI ${data.bmi.toFixed(1)}`,
    `🏋️ Body Fat ${data.bodyFatPercent.toFixed(1)}% | Muscle ${data.muscleMass.toFixed(1)} kg`,
    `💧 Water ${data.waterPercent.toFixed(1)}% | 🦴 Bone ${data.boneMass.toFixed(1)} kg`,
    `🫀 Visceral Fat ${data.visceralFat} | BMR ${data.bmr} kcal`,
    `📅 Metabolic Age ${data.metabolicAge} yr | Physique ${data.physiqueRating}`,
  ].join('\n');
}

export class NtfyExporter implements Exporter {
  readonly name = 'ntfy';
  private readonly config: NtfyConfig;

  constructor(config: NtfyConfig) {
    this.config = config;
  }

  async healthcheck(): Promise<ExportResult> {
    try {
      const healthUrl = `${this.config.url.replace(/\/+$/, '')}/v1/health`;
      const response = await fetch(healthUrl, {
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) {
        return { success: false, error: `HTTP ${response.status}` };
      }
      return { success: true };
    } catch (err) {
      return { success: false, error: errMsg(err) };
    }
  }

  async export(data: BodyComposition): Promise<ExportResult> {
    const { url, topic, title, priority, token, username, password } = this.config;
    const targetUrl = `${url.replace(/\/+$/, '')}/${topic}`;

    const headers: Record<string, string> = {
      Title: title,
      Priority: String(priority),
      Tags: 'scales',
    };

    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    } else if (username && password) {
      headers['Authorization'] = `Basic ${btoa(username + ':' + password)}`;
    }

    const body = formatMessage(data);

    return withRetry(
      async () => {
        const response = await fetch(targetUrl, {
          method: 'POST',
          headers,
          body,
          signal: AbortSignal.timeout(10_000),
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        log.info('Ntfy notification sent.');
        return { success: true };
      },
      { log, label: 'ntfy notification' },
    );
  }
}
