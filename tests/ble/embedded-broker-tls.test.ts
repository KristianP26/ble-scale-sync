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
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, connect as netConnect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { X509Certificate } from 'node:crypto';
import { connectAsync, type MqttClient } from 'mqtt';
import { startEmbeddedBroker, type EmbeddedBrokerOptions } from '../../src/ble/embedded-broker.js';
import { _resetPeerInput } from '../../src/ble/peer-input.js';
import { hasOpenssl, makeBrokerCert, type BrokerCert } from '../helpers/broker-cert.js';

let warnSpy: MockInstance<typeof console.warn>;
let root: string;
let certA: BrokerCert;
let certB: BrokerCert;
let encryptedKey: string;

beforeAll(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  if (!hasOpenssl()) return;
  root = mkdtempSync(join(tmpdir(), 'bss-broker-tls-'));
  mkdirSync(join(root, 'a'));
  mkdirSync(join(root, 'b'));
  certA = makeBrokerCert(join(root, 'a'), { cn: 'localhost' });
  certB = makeBrokerCert(join(root, 'b'), { cn: 'other.example' });
  encryptedKey = join(root, 'encrypted.key');
  execFileSync(
    'openssl',
    ['pkey', '-in', certA.key, '-aes256', '-passout', 'pass:secret', '-out', encryptedKey],
    { stdio: 'pipe' },
  );
});

beforeEach(() => {
  warnSpy.mockClear();
  _resetPeerInput();
});

afterAll(() => {
  vi.restoreAllMocks();
  if (root) rmSync(root, { recursive: true, force: true });
});

const LOGIN = { username: 'user', password: 'pass' };

function startTls(cert: BrokerCert, extra: Partial<EmbeddedBrokerOptions> = {}) {
  return startEmbeddedBroker({
    port: 0,
    bindHost: '127.0.0.1',
    ...LOGIN,
    tls: { certFile: cert.cert, keyFile: cert.key },
    ...extra,
  });
}

/** An `mqtts://` client that trusts `cert` and checks the name `servername`. */
function tlsClient(
  port: number,
  cert: BrokerCert,
  clientId: string,
  extra: Record<string, unknown> = {},
): Promise<MqttClient> {
  return connectAsync(`mqtts://127.0.0.1:${port}`, {
    clientId,
    ca: readFileSync(cert.cert),
    servername: 'localhost',
    ...LOGIN,
    reconnectPeriod: 0,
    connectTimeout: 3000,
    ...extra,
  });
}

