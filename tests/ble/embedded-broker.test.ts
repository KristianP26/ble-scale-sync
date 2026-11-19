import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  beforeEach,
  afterAll,
  type MockInstance,
} from 'vitest';
import { networkInterfaces } from 'node:os';
import { connect as netConnect, type Socket } from 'node:net';
import { connectAsync, type MqttClient } from 'mqtt';
import { startEmbeddedBroker } from '../../src/ble/embedded-broker.js';
import { _resetPeerInput } from '../../src/ble/peer-input.js';
import {
  createMqttClient,
  getOrCreatePersistentClient,
  _resetProxyState,
} from '../../src/ble/handler-mqtt-proxy/client.js';
import type { MqttProxyConfig } from '../../src/config/schema.js';

let warnSpy: MockInstance<typeof console.warn>;

// Suppress log output during tests
beforeAll(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

beforeEach(() => {
  warnSpy.mockClear();
  _resetPeerInput();
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

describe('startEmbeddedBroker packet size limits', () => {
  // One unauthenticated socket used to be able to make the broker buffer
  // 150 MB: aedes and mqtt-packet have no packet size option.
  it('closes a socket whose first packet announces 32 KiB', async () => {
    const broker = await startEmbeddedBroker({ port: 0, bindHost: '127.0.0.1' });
    try {
      const socket = await rawSocket(broker.port);
      const closed = socketClosesWithin(socket, 1000);
      socket.write(Buffer.from([0x10, 0x80, 0x80, 0x02])); // remaining length 32768
      expect(await closed).toBe(true);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          'Closed a connection from 127.0.0.1: its first packet is over the limit of 16384 bytes.',
        ),
      );
    } finally {
      await broker.close();
    }
  });

  it('closes a connected client that announces a later packet over the limit', async () => {
    const broker = await startEmbeddedBroker({
      port: 0,
      bindHost: '127.0.0.1',
      limits: { maxPacketBytes: 4096 },
    });
    try {
      const socket = await rawSocket(broker.port);
      socket.write(connectPacket('size-limit'));
      await waitForBytes(socket, 4); // CONNACK
      const closed = socketClosesWithin(socket, 1000);
      socket.write(Buffer.from([0x30, 0x81, 0x20])); // PUBLISH, remaining length 4097
      expect(await closed).toBe(true);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          'Closed a connection from 127.0.0.1: it announced an MQTT packet over the limit of 4096 bytes.',
        ),
      );
    } finally {
      await broker.close();
    }
  });

  it('delivers a publish whose remaining length is exactly the limit', async () => {
    const broker = await startEmbeddedBroker({
      port: 0,
      bindHost: '127.0.0.1',
      limits: { maxPacketBytes: 4096 },
    });
    try {
      const client = await connectAsync(broker.url, { clientId: 'size-exact', reconnectPeriod: 0 });
      try {
        const received = new Promise<number>((resolve) => {
          client.on('message', (_t, payload) => resolve(payload.length));
        });
        await client.subscribeAsync('t');
        // QoS 0 remaining length = 2 (topic length) + 1 (topic) + payload.
        await client.publishAsync('t', Buffer.alloc(4096 - 3, 0x61));
        await expect(received).resolves.toBe(4093);
      } finally {
        await client.endAsync(true);
      }
    } finally {
      await broker.close();
    }
  });

  it('closes the publisher of a packet one byte over the limit', async () => {
    const broker = await startEmbeddedBroker({
      port: 0,
      bindHost: '127.0.0.1',
      limits: { maxPacketBytes: 4096 },
    });
    try {
      const client = await connectAsync(broker.url, { clientId: 'size-over', reconnectPeriod: 0 });
      try {
        const closed = closesWithin(client, 1000);
        void client.publishAsync('t', Buffer.alloc(4096 - 2, 0x61)).catch(() => {});
        expect(await closed).toBe(true);
      } finally {
        await client.endAsync(true);
      }
    } finally {
      await broker.close();
    }
  });

  // The largest scan batch the firmware sends is about 430 KiB in the worst
  // case (firmware/tests/test_scan_payload_size.py), so the default must carry
  // a 900 KiB publish.
  it('delivers a 900 KiB publish with the default limits', async () => {
    const broker = await startEmbeddedBroker({ port: 0, bindHost: '127.0.0.1' });
    try {
      const client = await connectAsync(broker.url, { clientId: 'size-900k', reconnectPeriod: 0 });
      try {
        const received = new Promise<number>((resolve) => {
          client.on('message', (_t, payload) => resolve(payload.length));
        });
        await client.subscribeAsync('scan/results');
        await client.publishAsync('scan/results', Buffer.alloc(900 * 1024, 0x61));
        await expect(received).resolves.toBe(900 * 1024);
      } finally {
        await client.endAsync(true);
      }
    } finally {
      await broker.close();
    }
  });

  it('does not cut a packet whose header arrives in two writes', async () => {
    const broker = await startEmbeddedBroker({ port: 0, bindHost: '127.0.0.1' });
    try {
      const socket = await rawSocket(broker.port);
      socket.write(connectPacket('size-split'));
      await waitForBytes(socket, 4); // CONNACK
      const before = socket.bytesRead;
      socket.write(Buffer.from([0xc0])); // PINGREQ type byte only
      await new Promise((r) => setTimeout(r, 30));
      socket.write(Buffer.from([0x00])); // its length, one tick later
      await waitForBytes(socket, before + 2); // PINGRESP d0 00
      expect(socket.destroyed).toBe(false);
    } finally {
      await broker.close();
    }
  });

  it('logs an oversize connection once a minute', async () => {
    const broker = await startEmbeddedBroker({ port: 0, bindHost: '127.0.0.1' });
    try {
      for (let i = 0; i < 3; i++) {
        const socket = await rawSocket(broker.port);
        const closed = socketClosesWithin(socket, 1000);
        socket.write(Buffer.from([0x10, 0x80, 0x80, 0x02]));
        expect(await closed).toBe(true);
      }
      const lines = warnSpy.mock.calls.filter((c) => String(c[0]).includes('Closed a connection'));
      expect(lines).toHaveLength(1);
      // Under the broker's own scope, so a log filter on it sees the policy warnings too.
      expect(String(lines[0][0])).toContain('[MQTTBroker]');
    } finally {
      await broker.close();
    }
  });
});

