import { createServer, type Server, type Socket } from 'node:net';
import { createServer as createTlsServer } from 'node:tls';
import { timingSafeEqual } from 'node:crypto';
import type { AuthenticateError } from 'aedes';
import { createLogger } from '../logger.js';
import { errMsg } from '../utils/error.js';
import { isLoopback } from './loopback.js';
import { loadBrokerTls, type BrokerTlsFiles } from './embedded-broker-tls.js';
import { attachMqttFrameGuard } from './mqtt-frame-guard.js';
import { warnThrottled as warnThrottledTo } from './peer-input.js';

const log = createLogger('MQTTBroker');

/** The broker's policy warnings, once a minute per kind, under the broker's own log scope. */
const warnThrottled = (key: string, text: string): void => warnThrottledTo(key, text, { log });

/** aedes AuthErrorCode.BAD_USERNAME_OR_PASSWORD (const enum, not importable at runtime). */
const AUTH_BAD_USER_PASS = 4;

/**
 * Return code aedes puts on the CONNACK, and on the error it emits as
 * `connectionError`, when the keep alive is 0 or over `keepaliveLimit`. MQTT
 * 3.1.1 does not define it, so mqtt.js reports "Connection refused: undefined".
 */
const CONNACK_KEEPALIVE_REFUSED = 6;

/**
 * An error the broker raises itself when it turns a client down: a failed login
 * or a topic the ACL does not allow. The listeners tell these from library
 * errors by type, never by message text, so rewording a message cannot turn a
 * warning back into a debug line. `returnCode` is what aedes puts on the CONNACK.
 */
class BrokerPolicyError extends Error {
  constructor(
    readonly kind: 'login' | 'acl',
    message: string,
    readonly returnCode?: number,
  ) {
    super(message);
    this.name = 'BrokerPolicyError';
  }
}

/**
 * What the broker bounds on its own, because aedes does not (ADR D112). Fixed
 * constants, not config keys: the shipped clients stay far below them (a scan
 * result of 500 devices is under 600 KiB). `EmbeddedBrokerOptions.limits`
 * exists for tests.
 */
export interface EmbeddedBrokerLimits {
  /** Largest first packet (a CONNECT is under 300 B) in bytes of MQTT remaining length. */
  maxFirstPacketBytes: number;
  /** Largest later packet in bytes of MQTT remaining length. */
  maxPacketBytes: number;
  /** Open connections the listener accepts; the next one is dropped. */
  maxConnections: number;
  /**
   * How long a socket may stay open without sending its CONNECT. Short enough
   * to free a slot soon, long enough for a slow Wi-Fi or TLS start on a classic
   * ESP32 (15 s is a judgement call, not measured on hardware).
   */
  connectTimeoutMs: number;
  /**
   * Largest CONNECT keep alive in seconds; 0 (no keep alive) is refused too, so
   * a half-open socket cannot hold a slot for ever. The ESP32 firmware and the
   * app's own clients use 60.
   */
  maxKeepaliveSec: number;
  /** Open connections of the loopback listener the app's own client uses in TLS mode. */
  maxInternalConnections: number;
  /**
   * Total time a TLS handshake may take, a deadline and not an idle timeout.
   * The same margin as `connectTimeoutMs`, for the same slow-radio reason.
   */
  tlsHandshakeTimeoutMs: number;
}

export const EMBEDDED_BROKER_LIMITS: Readonly<EmbeddedBrokerLimits> = {
  maxFirstPacketBytes: 16_384,
  maxPacketBytes: 1_048_576,
  maxConnections: 32,
  connectTimeoutMs: 15_000,
  maxKeepaliveSec: 300,
  maxInternalConnections: 16,
  tlsHandshakeTimeoutMs: 15_000,
};

