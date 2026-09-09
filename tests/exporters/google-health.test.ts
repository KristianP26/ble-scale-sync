import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GoogleHealthExporter } from '../../src/exporters/google-health.js';
import type { GoogleHealthConfig } from '../../src/exporters/config.js';
import type { BodyComposition } from '../../src/interfaces/scale-adapter.js';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const WEIGHT_URL = 'https://health.googleapis.com/v4/users/me/dataTypes/weight/dataPoints';
const BODY_FAT_URL = 'https://health.googleapis.com/v4/users/me/dataTypes/body-fat/dataPoints';

const REQUIRED_SCOPE =
  'https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.writeonly';

const samplePayload: BodyComposition = {
  weight: 72.5,
  impedance: 485,
  bmi: 23.1,
  bodyFatPercent: 18.456,
  waterPercent: 55.2,
  boneMass: 3.1,
  muscleMass: 58.4,
  visceralFat: 6,
  physiqueRating: 5,
  bmr: 1650,
  metabolicAge: 25,
};

const defaultConfig: GoogleHealthConfig = {
  clientId: 'test-client-id',
  clientSecret: 'test-client-secret',
  refreshToken: 'test-refresh-token',
  writeBodyFat: true,
};

const mockFetch = vi.fn();

vi.stubGlobal('fetch', mockFetch);

