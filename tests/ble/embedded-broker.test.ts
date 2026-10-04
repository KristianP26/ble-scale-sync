import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { networkInterfaces } from 'node:os';
import { connectAsync, type MqttClient } from 'mqtt';
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

  // Last line of defence behind the config schema: a LAN-exposed broker with a
  // username but no password would accept that username with an empty password.
  it('refuses to start on a non-loopback bind with a username but no password', async () => {
    await expect(
      startEmbeddedBroker({ port: 0, bindHost: '0.0.0.0', username: 'user' }),
    ).rejects.toThrow(/password/);
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

  // B-19: the previous version of this test subscribed only to `ble-proxy/#`
  // and then asserted that `rogue/topic` did not arrive, which it could not
  // have with or without the ACL. A subscriber that is allowed to receive
  // `rogue/topic` cannot exist while the subscribe ACL is in place either, so
  // these assert what aedes does with a denied packet instead: it closes the
  // offending client's connection, while an allowed one stays up.
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
        await subscriber.subscribeAsync('ble-proxy/#');
        // Inside the prefix: delivered, and the publisher stays connected.
        await publisher.publishAsync('ble-proxy/esp32-ble-proxy/status', 'online');
        expect(await closesWithin(publisher, 200)).toBe(false);
        expect(received).toContain('ble-proxy/esp32-ble-proxy/status');

        // Outside the prefix: refused, which aedes enforces by dropping the
        // publisher's connection.
        const closed = closesWithin(publisher, 1000);
        void publisher.publishAsync('rogue/topic', 'pwnd').catch(() => {});
        expect(await closed).toBe(true);
      } finally {
        await publisher.endAsync(true);
        await subscriber.endAsync();
      }
    } finally {
      await broker.close();
    }
  });

  it('rejects subscribe filters that reach outside the configured topic_prefix', async () => {
    const broker = await startEmbeddedBroker({
      port: 0,
      bindHost: '127.0.0.1',
      topicPrefix: 'ble-proxy',
    });
    try {
      for (const filter of ['#', 'rogue/#']) {
        const client = await connectAsync(broker.url, {
          clientId: `acl-sub-${filter.replace(/\W/g, '')}`,
          clean: true,
          reconnectPeriod: 0,
        });
        try {
          const closed = closesWithin(client, 1000);
          void client.subscribeAsync(filter).catch(() => {});
          expect(await closed, `subscribe to "${filter}" was accepted`).toBe(true);
        } finally {
          await client.endAsync(true);
        }
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

  // B-08: the URL handed to the app's own client must reach the interface the
  // broker actually listens on, not always 127.0.0.1.
  it.skipIf(!hasIpv6Loopback())(
    'returns a URL its own client can reach on an IPv6 loopback bind',
    async () => {
      const broker = await startEmbeddedBroker({ port: 0, bindHost: '::1' });
      try {
        expect(broker.url).toBe(`mqtt://[::1]:${broker.port}`);
        const client = await connectAsync(broker.url, {
          clientId: 'b08-ipv6',
          clean: true,
          reconnectPeriod: 0,
          connectTimeout: 2000,
        });
        await client.endAsync();
      } finally {
        await broker.close();
      }
    },
  );

  it('keeps the IPv4 loopback URL for a wildcard bind', async () => {
    const broker = await startEmbeddedBroker({ port: 0, bindHost: '0.0.0.0' });
    try {
      expect(broker.url).toBe(`mqtt://127.0.0.1:${broker.port}`);
    } finally {
      await broker.close();
    }
  });
});

/** Whether the client's connection closes within `ms`. */
function closesWithin(client: MqttClient, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      client.removeListener('close', onClose);
      resolve(false);
    }, ms);
    const onClose = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    client.once('close', onClose);
  });
}

function hasIpv6Loopback(): boolean {
  return Object.values(networkInterfaces()).some((list) =>
    (list ?? []).some((a) => a.family === 'IPv6' && a.address === '::1'),
  );
}