export interface EmbeddedBrokerOptions {
  /** Port to listen on. Use 0 for an OS-assigned ephemeral port (tests). */
  port: number;
  /** Host/interface to bind. Default '0.0.0.0' so LAN devices (ESP32) can connect. */
  bindHost?: string;
  /** Optional username for CONNECT authentication. If set, password is required. */
  username?: string | null;
  /** Optional password for CONNECT authentication. */
  password?: string | null;
  /** Broker id used by aedes (appears in $SYS topics). */
  brokerId?: string;
  /**
   * Topic prefix used by the mqtt-proxy handler. When set, the broker's
   * authorizePublish/authorizeSubscribe hooks restrict MQTT clients to this
   * prefix (plus $SYS read-only), so a misconfigured LAN device can't use the
   * broker as a general-purpose pub/sub bus.
   */
  topicPrefix?: string;
  /**
   * Device id of the ESP32 proxy. With a `topicPrefix` it limits retained
   * publishes to `<prefix>/<deviceId>/status` and `<prefix>/<deviceId>/config`.
   * Without it retained publishes are allowed anywhere under the prefix.
   */
  deviceId?: string;
  /**
   * PEM files of the TLS identity. With them the listener on `port` speaks TLS
   * only; the app's own client reaches the broker over a plaintext listener on
   * the loopback, and `EmbeddedBrokerHandle.url` points at it. Without them the
   * broker serves plain MQTT.
   */
  tls?: BrokerTlsFiles;
  /**
   * How long to wait for in-flight client work to drain on `close()`.
   * Defaults to 10s so shutdown is bounded even when MQTT keepalive clients
   * (e.g. the ESP32 proxy) hold the connection open.
   */
  drainTimeoutMs?: number;
  /** Overrides of `EMBEDDED_BROKER_LIMITS`, for tests. */
  limits?: Partial<EmbeddedBrokerLimits>;
}

export interface EmbeddedBrokerHandle {
  /**
   * URL the app's own client uses (loopback for a wildcard bind, else the bound
   * address). In TLS mode it is a plaintext loopback URL on its own port.
   */
  url: string;
  /** Actual port the public listener is listening on (useful when `port: 0`). */
  port: number;
  /** True when the public listener serves TLS. */
  tls: boolean;
  /** Stop accepting new connections and close the broker. Idempotent. */
  close: () => Promise<void>;
}

/** Timing-safe string comparison. Handles length mismatch without leaking it. */
function safeStringEqual(a: string | Buffer, b: string | Buffer): boolean {
  // Pad shorter to the longer length so timingSafeEqual doesn't throw,
  // then require equal lengths for success.
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  const len = Math.max(bufA.length, bufB.length, 1);
  const padA = Buffer.alloc(len);
  const padB = Buffer.alloc(len);
  bufA.copy(padA);
  bufB.copy(padB);
  const equal = timingSafeEqual(padA, padB);
  return equal && bufA.length === bufB.length;
}

/**
 * Start an embedded aedes MQTT broker on a TCP socket.
 *
 * The broker is intended for a zero-config ESP32 BLE proxy setup: the ESP32
 * connects to the server's IP on `port`, and the local BLE Scale Sync client
 * connects to the same broker via loopback. No external Mosquitto needed.
 */
