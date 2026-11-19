import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebhookExporter } from '../../src/exporters/webhook.js';
import { InfluxDbExporter } from '../../src/exporters/influxdb.js';
import type { BodyComposition } from '../../src/interfaces/scale-adapter.js';

// Real sockets and the real fetch: the mocked tests prove what we ask for, this
// proves what undici then does with a redirect on every supported Node version.

const sample: BodyComposition = {
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

interface Seen {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

const servers: http.Server[] = [];

async function listen(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
  seen?: Seen[],
): Promise<number> {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c));
    req.on('end', () => {
      seen?.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
      handler(req, res);
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return (server.address() as AddressInfo).port;
}

afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }
});

describe('exporters against a server that redirects to another host', () => {
  async function pair(status: number): Promise<{ trustedPort: number; reached: Seen[] }> {
    const reached: Seen[] = [];
    const otherPort = await listen((_req, res) => {
      res.writeHead(204);
      res.end();
    }, reached);
    const trustedPort = await listen((_req, res) => {
      res.writeHead(status, { location: `http://127.0.0.1:${otherPort}/elsewhere` });
      res.end();
    });
    return { trustedPort, reached };
  }

  it.each([302, 303])(
    'webhook counts a %i as delivered and sends nothing to the redirect target',
    async (status) => {
      const { trustedPort, reached } = await pair(status);
      const exporter = new WebhookExporter({
        url: `http://127.0.0.1:${trustedPort}/hook`,
        method: 'POST',
        headers: { 'X-Api-Key': 'secret-key' },
        timeout: 5000,
      });
      const result = await exporter.export(sample);
      expect(result).toEqual({ success: true });
      expect(reached).toEqual([]);
    },
  );

  it('influxdb counts a 303 as delivered and sends nothing to the redirect target', async () => {
    const { trustedPort, reached } = await pair(303);
    const exporter = new InfluxDbExporter({
      url: `http://127.0.0.1:${trustedPort}`,
      token: 't',
      org: 'o',
      bucket: 'b',
      measurement: 'm',
    });
    const result = await exporter.export(sample);
    expect(result.success).toBe(true);
    expect(reached).toEqual([]);
  });

  it.each([301, 307, 308])(
    'webhook sends nothing to the redirect target on a %i and reports the redirect',
    async (status) => {
      const { trustedPort, reached } = await pair(status);
      const exporter = new WebhookExporter({
        url: `http://127.0.0.1:${trustedPort}/hook`,
        method: 'POST',
        headers: { 'X-Api-Key': 'secret-key' },
        timeout: 5000,
      });
      const result = await exporter.export(sample);
      expect(result.success).toBe(false);
      expect(result.error).toMatch(
        new RegExp(
          `^HTTP ${status}: redirected to http://127\\.0\\.0\\.1:\\d+, which is not followed`,
        ),
      );
      expect(reached).toEqual([]);
    },
  );

  it('influxdb sends nothing to the redirect target and does not report a success', async () => {
    const { trustedPort, reached } = await pair(307);
    const exporter = new InfluxDbExporter({
      url: `http://127.0.0.1:${trustedPort}`,
      token: 't',
      org: 'o',
      bucket: 'b',
      measurement: 'm',
    });
    const result = await exporter.export(sample);
    expect(result.success).toBe(false);
    expect(result.error).toContain('HTTP 307');
    expect(reached).toEqual([]);
  });
});
