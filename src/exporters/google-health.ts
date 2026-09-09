import { createLogger } from '../logger.js';
import type { BodyComposition } from '../interfaces/scale-adapter.js';
import type { Exporter, ExportContext, ExportResult } from '../interfaces/exporter.js';
import type { ExporterSchema } from '../interfaces/exporter-schema.js';
import { withRetry, httpError, NonRetryableError } from '../utils/retry.js';
import { errMsg } from '../utils/error.js';
import type { GoogleHealthConfig } from './config.js';

const log = createLogger('GoogleHealth');

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API_BASE = 'https://health.googleapis.com/v4/users/me/dataTypes';
const WEIGHT_URL = `${API_BASE}/weight/dataPoints`;
const BODY_FAT_URL = `${API_BASE}/body-fat/dataPoints`;

const REQUIRED_SCOPE =
  'https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.writeonly';

const REQUEST_TIMEOUT_MS = 10_000;
const TOKEN_EXPIRY_SKEW_MS = 60_000;

/**
 * Runtime configuration for the Google Health exporter.
 *
 * The refresh token must have been granted with offline access and the
 * health_metrics_and_measurements.writeonly scope. Access tokens are obtained
 * and cached in memory; they are never persisted or logged.
 */
export const googleHealthSchema: ExporterSchema = {
  name: 'google-health',
  displayName: 'Google Health',
  description: 'Push weight and derived body fat to the Google Health API',
  fields: [
    {
      key: 'client_id',
      label: 'OAuth Client ID',
      type: 'string',
      required: true,
      description: 'Google OAuth 2.0 Web application client ID',
    },
    {
      key: 'client_secret',
      label: 'OAuth Client Secret',
      type: 'password',
      required: true,
      description: 'Google OAuth 2.0 Web application client secret',
    },
    {
      key: 'refresh_token',
      label: 'OAuth Refresh Token',
      type: 'password',
      required: true,
      description:
        'Refresh token granted with offline access and the Google Health health-metrics write scope',
    },
    {
      key: 'write_body_fat',
      label: 'Upload body fat',
      type: 'boolean',
      required: false,
      default: true,
      description: 'Upload bodyFatPercent as a DERIVED Google Health body-fat data point',
    },
    {
      key: 'device_manufacturer',
      label: 'Scale manufacturer',
      type: 'string',
      required: false,
      description: 'Optional device metadata, for example Juniper',
    },
    {
      key: 'device_display_name',
      label: 'Scale display name',
      type: 'string',
      required: false,
      description: 'Optional device metadata, for example Juniper Body Fat Scale',
    },
  ],

  // Google OAuth credentials belong to one person's health account. Requiring
  // per-user configuration prevents one shared token receiving every household
  // member's measurements by mistake.
  supportsGlobal: false,
  supportsPerUser: true,
};

interface GoogleTokenResponse {
  access_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
}

interface GoogleApiError {
  error?: {
    code?: number;
    message?: string;
    status?: string;
  };
}

interface GoogleOperation {
  name?: string;
  done?: boolean;
  response?: unknown;
  error?: {
    code?: number;
    message?: string;
  };
}

type RecordingMethod = 'ACTIVELY_MEASURED' | 'DERIVED';

interface SampleTime {
  physicalTime: string;
  utcOffset?: string;
}

interface DataSource {
  recordingMethod: RecordingMethod;
  device?: {
    formFactor: 'SCALE';
    manufacturer?: string;
    displayName?: string;
  };
}

interface WeightDataPoint {
  dataSource: DataSource;
  weight: {
    sampleTime: SampleTime;
    weightGrams: number;
  };
}

interface BodyFatDataPoint {
  bodyFat: {
    sampleTime: SampleTime;
    percentage: number;
  };
}