export async function startEmbeddedBroker(
  opts: EmbeddedBrokerOptions,
): Promise<EmbeddedBrokerHandle> {
  const { Aedes } = await import('aedes');

  const bindHost = opts.bindHost ?? '0.0.0.0';
  const authEnabled = !!opts.username;
  const drainTimeout = opts.drainTimeoutMs ?? 10_000;
  const limits: EmbeddedBrokerLimits = { ...EMBEDDED_BROKER_LIMITS, ...opts.limits };

  // The config schema already rejects this; this is the last line of defence
  // for any other caller. Without a login anyone on the network can publish to
  // and subscribe from the broker, and with a username but no password
  // authenticate() below compares the password against '', so any client that
  // knows the username would get in. A loopback bind may run without either.
  if (!isLoopback(bindHost) && !(opts.username && opts.password)) {
    throw new Error(
      `Embedded broker on ${bindHost} needs mqtt_proxy.username and mqtt_proxy.password. ` +
        'Set both, or change embedded_broker_bind to 127.0.0.1.',
    );
  }

  // Read the TLS files before anything starts: a bad file must leave nothing
  // running, and it never falls back to plain MQTT.
  const tlsMaterial = opts.tls ? loadBrokerTls(opts.tls) : null;

  const aedes = await Aedes.createBroker({
    id: opts.brokerId ?? 'ble-scale-sync-embedded',
    drainTimeout,
    connectTimeout: limits.connectTimeoutMs,
    keepaliveLimit: limits.maxKeepaliveSec,
  });

  if (authEnabled) {
    const expectedUser = opts.username!;
    const expectedPass = opts.password ?? '';
    aedes.authenticate = (_client, username, password, callback) => {
      const userOk = username != null && safeStringEqual(username, expectedUser);
      // The password stays bytes: toString() would replace invalid UTF-8 with
      // U+FFFD and make different byte strings compare equal.
      const passOk = safeStringEqual(password ?? '', expectedPass);
      if (userOk && passOk) {
        callback(null, true);
      } else {
        const err = new BrokerPolicyError(
          'login',
          'Bad username or password',
          AUTH_BAD_USER_PASS,
        ) as AuthenticateError;
        callback(err, false);
      }
    };
  }

  // Topic-prefix ACL prevents a rogue LAN client from using the broker as a
  // general pub/sub bus. Internal broker-originated publishes (client === null)
  // are always allowed so $SYS stats and similar housekeeping still work.
  const topicPrefix = opts.topicPrefix;
  // An empty prefix is a prefix too (the schema accepts `topic_prefix: ''`):
  // only topics that start with '/' are allowed then. Testing truthiness here
  // switched the whole ACL off for it.
  if (topicPrefix !== undefined) {
    const isAllowed = (topicOrFilter: string, isFilter: boolean): boolean => {
      // For subscribe filters, strip trailing wildcards to get the literal portion.
      const literal = isFilter ? literalPrefix(topicOrFilter) : topicOrFilter;
      return (
        (topicPrefix !== '' && literal === topicPrefix) || literal.startsWith(`${topicPrefix}/`)
      );
    };

    // aedes-persistence keeps retained messages in memory and nothing else
    // bounds them: a client with the login could retain a topic per random
    // name, up to the packet limit each. The only retained publishers are the
    // ESP32 (`status`, also as its will) and the app (`config`), both on the
    // exact topics of one device id, so everything else under the prefix is
    // refused and the store holds two entries at most. Exact strings, not a
    // pattern: a device id may contain '/'.
    const deviceId = opts.deviceId;
    const retainedAllowed =
      deviceId !== undefined
        ? new Set([`${topicPrefix}/${deviceId}/status`, `${topicPrefix}/${deviceId}/config`])
        : null;

    aedes.authorizePublish = (client, packet, callback) => {
      if (!client) return callback(null); // broker-originated
      if (packet.topic.startsWith('$SYS/')) {
        return callback(new BrokerPolicyError('acl', '$SYS/ topics are reserved'));
      }
      if (!isAllowed(packet.topic, false)) {
        return callback(
          new BrokerPolicyError('acl', `publish rejected: topic outside "${topicPrefix}"`),
        );
      }
      if (packet.retain && retainedAllowed && !retainedAllowed.has(packet.topic)) {
        return callback(
          new BrokerPolicyError(
            'acl',
            `publish rejected: retained messages are only allowed on ${topicPrefix}/${deviceId}/status and ${topicPrefix}/${deviceId}/config`,
          ),
        );
      }
      callback(null);
    };

    aedes.authorizeSubscribe = (client, sub, callback) => {
      if (!client) return callback(null, sub);
      // Allow read-only $SYS subscriptions so tools like mqtt-explorer still work.
      if (sub.topic.startsWith('$SYS/')) return callback(null, sub);
      if (!isAllowed(sub.topic, true)) {
        return callback(
          new BrokerPolicyError('acl', `subscribe rejected: topic outside "${topicPrefix}"`),
          null,
        );
      }
      callback(null, sub);
    };
  }

  aedes.on('client', (client) => {
    log.debug(`Client connected: ${client.id}`);
  });
  aedes.on('clientDisconnect', (client) => {
    log.debug(`Client disconnected: ${client.id}`);
  });
  // Failed logins and ACL denials are what a LAN client probing the broker
  // produces, so they are visible at the default log level. The text never
  // carries what the client sent, only the address and fixed wording.
  aedes.on('clientError', (client, err) => {
    if (err instanceof BrokerPolicyError) {
      if (err.kind === 'login') {
        warnThrottled(
          'broker-login',
          `Rejected a login from ${peerOf(client.conn)}: bad username or password.`,
        );
      } else {
        warnThrottled('broker-acl', `Disconnected ${peerOf(client.conn)}: ${err.message}`);
      }
      return;
    }
    log.debug(`Client error ${client.id}: ${errMsg(err)}`);
  });
  // A socket that never completed CONNECT has no client id yet. aedes destroys
  // the socket before it emits, so `client.conn.remoteAddress` is already
  // undefined here: the address is remembered when the socket is accepted.
  aedes.on('connectionError', (client, err) => {
    if ((err as Error & { errorCode?: number }).errorCode === CONNACK_KEEPALIVE_REFUSED) {
      warnThrottled(
        'broker-keepalive',
        `Refused a connection from ${peerOf(client.conn)}: its keep alive is 0 or over ${limits.maxKeepaliveSec} seconds.`,
      );
      return;
    }
    log.debug(`Connection error: ${errMsg(err)}`);
  });

  const sockets = new Set<Socket>();
  const peers = new WeakMap<object, string>();
  const peerOf = (conn: object): string => peers.get(conn) ?? 'unknown address';

  /** Hand one accepted connection (plain, or already through the TLS handshake) to aedes. */
  const serve = (socket: Socket): void => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    const peer = displayAddress(socket.remoteAddress);
    peers.set(socket, peer);
    aedes.handle(socket);
    // After handle(): the guard is a 'data' tap and needs aedes' 'readable'
    // listener in place first (see mqtt-frame-guard.ts). On a TLS listener this
    // socket is the TLSSocket, so the guard sees the decrypted stream.
    attachMqttFrameGuard(
      socket,
      { firstPacketMax: limits.maxFirstPacketBytes, packetMax: limits.maxPacketBytes },
      ({ packetIndex }) => {
        warnThrottled(
          packetIndex === 0 ? 'broker-oversize-first' : 'broker-oversize',
          packetIndex === 0
            ? `Closed a connection from ${peer}: its first packet is over the limit of ${limits.maxFirstPacketBytes} bytes.`
            : `Closed a connection from ${peer}: it announced an MQTT packet over the limit of ${limits.maxPacketBytes} bytes.`,
        );
        socket.destroy();
      },
    );
  };

  /** Cap the connections of a listener and say so when one is dropped. */
  const capConnections = (server: Server, max: number): void => {
    server.maxConnections = max;
    // No per-IP cap on purpose: behind Docker Desktop or a NAT every client
    // shares one address.
    server.on('drop', (data) => {
      warnThrottled(
        'broker-cap',
        `Refused a connection from ${displayAddress(data?.remoteAddress)}: ` +
          `the broker already has ${max} open connections.`,
      );
    });
  };

  const servers: Server[] = [];
  let publicServer: Server;
  let internalServer: Server | null = null;
  if (tlsMaterial) {
    // The LAN listener speaks TLS only; there is no plaintext fallback on it.
    // The app's own client uses a second listener on the loopback, which the LAN
    // cannot reach, so it needs no certificate that names 127.0.0.1.
    const tlsServer = createTlsServer(
      {
        cert: tlsMaterial.cert,
        key: tlsMaterial.key,
        minVersion: 'TLSv1.2',
        handshakeTimeout: limits.tlsHandshakeTimeoutMs,
      },
      serve,
    );
    // Node does not close a socket whose handshake timed out or failed, so
    // without the destroy() an idle socket would stay open for ever.
    tlsServer.on('tlsClientError', (err, socket) => {
      // A reset connection has lost its address by now; the one remembered for
      // the raw socket at accept time is what is left.
      const raw = (socket as { _parent?: object })._parent;
      const peer = socket.remoteAddress
        ? displayAddress(socket.remoteAddress)
        : peerOf(raw ?? socket);
      warnThrottled(
        'broker-tls',
        `TLS handshake from ${peer} failed (${errorCodeOf(err)}). ` +
          'Check that the device uses TLS (mqtt_tls), trusts this certificate (mqtt_ca_file), ' +
          'checks the name in mqtt_tls_hostname and has the right date.',
      );
      socket.destroy();
    });
    // A socket still in its handshake never reaches serve(), so close() would
    // wait out the handshake timeout for it. Track the raw socket as well.
    tlsServer.on('connection', (raw: Socket) => {
      peers.set(raw, displayAddress(raw.remoteAddress));
      sockets.add(raw);
      raw.once('close', () => sockets.delete(raw));
    });
    publicServer = tlsServer;
    internalServer = createServer(serve);
    capConnections(internalServer, limits.maxInternalConnections);
    servers.push(publicServer, internalServer);
  } else {
    publicServer = createServer(serve);
    servers.push(publicServer);
  }
  capConnections(publicServer, limits.maxConnections);

  const listen = (server: Server, port: number, host: string): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const onError = (err: NodeJS.ErrnoException) => {
        server.off('listening', onListening);
        if (err.code === 'EADDRINUSE') {
          reject(
            new Error(
              `Port ${port} on ${host} is already in use. ` +
                `Stop the other MQTT broker (e.g. Mosquitto) or set ` +
                `ble.mqtt_proxy.embedded_broker_port to a free port.`,
            ),
          );
        } else {
          reject(err);
        }
      };
      const onListening = () => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, host);
    });

  const shutdown = (): Promise<void> =>
    new Promise<void>((resolve) => {
      aedes.close(() => {
        const closing = servers.map(
          (server) => new Promise<void>((done) => server.close(() => done())),
        );
        // Forcefully destroy any sockets still open (MQTT keepalive clients
        // would otherwise block server.close for up to drainTimeout).
        for (const socket of sockets) {
          socket.destroy();
        }
        sockets.clear();
        void Promise.all(closing).then(() => resolve());
      });
    });

  try {
    // The public port first: a port in use is the likely failure. The loopback
    // listener takes an ephemeral port and cannot collide.
    await listen(publicServer, opts.port, bindHost);
    if (internalServer) await listen(internalServer, 0, '127.0.0.1');
  } catch (err) {
    // aedes keeps timers and the listeners it opened would stay: undo it all.
    await shutdown();
    throw err;
  }

  const publicAddr = publicServer.address();
  const actualPort = typeof publicAddr === 'object' && publicAddr ? publicAddr.port : opts.port;
  const clientAddr = (internalServer ?? publicServer).address();
  const clientPort = typeof clientAddr === 'object' && clientAddr ? clientAddr.port : actualPort;
  const url = `mqtt://${internalClientHost(typeof clientAddr === 'object' ? clientAddr : null)}:${clientPort}`;

  log.info(
    `Embedded MQTT broker listening on ${bindHost}:${actualPort}` +
      (tlsMaterial
        ? authEnabled
          ? ' (TLS, authentication enabled)'
          : ' (TLS)'
        : authEnabled
          ? ' (authentication enabled)'
          : '') +
      (topicPrefix !== undefined ? ` [ACL: ${topicPrefix}/*]` : ''),
  );
  if (!tlsMaterial && !isLoopback(bindHost)) {
    log.info(
      'Embedded MQTT broker is not encrypted: its login and the readings cross the network in plain text. ' +
        'Set ble.mqtt_proxy.embedded_broker_tls_cert and embedded_broker_tls_key to use TLS.',
    );
  }

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await shutdown();
    log.info('Embedded MQTT broker stopped');
  };

  return { url, port: actualPort, tls: tlsMaterial !== null, close };
}

