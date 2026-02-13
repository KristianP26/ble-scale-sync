import { createLogger } from '../logger.js';
import type { BodyComposition } from '../interfaces/scale-adapter.js';
import type { Exporter, ExportContext, ExportResult } from '../interfaces/exporter.js';
import type { ExporterSchema } from '../interfaces/exporter-schema.js';
import type { NtfyConfig } from './config.js';
import { withRetry } from '../utils/retry.js';
import { errMsg } from '../utils/error.js';

const log = createLogger('Ntfy');

export const ntfySchema: ExporterSchema = {
  name: 'ntfy',
  displayName: 'Ntfy',
  description: 'Send push notifications via ntfy.sh or self-hosted ntfy server',
  fields: [
    {
      key: 'topic',
      label: 'Topic',
      type: 'string',
      required: true,
      description: 'Ntfy topic name',
    },
    {
      key: 'url',
      label: 'Server URL',
      type: 'string',
      required: false,
      default: 'https://ntfy.sh',
    },
    { key: 'title', label: 'Title', type: 'string', required: false, default: 'Scale Measurement' },
    {
      key: 'priority',
      label: 'Priority',
      type: 'select',
      required: false,
      default: 3,
      choices: [
        { label: '1 (Min)', value: 1 },
        { label: '2 (Low)', value: 2 },
        { label: '3 (Default)', value: 3 },
        { label: '4 (High)', value: 4 },
      ],
    },
    { key: 'token', label: 'Bearer Token', type: 'password', required: false },
    { key: 'username', label: 'Username', type: 'string', required: false },
    { key: 'password', label: 'Password', type: 'password', required: false },
  ],
  supportsGlobal: true,
  supportsPerUser: false,
};

function formatMessage(data: BodyComposition, userName?: string): string {
  const prefix = userName ? `[${userName}] ` : '';
  return [
    `${prefix}⚖️ ${data.weight.toFixed(2)} kg | BMI ${data.bmi.toFixed(1)}`,
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

  async export(data: BodyComposition, context?: ExportContext): Promise<ExportResult> {
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

    const body = formatMessage(data, context?.userName);

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
