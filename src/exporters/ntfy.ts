import { createLogger } from '../logger.js';
import type { BodyComposition } from '../interfaces/scale-adapter.js';
import type { Exporter, ExportResult } from '../interfaces/exporter.js';
import type { NtfyConfig } from './config.js';

const log = createLogger('Ntfy');

const MAX_RETRIES = 2;

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
    let lastError: string | undefined;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        log.info(`Retrying ntfy notification (${attempt}/${MAX_RETRIES})...`);
      }

      try {
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
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        log.error(`Ntfy notification failed: ${lastError}`);
      }
    }

    return { success: false, error: lastError ?? 'All ntfy notification attempts failed' };
  }
}
