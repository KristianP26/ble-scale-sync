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

  it('uses provided timestamp millis when passed', () => {
    const ts = new Date('2025-07-01T07:15:00Z');
    const line = toLineProtocol(samplePayload, 'test', undefined, ts);
    const tsField = Number(line.split(' ').pop());
    expect(tsField).toBe(ts.getTime());
  });
});

describe('InfluxDbExporter back-date support', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockResolvedValue({ status: 204 });
  });

  it('declares supportsBackdate=true', () => {
    const exporter = new InfluxDbExporter(defaultConfig);
    expect(exporter.supportsBackdate).toBe(true);
  });

  it('passes context.timestamp through to the line protocol', async () => {
    const exporter = new InfluxDbExporter(defaultConfig);
    const ts = new Date('2025-07-01T07:15:00Z');
    await exporter.export(samplePayload, { timestamp: ts });
    const body = mockFetch.mock.calls[0][1].body as string;
    const tsField = Number(body.split(' ').pop());
    expect(tsField).toBe(ts.getTime());
  });
});

describe('InfluxDbExporter InfluxDB v3 compatibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockResolvedValue({ status: 204 });
  });

  // Measured against a real influxdb:3-core container: an unauthenticated
  // GET /health answers 401 there, so the wizard reported a working v3 target
  // as broken even though the write itself returned 204.
  it('sends the token on the healthcheck', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200 });
    const exporter = new InfluxDbExporter(defaultConfig);
    const result = await exporter.healthcheck();

    expect(result.success).toBe(true);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('http://localhost:8086/health');
    expect(init.headers.Authorization).toBe('Token my-token');
  });

  it('reports the healthcheck status when the token is rejected', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 401 });
    const exporter = new InfluxDbExporter(defaultConfig);
    const result = await exporter.healthcheck();

    expect(result.success).toBe(false);
    expect(result.error).toBe('HTTP 401');
  });

  it('omits org from the write URL when it is not configured', async () => {
    const { org: _org, ...withoutOrg } = defaultConfig;
    const exporter = new InfluxDbExporter(withoutOrg as InfluxDbConfig);
    await exporter.export(samplePayload);

    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).not.toContain('org=');
    expect(url).toBe('http://localhost:8086/api/v2/write?bucket=my-bucket&precision=ms');
  });

  it('omits org when it is configured as an empty string', async () => {
    const exporter = new InfluxDbExporter({ ...defaultConfig, org: '' });
    await exporter.export(samplePayload);

    expect(mockFetch.mock.calls[0][0] as string).not.toContain('org=');
  });

  it('still sends org when configured, for v2', async () => {
    const exporter = new InfluxDbExporter(defaultConfig);
    await exporter.export(samplePayload);

    expect(mockFetch.mock.calls[0][0] as string).toBe(
      'http://localhost:8086/api/v2/write?org=my-org&bucket=my-bucket&precision=ms',
    );
  });
});
