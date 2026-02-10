import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WebhookExporter } from '../../src/exporters/webhook.js';
import type { WebhookConfig } from '../../src/exporters/config.js';
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

const defaultConfig: WebhookConfig = {
  url: 'https://example.com/hook',
  method: 'POST',
  headers: {},
  timeout: 10_000,
};

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('WebhookExporter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockResolvedValue({ ok: true, status: 200 });
  });

  it('has name "webhook"', () => {
    const exporter = new WebhookExporter(defaultConfig);
    expect(exporter.name).toBe('webhook');
  });

  it('sends POST with JSON body to configured URL', async () => {
    const exporter = new WebhookExporter(defaultConfig);
    const result = await exporter.export(samplePayload);

    expect(result.success).toBe(true);
    expect(mockFetch).toHaveBeenCalledWith(
      'https://example.com/hook',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(samplePayload),
      }),
    );
  });

  it('uses custom HTTP method', async () => {
    const config: WebhookConfig = { ...defaultConfig, method: 'PUT' };
    const exporter = new WebhookExporter(config);
    await exporter.export(samplePayload);

    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ method: 'PUT' }),
    );
  });

  it('merges custom headers with Content-Type', async () => {
    const config: WebhookConfig = {
      ...defaultConfig,
      headers: { 'X-Api-Key': 'secret123', Authorization: 'Bearer tok' },
    };
    const exporter = new WebhookExporter(config);
    await exporter.export(samplePayload);

    const callHeaders = mockFetch.mock.calls[0][1].headers;
    expect(callHeaders).toEqual({
      'Content-Type': 'application/json',
      'X-Api-Key': 'secret123',
      Authorization: 'Bearer tok',
    });
  });

  it('returns failure on non-2xx response', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500 });
    const exporter = new WebhookExporter(defaultConfig);
    const result = await exporter.export(samplePayload);

    expect(result.success).toBe(false);
    expect(result.error).toBe('HTTP 500');
  });

  it('retries on network error (3 total attempts)', async () => {
    mockFetch.mockRejectedValue(new Error('network error'));
    const exporter = new WebhookExporter(defaultConfig);
    const result = await exporter.export(samplePayload);

    expect(result.success).toBe(false);
    expect(result.error).toBe('network error');
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('passes AbortSignal.timeout to fetch', async () => {
    const config: WebhookConfig = { ...defaultConfig, timeout: 5000 };
    const exporter = new WebhookExporter(config);
    await exporter.export(samplePayload);

    const signal = mockFetch.mock.calls[0][1].signal;
    expect(signal).toBeInstanceOf(AbortSignal);
  });

  it('succeeds on retry after initial failure', async () => {
    mockFetch
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValueOnce({ ok: true, status: 200 });
    const exporter = new WebhookExporter(defaultConfig);
    const result = await exporter.export(samplePayload);

    expect(result.success).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});
