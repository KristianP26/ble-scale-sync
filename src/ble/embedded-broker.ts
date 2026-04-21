import { createServer, type Server, type Socket } from 'node:net';
import { timingSafeEqual } from 'node:crypto';
import type { AuthenticateError } from 'aedes';
import { createLogger } from '../logger.js';
import { errMsg } from '../utils/error.js';
import { isLoopback } from './loopback.js';

const log = createLogger('MQTTBroker');

/** aedes AuthErrorCode.BAD_USERNAME_OR_PASSWORD (const enum, not importable at runtime). */
const AUTH_BAD_USER_PASS = 4;

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
   * How long to wait for in-flight client work to drain on `close()`.
   * Defaults to 10s so shutdown is bounded even when MQTT keepalive clients
   * (e.g. the ESP32 proxy) hold the connection open.
   */
  drainTimeoutMs?: number;
}

export interface EmbeddedBrokerHandle {
  /** URL an internal client can use to connect (loopback). */
  url: string;
  /** Actual port the server is listening on (useful when `port: 0`). */
  port: number;
  /** Stop accepting new connections and close the broker. Idempotent. */
  close: () => Promise<void>;
}

/** Timing-safe string comparison. Handles length mismatch without leaking it. */
function safeStringEqual(a: string, b: string): boolean {
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

  if (!authEnabled && !isLoopback(bindHost)) {
    log.warn(
      `Embedded broker is binding ${bindHost} without authentication. Anyone on this ` +
        `network can publish to and subscribe from it. Set mqtt_proxy.username + ` +
        `mqtt_proxy.password in config.yaml, or change embedded_broker_bind to 127.0.0.1 ` +
        `if the ESP32 runs on this machine.`,
    );
  }

  const aedes = await Aedes.createBroker({
    id: opts.brokerId ?? 'ble-scale-sync-embedded',
    drainTimeout,
  });

  if (authEnabled) {
    const expectedUser = opts.username!;
    const expectedPass = opts.password ?? '';
    aedes.authenticate = (_client, username, password, callback) => {
      const passStr = password ? password.toString() : '';
      const userOk = username != null && safeStringEqual(username, expectedUser);
      const passOk = safeStringEqual(passStr, expectedPass);
      if (userOk && passOk) {
        callback(null, true);
      } else {
        const err = Object.assign(new Error('Bad username or password'), {
          returnCode: AUTH_BAD_USER_PASS,
        }) as AuthenticateError;
        callback(err, false);
      }
    };
  }

  // Topic-prefix ACL prevents a rogue LAN client from using the broker as a
  // general pub/sub bus. Internal broker-originated publishes (client === null)
  // are always allowed so $SYS stats and similar housekeeping still work.
  const topicPrefix = opts.topicPrefix;
  if (topicPrefix) {
    const isAllowed = (topicOrFilter: string, isFilter: boolean): boolean => {
      // For subscribe filters, strip trailing wildcards to get the literal portion.
      const literal = isFilter ? literalPrefix(topicOrFilter) : topicOrFilter;
      return literal === topicPrefix || literal.startsWith(`${topicPrefix}/`);
    };

    aedes.authorizePublish = (client, packet, callback) => {
      if (!client) return callback(null); // broker-originated
      if (packet.topic.startsWith('$SYS/')) {
        return callback(new Error('$SYS/ topics are reserved'));
      }
      if (!isAllowed(packet.topic, false)) {
        return callback(new Error(`publish rejected: topic outside "${topicPrefix}"`));
      }
      callback(null);
    };

    aedes.authorizeSubscribe = (client, sub, callback) => {
      if (!client) return callback(null, sub);
      // Allow read-only $SYS subscriptions so tools like mqtt-explorer still work.
      if (sub.topic.startsWith('$SYS/')) return callback(null, sub);
      if (!isAllowed(sub.topic, true)) {
        return callback(new Error(`subscribe rejected: topic outside "${topicPrefix}"`), null);
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
  aedes.on('clientError', (client, err) => {
    log.debug(`Client error ${client.id}: ${errMsg(err)}`);
  });

  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    aedes.handle(socket);
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException) => {
      server.off('listening', onListening);
      if (err.code === 'EADDRINUSE') {
        reject(
          new Error(
            `Port ${opts.port} on ${bindHost} is already in use. ` +
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
    server.listen(opts.port, bindHost);
  });

  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : opts.port;
  const url = `mqtt://127.0.0.1:${actualPort}`;

  log.info(
    `Embedded MQTT broker listening on ${bindHost}:${actualPort}` +
      (authEnabled ? ' (authentication enabled)' : '') +
      (topicPrefix ? ` [ACL: ${topicPrefix}/*]` : ''),
  );

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await new Promise<void>((resolve) => {
      aedes.close(() => {
        server.close(() => resolve());
        // Forcefully destroy any sockets still open (MQTT keepalive clients
        // would otherwise block server.close for up to drainTimeout).
        for (const socket of sockets) {
          socket.destroy();
        }
        sockets.clear();
      });
    });
    log.info('Embedded MQTT broker stopped');
  };

  return { url, port: actualPort, close };
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
