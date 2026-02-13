import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WebhookExporter } from '../../src/exporters/webhook.js';
import { InfluxDbExporter, toLineProtocol } from '../../src/exporters/influxdb.js';
import { NtfyExporter } from '../../src/exporters/ntfy.js';
import type { WebhookConfig, InfluxDbConfig, NtfyConfig } from '../../src/exporters/config.js';
import type { BodyComposition } from '../../src/interfaces/scale-adapter.js';
import type { ExportContext } from '../../src/interfaces/exporter.js';

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

const userContext: ExportContext = {
  userName: 'Dad',
  userSlug: 'dad',
};

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

beforeEach(() => {
  vi.clearAllMocks();
  mockFetch.mockResolvedValue({ ok: true, status: 200 });
});

// ─── WebhookExporter with ExportContext ──────────────────────────────────

describe('WebhookExporter with ExportContext', () => {
  const config: WebhookConfig = {
    url: 'https://example.com/hook',
    method: 'POST',
    headers: {},
    timeout: 10_000,
  };

  it('adds user fields to JSON body when context is provided', async () => {
    const exporter = new WebhookExporter(config);
    await exporter.export(samplePayload, userContext);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.user_name).toBe('Dad');
    expect(body.user_slug).toBe('dad');
    expect(body.weight).toBe(80);
  });

  it('does not add user fields when context is undefined', async () => {
    const exporter = new WebhookExporter(config);
    await exporter.export(samplePayload);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.user_name).toBeUndefined();
    expect(body.user_slug).toBeUndefined();
    expect(body.weight).toBe(80);
  });

  it('does not add user fields when userName is undefined', async () => {
    const exporter = new WebhookExporter(config);
    await exporter.export(samplePayload, { userSlug: 'dad' });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.user_name).toBeUndefined();
    expect(body.user_slug).toBeUndefined();
  });
});

// ─── InfluxDbExporter with ExportContext ─────────────────────────────────

describe('InfluxDbExporter with ExportContext', () => {
  const config: InfluxDbConfig = {
    url: 'http://localhost:8086',
    token: 'my-token',
    org: 'my-org',
    bucket: 'my-bucket',
    measurement: 'body_composition',
  };

  it('adds user tag to line protocol when context has userSlug', async () => {
    mockFetch.mockResolvedValue({ status: 204 });
    const exporter = new InfluxDbExporter(config);
    await exporter.export(samplePayload, userContext);

    const body = mockFetch.mock.calls[0][1].body as string;
    expect(body).toMatch(/^body_composition,user=dad /);
  });

  it('does not add user tag when context is undefined', async () => {
    mockFetch.mockResolvedValue({ status: 204 });
    const exporter = new InfluxDbExporter(config);
    await exporter.export(samplePayload);

    const body = mockFetch.mock.calls[0][1].body as string;
    expect(body).toMatch(/^body_composition /);
    expect(body).not.toContain(',user=');
  });
});

describe('toLineProtocol() with userSlug', () => {
  it('includes user tag when userSlug provided', () => {
    const line = toLineProtocol(samplePayload, 'test', 'dad');
    expect(line).toMatch(/^test,user=dad /);
  });

  it('omits user tag when userSlug is undefined', () => {
    const line = toLineProtocol(samplePayload, 'test');
    expect(line).toMatch(/^test /);
    expect(line).not.toContain(',user=');
  });

  it('preserves all fields with user tag', () => {
    const line = toLineProtocol(samplePayload, 'test', 'mom');
    expect(line).toContain('weight=80.00');
    expect(line).toContain('impedance=500i');
  });
});

// ─── NtfyExporter with ExportContext ────────────────────────────────────

describe('NtfyExporter with ExportContext', () => {
  const config: NtfyConfig = {
    url: 'https://ntfy.sh',
    topic: 'my-scale',
    title: 'Scale Measurement',
    priority: 3,
  };

  it('prepends [Name] to message when context has userName', async () => {
    const exporter = new NtfyExporter(config);
    await exporter.export(samplePayload, userContext);

    const body = mockFetch.mock.calls[0][1].body as string;
    expect(body).toMatch(/^\[Dad\] /);
    expect(body).toContain('80.00 kg');
  });

  it('does not prepend prefix when context is undefined', async () => {
    const exporter = new NtfyExporter(config);
    await exporter.export(samplePayload);

    const body = mockFetch.mock.calls[0][1].body as string;
    expect(body).not.toContain('[');
    expect(body).toContain('80.00 kg');
  });

  it('does not prepend prefix when userName is undefined', async () => {
    const exporter = new NtfyExporter(config);
    await exporter.export(samplePayload, { userSlug: 'dad' });

    const body = mockFetch.mock.calls[0][1].body as string;
    expect(body).not.toContain('[');
  });

  it('appends drift warning when context has driftWarning', async () => {
    const exporter = new NtfyExporter(config);
    await exporter.export(samplePayload, {
      ...userContext,
      driftWarning: "Weight 76 kg is near the lower boundary of Dad's range [75–95]",
    });

    const body = mockFetch.mock.calls[0][1].body as string;
    expect(body).toMatch(/^\[Dad\] /);
    expect(body).toContain('⚠️');
    expect(body).toContain('near the lower boundary');
  });

  it('does not append drift warning when not present', async () => {
    const exporter = new NtfyExporter(config);
    await exporter.export(samplePayload, userContext);

    const body = mockFetch.mock.calls[0][1].body as string;
    expect(body).not.toContain('⚠️');
  });
});

// ─── Orchestrator context propagation ───────────────────────────────────

describe('dispatchExports() with ExportContext', () => {
  it('propagates context to exporters', async () => {
    const { dispatchExports } = await import('../../src/orchestrator.js');

    const mockExport = vi.fn().mockResolvedValue({ success: true });
    const exporter = { name: 'test', export: mockExport };

    await dispatchExports([exporter], samplePayload, userContext);

    expect(mockExport).toHaveBeenCalledWith(samplePayload, userContext);
  });

  it('does not pass context when not provided', async () => {
    const { dispatchExports } = await import('../../src/orchestrator.js');

    const mockExport = vi.fn().mockResolvedValue({ success: true });
    const exporter = { name: 'test', export: mockExport };

    await dispatchExports([exporter], samplePayload);

    expect(mockExport).toHaveBeenCalledWith(samplePayload);
  });
});