function rawSocket(port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = netConnect(port, '127.0.0.1');
    socket.on('error', () => {});
    socket.once('connect', () => resolve(socket));
    socket.once('error', reject);
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

function closesWithin(client: MqttClient, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    client.once('close', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

describe.skipIf(!hasOpenssl())('embedded broker over TLS', () => {
  it('uses a certificate that is valid from before 1970', () => {
    // The ESP32 has no clock; the recipe in the docs starts the certificate in
    // 1960 so it verifies whatever date the board reports.
    const x509 = new X509Certificate(readFileSync(certA.cert));
    expect(x509.validFromDate.getUTCFullYear()).toBeLessThan(1970);
    expect(x509.validToDate.getUTCFullYear()).toBe(2100);
  });

  it('serves a TLS client on the public port and the app on a plaintext loopback port', async () => {
    const broker = await startTls(certA);
    try {
      expect(broker.tls).toBe(true);
      expect(broker.url).toMatch(/^mqtt:\/\/127\.0\.0\.1:\d+$/);
      expect(broker.url).not.toBe(`mqtt://127.0.0.1:${broker.port}`);

      const internal = await connectAsync(broker.url, {
        clientId: 'internal',
        ...LOGIN,
        reconnectPeriod: 0,
      });
      const lan = await tlsClient(broker.port, certA, 'lan');
      try {
        const received = new Promise<string>((resolve) => {
          internal.on('message', (_t, payload) => resolve(payload.toString()));
        });
        await internal.subscribeAsync('x/y');
        await lan.publishAsync('x/y', 'over-tls');
        await expect(received).resolves.toBe('over-tls');
      } finally {
        await lan.endAsync(true);
        await internal.endAsync(true);
      }
    } finally {
      await broker.close();
    }
  });

  it('verifies by the DNS name and by the IP address of the certificate', async () => {
    const broker = await startTls(certA);
    try {
      const byName = await tlsClient(broker.port, certA, 'by-name');
      expect(byName.connected).toBe(true);
      await byName.endAsync(true);
      // No servername: mqtt.js verifies against the host, 127.0.0.1.
      const byIp = await tlsClient(broker.port, certA, 'by-ip', { servername: undefined });
      expect(byIp.connected).toBe(true);
      await byIp.endAsync(true);
      // Another name is refused.
      await expect(
        tlsClient(broker.port, certA, 'wrong-name', { servername: 'other.example' }),
      ).rejects.toThrow();
    } finally {
      await broker.close();
    }
  });

  it('enforces the login and the topic ACL on the TLS port', async () => {
    const broker = await startTls(certA, { topicPrefix: 'ble-proxy' });
    try {
      await expect(
        tlsClient(broker.port, certA, 'bad-login', { password: 'wrong' }),
      ).rejects.toThrow();

      const client = await tlsClient(broker.port, certA, 'acl');
      try {
        const closed = closesWithin(client, 1000);
        void client.publishAsync('rogue/topic', 'x').catch(() => {});
        expect(await closed).toBe(true);
      } finally {
        await client.endAsync(true);
      }
    } finally {
      await broker.close();
    }
  });

  it('refuses a client that does not trust the certificate', async () => {
    const broker = await startTls(certA);
    try {
      await expect(
        connectAsync(`mqtts://127.0.0.1:${broker.port}`, {
          clientId: 'no-ca',
          servername: 'localhost',
          ...LOGIN,
          reconnectPeriod: 0,
          connectTimeout: 3000,
        }),
      ).rejects.toThrow();
      // A client that trusts only the other certificate fails too.
      await expect(tlsClient(broker.port, certB, 'wrong-ca')).rejects.toThrow();
    } finally {
      await broker.close();
    }
  });

  it('closes a plaintext client on the TLS port and says what to check', async () => {
    const broker = await startTls(certA);
    try {
      // The earlier test's rejected clients can still be reported by their own
      // server, and the log is throttled per kind: start from a clean slate.
      await new Promise((r) => setTimeout(r, 100));
      warnSpy.mockClear();
      _resetPeerInput();
      const socket = await rawSocket(broker.port);
      const closed = socketClosesWithin(socket, 2000);
      // A plaintext MQTT CONNECT.
      socket.write(
        Buffer.from([
          0x10, 0x0e, 0x00, 0x04, 0x4d, 0x51, 0x54, 0x54, 0x04, 0x02, 0x00, 0x3c, 0x00, 0x02, 0x61,
          0x62,
        ]),
      );
      expect(await closed).toBe(true);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringMatching(/TLS handshake from 127\.0\.0\.1 failed \(.+\).*mqtt_tls/),
      );
    } finally {
      await broker.close();
    }
  });

  // Node does not close a socket whose handshake never completes; without the
  // destroy() in the tlsClientError handler it stays open for ever.
  it('closes a socket that never completes the handshake', async () => {
    const broker = await startTls(certA, { limits: { tlsHandshakeTimeoutMs: 300 } });
    try {
      const socket = await rawSocket(broker.port);
      expect(await socketClosesWithin(socket, 2000)).toBe(true);
    } finally {
      await broker.close();
    }
  });

  // After a reset the TLS socket has no remoteAddress any more; the log line gets
  // the address from the raw socket underneath (a private field of Node's TLS
  // socket) and says "unknown address" when that is gone.
  it('names the client address when a handshake ends in a reset', async () => {
    const broker = await startTls(certA);
    try {
      const socket = await rawSocket(broker.port);
      socket.write(Buffer.from([0x16, 0x03, 0x01]));
      await new Promise((r) => setTimeout(r, 30));
      socket.resetAndDestroy();
      await new Promise((r) => setTimeout(r, 200));
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('TLS handshake from 127.0.0.1 failed (ECONNRESET)'),
      );
    } finally {
      await broker.close();
    }
  });

  it('closes within a second while a socket is still in its handshake', async () => {
    const broker = await startTls(certA, { limits: { tlsHandshakeTimeoutMs: 60_000 } });
    const socket = await rawSocket(broker.port);
    const started = Date.now();
    await broker.close();
    expect(Date.now() - started).toBeLessThan(1000);
    expect(await socketClosesWithin(socket, 1000)).toBe(true);
  });

  it('caps the connections of the TLS listener and not of the loopback listener', async () => {
    const broker = await startTls(certA, { limits: { maxConnections: 2 } });
    const idle: Socket[] = [];
    try {
      for (let i = 0; i < 2; i++) idle.push(await rawSocket(broker.port));
      const third = await rawSocket(broker.port);
      expect(await socketClosesWithin(third, 1000)).toBe(true);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('the broker already has 2 open connections'),
      );

      const internal = await connectAsync(broker.url, {
        clientId: 'internal-while-full',
        ...LOGIN,
        reconnectPeriod: 0,
      });
      expect(internal.connected).toBe(true);
      await internal.endAsync(true);
    } finally {
      for (const s of idle) s.destroy();
      await broker.close();
    }
  });

  it('serves plain MQTT without TLS keys', async () => {
    const broker = await startEmbeddedBroker({ port: 0, bindHost: '127.0.0.1' });
    try {
      expect(broker.tls).toBe(false);
      expect(broker.url).toBe(`mqtt://127.0.0.1:${broker.port}`);
    } finally {
      await broker.close();
    }
  });
});

