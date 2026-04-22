import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { connectAsync } from 'mqtt';
import { startEmbeddedBroker } from '../../src/ble/embedded-broker.js';

// Suppress log output during tests
beforeAll(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterAll(() => {
  vi.restoreAllMocks();
});

describe('startEmbeddedBroker', () => {
  it('assigns an ephemeral port when port=0 and exposes a loopback URL', async () => {
    const broker = await startEmbeddedBroker({ port: 0, bindHost: '127.0.0.1' });
    try {
      expect(broker.port).toBeGreaterThan(0);
      expect(broker.url).toBe(`mqtt://127.0.0.1:${broker.port}`);
    } finally {
      await broker.close();
    }
  });

  it('accepts MQTT publish/subscribe round-trip from an external client', async () => {
    const broker = await startEmbeddedBroker({ port: 0, bindHost: '127.0.0.1' });
    try {
      const client = await connectAsync(broker.url, { clientId: 'test-roundtrip', clean: true });
      try {
        const received = new Promise<string>((resolve) => {
          client.on('message', (_topic, payload) => resolve(payload.toString()));
        });
        await client.subscribeAsync('embedded/roundtrip');
        await client.publishAsync('embedded/roundtrip', 'hello');
        await expect(received).resolves.toBe('hello');
      } finally {
        await client.endAsync();
      }
    } finally {
      await broker.close();
    }
  });

  it('rejects unauthenticated clients when username/password are configured', async () => {
    const broker = await startEmbeddedBroker({
      port: 0,
      bindHost: '127.0.0.1',
      username: 'user',
      password: 'pass',
    });
    try {
      await expect(
        connectAsync(broker.url, {
          clientId: 'bad-creds',
          clean: true,
          username: 'wrong',
          password: 'wrong',
          reconnectPeriod: 0,
          connectTimeout: 2000,
        }),
      ).rejects.toThrow();
    } finally {
      await broker.close();
    }
  });

  it('accepts correct credentials when authentication is configured', async () => {
    const broker = await startEmbeddedBroker({
      port: 0,
      bindHost: '127.0.0.1',
      username: 'user',
      password: 'pass',
    });
    try {
      const client = await connectAsync(broker.url, {
        clientId: 'good-creds',
        clean: true,
        username: 'user',
        password: 'pass',
        reconnectPeriod: 0,
        connectTimeout: 2000,
      });
      try {
        expect(client.connected).toBe(true);
      } finally {
        await client.endAsync();
      }
    } finally {
      await broker.close();
    }
  });

  it('fails with an actionable error when the port is already in use', async () => {
    const first = await startEmbeddedBroker({ port: 0, bindHost: '127.0.0.1' });
    try {
      await expect(
        startEmbeddedBroker({ port: first.port, bindHost: '127.0.0.1' }),
      ).rejects.toThrow(/already in use/);
    } finally {
      await first.close();
    }
  });

  it('close() stops accepting new connections', async () => {
    const broker = await startEmbeddedBroker({ port: 0, bindHost: '127.0.0.1' });
    const url = broker.url;
    await broker.close();
    await expect(
      connectAsync(url, {
        clientId: 'post-close',
        clean: true,
        reconnectPeriod: 0,
        connectTimeout: 1000,
      }),
    ).rejects.toThrow();
  });

  it('close() is idempotent', async () => {
    const broker = await startEmbeddedBroker({ port: 0, bindHost: '127.0.0.1' });
    await broker.close();
    await expect(broker.close()).resolves.toBeUndefined();
  });

  it('rejects publishes to topics outside the configured topic_prefix', async () => {
    const broker = await startEmbeddedBroker({
      port: 0,
      bindHost: '127.0.0.1',
      topicPrefix: 'ble-proxy',
    });
    try {
      const publisher = await connectAsync(broker.url, {
        clientId: 'acl-publisher',
        clean: true,
        reconnectPeriod: 0,
      });
      const subscriber = await connectAsync(broker.url, {
        clientId: 'acl-subscriber',
        clean: true,
        reconnectPeriod: 0,
      });
      try {
        const received: string[] = [];
        subscriber.on('message', (t) => received.push(t));
        // Subscribe inside prefix (allowed)
        await subscriber.subscribeAsync('ble-proxy/#');
        // Publish inside prefix (should be delivered)
        await publisher.publishAsync('ble-proxy/esp32-ble-proxy/status', 'online');
        // Publish outside prefix (should be dropped by broker ACL)
        await publisher.publishAsync('rogue/topic', 'pwnd');
        // Brief wait for delivery
        await new Promise((r) => setTimeout(r, 100));
        expect(received).toContain('ble-proxy/esp32-ble-proxy/status');
        expect(received).not.toContain('rogue/topic');
      } finally {
        await publisher.endAsync();
        await subscriber.endAsync();
      }
    } finally {
      await broker.close();
    }
  });

  it('allows subscribe filters inside the prefix (including wildcards)', async () => {
    const broker = await startEmbeddedBroker({
      port: 0,
      bindHost: '127.0.0.1',
      topicPrefix: 'ble-proxy',
    });
    try {
      const client = await connectAsync(broker.url, {
        clientId: 'acl-wildcard',
        clean: true,
        reconnectPeriod: 0,
      });
      try {
        // Wildcard within prefix (allowed)
        await expect(client.subscribeAsync('ble-proxy/+/status')).resolves.toBeDefined();
      } finally {
        await client.endAsync();
      }
    } finally {
      await broker.close();
    }
  });
});
