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
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect, Server as TlsServer } from 'node:tls';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { X509Certificate } from 'node:crypto';
import { connectAsync, type MqttClient } from 'mqtt';
import { startEmbeddedBroker, type EmbeddedBrokerOptions } from '../../src/ble/embedded-broker.js';
import { _resetPeerInput } from '../../src/ble/peer-input.js';
import { describeCertExpiry } from '../../src/ble/embedded-broker-tls.js';
import { hasOpenssl, makeBrokerCert, type BrokerCert } from '../helpers/broker-cert.js';

let warnSpy: MockInstance<typeof console.warn>;
let logSpy: MockInstance<typeof console.log>;
let root: string;
let certA: BrokerCert;
let certB: BrokerCert;
let encryptedKey: string;

beforeAll(() => {
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
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
  logSpy.mockClear();
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

describe('describeCertExpiry', () => {
  const now = new Date('2026-11-19T12:00:00Z');
  const inDays = (days: number): Date => new Date(now.getTime() + days * 86_400_000);

  it('is ok with 30 days or more left, soon below that, expired at the end date', () => {
    expect(describeCertExpiry(inDays(365), now)).toBe('ok');
    expect(describeCertExpiry(inDays(30), now)).toBe('ok');
    expect(describeCertExpiry(inDays(29), now)).toBe('soon');
    expect(describeCertExpiry(inDays(1), now)).toBe('soon');
    expect(describeCertExpiry(inDays(0), now)).toBe('expired');
    expect(describeCertExpiry(inDays(-1), now)).toBe('expired');
  });
});

describe.skipIf(!hasOpenssl())('embedded broker certificate reload and expiry', () => {
  let live: BrokerCert;
  let seq = 0;

  /** A directory the broker reads its pair from, filled from `from`. */
  function liveFiles(from: BrokerCert): BrokerCert {
    const dir = join(root, `live-${seq++}`);
    mkdirSync(dir);
    const files = { cert: join(dir, 'live.pem'), key: join(dir, 'live.key') };
    copyFileSync(from.cert, files.cert);
    copyFileSync(from.key, files.key);
    return files;
  }

  const swap = (to: Partial<BrokerCert>): void => {
    if (to.cert) copyFileSync(to.cert, live.cert);
    if (to.key) copyFileSync(to.key, live.key);
  };

  /** Name in the certificate a new handshake on `port` is served. */
  function servedCn(port: number, ca: BrokerCert, servername: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = tlsConnect({
        host: '127.0.0.1',
        port,
        servername,
        ca: readFileSync(ca.cert),
        rejectUnauthorized: false,
      });
      socket.once('secureConnect', () => {
        const cn = String(socket.getPeerCertificate().subject.CN);
        socket.destroy();
        resolve(cn);
      });
      socket.once('error', reject);
    });
  }

  const startLive = (extra: Partial<EmbeddedBrokerOptions> = {}) => {
    live = liveFiles(certA);
    return startEmbeddedBroker({
      port: 0,
      bindHost: '127.0.0.1',
      ...LOGIN,
      tls: { certFile: live.cert, keyFile: live.key },
      ...extra,
    });
  };

  it('serves the new certificate to new connections and leaves an open one alone', async () => {
    const broker = await startLive();
    try {
      const open = await tlsClient(broker.port, certA, 'open-before');
      expect(await servedCn(broker.port, certA, 'localhost')).toBe('localhost');

      swap(certB);
      expect(broker.reloadTls()).toBe('reloaded');

      expect(await servedCn(broker.port, certB, 'other.example')).toBe('other.example');
      expect(open.connected).toBe(true);
      await open.publishAsync('still/open', 'x');
      await open.endAsync(true);
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          'Embedded broker TLS certificate reloaded (valid until 2100-12-31)',
        ),
      );
    } finally {
      await broker.close();
    }
  });

  it('keeps the old certificate and warns when the new files do not load', async () => {
    const broker = await startLive();
    try {
      writeFileSync(live.cert, 'not a certificate');
      expect(broker.reloadTls()).toBe('failed');
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringMatching(
          /files changed but cannot be loaded .*keeping the previous certificate/,
        ),
      );
      expect(await servedCn(broker.port, certA, 'localhost')).toBe('localhost');
    } finally {
      await broker.close();
    }
  });

  it('keeps the old certificate and warns when the new context cannot be applied', async () => {
    const broker = await startLive();
    const apply = vi.spyOn(TlsServer.prototype, 'setSecureContext').mockImplementation(() => {
      throw new Error('context refused');
    });
    try {
      swap(certB);
      expect(() => broker.reloadTls()).not.toThrow();
      expect(broker.reloadTls()).toBe('failed');
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringMatching(/cannot be applied \(context refused\).*keeping the previous/),
      );
      expect(await servedCn(broker.port, certA, 'localhost')).toBe('localhost');

      apply.mockRestore();
      expect(broker.reloadTls()).toBe('reloaded');
      expect(await servedCn(broker.port, certB, 'other.example')).toBe('other.example');
    } finally {
      apply.mockRestore();
      await broker.close();
    }
  });

  // A renewal job writes the certificate and the key one after the other. The
  // check that lands in between fails once and must not remember the new
  // certificate as seen: the next check applies the pair.
  it('applies a half-renewed pair at the next check, once the key matches', async () => {
    const broker = await startLive();
    try {
      swap({ cert: certB.cert });
      expect(broker.reloadTls()).toBe('failed');
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('certificate and key do not match'),
      );
      expect(await servedCn(broker.port, certA, 'localhost')).toBe('localhost');

      swap({ key: certB.key });
      expect(broker.reloadTls()).toBe('reloaded');
      expect(await servedCn(broker.port, certB, 'other.example')).toBe('other.example');
    } finally {
      await broker.close();
    }
  });

  it('does nothing, and logs nothing, when the pair is unchanged', async () => {
    const broker = await startLive();
    try {
      logSpy.mockClear();
      warnSpy.mockClear();
      expect(broker.reloadTls()).toBe('unchanged');
      expect(logSpy).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      await broker.close();
    }
  });

  it('picks up a renewed pair on its own timer', async () => {
    const broker = await startLive({ limits: { tlsCheckIntervalMs: 100 } });
    try {
      swap(certB);
      const deadline = Date.now() + 3000;
      let cn = '';
      while (Date.now() < deadline) {
        cn = await servedCn(broker.port, certB, 'other.example');
        if (cn === 'other.example') break;
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(cn).toBe('other.example');
    } finally {
      await broker.close();
    }
  });

  it('keeps its timer unref-ed and clears it on close', async () => {
    const setSpy = vi.spyOn(globalThis, 'setInterval');
    const clearSpy = vi.spyOn(globalThis, 'clearInterval');
    try {
      const broker = await startLive();
      const index = setSpy.mock.calls.findIndex((call) => call[1] === 86_400_000);
      expect(index).toBeGreaterThanOrEqual(0);
      const timer = setSpy.mock.results[index].value as NodeJS.Timeout;
      expect(timer.hasRef()).toBe(false);
      await broker.close();
      expect(clearSpy).toHaveBeenCalledWith(timer);
    } finally {
      setSpy.mockRestore();
      clearSpy.mockRestore();
    }
  });

  it('plain MQTT has nothing to reload', async () => {
    const broker = await startEmbeddedBroker({ port: 0, bindHost: '127.0.0.1' });
    try {
      expect(broker.reloadTls()).toBe('unchanged');
    } finally {
      await broker.close();
    }
  });

  it('logs the end date at start and does not warn for the documented certificate', async () => {
    const broker = await startLive();
    try {
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringMatching(/Embedded broker TLS certificate expires in \d+ days \(2100-12-31\)/),
      );
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      await broker.close();
    }
  });

  it('warns at start about a certificate that is expired or about to expire', async () => {
    mkdirSync(join(root, 'old'));
    mkdirSync(join(root, 'soon'));
    const old = makeBrokerCert(join(root, 'old'), { enddate: '20000101000000Z' });
    const ends = new Date(Date.now() + 10 * 86_400_000)
      .toISOString()
      .replace(/[-:]/g, '')
      .replace(/\.\d+Z$/, 'Z')
      .replace('T', '');
    const soon = makeBrokerCert(join(root, 'soon'), { enddate: ends });

    const expired = await startTls(old);
    await expired.close();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        'Embedded broker TLS certificate expired on 2000-01-01. Devices that check the date will refuse it.',
      ),
    );

    warnSpy.mockClear();
    const closing = await startTls(soon);
    await closing.close();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/Embedded broker TLS certificate expires in (9|10) days/),
    );
  });
});
