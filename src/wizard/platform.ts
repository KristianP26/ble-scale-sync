import { execSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { PlatformInfo } from './types.js';
import { isSupportedPython, parsePythonVersion } from '../garmin-cli.js';

function tryExec(cmd: string): string | null {
  try {
    return execSync(cmd, { stdio: 'pipe', timeout: 5000 }).toString().trim();
  } catch {
    return null;
  }
}

/**
 * `cmd --version`, from stdout or stderr, or null when it does not run or
 * prints no version. Python 2 writes the version to stderr and exits 0, and
 * execFileSync returns only stdout on success, so both streams are read.
 */
function probePython(cmd: string): { major: number; minor: number } | null {
  const result = spawnSync(cmd, ['--version'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    timeout: 5000,
  });
  // Not found, or killed at the timeout.
  if (result.error) return null;
  return parsePythonVersion(`${result.stdout ?? ''}\n${result.stderr ?? ''}`);
}

export function detectPlatform(): PlatformInfo {
  const os = process.platform as PlatformInfo['os'];
  const arch = process.arch;

  // Docker detection
  const hasDocker = tryExec('docker --version') !== null;

  // Python: the first interpreter Garmin can use (3.12+, garminconnect 0.3.x).
  // Any answer to --version used to count, Python 2 included, so the Garmin
  // step started a login that died at import. An older one is remembered
  // only to name its version in the message.
  let hasPython = false;
  let pythonCommand: string | null = null;
  let pythonVersion: string | undefined;
  for (const cmd of ['python3', 'python']) {
    const version = probePython(cmd);
    if (version === null) continue;
    hasPython = true;
    if (isSupportedPython(version)) {
      pythonCommand = cmd;
      pythonVersion = `${version.major}.${version.minor}`;
      break;
    }
    pythonVersion ??= `${version.major}.${version.minor}`;
  }

  // Docker creates /.dockerenv, Podman /run/.containerenv. A file the wizard
  // writes outside a mount there is gone when the container exits.
  const inContainer = existsSync('/.dockerenv') || existsSync('/run/.containerenv');

  // BT GID on Linux
  let btGid: number | undefined;
  if (os === 'linux') {
    const gidLine = tryExec('getent group bluetooth');
    if (gidLine) {
      const parts = gidLine.split(':');
      const gid = Number(parts[2]);
      if (Number.isFinite(gid)) btGid = gid;
    }
  }

  return { os, arch, hasDocker, hasPython, pythonCommand, pythonVersion, btGid, inContainer };
}
