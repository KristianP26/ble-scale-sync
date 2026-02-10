import { createLogger } from '../logger.js';
import type { BodyComposition } from '../interfaces/scale-adapter.js';
import type { Exporter, ExportResult } from '../interfaces/exporter.js';
import type { WebhookConfig } from './config.js';

const log = createLogger('Webhook');

const MAX_RETRIES = 2;

export class WebhookExporter implements Exporter {
  readonly name = 'webhook';
  private readonly config: WebhookConfig;

  constructor(config: WebhookConfig) {
    this.config = config;
  }

  async export(data: BodyComposition): Promise<ExportResult> {
    const { url, method, headers, timeout } = this.config;
    let lastError: string | undefined;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        log.info(`Retrying webhook (${attempt}/${MAX_RETRIES})...`);
      }

      try {
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
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        log.error(`Webhook failed: ${lastError}`);
      }
    }

    return { success: false, error: lastError ?? 'All webhook attempts failed' };
  }
}