describe('startEmbeddedBroker connection limits', () => {
  it('closes the connection over the cap and accepts one again after another closes', async () => {
    const broker = await startEmbeddedBroker({
      port: 0,
      bindHost: '127.0.0.1',
      limits: { maxConnections: 3 },
    });
    const idle: Socket[] = [];
    try {
      for (let i = 0; i < 3; i++) idle.push(await rawSocket(broker.port));
      expect(idle.every((s) => !s.destroyed)).toBe(true);

      const fourth = await rawSocket(broker.port);
      expect(await socketClosesWithin(fourth, 1000)).toBe(true);
      expect(idle.every((s) => !s.destroyed)).toBe(true);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          'Refused a connection from 127.0.0.1: the broker already has 3 open connections.',
        ),
      );

      const freed = socketClosesWithin(idle[0], 1000);
      idle[0].destroy();
      await freed;
      await new Promise((r) => setTimeout(r, 50));
      const client = await connectAsync(broker.url, { clientId: 'cap-after', reconnectPeriod: 0 });
      expect(client.connected).toBe(true);
      await client.endAsync(true);
    } finally {
      for (const s of idle) s.destroy();
      await broker.close();
    }
  });

  it('closes a socket that sends no CONNECT within the timeout', async () => {
    const broker = await startEmbeddedBroker({
      port: 0,
      bindHost: '127.0.0.1',
      limits: { connectTimeoutMs: 300 },
    });
    try {
      const socket = await rawSocket(broker.port);
      expect(await socketClosesWithin(socket, 2000)).toBe(true);
    } finally {
      await broker.close();
    }
  });

  // The cap of 32 only holds up if a reconnect loop does not pile up sockets:
  // aedes closes the older connection of the same client id on takeover.
  it('does not accumulate sockets when a client reconnects with a fixed id', async () => {
    const broker = await startEmbeddedBroker({
      port: 0,
      bindHost: '127.0.0.1',
      limits: { maxConnections: 3 },
    });
    try {
      for (let i = 0; i < 5; i++) {
        const client = await connectAsync(broker.url, {
          clientId: 'fixed-id',
          clean: false,
          reconnectPeriod: 0,
          connectTimeout: 1500,
        });
        expect(client.connected).toBe(true);
        // Not ended: the next iteration takes the id over while this one is open.
        client.on('error', () => {});
      }
      expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('Refused a connection'));
    } finally {
      await broker.close();
    }
  });
});

