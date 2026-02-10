import { describe, it, expect, vi, beforeEach } from 'vitest';
import { InfluxDbExporter, toLineProtocol } from '../../src/exporters/influxdb.js';
import type { InfluxDbConfig } from '../../src/exporters/config.js';
import type { BodyComposition } from '../../src/interfaces/scale-adapter.js';

const samplePayload: BodyComposition = {
  weight: 80,
  impedance: 500,
  bmi: 23.9,
  bodyFatPercent: 18.5,
  waterPercent: 55.2,
  boneMass: 3.1,
  muscleMass: 62.4,
  visceralFat: 8,
  physiqueRating: 5,
  bmr: 1750,
  metabolicAge: 30,
};

const defaultConfig: InfluxDbConfig = {
  url: 'http://localhost:8086',
  token: 'my-token',
  org: 'my-org',
  bucket: 'my-bucket',
  measurement: 'body_composition',
};

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('InfluxDbExporter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockResolvedValue({ status: 204 });
  });

  it('has name "influxdb"', () => {
    const exporter = new InfluxDbExporter(defaultConfig);
    expect(exporter.name).toBe('influxdb');
  });

  it('writes line protocol to InfluxDB v2 API', async () => {
    const exporter = new InfluxDbExporter(defaultConfig);
    const result = await exporter.export(samplePayload);

    expect(result.success).toBe(true);
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:8086/api/v2/write?org=my-org&bucket=my-bucket&precision=ms',
      expect.objectContaining({
        method: 'POST',
        headers: {
          Authorization: 'Token my-token',
          'Content-Type': 'text/plain',
        },
      }),
    );
  });

  it('sends Authorization header with token', async () => {
    const exporter = new InfluxDbExporter(defaultConfig);
    await exporter.export(samplePayload);

    const headers = mockFetch.mock.calls[0][1].headers;
    expect(headers.Authorization).toBe('Token my-token');
  });

  it('URL-encodes org and bucket', async () => {
    const config: InfluxDbConfig = {
      ...defaultConfig,
      org: 'my org',
      bucket: 'my/bucket',
    };
    const exporter = new InfluxDbExporter(config);
    await exporter.export(samplePayload);

    const url = mockFetch.mock.calls[0][0];
    expect(url).toContain('org=my%20org');
    expect(url).toContain('bucket=my%2Fbucket');
  });

  it('returns failure on non-204 response', async () => {
    mockFetch.mockResolvedValue({ status: 401 });
    const exporter = new InfluxDbExporter(defaultConfig);
    const result = await exporter.export(samplePayload);

    expect(result.success).toBe(false);
    expect(result.error).toBe('HTTP 401');
  });

  it('retries on failure (3 total attempts)', async () => {
    mockFetch.mockRejectedValue(new Error('connection refused'));
    const exporter = new InfluxDbExporter(defaultConfig);
    const result = await exporter.export(samplePayload);

    expect(result.success).toBe(false);
    expect(result.error).toBe('connection refused');
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('uses custom measurement name', async () => {
    const config: InfluxDbConfig = { ...defaultConfig, measurement: 'scale_data' };
    const exporter = new InfluxDbExporter(config);
    await exporter.export(samplePayload);

    const body = mockFetch.mock.calls[0][1].body as string;
    expect(body).toMatch(/^scale_data /);
  });
});

describe('toLineProtocol()', () => {
  it('formats float fields with 2 decimal places', () => {
    const line = toLineProtocol(samplePayload, 'test');
    expect(line).toContain('weight=80.00');
    expect(line).toContain('bmi=23.90');
    expect(line).toContain('bodyFatPercent=18.50');
    expect(line).toContain('waterPercent=55.20');
    expect(line).toContain('boneMass=3.10');
    expect(line).toContain('muscleMass=62.40');
  });

  it('formats integer fields with i suffix', () => {
    const line = toLineProtocol(samplePayload, 'test');
    expect(line).toContain('impedance=500i');
    expect(line).toContain('visceralFat=8i');
    expect(line).toContain('physiqueRating=5i');
    expect(line).toContain('bmr=1750i');
    expect(line).toContain('metabolicAge=30i');
  });

  it('starts with measurement name', () => {
    const line = toLineProtocol(samplePayload, 'body_composition');
    expect(line).toMatch(/^body_composition /);
  });

  it('ends with timestamp in milliseconds', () => {
    const before = Date.now();
    const line = toLineProtocol(samplePayload, 'test');
    const after = Date.now();
    const timestamp = Number(line.split(' ').pop());
    expect(timestamp).toBeGreaterThanOrEqual(before);
    expect(timestamp).toBeLessThanOrEqual(after);
  });
});
