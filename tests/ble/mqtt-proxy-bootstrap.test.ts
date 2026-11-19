import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootstrapMqttProxy } from '../../src/ble/mqtt-proxy-bootstrap.js';
import { hasOpenssl, makeBrokerCert } from '../helpers/broker-cert.js';
import type { MqttProxyConfig } from '../../src/config/schema.js';

beforeAll(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterAll(() => {
  vi.restoreAllMocks();
});

function baseConfig(overrides: Partial<MqttProxyConfig> = {}): MqttProxyConfig {
  return {
    device_id: 'esp32-ble-proxy',
    topic_prefix: 'ble-proxy',
    embedded_broker_port: 0, // ephemeral
    embedded_broker_bind: '127.0.0.1',
    auto_connect: true,
    ...overrides,
  };
}

describe('bootstrapMqttProxy', () => {
  it('is a no-op when broker_url is already configured', async () => {
    const mqttProxy = baseConfig({ broker_url: 'mqtt://192.168.1.10:1883' });
    const result = await bootstrapMqttProxy(mqttProxy);
    expect(result.embeddedBroker).toBeNull();
    expect(result.mqttProxy.broker_url).toBe('mqtt://192.168.1.10:1883');
  });

  it('starts the embedded broker when broker_url is absent', async () => {
    const mqttProxy = baseConfig();
    const result = await bootstrapMqttProxy(mqttProxy);
    try {
      expect(result.embeddedBroker).not.toBeNull();
      expect(result.mqttProxy.broker_url).toMatch(/^mqtt:\/\/127\.0\.0\.1:\d+$/);
      expect(result.mqttProxy.broker_url).toBe(result.embeddedBroker!.url);
    } finally {
      if (result.embeddedBroker) await result.embeddedBroker.close();
    }
  });

  it('limits retained publishes to the device of the config', async () => {
    const result = await bootstrapMqttProxy(baseConfig({ device_id: 'esp-a' }));
    try {
      const { connectAsync } = await import('mqtt');
      const client = await connectAsync(result.mqttProxy.broker_url!, {
        clientId: 'retained-check',
        clean: true,
        reconnectPeriod: 0,
      });
      const closed = new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), 500);
        client.once('close', () => {
          clearTimeout(timer);
          resolve(true);
        });
      });
      // Another device's status: the retained rule is keyed to `device_id`.
      void client.publishAsync('ble-proxy/esp-b/status', 'x', { retain: true }).catch(() => {});
      expect(await closed).toBe(true);
      await client.endAsync(true);
    } finally {
      if (result.embeddedBroker) await result.embeddedBroker.close();
    }
  });

  describe.skipIf(!hasOpenssl())('with TLS keys', () => {
    let dir: string;
    let cert: { cert: string; key: string };

    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), 'bss-bootstrap-tls-'));
      cert = makeBrokerCert(dir);
    });

    afterAll(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    const tlsConfig = (certFile: string, keyFile: string) =>
      baseConfig({
        username: 'alice',
        password: 'secret',
        embedded_broker_tls_cert: certFile,
        embedded_broker_tls_key: keyFile,
      });

    it('starts a TLS broker and points broker_url at its loopback listener', async () => {
      const result = await bootstrapMqttProxy(tlsConfig(cert.cert, cert.key));
      try {
        expect(result.embeddedBroker?.tls).toBe(true);
        expect(result.mqttProxy.broker_url).toBe(result.embeddedBroker!.url);
        expect(result.mqttProxy.broker_url).toMatch(/^mqtt:\/\/127\.0\.0\.1:\d+$/);
        const { connectAsync } = await import('mqtt');
        const client = await connectAsync(`mqtts://127.0.0.1:${result.embeddedBroker!.port}`, {
          clientId: 'bootstrap-tls',
          ca: readFileSync(cert.cert),
          servername: 'localhost',
          username: 'alice',
          password: 'secret',
          reconnectPeriod: 0,
          connectTimeout: 3000,
        });
        expect(client.connected).toBe(true);
        await client.endAsync(true);
      } finally {
        if (result.embeddedBroker) await result.embeddedBroker.close();
      }
    });

    it.skipIf(process.platform === 'win32')('expands ~/ in the file paths', async () => {
      vi.stubEnv('HOME', dir);
      try {
        const result = await bootstrapMqttProxy(tlsConfig('~/broker.pem', '~/broker.key'));
        try {
          expect(result.embeddedBroker?.tls).toBe(true);
        } finally {
          if (result.embeddedBroker) await result.embeddedBroker.close();
        }
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it('does not start without a usable file', async () => {
      await expect(bootstrapMqttProxy(tlsConfig(join(dir, 'nope.pem'), cert.key))).rejects.toThrow(
        /certificate file not found/,
      );
    });
  });

  it('propagates credentials from config to the embedded broker', async () => {
    const mqttProxy = baseConfig({ username: 'alice', password: 'secret' });
    const result = await bootstrapMqttProxy(mqttProxy);
    try {
      expect(result.embeddedBroker).not.toBeNull();
      const { connectAsync } = await import('mqtt');
      await expect(
        connectAsync(result.mqttProxy.broker_url!, {
          clientId: 'auth-check',
          clean: true,
          reconnectPeriod: 0,
          connectTimeout: 1500,
          // no credentials -> must be rejected
        }),
      ).rejects.toThrow();
    } finally {
      if (result.embeddedBroker) await result.embeddedBroker.close();
    }
  });
});
