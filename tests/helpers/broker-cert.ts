import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Self-signed certificates for the embedded broker tests, made with the same
 * `openssl` commands as the recipe in docs/guide/esp32-proxy.md, so what CI
 * exercises is what the docs tell a user to run. Nothing is committed (a private
 * key in the repo would trip secret scanners) and nothing touches the network.
 *
 * The validity runs from 1960 to 2100: the ESP32 has no clock and checks the
 * certificate dates, so the certificate has to be valid whatever date the board
 * reports.
 */

export function hasOpenssl(): boolean {
  try {
    execFileSync('openssl', ['version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

export interface BrokerCert {
  /** PEM certificate, also the trust anchor a client passes as `ca`. */
  cert: string;
  key: string;
}

/**
 * Write a certificate for `cn` (also its DNS name) and 127.0.0.1 into `dir`,
 * which must exist and be empty.
 */
export function makeBrokerCert(
  dir: string,
  { cn = 'localhost' }: { cn?: string } = {},
): BrokerCert {
  writeFileSync(
    join(dir, 'ca.cnf'),
    [
      '[ca]',
      'default_ca = c',
      '[c]',
      'database = index.txt',
      'new_certs_dir = .',
      'serial = serial',
      'default_md = sha256',
      'policy = p',
      'unique_subject = no',
      'copy_extensions = copy',
      '[p]',
      'commonName = supplied',
      '[req]',
      'distinguished_name = dn',
      'prompt = no',
      '[dn]',
      `CN = ${cn}`,
      '[ext]',
      `subjectAltName = DNS:${cn},IP:127.0.0.1`,
      'basicConstraints = critical,CA:TRUE',
      '',
    ].join('\n'),
  );
  writeFileSync(join(dir, 'index.txt'), '');
  writeFileSync(join(dir, 'serial'), '01\n');

  const run = (args: string[]): void => {
    execFileSync('openssl', args, { cwd: dir, stdio: 'pipe' });
  };
  run([
    'req',
    '-new',
    '-newkey',
    'ec',
    '-pkeyopt',
    'ec_paramgen_curve:prime256v1',
    '-nodes',
    '-keyout',
    'broker.key',
    '-out',
    'broker.csr',
    '-config',
    'ca.cnf',
  ]);
  run([
    'ca',
    '-batch',
    '-selfsign',
    '-config',
    'ca.cnf',
    '-keyfile',
    'broker.key',
    '-in',
    'broker.csr',
    '-out',
    'broker.pem',
    '-startdate',
    '19600101000000Z',
    '-enddate',
    '21001231235959Z',
    '-extensions',
    'ext',
    '-notext',
  ]);
  return { cert: join(dir, 'broker.pem'), key: join(dir, 'broker.key') };
}
