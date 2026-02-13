import { createLogger } from '../logger.js';
import type { BodyComposition } from '../interfaces/scale-adapter.js';
import type { Exporter, ExportContext, ExportResult } from '../interfaces/exporter.js';
import type { ExporterSchema } from '../interfaces/exporter-schema.js';
import type { WebhookConfig } from './config.js';
import { withRetry } from '../utils/retry.js';
import { errMsg } from '../utils/error.js';

const log = createLogger('Webhook');

export const webhookSchema: ExporterSchema = {
  name: 'webhook',
  displayName: 'Webhook',
  description: 'Send body composition data via HTTP request to a custom URL',
  fields: [
    {
      key: 'url',
      label: 'Webhook URL',
      type: 'string',
      required: true,
      description: 'The URL to send data to',
    },
    {
      key: 'method',
      label: 'HTTP Method',
      type: 'select',
      required: false,
      default: 'POST',
      choices: [
        { label: 'POST', value: 'POST' },
        { label: 'PUT', value: 'PUT' },
      ],
    },
    {
      key: 'headers',
      label: 'Custom Headers',
      type: 'string',
      required: false,
      description: 'Comma-separated Key: Value pairs',
    },
    { key: 'timeout', label: 'Timeout (ms)', type: 'number', required: false, default: 10000 },
  ],
  supportsGlobal: true,
  supportsPerUser: false,
};

export class WebhookExporter implements Exporter {
  readonly name = 'webhook';
  private readonly config: WebhookConfig;

  constructor(config: WebhookConfig) {
    this.config = config;
  }

  async healthcheck(): Promise<ExportResult> {
    try {
      const response = await fetch(this.config.url, {
        method: 'HEAD',
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
    const { url, method, headers, timeout } = this.config;
    const payload = context?.userName
      ? { ...data, user_name: context.userName, user_slug: context.userSlug }
      : data;

    return withRetry(
      async () => {
        const response = await fetch(url, {
          method,
          headers: { 'Content-Type': 'application/json', ...headers },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(timeout),
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        log.info(`Webhook delivered (HTTP ${response.status}).`);
        return { success: true };
      },
      { log, label: 'webhook' },
    );
  }
}
