import * as fs from 'node:fs';
import * as path from 'node:path';
import { createLogger } from '../logger.js';
import type { BodyComposition } from '../interfaces/scale-adapter.js';
import type { Exporter, ExportContext, ExportResult } from '../interfaces/exporter.js';
import type { ExporterSchema } from '../interfaces/exporter-schema.js';
import type { StravaConfig } from './config.js';
import { withRetry, httpError, httpHealthcheck } from '../utils/retry.js';
import { errMsg } from '../utils/error.js';
import { cliCommand } from '../cli-invocation.js';
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

  /**
   * Read the athlete profile with whatever token is on disk, refreshing it
   * first if it has expired.
   *
   * This exporter had no healthcheck at all, though it is one of the two most
   * likely to be holding a token that has stopped working: the wizard's
   * validation step and the startup check both simply skipped it (#406).
   * A GET is used rather than the PUT the export does, so a check never
   * changes the athlete's weight.
   *
   * It is not free of side effects, though: an expired access token is
   * refreshed first, and Strava rotates the refresh token on every exchange, so
   * the token file is rewritten. That is deliberate - a check that reported
   * "fine" on a token it could not actually use would be worthless - but it
   * means the startup healthcheck can write to disk.
   */
  async healthcheck(): Promise<ExportResult> {
    try {
      const accessToken = await this.ensureFreshToken(this.loadTokens());
      return await httpHealthcheck(() =>
        fetch('https://www.strava.com/api/v3/athlete', {
          headers: { Authorization: `Bearer ${accessToken}` },
          signal: AbortSignal.timeout(5000),
        }),
      );
    } catch (err) {
      // A missing or malformed token file, or a refresh that was refused: all
      // of them mean this exporter cannot work, which is what a healthcheck is
      // for.
      return { success: false, error: errMsg(err) };
    }
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
        `Strava token file not found at ${tokenPath}. Run "${cliCommand('setup-strava')}" first.`,
      );
    }
    const raw = fs.readFileSync(tokenPath, 'utf-8');
    try {
      return JSON.parse(raw) as StravaTokens;
    } catch {
      throw new Error(
        `Malformed token file at ${tokenPath}. Delete it and run "${cliCommand('setup-strava')}" again.`,
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