describe('startEmbeddedBroker policy logging', () => {
  it('logs a failed login once with the address and without the credentials', async () => {
    const broker = await startEmbeddedBroker({
      port: 0,
      bindHost: '127.0.0.1',
      username: 'real-user',
      password: 'real-secret',
    });
    try {
      for (let i = 0; i < 3; i++) {
        await expect(
          connectAsync(broker.url, {
            clientId: `bad-login-${i}`,
            username: 'sent-user',
            password: 'sent-secret',
            reconnectPeriod: 0,
            connectTimeout: 2000,
          }),
        ).rejects.toThrow();
      }
      const lines = warnSpy.mock.calls.map((c) => String(c[0]));
      const login = lines.filter((l) => l.includes('Rejected a login'));
      expect(login).toHaveLength(1);
      expect(login[0]).toContain('Rejected a login from 127.0.0.1: bad username or password.');
      for (const secret of ['real-user', 'real-secret', 'sent-user', 'sent-secret']) {
        expect(lines.join('\n')).not.toContain(secret);
      }
    } finally {
      await broker.close();
    }
  });

  it('logs a publish outside the topic prefix', async () => {
    const broker = await startEmbeddedBroker({
      port: 0,
      bindHost: '127.0.0.1',
      topicPrefix: 'ble-proxy',
    });
    try {
      const client = await connectAsync(broker.url, { clientId: 'acl-log', reconnectPeriod: 0 });
      try {
        const closed = closesWithin(client, 1000);
        void client.publishAsync('rogue/topic', 'x').catch(() => {});
        expect(await closed).toBe(true);
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining(
            'Disconnected 127.0.0.1: publish rejected: topic outside "ble-proxy"',
          ),
        );
      } finally {
        await client.endAsync(true);
      }
    } finally {
      await broker.close();
    }
  });

  it('logs a subscribe outside the topic prefix', async () => {
    const broker = await startEmbeddedBroker({
      port: 0,
      bindHost: '127.0.0.1',
      topicPrefix: 'ble-proxy',
    });
    try {
      const client = await connectAsync(broker.url, {
        clientId: 'acl-sub-log',
        reconnectPeriod: 0,
      });
      try {
        const closed = closesWithin(client, 1000);
        void client.subscribeAsync('#').catch(() => {});
        expect(await closed).toBe(true);
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining(
            'Disconnected 127.0.0.1: subscribe rejected: topic outside "ble-proxy"',
          ),
        );
      } finally {
        await client.endAsync(true);
      }
    } finally {
      await broker.close();
    }
  });
});

describe('startEmbeddedBroker password check', () => {
  // timingSafeEqual on the raw bytes: two passwords that decode to the same
  // text after a lossy UTF-8 conversion must not match.
  it('does not accept a password that differs only in invalid UTF-8 bytes', async () => {
    const broker = await startEmbeddedBroker({
      port: 0,
      bindHost: '127.0.0.1',
      username: 'user',
      password: '\u{FFFD}',
    });
    try {
      await expect(
        connectAsync(broker.url, {
          clientId: 'bytes-pass',
          username: 'user',
          password: Buffer.from([0xff]),
          reconnectPeriod: 0,
          connectTimeout: 2000,
        }),
      ).rejects.toThrow();
    } finally {
      await broker.close();
    }
  });
});

/**
 * Whether the broker drops a client that publishes to / subscribes to `topic`:
 * aedes closes the connection of a client the ACL turns down.
 */
async function aclRefuses(
  url: string,
  action: 'publish' | 'subscribe',
  topic: string,
): Promise<boolean> {
  const client = await connectAsync(url, {
    clientId: `acl-${action}-${Math.random().toString(16).slice(2)}`,
    reconnectPeriod: 0,
  });
  try {
    const closed = closesWithin(client, 400);
    const call =
      action === 'publish' ? client.publishAsync(topic, 'x') : client.subscribeAsync(topic);
    void call.catch(() => {});
    return await closed;
  } finally {
    await client.endAsync(true);
  }
}

describe('startEmbeddedBroker topic ACL', () => {
  // `topic_prefix: ''` is accepted by the schema. The ACL used to be installed
  // only for a truthy prefix, so an empty one left every topic open.
  it('keeps the ACL on for an empty topic_prefix', async () => {
    const broker = await startEmbeddedBroker({ port: 0, bindHost: '127.0.0.1', topicPrefix: '' });
    try {
      expect(await aclRefuses(broker.url, 'publish', 'rogue')).toBe(true);
      expect(await aclRefuses(broker.url, 'publish', 'rogue/topic')).toBe(true);
      expect(await aclRefuses(broker.url, 'publish', '/esp/status')).toBe(false);
      expect(await aclRefuses(broker.url, 'subscribe', '#')).toBe(true);
      expect(await aclRefuses(broker.url, 'subscribe', '+/x')).toBe(true);
      expect(await aclRefuses(broker.url, 'subscribe', '/esp/#')).toBe(false);
    } finally {
      await broker.close();
    }
  });

  it('keeps the exact prefix boundary for a non-empty topic_prefix', async () => {
    const broker = await startEmbeddedBroker({
      port: 0,
      bindHost: '127.0.0.1',
      topicPrefix: 'ble-proxy',
    });
    try {
      expect(await aclRefuses(broker.url, 'publish', 'ble-proxy')).toBe(false);
      expect(await aclRefuses(broker.url, 'publish', 'ble-proxy/esp/status')).toBe(false);
      expect(await aclRefuses(broker.url, 'subscribe', 'ble-proxy/+/status')).toBe(false);
      expect(await aclRefuses(broker.url, 'publish', 'ble-proxy2/x')).toBe(true);
      expect(await aclRefuses(broker.url, 'publish', 'ble-proxy-x/y')).toBe(true);
      expect(await aclRefuses(broker.url, 'subscribe', '+/x')).toBe(true);
    } finally {
      await broker.close();
    }
  });
});

