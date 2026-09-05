import * as fs from 'node:fs';
import * as path from 'node:path';
import { createLogger } from '../logger.js';
import type { BodyComposition } from '../interfaces/scale-adapter.js';
import type { Exporter, ExportContext, ExportResult } from '../interfaces/exporter.js';
import type { ExporterSchema } from '../interfaces/exporter-schema.js';
import type { StravaConfig } from './config.js';
import { withRetry, httpError } from '../utils/retry.js';
const log = createLogger('Strava');

interface StravaTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number;
}

export const stravaSchema: ExporterSchema = {
  name: 'strava',
  displayName: 'Strava',
  description: 'Update weight in your Strava athlete profile',
  fields: [
    {
      key: 'client_id',
      label: 'Client ID',
      type: 'string',
      required: true,
      description: 'Strava API application client ID',
    },
    {
      key: 'client_secret',
      label: 'Client Secret',
      type: 'password',
      required: true,
      description: 'Strava API application client secret',
    },
    {
      key: 'token_dir',
      label: 'Token Directory',
      type: 'string',
      required: false,
      default: './strava-tokens',
      description: 'Directory for cached OAuth tokens',
    },
  ],
  supportsGlobal: false,
  supportsPerUser: true,
};

export class StravaExporter implements Exporter {
  readonly name = 'strava';
  private readonly config: StravaConfig;

  constructor(config: StravaConfig) {
    this.config = config;
  }

  async export(data: BodyComposition, _context?: ExportContext): Promise<ExportResult> {
    return withRetry(
      async () => {
        const tokens = this.loadTokens();
        const accessToken = await this.ensureFreshToken(tokens);

        const response = await fetch('https://www.strava.com/api/v3/athlete', {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ weight: data.weight }),
          signal: AbortSignal.timeout(10_000),
        });

        if (!response.ok) {
          throw httpError(response.status);
        }

        log.info(`Strava weight updated to ${data.weight.toFixed(2)} kg.`);
        return { success: true };
      },
      { log, label: 'Strava weight update' },
    );
  }

  private loadTokens(): StravaTokens {
    const tokenPath = this.tokenFilePath();
    if (!fs.existsSync(tokenPath)) {
      throw new Error(
        `Strava token file not found at ${tokenPath}. Run "npm run setup-strava" first.`,
      );
    }
    const raw = fs.readFileSync(tokenPath, 'utf-8');
    try {
      return JSON.parse(raw) as StravaTokens;
    } catch {
      throw new Error(
        `Malformed token file at ${tokenPath}. Delete it and run "npm run setup-strava" again.`,
      );
    }
  }

  private async ensureFreshToken(tokens: StravaTokens): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    if (tokens.expires_at > now) {
      return tokens.access_token;
    }

    log.info('Access token expired, refreshing...');
    const response = await fetch('https://www.strava.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        grant_type: 'refresh_token',
        refresh_token: tokens.refresh_token,
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      throw httpError(response.status, 'Token refresh failed');
    }

    const data = (await response.json()) as {
      access_token: string;
      refresh_token: string;
      expires_at: number;
    };

    const updated: StravaTokens = {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: data.expires_at,
    };

    this.saveTokens(updated);
    log.info('Token refreshed successfully.');
    return updated.access_token;
  }

  private saveTokens(tokens: StravaTokens): void {
    const tokenPath = this.tokenFilePath();
    const dir = path.dirname(tokenPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(tokenPath, JSON.stringify(tokens, null, 2) + '\n', { mode: 0o600 });
  }

  private tokenFilePath(): string {
    return path.join(this.config.tokenDir, 'strava_tokens.json');
  }
}
