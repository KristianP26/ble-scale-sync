import { createLogger } from '../logger.js';
import type { BodyComposition } from '../interfaces/scale-adapter.js';
import type { Exporter, ExportContext, ExportResult } from '../interfaces/exporter.js';
import type { ExporterSchema } from '../interfaces/exporter-schema.js';
import type { TelegramConfig } from './config.js';
import { formatNotification } from './notification-message.js';
import { withRetry, httpError } from '../utils/retry.js';
import { errMsg } from '../utils/error.js';

const log = createLogger('Telegram');

const API_BASE = 'https://api.telegram.org';

export const telegramSchema: ExporterSchema = {
  name: 'telegram',
  displayName: 'Telegram',
  description: 'Send measurement notifications to a Telegram chat via a bot',
  fields: [
    {
      key: 'bot_token',
      label: 'Bot Token',
      type: 'password',
      required: true,
      description: 'Bot token from @BotFather',
    },
    {
      key: 'chat_id',
      label: 'Chat ID',
      type: 'string',
      required: true,
      description: 'Target chat ID (numeric) or @channelusername',
    },
    {
      key: 'title',
      label: 'Title',
      type: 'string',
      required: false,
      default: 'Scale Measurement',
    },
    {
      key: 'silent',
      label: 'Silent (deliver without notification sound)',
      type: 'boolean',
      required: false,
      default: false,
    },
    {
      key: 'report_exports',
      label: 'Report export results',
      type: 'boolean',
      required: false,
      default: false,
      description: 'Wait for the other exporters and append their results to the message',
    },
  ],
  supportsGlobal: true,
  supportsPerUser: false,
};

export class TelegramExporter implements Exporter {
  readonly name = 'telegram';
  readonly reportsExports: boolean;
  private readonly config: TelegramConfig;

  constructor(config: TelegramConfig) {
    this.config = config;
    this.reportsExports = config.reportExports;
  }

  async healthcheck(): Promise<ExportResult> {
    try {
      // getChat validates both the bot token and that the bot can reach the chat.
      const url = `${API_BASE}/bot${this.config.botToken}/getChat?chat_id=${encodeURIComponent(
        this.config.chatId,
      )}`;
      const response = await fetch(url, {
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
    const { botToken, chatId, title, silent } = this.config;
    const url = `${API_BASE}/bot${botToken}/sendMessage`;
    const text = `${title}\n${formatNotification(data, context)}`;

    return withRetry(
      async () => {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            text,
            disable_notification: silent,
          }),
          signal: AbortSignal.timeout(10_000),
        });

        if (!response.ok) {
          throw httpError(response.status);
        }

        log.info('Telegram notification sent.');
        return { success: true };
      },
      { log, label: 'telegram notification' },
    );
  }
}