/**
 * Host the app's own client should dial, derived from where the server really
 * listens. A hard-coded 127.0.0.1 only reaches a wildcard or IPv4 loopback
 * bind: with `embedded_broker_bind: ::1`, a specific LAN address, or
 * `localhost` resolving to ::1, the app could never connect to its own broker
 * (B-08). A wildcard bind is reached through the loopback of its family.
 */
function internalClientHost(addr: { address: string; family: string | number } | null): string {
  if (!addr) return '127.0.0.1';
  const ipv6 = addr.family === 'IPv6' || addr.family === 6;
  if (addr.address === '0.0.0.0') return '127.0.0.1';
  if (addr.address === '::') return '[::1]';
  return ipv6 ? `[${addr.address}]` : addr.address;
}

/** Library error code (`ERR_SSL_...`, `ECONNRESET`) for a log line, never message text. */
function errorCodeOf(err: Error): string {
  const code = (err as NodeJS.ErrnoException).code;
  return typeof code === 'string' ? code : 'unknown error';
}

/** Peer address for a log line: an IPv4-mapped IPv6 address shown as plain IPv4. */
function displayAddress(address: string | undefined): string {
  if (!address) return 'unknown address';
  return address.startsWith('::ffff:') ? address.slice(7) : address;
}

/**
 * Strip trailing wildcards from an MQTT subscribe filter to recover the literal
 * prefix. `ble-proxy/#` -> `ble-proxy/`, `ble-proxy/+/status` -> `ble-proxy/`.
 */
function literalPrefix(filter: string): string {
  const plus = filter.indexOf('+');
  const hash = filter.indexOf('#');
  const idx = plus === -1 ? hash : hash === -1 ? plus : Math.min(plus, hash);
  return idx === -1 ? filter : filter.slice(0, idx);
}