describe('startEmbeddedBroker keep alive limit', () => {
  const connectWith = (url: string, keepalive: number, clientId: string): Promise<MqttClient> =>
    connectAsync(url, { clientId, keepalive, reconnectPeriod: 0, connectTimeout: 2000 });

  it('connects clients with a keep alive of 60 and 300 seconds', async () => {
    const broker = await startEmbeddedBroker({ port: 0, bindHost: '127.0.0.1' });
    try {
      for (const keepalive of [60, 300]) {
        const client = await connectWith(broker.url, keepalive, `ka-${keepalive}`);
        expect(client.connected).toBe(true);
        await client.endAsync(true);
      }
    } finally {
      await broker.close();
    }
  });

  it('refuses a keep alive over 300 seconds and a keep alive of 0', async () => {
    const broker = await startEmbeddedBroker({ port: 0, bindHost: '127.0.0.1' });
    try {
      await expect(connectWith(broker.url, 3600, 'ka-3600')).rejects.toThrow();
      await expect(connectWith(broker.url, 301, 'ka-301')).rejects.toThrow();
      await expect(connectWith(broker.url, 0, 'ka-0')).rejects.toThrow();
    } finally {
      await broker.close();
    }
  });

  it('logs the refusal with the address, once a minute', async () => {
    const broker = await startEmbeddedBroker({ port: 0, bindHost: '127.0.0.1' });
    try {
      await expect(connectWith(broker.url, 3600, 'ka-log-1')).rejects.toThrow();
      await expect(connectWith(broker.url, 0, 'ka-log-2')).rejects.toThrow();
      const lines = warnSpy.mock.calls.filter((c) => String(c[0]).includes('Refused a connection'));
      expect(lines).toHaveLength(1);
      expect(String(lines[0][0])).toContain(
        'Refused a connection from 127.0.0.1: its keep alive is 0 or over 300 seconds.',
      );
    } finally {
      await broker.close();
    }
  });

  // The app's own clients keep the mqtt.js default keep alive (60 s), so the
  // limit never locks the app out of its own broker.
  it('connects the app own clients', async () => {
    const broker = await startEmbeddedBroker({ port: 0, bindHost: '127.0.0.1' });
    const config = {
      device_id: 'esp32-ble-proxy',
      topic_prefix: 'ble-proxy',
      embedded_broker_port: 0,
      embedded_broker_bind: '127.0.0.1',
      broker_url: broker.url,
    } as MqttProxyConfig;
    try {
      const ephemeral = await createMqttClient(config);
      expect(ephemeral.connected).toBe(true);
      await ephemeral.endAsync(true);
      const persistent = await getOrCreatePersistentClient(config);
      expect(persistent.connected).toBe(true);
      await persistent.endAsync(true);
    } finally {
      _resetProxyState();
      await broker.close();
    }
  });
});

/** Raw TCP socket to 127.0.0.1:`port`; data is buffered, errors are swallowed. */
function rawSocket(port: number): Promise<Socket & { received?: Buffer }> {
  return new Promise((resolve, reject) => {
    const socket: Socket & { received?: Buffer } = netConnect(port, '127.0.0.1');
    socket.received = Buffer.alloc(0);
    socket.on('data', (d) => {
      socket.received = Buffer.concat([socket.received ?? Buffer.alloc(0), d]);
    });
    socket.on('error', () => {});
    socket.once('connect', () => resolve(socket));
    socket.once('error', reject);
  });
}

/** MQTT 3.1.1 CONNECT, clean session, keep alive 60, no login. */
function connectPacket(clientId: string): Buffer {
  const id = Buffer.from(clientId);
  const body = Buffer.concat([
    Buffer.from([0x00, 0x04, 0x4d, 0x51, 0x54, 0x54, 0x04, 0x02, 0x00, 0x3c]),
    Buffer.from([id.length >> 8, id.length & 0xff]),
    id,
  ]);
  return Buffer.concat([Buffer.from([0x10, body.length]), body]);
}

function waitForBytes(socket: Socket & { received?: Buffer }, total: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = (): void => {
      if ((socket.received?.length ?? 0) >= total) return resolve();
      if (Date.now() - started > 2000) return reject(new Error('timed out waiting for bytes'));
      setTimeout(poll, 10);
    };
    poll();
  });
}

function socketClosesWithin(socket: Socket, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (socket.destroyed) return resolve(true);
    const timer = setTimeout(() => resolve(false), ms);
    socket.once('close', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

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