function safeJson<T>(text: string): T | undefined {
  if (!text) return undefined;

  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

function tokenErrorDetail(payload: GoogleTokenResponse | undefined): string | undefined {
  if (!payload) return undefined;

  if (payload.error_description) {
    return payload.error_description;
  }

  return payload.error;
}

function apiErrorDetail(payload: GoogleApiError | undefined): string | undefined {
  const error = payload?.error;

  if (!error) {
    return undefined;
  }

  return error.message ?? error.status;
}

/**
 * Build the Google Health sample timestamp.
 *
 * The physical time is sent as RFC3339 and the UTC offset follows the process
 * timezone and the date's DST rules. Containers that should use local civil
 * time should set TZ explicitly.
 */
function buildSampleTime(timestamp: Date): SampleTime {
  if (Number.isNaN(timestamp.getTime())) {
    throw new NonRetryableError('Google Health measurement timestamp is invalid');
  }

  return {
    physicalTime: timestamp.toISOString(),
    utcOffset: `${-timestamp.getTimezoneOffset() * 60}s`,
  };
}

function validWeight(weightKg: number): boolean {
  return Number.isFinite(weightKg) && weightKg > 0;
}

function validBodyFat(percentage: number): boolean {
  // BLE Scale Sync uses non-positive values as effectively absent in several
  // exporters. Google permits 0, but suppressing it here avoids turning a
  // missing or placeholder value into a genuine health record.
  return Number.isFinite(percentage) && percentage > 0 && percentage <= 100;
}

export class GoogleHealthExporter implements Exporter {
  readonly name = 'google-health';
  readonly supportsBackdate = true;

  private readonly config: GoogleHealthConfig;

  private accessToken: string | null = null;
  private accessTokenExpiresAt = 0;
  private tokenRefreshInFlight: Promise<string> | null = null;

  constructor(config: GoogleHealthConfig) {
    this.config = config;
  }

  private buildDataSource(recordingMethod: RecordingMethod): DataSource {
    const manufacturer = this.config.deviceManufacturer?.trim();
    const displayName = this.config.deviceDisplayName?.trim();

    const dataSource: DataSource = {
      recordingMethod,
    };

    if (manufacturer || displayName) {
      dataSource.device = {
        formFactor: 'SCALE',
        ...(manufacturer ? { manufacturer } : {}),
        ...(displayName ? { displayName } : {}),
      };
    }

    return dataSource;
  }

  private buildWeightPayload(data: BodyComposition, timestamp: Date): WeightDataPoint {
    return {
      dataSource: this.buildDataSource('ACTIVELY_MEASURED'),
      weight: {
        sampleTime: buildSampleTime(timestamp),

        // Scale readings are currently at 0.1 kg resolution. Whole grams
        // avoid carrying floating-point noise into the Google Health record.
        weightGrams: Math.round(data.weight * 1000),
      },
    };
  }

  private buildBodyFatPayload(data: BodyComposition, timestamp: Date): BodyFatDataPoint {
    return {
      bodyFat: {
        sampleTime: buildSampleTime(timestamp),
        percentage: Number(data.bodyFatPercent.toFixed(2)),
      },
    };
  }

  private clearCachedAccessToken(): void {
    this.accessToken = null;
    this.accessTokenExpiresAt = 0;
  }

  /**
   * Perform one refresh-token exchange.
   *
   * Credentials and returned tokens are never logged.
   */
  private async refreshAccessTokenOnce(): Promise<string> {
    const body = new URLSearchParams({
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      refresh_token: this.config.refreshToken,
      grant_type: 'refresh_token',
    });

    const response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    const text = await response.text();
    const payload = safeJson<GoogleTokenResponse>(text);

    if (!response.ok) {
      const detail = tokenErrorDetail(payload);

      throw httpError(
        response.status,
        detail ? `Google OAuth token refresh (${detail})` : 'Google OAuth token refresh',
      );
    }

    if (!payload?.access_token) {
      throw new NonRetryableError('Google OAuth token refresh returned no access_token');
    }

    if (payload.scope) {
      const scopes = new Set(payload.scope.split(/\s+/).filter(Boolean));

      if (!scopes.has(REQUIRED_SCOPE)) {
        throw new NonRetryableError(
          'Google OAuth refresh token does not include the Google Health health-metrics write scope',
        );
      }
    }

    const expiresInSeconds =
      typeof payload.expires_in === 'number' && payload.expires_in > 0 ? payload.expires_in : 3600;

    this.accessToken = payload.access_token;
    this.accessTokenExpiresAt = Date.now() + expiresInSeconds * 1000;

    return payload.access_token;
  }

  /**
   * Refreshing an OAuth access token is safe to retry; unlike creating a health
   * data point, it cannot duplicate a measurement.
   */
  private async refreshAccessToken(): Promise<string> {
    let token = '';

    const result = await withRetry(
      async () => {
        token = await this.refreshAccessTokenOnce();

        return {
          success: true,
        };
      },
      {
        log,
        label: 'Google OAuth token refresh',
      },
    );

    if (!result.success || !token) {
      throw new Error(result.error ?? 'Google OAuth token refresh failed');
    }

    return token;
  }

  private async getAccessToken(forceRefresh = false): Promise<string> {
    if (
      !forceRefresh &&
      this.accessToken &&
      Date.now() + TOKEN_EXPIRY_SKEW_MS < this.accessTokenExpiresAt
    ) {
      return this.accessToken;
    }

    if (forceRefresh) {
      this.clearCachedAccessToken();
    }

    // Coalesce concurrent exports or health checks so they do not race
    // multiple refresh-token exchanges against the same Google account.
    if (!this.tokenRefreshInFlight) {
      this.tokenRefreshInFlight = this.refreshAccessToken().finally(() => {
        this.tokenRefreshInFlight = null;
      });
    }

    return this.tokenRefreshInFlight;
  }

  /**
   * POST one Google Health data point.
   *
   * Data creation is deliberately not wrapped in withRetry(): POST /dataPoints
   * is not treated as idempotent here. If Google accepted the record but the
   * connection failed before the response reached us, retrying could create a
   * duplicate health entry.
   *
   * HTTP 401 is the exception. The request was not authorized, so refreshing
   * the bearer token and retrying once does not risk duplicating the record.
   */
  private async createDataPoint(
    label: 'weight' | 'body fat',
    url: string,
    payload: WeightDataPoint | BodyFatDataPoint,
    allowAuthRetry = true,
  ): Promise<void> {
    const accessToken = await this.getAccessToken();
    const requestBody = JSON.stringify(payload);

    log.debug(`Google Health ${label} endpoint: ${url}`);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: requestBody,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    const text = await response.text();

    if (response.status === 401 && allowAuthRetry) {
      log.warn(
        `Google Health ${label} received HTTP 401; refreshing access token and retrying once.`,
      );

      await this.getAccessToken(true);

      return this.createDataPoint(label, url, payload, false);
    }

    if (!response.ok) {
      const parsedError = safeJson<GoogleApiError>(text);
      const detail = apiErrorDetail(parsedError);

      throw new Error(
        detail
          ? `Google Health ${label} upload failed: HTTP ${response.status} (${detail})`
          : `Google Health ${label} upload failed: HTTP ${response.status}`,
      );
    }

    const operation = safeJson<GoogleOperation>(text);

    if (operation?.error) {
      throw new Error(
        `Google Health ${label} operation failed` +
          (operation.error.message ? `: ${operation.error.message}` : ''),
      );
    }

    if (operation?.done === false) {
      log.info(`Google Health ${label} upload accepted and is still processing.`);
    }
  }

  async export(data: BodyComposition, context?: ExportContext): Promise<ExportResult> {
    if (!validWeight(data.weight)) {
      return {
        success: false,
        error: `invalid weight: ${data.weight}`,
      };
    }

    const timestamp = context?.timestamp ?? new Date();

    try {
      await this.createDataPoint('weight', WEIGHT_URL, this.buildWeightPayload(data, timestamp));

      log.info(`Google Health weight uploaded: ${data.weight.toFixed(2)} kg.`);
    } catch (err) {
      const error = errMsg(err);

      log.error(`Google Health weight upload failed: ${error}`);

      return {
        success: false,
        error,
      };
    }

    if (this.config.writeBodyFat) {
      if (!validBodyFat(data.bodyFatPercent)) {
        log.warn(`Skipping Google Health body fat: invalid value ${String(data.bodyFatPercent)}%.`);
      } else {
        try {
          const bodyFatPayload = this.buildBodyFatPayload(data, timestamp);

          await this.createDataPoint('body fat', BODY_FAT_URL, bodyFatPayload);

          log.info(`Google Health derived body fat uploaded: ${data.bodyFatPercent.toFixed(2)}%.`);
        } catch (err) {
          const error = errMsg(err);

          log.error(`Google Health body fat upload failed after weight succeeded: ${error}`);

          return {
            success: false,
            error: `weight uploaded; body fat upload failed: ${error}`,
          };
        }
      }
    }

    return {
      success: true,
    };
  }

  /**
   * Validate the long-lived credentials without writing a fake health record.
   *
   * This confirms that the refresh token can still produce an access token.
   * Google Health API authorization itself is exercised by the next real upload.
   */
  async healthcheck(): Promise<ExportResult> {
    try {
      await this.getAccessToken(true);

      return {
        success: true,
      };
    } catch (err) {
      return {
        success: false,
        error: errMsg(err),
      };
    }
  }
}
