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
  reportExports: false,
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

  // A header value must be a ByteString, so Node's fetch (undici) throws on a
  // title such as "Vážení" before anything is sent, and retrying cannot help.
  // The mock builds a real Headers object to reproduce that check; ntfy
  // documents RFC 2047 encoded words as the way to send a UTF-8 header.
  describe('non-ASCII titles', () => {
    const decodeRfc2047 = (value: string): string => {
      const m = /^=\?UTF-8\?B\?([A-Za-z0-9+/=]*)\?=$/.exec(value);
      return m ? Buffer.from(m[1], 'base64').toString('utf8') : value;
    };

    it.each(['Vážení', 'Scale ⚖️ 🎉'])('delivers the title %j', async (title) => {
      mockFetch.mockImplementation(async (_url: string, init: RequestInit) => {
        new Headers(init.headers);
        return { ok: true, status: 200 };
      });
      const exporter = new NtfyExporter({ ...defaultConfig, title });
      const result = await exporter.export(samplePayload);

      expect(result).toEqual({ success: true });
      const sent = new Headers(mockFetch.mock.calls[0][1].headers).get('Title')!;
      expect(decodeRfc2047(sent)).toBe(title);
    });

    // Latin-1 passes the ByteString check but goes out as raw ISO-8859-1
    // bytes, which a UTF-8 reader such as ntfy turns into garbage.
    it('encodes a Latin-1 title too, so only ASCII ever goes out raw', async () => {
      const exporter = new NtfyExporter({ ...defaultConfig, title: 'Café' });
      await exporter.export(samplePayload);

      const sent = mockFetch.mock.calls[0][1].headers.Title as string;
      expect(sent).toMatch(/^[\x20-\x7e]*$/);
      expect(decodeRfc2047(sent)).toBe('Café');
    });

    it('leaves a plain ASCII title untouched', async () => {
      const exporter = new NtfyExporter({ ...defaultConfig, title: 'Scale Measurement' });
      await exporter.export(samplePayload);

      expect(mockFetch.mock.calls[0][1].headers.Title).toBe('Scale Measurement');
    });
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
    expect(body).toContain('Muscle 62.40 kg');
    expect(body).toContain('Bone 3.10 kg');
    expect(body).toContain('BMR 1750 kcal');
    expect(body).toContain('Physique 5');
  });

  it('exposes reportsExports from the config', () => {
    expect(new NtfyExporter(defaultConfig).reportsExports).toBe(false);
    expect(new NtfyExporter({ ...defaultConfig, reportExports: true }).reportsExports).toBe(true);
  });

  it('appends one line per export result', async () => {
    const exporter = new NtfyExporter({ ...defaultConfig, reportExports: true });
    await exporter.export(samplePayload, {
      exportResults: [
        { name: 'garmin', ok: true },
        { name: 'influxdb', ok: false, error: 'HTTP 401' },
      ],
    });

    const body = mockFetch.mock.calls[0][1].body as string;
    expect(body.endsWith('\n✅ garmin\n❌ influxdb: HTTP 401')).toBe(true);
  });

  it('truncates a forwarded export error to 120 characters', async () => {
    const exporter = new NtfyExporter({ ...defaultConfig, reportExports: true });
    await exporter.export(samplePayload, {
      exportResults: [{ name: 'file', ok: false, error: 'x'.repeat(200) }],
    });

    const body = mockFetch.mock.calls[0][1].body as string;
    expect(body.endsWith(`\n❌ file: ${'x'.repeat(120)}`)).toBe(true);
  });

  it('formats weight-valued fields in the configured unit', async () => {
    const exporter = new NtfyExporter(defaultConfig);
    await exporter.export(samplePayload, { weightUnit: 'lbs' });

    const body = mockFetch.mock.calls[0][1].body as string;
    expect(body).toContain('⚖️ 176.37 lbs');
    expect(body).toContain('Muscle 137.57 lbs');
    expect(body).toContain('Bone 6.83 lbs');
    expect(body).not.toContain('kg');
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