function mockResponse(
  status: number,
  body: unknown = {},
): {
  ok: boolean;
  status: number;
  statusText: string;
  text: () => Promise<string>;
} {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status >= 200 && status < 300 ? 'OK' : 'Error',
    text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

function tokenResponse(
  accessToken = 'test-access-token',
  expiresIn = 3600,
): ReturnType<typeof mockResponse> {
  return mockResponse(200, {
    access_token: accessToken,
    expires_in: expiresIn,
    scope: REQUIRED_SCOPE,
    token_type: 'Bearer',
  });
}

function parseRequestBody(callIndex: number): unknown {
  const options = mockFetch.mock.calls[callIndex][1] as RequestInit;
  return JSON.parse(String(options.body));
}

describe('GoogleHealthExporter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('has name "google-health" and supports backdated readings', () => {
    const exporter = new GoogleHealthExporter(defaultConfig);

    expect(exporter.name).toBe('google-health');
    expect(exporter.supportsBackdate).toBe(true);
  });

  it('refreshes an OAuth access token and uploads weight', async () => {
    mockFetch
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(mockResponse(200, { done: true }));

    const exporter = new GoogleHealthExporter({
      ...defaultConfig,
      writeBodyFat: false,
    });

    const result = await exporter.export(samplePayload);

    expect(result.success).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);

    expect(mockFetch.mock.calls[0][0]).toBe(TOKEN_URL);

    const tokenOptions = mockFetch.mock.calls[0][1] as RequestInit;
    expect(tokenOptions.method).toBe('POST');
    expect(tokenOptions.headers).toEqual(
      expect.objectContaining({
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      }),
    );

    const tokenBody = tokenOptions.body as URLSearchParams;

    expect(tokenBody.get('client_id')).toBe('test-client-id');
    expect(tokenBody.get('client_secret')).toBe('test-client-secret');
    expect(tokenBody.get('refresh_token')).toBe('test-refresh-token');
    expect(tokenBody.get('grant_type')).toBe('refresh_token');

    expect(mockFetch.mock.calls[1][0]).toBe(WEIGHT_URL);

    const uploadOptions = mockFetch.mock.calls[1][1] as RequestInit;

    expect(uploadOptions.method).toBe('POST');
    expect(uploadOptions.headers).toEqual(
      expect.objectContaining({
        Authorization: 'Bearer test-access-token',
        'Content-Type': 'application/json',
        Accept: 'application/json',
      }),
    );

    const payload = parseRequestBody(1) as {
      dataSource: {
        recordingMethod: string;
      };
      weight: {
        weightGrams: number;
      };
    };

    expect(payload.dataSource.recordingMethod).toBe('ACTIVELY_MEASURED');
    expect(payload.weight.weightGrams).toBe(72_500);
  });

  it('uses the measurement timestamp supplied in ExportContext', async () => {
    mockFetch
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(mockResponse(200, { done: true }));

    const exporter = new GoogleHealthExporter({
      ...defaultConfig,
      writeBodyFat: false,
    });

    const timestamp = new Date('2026-08-24T10:15:30.000Z');

    const result = await exporter.export(samplePayload, {
      timestamp,
    });

    expect(result.success).toBe(true);

    const payload = parseRequestBody(1) as {
      weight: {
        sampleTime: {
          physicalTime: string;
        };
      };
    };

    expect(payload.weight.sampleTime.physicalTime).toBe('2026-08-24T10:15:30.000Z');
  });

  it('uploads body fat when enabled and a valid value is available', async () => {
    mockFetch
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(mockResponse(200, { done: true }))
      .mockResolvedValueOnce(mockResponse(200, { done: true }));

    const exporter = new GoogleHealthExporter(defaultConfig);

    const result = await exporter.export(samplePayload);

    expect(result.success).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(3);

    expect(mockFetch.mock.calls[1][0]).toBe(WEIGHT_URL);
    expect(mockFetch.mock.calls[2][0]).toBe(BODY_FAT_URL);

    const bodyFatPayload = parseRequestBody(2) as {
      bodyFat: {
        percentage: number;
      };
    };

    expect(bodyFatPayload.bodyFat.percentage).toBe(18.46);
  });

  it('does not upload body fat when writeBodyFat is disabled', async () => {
    mockFetch
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(mockResponse(200, { done: true }));

    const exporter = new GoogleHealthExporter({
      ...defaultConfig,
      writeBodyFat: false,
    });

    const result = await exporter.export(samplePayload);

    expect(result.success).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch.mock.calls[1][0]).toBe(WEIGHT_URL);
  });

  it('skips an invalid body-fat value but still uploads weight', async () => {
    mockFetch
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(mockResponse(200, { done: true }));

    const exporter = new GoogleHealthExporter(defaultConfig);

    const result = await exporter.export({
      ...samplePayload,
      bodyFatPercent: 0,
    });

    expect(result.success).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch.mock.calls[1][0]).toBe(WEIGHT_URL);
  });

  it('includes optional scale metadata in the weight data source', async () => {
    mockFetch
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(mockResponse(200, { done: true }));

    const exporter = new GoogleHealthExporter({
      ...defaultConfig,
      writeBodyFat: false,
      deviceManufacturer: 'Test Manufacturer',
      deviceDisplayName: 'Test Scale',
    });

    const result = await exporter.export(samplePayload);

    expect(result.success).toBe(true);

    const payload = parseRequestBody(1) as {
      dataSource: {
        device?: {
          formFactor: string;
          manufacturer?: string;
          displayName?: string;
        };
      };
    };

    expect(payload.dataSource.device).toEqual({
      formFactor: 'SCALE',
      manufacturer: 'Test Manufacturer',
      displayName: 'Test Scale',
    });
  });

  it('reuses a cached access token for subsequent uploads', async () => {
    mockFetch
      .mockResolvedValueOnce(tokenResponse('cached-token'))
      .mockResolvedValueOnce(mockResponse(200, { done: true }))
      .mockResolvedValueOnce(mockResponse(200, { done: true }));

    const exporter = new GoogleHealthExporter({
      ...defaultConfig,
      writeBodyFat: false,
    });

    const first = await exporter.export(samplePayload);
    const second = await exporter.export(samplePayload);

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);

    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(mockFetch.mock.calls[0][0]).toBe(TOKEN_URL);
    expect(mockFetch.mock.calls[1][0]).toBe(WEIGHT_URL);
    expect(mockFetch.mock.calls[2][0]).toBe(WEIGHT_URL);

    const secondUploadOptions = mockFetch.mock.calls[2][1] as RequestInit;

    expect(secondUploadOptions.headers).toEqual(
      expect.objectContaining({
        Authorization: 'Bearer cached-token',
      }),
    );
  });

  it('refreshes the token and retries once after an HTTP 401', async () => {
    mockFetch
      .mockResolvedValueOnce(tokenResponse('expired-token'))
      .mockResolvedValueOnce(
        mockResponse(401, {
          error: {
            message: 'Invalid Credentials',
          },
        }),
      )
      .mockResolvedValueOnce(tokenResponse('replacement-token'))
      .mockResolvedValueOnce(mockResponse(200, { done: true }));

    const exporter = new GoogleHealthExporter({
      ...defaultConfig,
      writeBodyFat: false,
    });

    const result = await exporter.export(samplePayload);

    expect(result.success).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(4);

    expect(mockFetch.mock.calls[0][0]).toBe(TOKEN_URL);
    expect(mockFetch.mock.calls[1][0]).toBe(WEIGHT_URL);
    expect(mockFetch.mock.calls[2][0]).toBe(TOKEN_URL);
    expect(mockFetch.mock.calls[3][0]).toBe(WEIGHT_URL);

    const firstUpload = mockFetch.mock.calls[1][1] as RequestInit;
    const retryUpload = mockFetch.mock.calls[3][1] as RequestInit;

    expect(firstUpload.headers).toEqual(
      expect.objectContaining({
        Authorization: 'Bearer expired-token',
      }),
    );

    expect(retryUpload.headers).toEqual(
      expect.objectContaining({
        Authorization: 'Bearer replacement-token',
      }),
    );
  });

  it('returns a structured Google API error when weight upload fails', async () => {
    mockFetch.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(
      mockResponse(400, {
        error: {
          code: 400,
          message: 'Invalid data point',
          status: 'INVALID_ARGUMENT',
        },
      }),
    );

    const exporter = new GoogleHealthExporter({
      ...defaultConfig,
      writeBodyFat: false,
    });

    const result = await exporter.export(samplePayload);

    expect(result.success).toBe(false);
    expect(result.error).toContain('HTTP 400');
    expect(result.error).toContain('Invalid data point');
  });

  it('reports partial failure when weight succeeds but body fat fails', async () => {
    mockFetch
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(mockResponse(200, { done: true }))
      .mockResolvedValueOnce(
        mockResponse(500, {
          error: {
            message: 'Body fat service unavailable',
          },
        }),
      );

    const exporter = new GoogleHealthExporter(defaultConfig);

    const result = await exporter.export(samplePayload);

    expect(result.success).toBe(false);
    expect(result.error).toContain('weight uploaded; body fat upload failed');
    expect(result.error).toContain('HTTP 500');
  });

  it('fails without making a request when the weight is invalid', async () => {
    const exporter = new GoogleHealthExporter(defaultConfig);

    const result = await exporter.export({
      ...samplePayload,
      weight: 0,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('invalid weight');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('healthcheck refreshes the access token without writing health data', async () => {
    mockFetch.mockResolvedValueOnce(tokenResponse());

    const exporter = new GoogleHealthExporter(defaultConfig);

    const result = await exporter.healthcheck();

    expect(result.success).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toBe(TOKEN_URL);
  });

  it('healthcheck fails when the refresh token lacks the required scope', async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse(200, {
        access_token: 'test-access-token',
        expires_in: 3600,
        scope: 'https://www.googleapis.com/auth/some.other.scope',
        token_type: 'Bearer',
      }),
    );

    const exporter = new GoogleHealthExporter(defaultConfig);

    const result = await exporter.healthcheck();

    expect(result.success).toBe(false);
    expect(result.error).toContain('does not include the Google Health health-metrics write scope');
  });
});
