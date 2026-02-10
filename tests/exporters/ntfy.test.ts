import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NtfyExporter } from '../../src/exporters/ntfy.js';
import type { NtfyConfig } from '../../src/exporters/config.js';
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

const defaultConfig: NtfyConfig = {
  url: 'https://ntfy.sh',
  topic: 'my-scale',
  title: 'Scale Measurement',
  priority: 3,
};

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('NtfyExporter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockResolvedValue({ ok: true, status: 200 });
  });

  it('has name "ntfy"', () => {
    const exporter = new NtfyExporter(defaultConfig);
    expect(exporter.name).toBe('ntfy');
  });

  it('sends notification to correct URL', async () => {
    const exporter = new NtfyExporter(defaultConfig);
    await exporter.export(samplePayload);

    expect(mockFetch).toHaveBeenCalledWith(
      'https://ntfy.sh/my-scale',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('strips trailing slashes from URL', async () => {
    const config: NtfyConfig = { ...defaultConfig, url: 'https://ntfy.sh///' };
    const exporter = new NtfyExporter(config);
    await exporter.export(samplePayload);

    expect(mockFetch.mock.calls[0][0]).toBe('https://ntfy.sh/my-scale');
  });

  it('sends Title, Priority, and Tags headers', async () => {
    const config: NtfyConfig = { ...defaultConfig, priority: 5, title: 'My Scale' };
    const exporter = new NtfyExporter(config);
    await exporter.export(samplePayload);

    const headers = mockFetch.mock.calls[0][1].headers;
    expect(headers.Title).toBe('My Scale');
    expect(headers.Priority).toBe('5');
    expect(headers.Tags).toBe('scales');
  });

  it('formats message body with emoji', async () => {
    const exporter = new NtfyExporter(defaultConfig);
    await exporter.export(samplePayload);

    const body = mockFetch.mock.calls[0][1].body as string;
    expect(body).toContain('⚖️');
    expect(body).toContain('🏋️');
    expect(body).toContain('💧');
    expect(body).toContain('🫀');
    expect(body).toContain('📅');
    expect(body).toContain('80.00 kg');
    expect(body).toContain('BMI 23.9');
    expect(body).toContain('Body Fat 18.5%');
    expect(body).toContain('Muscle 62.4 kg');
    expect(body).toContain('BMR 1750 kcal');
    expect(body).toContain('Physique 5');
  });

  it('uses Bearer token auth when token is set', async () => {
    const config: NtfyConfig = { ...defaultConfig, token: 'tk_abc123' };
    const exporter = new NtfyExporter(config);
    await exporter.export(samplePayload);

    const headers = mockFetch.mock.calls[0][1].headers;
    expect(headers.Authorization).toBe('Bearer tk_abc123');
  });

  it('uses Basic auth when username and password are set', async () => {
    const config: NtfyConfig = { ...defaultConfig, username: 'user', password: 'pass' };
    const exporter = new NtfyExporter(config);
    await exporter.export(samplePayload);

    const headers = mockFetch.mock.calls[0][1].headers;
    expect(headers.Authorization).toBe(`Basic ${btoa('user:pass')}`);
  });

  it('prefers token over basic auth when both are set', async () => {
    const config: NtfyConfig = {
      ...defaultConfig,
      token: 'tk_abc',
      username: 'user',
      password: 'pass',
    };
    const exporter = new NtfyExporter(config);
    await exporter.export(samplePayload);

    const headers = mockFetch.mock.calls[0][1].headers;
    expect(headers.Authorization).toBe('Bearer tk_abc');
  });

  it('sends no Authorization header when no auth is configured', async () => {
    const exporter = new NtfyExporter(defaultConfig);
    await exporter.export(samplePayload);

    const headers = mockFetch.mock.calls[0][1].headers;
    expect(headers.Authorization).toBeUndefined();
  });

  it('returns failure on non-2xx response', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 403 });
    const exporter = new NtfyExporter(defaultConfig);
    const result = await exporter.export(samplePayload);

    expect(result.success).toBe(false);
    expect(result.error).toBe('HTTP 403');
  });

  it('retries on failure (3 total attempts)', async () => {
    mockFetch.mockRejectedValue(new Error('timeout'));
    const exporter = new NtfyExporter(defaultConfig);
    const result = await exporter.export(samplePayload);

    expect(result.success).toBe(false);
    expect(result.error).toBe('timeout');
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('succeeds on retry after initial failure', async () => {
    mockFetch
      .mockRejectedValueOnce(new Error('temporary'))
      .mockResolvedValueOnce({ ok: true, status: 200 });
    const exporter = new NtfyExporter(defaultConfig);
    const result = await exporter.export(samplePayload);

    expect(result.success).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});