describe.skipIf(!hasOpenssl())('embedded broker TLS files', () => {
  const start = (certFile: string, keyFile: string) =>
    startEmbeddedBroker({
      port: 0,
      bindHost: '127.0.0.1',
      ...LOGIN,
      tls: { certFile, keyFile },
    });

  function write(name: string, content: string): string {
    const path = join(root, name);
    writeFileSync(path, content);
    return path;
  }

  const cases: Array<[string, () => [string, string], RegExp]> = [
    [
      'a missing certificate',
      () => [join(root, 'missing.pem'), certA.key],
      /certificate file not found: .*missing\.pem. Fix ble\.mqtt_proxy\.embedded_broker_tls_cert/,
    ],
    [
      'a missing key',
      () => [certA.cert, join(root, 'missing.key')],
      /key file not found: .*missing\.key. Fix ble\.mqtt_proxy\.embedded_broker_tls_key/,
    ],
    [
      'a certificate that is not PEM',
      () => [write('garbage.pem', 'not a certificate'), certA.key],
      /garbage\.pem is not a PEM certificate/,
    ],
    [
      'a key that is not PEM',
      () => [certA.cert, write('garbage.key', 'not a key')],
      /garbage\.key is not a PEM private key/,
    ],
    [
      'a key that belongs to another certificate',
      () => [certA.cert, certB.key],
      /certificate and key do not match/,
    ],
    [
      'an encrypted key',
      () => [certA.cert, encryptedKey],
      /key file is encrypted: .*encrypted\.key.*openssl pkey/,
    ],
  ];

  it.each(cases)('refuses to start with %s', async (_name, files, message) => {
    const [certFile, keyFile] = files();
    let error: Error | undefined;
    await start(certFile, keyFile).catch((err) => {
      error = err as Error;
    });
    expect(error?.message).toMatch(message);
    expect(error?.message).not.toContain('PRIVATE KEY');
    expect(error?.message).not.toContain('secret');
  });

  it('leaves the port free after a bad file', async () => {
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const port = (probe.address() as { port: number }).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));

    await expect(
      startEmbeddedBroker({
        port,
        bindHost: '127.0.0.1',
        ...LOGIN,
        tls: { certFile: certA.cert, keyFile: certB.key },
      }),
    ).rejects.toThrow(/do not match/);

    const again = createServer();
    await new Promise<void>((resolve, reject) => {
      again.once('error', reject);
      again.listen(port, '127.0.0.1', resolve);
    });
    await new Promise<void>((resolve) => again.close(() => resolve()));
  });

  it('reports a port in use and leaves nothing listening', async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const port = (blocker.address() as { port: number }).port;
    try {
      await expect(
        startEmbeddedBroker({
          port,
          bindHost: '127.0.0.1',
          ...LOGIN,
          tls: { certFile: certA.cert, keyFile: certA.key },
        }),
      ).rejects.toThrow(/already in use/);
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
    const broker = await startEmbeddedBroker({
      port,
      bindHost: '127.0.0.1',
      ...LOGIN,
      tls: { certFile: certA.cert, keyFile: certA.key },
    });
    await broker.close();
  });
});
