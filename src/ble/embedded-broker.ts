import { createServer, type Server } from 'node:net';
import type { AuthenticateError } from 'aedes';
import { createLogger } from '../logger.js';
import { errMsg } from '../utils/error.js';

const log = createLogger('MQTTBroker');

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
}

export interface EmbeddedBrokerHandle {
  /** URL an internal client can use to connect (loopback). */
  url: string;
  /** Actual port the server is listening on (useful when `port: 0`). */
  port: number;
  /** Stop accepting new connections and close the broker. Idempotent. */
  close: () => Promise<void>;
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

  const aedes = await Aedes.createBroker({
    id: opts.brokerId ?? 'ble-scale-sync-embedded',
  });

  if (authEnabled) {
    const expectedUser = opts.username!;
    const expectedPass = opts.password ?? '';
    aedes.authenticate = (_client, username, password, callback) => {
      const passStr = password ? password.toString() : '';
      if (username === expectedUser && passStr === expectedPass) {
        callback(null, true);
      } else {
        const err = new Error('Bad username or password') as AuthenticateError;
        // AuthErrorCode.BAD_USERNAME_OR_PASSWORD = 4 (const enum, inlined at build time)
        (err as unknown as { returnCode: number }).returnCode = 4;
        callback(err, false);
      }
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

  const server: Server = createServer(aedes.handle);

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
      (authEnabled ? ' (authentication enabled)' : ''),
  );

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await new Promise<void>((resolve) => {
      aedes.close(() => {
        server.close(() => resolve());
      });
    });
    log.info('Embedded MQTT broker stopped');
  };

  return { url, port: actualPort, close };
}
