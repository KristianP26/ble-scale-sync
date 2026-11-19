import { readFileSync } from 'node:fs';
import { createPrivateKey, X509Certificate } from 'node:crypto';
import { createSecureContext } from 'node:tls';
import type { MqttProxyConfig } from '../config/schema.js';
import { expandHome } from '../config/token-dirs.js';
import { errMsg } from '../utils/error.js';

/** Files of the TLS identity of the embedded broker, as absolute paths. */
export interface BrokerTlsFiles {
  certFile: string;
  keyFile: string;
}

export interface BrokerTlsMaterial {
  cert: Buffer;
  key: Buffer;
  /** End of the validity of the first certificate in `cert` (the leaf of a chain). */
  validTo: Date;
}

const CERT_OPTION = 'ble.mqtt_proxy.embedded_broker_tls_cert';
const KEY_OPTION = 'ble.mqtt_proxy.embedded_broker_tls_key';

function codeOf(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : 'unknown error';
}

/** Read one file with an error that names the option and the path, never the content. */
function readTlsFile(path: string, what: 'certificate' | 'key', option: string): Buffer {
  try {
    return readFileSync(path);
  } catch (err) {
    const code = codeOf(err);
    if (code === 'ENOENT') {
      throw new Error(
        `Embedded broker TLS ${what} file not found: ${path}. Fix ${option}, or remove both TLS keys to serve plain MQTT.`,
      );
    }
    if (code === 'EACCES' || code === 'EPERM') {
      throw new Error(
        `Embedded broker TLS ${what} file cannot be read (permission denied): ${path}. In Docker the app runs as user node (uid 1000).`,
      );
    }
    throw new Error(`Embedded broker TLS ${what} file cannot be read (${code}): ${path}.`);
  }
}

/** True for a PEM private key that needs a passphrase. */
function isEncryptedKey(pem: Buffer): boolean {
  const text = pem.toString('latin1');
  return text.includes('BEGIN ENCRYPTED PRIVATE KEY') || /Proc-Type:\s*4,\s*ENCRYPTED/.test(text);
}

/**
 * Read and validate the TLS identity of the embedded broker. Synchronous: it
 * runs at startup, before anything listens, and again on a certificate reload.
 *
 * Every error names the option and the path and never the file content. There
 * is no fallback to plain MQTT: a key that looks like encryption but is not
 * used is worse than a refusal to start.
 */
export function loadBrokerTls(files: BrokerTlsFiles): BrokerTlsMaterial {
  const cert = readTlsFile(files.certFile, 'certificate', CERT_OPTION);
  const key = readTlsFile(files.keyFile, 'key', KEY_OPTION);

  let x509: X509Certificate;
  try {
    x509 = new X509Certificate(cert);
  } catch {
    throw new Error(
      `${files.certFile} is not a PEM certificate. Fix ${CERT_OPTION} (the file holds the certificate, or the full chain, in PEM form).`,
    );
  }

  if (isEncryptedKey(key)) {
    throw new Error(
      `The TLS key file is encrypted: ${files.keyFile}. The app cannot ask for a passphrase: ` +
        `remove it with: openssl pkey -in ${files.keyFile} -out <new key file>`,
    );
  }
  try {
    createPrivateKey(key);
  } catch {
    throw new Error(
      `${files.keyFile} is not a PEM private key. Fix ${KEY_OPTION} (an unencrypted key in PEM form).`,
    );
  }

  try {
    createSecureContext({ cert, key });
  } catch (err) {
    if (codeOf(err) === 'ERR_OSSL_X509_KEY_VALUES_MISMATCH') {
      throw new Error(
        `The embedded broker TLS certificate and key do not match (${files.certFile}, ${files.keyFile}).`,
      );
    }
    throw new Error(
      `The embedded broker TLS certificate and key cannot be loaded (${codeOf(err)}): ${files.certFile}, ${files.keyFile}.`,
    );
  }

  return { cert, key, validTo: x509.validToDate };
}

/** A certificate with fewer days left than this is reported as `soon`. */
export const CERT_EXPIRY_WARN_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

export type CertExpiry = 'ok' | 'soon' | 'expired';

/** Where a certificate that ends at `validTo` stands at `now`. */
export function describeCertExpiry(validTo: Date, now: Date = new Date()): CertExpiry {
  const msLeft = validTo.getTime() - now.getTime();
  if (msLeft <= 0) return 'expired';
  return msLeft < CERT_EXPIRY_WARN_DAYS * DAY_MS ? 'soon' : 'ok';
}

/** Whole days from `now` to `validTo`, rounded down; never negative. */
export function daysUntil(validTo: Date, now: Date = new Date()): number {
  return Math.max(0, Math.floor((validTo.getTime() - now.getTime()) / DAY_MS));
}

/** The files of a config, `~/` expanded, or null when it sets none. */
export function brokerTlsFilesOf(
  mqttProxy: Pick<MqttProxyConfig, 'embedded_broker_tls_cert' | 'embedded_broker_tls_key'>,
): BrokerTlsFiles | null {
  const { embedded_broker_tls_cert: cert, embedded_broker_tls_key: key } = mqttProxy;
  if (!cert || !key) return null;
  return { certFile: expandHome(cert), keyFile: expandHome(key) };
}

/**
 * Why the embedded broker of this config could not start for lack of a usable
 * TLS identity, or null. For `validate`: the same check start makes, on the
 * files of the machine it runs on (which is not the container when the paths
 * are container paths).
 */
export function brokerTlsProblem(mqttProxy: MqttProxyConfig): string | null {
  if (mqttProxy.broker_url) return null;
  const files = brokerTlsFilesOf(mqttProxy);
  if (!files) return null;
  try {
    loadBrokerTls(files);
    return null;
  } catch (err) {
    return errMsg(err);
  }
}
