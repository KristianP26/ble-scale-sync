import { createLogger } from '../logger.js';
import type { BodyComposition } from '../interfaces/scale-adapter.js';
import type { Exporter, ExportResult } from '../interfaces/exporter.js';
import type { WebhookConfig } from './config.js';
import { withRetry } from '../utils/retry.js';
import { errMsg } from '../utils/error.js';

const log = createLogger('Webhook');

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

  async export(data: BodyComposition): Promise<ExportResult> {
    const { url, method, headers, timeout } = this.config;

    return withRetry(
      async () => {
        const response = await fetch(url, {
          method,
          headers: { 'Content-Type': 'application/json', ...headers },
          body: JSON.stringify(data),
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
