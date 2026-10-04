import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { Writable, PassThrough } from 'node:stream';
import { join } from 'node:path';
import type { BodyComposition } from '../../src/interfaces/scale-adapter.js';

const samplePayload: BodyComposition = {
  weight: 80,
  impedance: 500,
  bmi: 23.9,
  bodyFatPercent: 18.5,
  waterPercent: 55.2,
  boneMass: 3.1,
  muscleMass: 62.4,
  visceralFat: 8,
  physiqueRating: 5,
  bmr: 1750,
  metabolicAge: 30,
};

interface MockProc extends EventEmitter {
  stdin: Writable | null;
  stdout: PassThrough | null;
  stderr: null;
}

function createVersionCheckProc(
  exitCode: number,
  errorMsg?: string,
  versionOutput = 'Python 3.12.4\n',
): MockProc {
  const proc = new EventEmitter() as MockProc;
  const stdoutStream = new PassThrough();
  proc.stdin = null;
  proc.stdout = stdoutStream;
  proc.stderr = null;
  process.nextTick(() => {
    if (errorMsg) {
      proc.emit('error', new Error(errorMsg));
    } else {
      stdoutStream.write(versionOutput);
      stdoutStream.end();
      proc.emit('close', exitCode);
    }
  });
  return proc;
}

/** `python3` / `python` answering `--version` with the given output, or missing (null). */
function versionChecks(
  versions: Partial<Record<'python3' | 'python', string | null>>,
): (cmd: string) => MockProc {
  return (cmd: string) => {
    const output = versions[cmd as 'python3' | 'python'];
    return output == null
      ? createVersionCheckProc(0, `spawn ${cmd} ENOENT`)
      : createVersionCheckProc(0, undefined, output);
  };
}

function createUploadProc(stdoutData: string, exitCode: number): MockProc {
  const proc = new EventEmitter() as MockProc;
  const stdinStream = new Writable({
    write(_chunk, _enc, cb) {
      cb();
    },
  });
  const stdoutStream = new PassThrough();

  proc.stdin = stdinStream;
  proc.stdout = stdoutStream;
  proc.stderr = null;

  process.nextTick(() => {
    stdoutStream.write(stdoutData);
    stdoutStream.end();
    proc.emit('close', exitCode);
  });

  return proc;
}

const { mockSpawn } = vi.hoisted(() => {
  const mockSpawn = vi.fn();
  return { mockSpawn };
});

vi.mock('node:child_process', () => ({
  spawn: mockSpawn,
}));

describe('GarminExporter', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import('../../src/exporters/garmin.js');
    mod._resetPythonCache();
  });

  it('returns success on successful upload', async () => {
    const uploadResult = JSON.stringify({ success: true, data: { weight: 80 } });

    mockSpawn.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === '--version') return createVersionCheckProc(0);
      return createUploadProc(uploadResult, 0);
    });

    const { GarminExporter } = await import('../../src/exporters/garmin.js');
    const exporter = new GarminExporter();
    const result = await exporter.export(samplePayload);

    expect(result.success).toBe(true);
    expect(mockSpawn).toHaveBeenCalledTimes(2);
    expect(mockSpawn.mock.calls[0][0]).toBe('python3');
  });

  it('retries on failure and eventually returns failure', async () => {
    const failResult = JSON.stringify({ success: false, error: 'auth failed' });

    mockSpawn.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === '--version') return createVersionCheckProc(0);
      return createUploadProc(failResult, 1);
    });

    const { GarminExporter } = await import('../../src/exporters/garmin.js');
    const exporter = new GarminExporter();
    const result = await exporter.export(samplePayload);

    expect(result.success).toBe(false);
    expect(result.error).toBe('auth failed');
    // 1 version check + 3 upload attempts
    expect(mockSpawn).toHaveBeenCalledTimes(4);
  });

  // F-13: a missing token is not fixed by trying again seconds later.
  it('does not retry a failure the uploader marks as not retryable', async () => {
    const failResult = JSON.stringify({
      success: false,
      error: 'Token directory not found: /x',
      retryable: false,
    });

    mockSpawn.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === '--version') return createVersionCheckProc(0);
      return createUploadProc(failResult, 1);
    });

    const { GarminExporter } = await import('../../src/exporters/garmin.js');
    const exporter = new GarminExporter();
    const result = await exporter.export(samplePayload);

    expect(result).toEqual({ success: false, error: 'Token directory not found: /x' });
    // 1 version check + 1 upload attempt
    expect(mockSpawn).toHaveBeenCalledTimes(2);
  });

  it('falls back to python when python3 is not found', async () => {
    const uploadResult = JSON.stringify({ success: true });

    const version = versionChecks({ python3: null, python: 'Python 3.12.4' });
    mockSpawn.mockImplementation((cmd: string, args: string[]) => {
      if (args[0] === '--version') return version(cmd);
      return createUploadProc(uploadResult, 0);
    });

    const { GarminExporter } = await import('../../src/exporters/garmin.js');
    const exporter = new GarminExporter();
    const result = await exporter.export(samplePayload);

    expect(result.success).toBe(true);
    // python3 probed and missing, python probed, then the upload itself
    expect(mockSpawn).toHaveBeenCalledTimes(3);
    expect(mockSpawn.mock.calls[2][0]).toBe('python');
  });

  // F-20: garminconnect 0.3.x needs Python 3.12. An older python3 used to be
  // taken because it answered --version at all, and the upload then died at
  // import with an error that named no version.
  it('passes over a python3 older than 3.12 for a python that is new enough', async () => {
    const version = versionChecks({ python3: 'Python 3.11.9', python: 'Python 3.12.1' });
    mockSpawn.mockImplementation((cmd: string, args: string[]) => {
      if (args[0] === '--version') return version(cmd);
      return createUploadProc(JSON.stringify({ success: true }), 0);
    });

    const { GarminExporter } = await import('../../src/exporters/garmin.js');
    const result = await new GarminExporter().export(samplePayload);

    expect(result.success).toBe(true);
    const upload = mockSpawn.mock.calls.find((c) => (c[1] as string[])[0] !== '--version');
    expect(upload?.[0]).toBe('python');
  });

  it('names the required version and starts no upload when no Python is new enough', async () => {
    const version = versionChecks({ python3: 'Python 3.9.2', python: 'Python 2.7.18' });
    mockSpawn.mockImplementation((cmd: string, args: string[]) => {
      if (args[0] === '--version') return version(cmd);
      return createUploadProc(JSON.stringify({ success: true }), 0);
    });

    const { GarminExporter } = await import('../../src/exporters/garmin.js');
    const result = await new GarminExporter().export(samplePayload);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Python 3\.12 or newer/);
    expect(result.error).toMatch(/3\.9/);
    expect(mockSpawn.mock.calls.every((c) => (c[1] as string[])[0] === '--version')).toBe(true);
  });

  it('passes token_dir as --token-dir to Python subprocess', async () => {
    const uploadResult = JSON.stringify({ success: true, data: { weight: 80 } });

    mockSpawn.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === '--version') return createVersionCheckProc(0);
      return createUploadProc(uploadResult, 0);
    });

    const { GarminExporter } = await import('../../src/exporters/garmin.js');
    const exporter = new GarminExporter({ token_dir: '/custom/token/path' });
    const result = await exporter.export(samplePayload);

    expect(result.success).toBe(true);
    const uploadCall = mockSpawn.mock.calls[1];
    expect(uploadCall[1]).toContain('--token-dir');
    expect(uploadCall[1]).toContain('/custom/token/path');
  });

  it('expands ~ in token_dir using HOME', async () => {
    const uploadResult = JSON.stringify({ success: true });

    mockSpawn.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === '--version') return createVersionCheckProc(0);
      return createUploadProc(uploadResult, 0);
    });

    const originalHome = process.env.HOME;
    process.env.HOME = '/test/home';

    try {
      const { GarminExporter } = await import('../../src/exporters/garmin.js');
      const exporter = new GarminExporter({ token_dir: '~/my-tokens' });
      const result = await exporter.export(samplePayload);

      expect(result.success).toBe(true);
      const uploadCall = mockSpawn.mock.calls[1];
      const tokenDirIndex = (uploadCall[1] as string[]).indexOf('--token-dir');
      expect(tokenDirIndex).toBeGreaterThan(-1);
      expect(uploadCall[1][tokenDirIndex + 1]).toBe('/test/home/my-tokens');
    } finally {
      if (originalHome !== undefined) {
        process.env.HOME = originalHome;
      } else {
        delete process.env.HOME;
      }
    }
  });

  it('returns error when tilde expansion fails (no HOME or USERPROFILE)', async () => {
    const uploadResult = JSON.stringify({ success: true });

    mockSpawn.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === '--version') return createVersionCheckProc(0);
      return createUploadProc(uploadResult, 0);
    });

    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    delete process.env.HOME;
    delete process.env.USERPROFILE;

    try {
      const { GarminExporter } = await import('../../src/exporters/garmin.js');
      const exporter = new GarminExporter({ token_dir: '~/my-tokens' });
      const result = await exporter.export(samplePayload);
      expect(result.success).toBe(false);
      expect(result.error).toContain('Cannot expand ~');
    } finally {
      if (originalHome !== undefined) process.env.HOME = originalHome;
      if (originalUserProfile !== undefined) process.env.USERPROFILE = originalUserProfile;
    }
  });

  // F-11: the uploader runs with cwd = the package directory, so a relative
  // path passed as written pointed into the install (node_modules under npm),
  // not next to config.yaml where the setup put the token.
  it('passes a relative token_dir as an absolute path from the config directory', async () => {
    mockSpawn.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === '--version') return createVersionCheckProc(0);
      return createUploadProc(JSON.stringify({ success: true }), 0);
    });

    const { GarminExporter } = await import('../../src/exporters/garmin.js');
    const { configDir } = await import('../../src/config/paths.js');
    const exporter = new GarminExporter({ token_dir: './garmin-tokens/alice' });
    await exporter.export(samplePayload);

    const args = mockSpawn.mock.calls[1][1] as string[];
    expect(args[args.indexOf('--token-dir') + 1]).toBe(join(configDir(), 'garmin-tokens', 'alice'));
  });

  it('does not pass --token-dir when neither token_dir nor TOKEN_DIR is set (backward compat)', async () => {
    const uploadResult = JSON.stringify({ success: true });

    mockSpawn.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === '--version') return createVersionCheckProc(0);
      return createUploadProc(uploadResult, 0);
    });

    vi.stubEnv('TOKEN_DIR', undefined);
    try {
      const { GarminExporter } = await import('../../src/exporters/garmin.js');
      const exporter = new GarminExporter();
      const result = await exporter.export(samplePayload);

      expect(result.success).toBe(true);
      const uploadCall = mockSpawn.mock.calls[1];
      expect(uploadCall[1]).not.toContain('--token-dir');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  // F-11: the app reads a relative TOKEN_DIR as next to config.yaml
  // (findTokenDirCollisions), and setup_garmin.py writes the token there. The
  // uploader would take it from its own working directory, the package
  // directory, so the exporter hands it over already resolved.
  it('passes a relative TOKEN_DIR as an absolute path from the config directory', async () => {
    mockSpawn.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === '--version') return createVersionCheckProc(0);
      return createUploadProc(JSON.stringify({ success: true }), 0);
    });

    vi.stubEnv('TOKEN_DIR', 'env-tokens');
    try {
      const { GarminExporter } = await import('../../src/exporters/garmin.js');
      const { configDir } = await import('../../src/config/paths.js');
      await new GarminExporter().export(samplePayload);

      const args = mockSpawn.mock.calls[1][1] as string[];
      expect(args[args.indexOf('--token-dir') + 1]).toBe(join(configDir(), 'env-tokens'));
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("prefers the entry's token_dir over TOKEN_DIR", async () => {
    mockSpawn.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === '--version') return createVersionCheckProc(0);
      return createUploadProc(JSON.stringify({ success: true }), 0);
    });

    vi.stubEnv('TOKEN_DIR', '/from/env');
    try {
      const { GarminExporter } = await import('../../src/exporters/garmin.js');
      await new GarminExporter({ token_dir: '/from/entry' }).export(samplePayload);

      const args = mockSpawn.mock.calls[1][1] as string[];
      expect(args[args.indexOf('--token-dir') + 1]).toBe('/from/entry');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  // ─── Historical (#164) ────────────────────────────────────────────────────

  /**
   * Returns a getStdinBody() closure and a factory that, each time it is
   * called, builds a fresh MockProc with stdin capture and schedules its
   * close event via process.nextTick. We can't pre-create the proc and reuse
   * it across spawn calls because the nextTick fires immediately and the
   * 'close' listener gets attached only AFTER spawn returns.
   */
  function makeCapturingUploadFactory(
    stdoutData: string,
    exitCode: number,
  ): {
    factory: () => MockProc;
    getStdinBody: () => string;
  } {
    const chunks: Buffer[] = [];
    const factory = (): MockProc => {
      const proc = new EventEmitter() as MockProc;
      const stdinStream = new Writable({
        write(chunk, _enc, cb) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          cb();
        },
      });
      const stdoutStream = new PassThrough();
      proc.stdin = stdinStream;
      proc.stdout = stdoutStream;
      proc.stderr = null;

      process.nextTick(() => {
        stdoutStream.write(stdoutData);
        stdoutStream.end();
        proc.emit('close', exitCode);
      });
      return proc;
    };
    return { factory, getStdinBody: () => Buffer.concat(chunks).toString() };
  }

  it('declares supportsBackdate=true', async () => {
    const { GarminExporter } = await import('../../src/exporters/garmin.js');
    const exporter = new GarminExporter();
    expect(exporter.supportsBackdate).toBe(true);
  });

  it('serialises context.timestamp as ISO string into the Python stdin payload', async () => {
    const captured = makeCapturingUploadFactory(JSON.stringify({ success: true }), 0);

    mockSpawn.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === '--version') return createVersionCheckProc(0);
      return captured.factory();
    });

    const { GarminExporter } = await import('../../src/exporters/garmin.js');
    const exporter = new GarminExporter();
    const result = await exporter.export(samplePayload, {
      timestamp: new Date('2025-07-01T07:15:00Z'),
    });

    expect(result.success).toBe(true);
    const stdinBody = captured.getStdinBody();
    expect(stdinBody).toContain('"timestamp":"2025-07-01T07:15:00.000Z"');
  });

  it('omits timestamp when context.timestamp is undefined', async () => {
    const captured = makeCapturingUploadFactory(JSON.stringify({ success: true }), 0);

    mockSpawn.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === '--version') return createVersionCheckProc(0);
      return captured.factory();
    });

    const { GarminExporter } = await import('../../src/exporters/garmin.js');
    const exporter = new GarminExporter();
    await exporter.export(samplePayload);

    const stdinBody = captured.getStdinBody();
    expect(stdinBody).not.toContain('"timestamp"');
  });

  // ─── Weight only ──────────────────────────────────────────────────────────

  it('flags the stdin payload weight_only when configured', async () => {
    const captured = makeCapturingUploadFactory(JSON.stringify({ success: true }), 0);

    mockSpawn.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === '--version') return createVersionCheckProc(0);
      return captured.factory();
    });

    const { GarminExporter } = await import('../../src/exporters/garmin.js');
    const exporter = new GarminExporter({ weight_only: true });
    const result = await exporter.export(samplePayload);

    expect(result.success).toBe(true);
    const payload = JSON.parse(captured.getStdinBody());
    expect(payload.weight_only).toBe(true);
    expect(payload.weight).toBe(80);
    // The metrics still cross the wire; garmin_upload.py is what drops them, so
    // the flag stays the single place the decision is made.
    expect(payload.bmi).toBe(23.9);
  });

  it('omits weight_only from the payload by default', async () => {
    const captured = makeCapturingUploadFactory(JSON.stringify({ success: true }), 0);

    mockSpawn.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === '--version') return createVersionCheckProc(0);
      return captured.factory();
    });

    const { GarminExporter } = await import('../../src/exporters/garmin.js');
    const exporter = new GarminExporter();
    await exporter.export(samplePayload);

    expect(captured.getStdinBody()).not.toContain('weight_only');
  });

  it('combines weight_only with a back-dated timestamp', async () => {
    const captured = makeCapturingUploadFactory(JSON.stringify({ success: true }), 0);

    mockSpawn.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === '--version') return createVersionCheckProc(0);
      return captured.factory();
    });

    const { GarminExporter } = await import('../../src/exporters/garmin.js');
    const exporter = new GarminExporter({ weight_only: true });
    await exporter.export(samplePayload, { timestamp: new Date('2025-07-01T07:15:00Z') });

    const payload = JSON.parse(captured.getStdinBody());
    expect(payload.weight_only).toBe(true);
    expect(payload.timestamp).toBe('2025-07-01T07:15:00.000Z');
  });

  it('is off when the registry factory gets no weight_only key', async () => {
    const captured = makeCapturingUploadFactory(JSON.stringify({ success: true }), 0);

    mockSpawn.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === '--version') return createVersionCheckProc(0);
      return captured.factory();
    });

    const { createExporterFromEntry } = await import('../../src/exporters/registry.js');
    const exporter = createExporterFromEntry({ type: 'garmin', email: 'a@b.c', password: 'x' });
    await exporter.export(samplePayload);

    expect(captured.getStdinBody()).not.toContain('weight_only');
  });

  it('is on when the registry factory gets weight_only: true from config.yaml', async () => {
    const captured = makeCapturingUploadFactory(JSON.stringify({ success: true }), 0);

    mockSpawn.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === '--version') return createVersionCheckProc(0);
      return captured.factory();
    });

    const { createExporterFromEntry } = await import('../../src/exporters/registry.js');
    const exporter = createExporterFromEntry({
      type: 'garmin',
      email: 'a@b.c',
      password: 'x',
      weight_only: true,
    });
    await exporter.export(samplePayload);

    expect(JSON.parse(captured.getStdinBody()).weight_only).toBe(true);
  });

  // ExporterEntrySchema is passthrough and `${ENV_VAR}` references resolve to
  // strings, so the string spellings reach the factory verbatim. Reading
  // "false" as true would silently invert the setting.
  it.each([
    ['true', true],
    ['yes', true],
    ['1', true],
    ['on', true],
    ['TRUE', true],
    ['false', false],
    ['no', false],
    ['0', false],
    ['off', false],
    ['', false],
  ])('coerces the string weight_only %j to %s', async (raw, expected) => {
    const captured = makeCapturingUploadFactory(JSON.stringify({ success: true }), 0);

    mockSpawn.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === '--version') return createVersionCheckProc(0);
      return captured.factory();
    });

    const { createExporterFromEntry } = await import('../../src/exporters/registry.js');
    const exporter = createExporterFromEntry({
      type: 'garmin',
      email: 'a@b.c',
      password: 'x',
      weight_only: raw,
    });
    await exporter.export(samplePayload);

    const payload = JSON.parse(captured.getStdinBody());
    expect(payload.weight_only).toBe(expected ? true : undefined);
  });

  it('rejects a weight_only value that is neither boolean nor a known spelling', async () => {
    const { createExporterFromEntry } = await import('../../src/exporters/registry.js');
    expect(() =>
      createExporterFromEntry({
        type: 'garmin',
        email: 'a@b.c',
        password: 'x',
        weight_only: 'maybe',
      }),
    ).toThrow(/must be true or false/);
  });
});

describe('GarminExporter upload timeout (#399)', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import('../../src/exporters/garmin.js');
    mod._resetPythonCache();
  });

  /** A process that never answers, so only the spawn options matter. */
  function createSilentProc(): MockProc {
    const proc = new EventEmitter() as MockProc;
    proc.stdin = new Writable({
      write(_chunk, _enc, cb) {
        cb();
      },
    });
    proc.stdout = new PassThrough();
    proc.stderr = null;
    return proc;
  }

  it('defaults to 180s, not the old hard-coded 60s', async () => {
    mockSpawn.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === '--version') return createVersionCheckProc(0);
      return createSilentProc();
    });

    const { GarminExporter } = await import('../../src/exporters/garmin.js');
    void new GarminExporter().export(samplePayload);
    await new Promise((r) => setTimeout(r, 10));

    expect(mockSpawn.mock.calls[1][2]).toMatchObject({ timeout: 180_000 });
  });

  it('passes a configured timeout to spawn and names it in the timeout error', async () => {
    mockSpawn.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === '--version') return createVersionCheckProc(0);
      const proc = createSilentProc();
      // SIGTERM close is what Node's own spawn timeout produces.
      process.nextTick(() => proc.emit('close', null, 'SIGTERM'));
      return proc;
    });

    const { GarminExporter } = await import('../../src/exporters/garmin.js');
    const exporter = new GarminExporter({ upload_timeout_sec: 300 });
    const result = await exporter.export(samplePayload);

    expect(mockSpawn.mock.calls[1][2]).toMatchObject({ timeout: 300_000 });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/timed out after 300s/);
  });

  /** A process that printed `stdoutData` and was then killed by the spawn timeout. */
  function createKilledProc(stdoutData: string): MockProc {
    const proc = createSilentProc();
    process.nextTick(() => {
      proc.stdout!.write(stdoutData);
      proc.stdout!.end();
      proc.emit('close', null, 'SIGTERM');
    });
    return proc;
  }

  // F-04: the uploader prints its result the moment Garmin has answered. A
  // kill after that line (the interpreter still shutting down) used to be
  // reported as a timeout, and the retry sent the same weigh-in again.
  it('keeps a success reported before the timeout kill, and does not upload again', async () => {
    mockSpawn.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === '--version') return createVersionCheckProc(0);
      return createKilledProc(JSON.stringify({ success: true, data: { weight: 80 } }) + '\n');
    });

    const { GarminExporter } = await import('../../src/exporters/garmin.js');
    const result = await new GarminExporter({ upload_timeout_sec: 60 }).export(samplePayload);

    expect(result.success).toBe(true);
    // 1 version check + 1 upload
    expect(mockSpawn).toHaveBeenCalledTimes(2);
  });

  it('keeps a not-retryable failure reported before the timeout kill', async () => {
    mockSpawn.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === '--version') return createVersionCheckProc(0);
      return createKilledProc(
        JSON.stringify({ success: false, error: 'token rejected', retryable: false }),
      );
    });

    const { GarminExporter } = await import('../../src/exporters/garmin.js');
    const result = await new GarminExporter({ upload_timeout_sec: 60 }).export(samplePayload);

    expect(result.success).toBe(false);
    expect(result.error).toBe('token rejected');
    expect(mockSpawn).toHaveBeenCalledTimes(2);
  });

  it('still reports a timeout when the kill came before a complete result', async () => {
    mockSpawn.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === '--version') return createVersionCheckProc(0);
      return createKilledProc('{"success": tr');
    });

    const { GarminExporter } = await import('../../src/exporters/garmin.js');
    const result = await new GarminExporter({ upload_timeout_sec: 60 }).export(samplePayload);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/timed out after 60s/);
    expect(mockSpawn).toHaveBeenCalledTimes(4);
  });

  it('accepts the value as a string, which is what a ${ENV_VAR} reference resolves to', async () => {
    const { createExporterFromEntry } = await import('../../src/exporters/registry.js');
    mockSpawn.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === '--version') return createVersionCheckProc(0);
      return createSilentProc();
    });

    const exporter = createExporterFromEntry({
      type: 'garmin',
      email: 'a@b.c',
      password: 'x',
      upload_timeout_sec: '240',
    });
    void exporter.export(samplePayload);
    await new Promise((r) => setTimeout(r, 10));

    expect(mockSpawn.mock.calls[1][2]).toMatchObject({ timeout: 240_000 });
  });

  it('rejects a non-numeric or out-of-range timeout instead of handing spawn nonsense', async () => {
    const { createExporterFromEntry } = await import('../../src/exporters/registry.js');
    const entry = (v: unknown) => ({
      type: 'garmin' as const,
      email: 'a@b.c',
      password: 'x',
      upload_timeout_sec: v,
    });

    expect(() => createExporterFromEntry(entry('soon'))).toThrow(/must be a number/);
    // spawn() throws on a fractional timeout, from inside the promise executor.
    expect(() => createExporterFromEntry(entry(10.5))).toThrow(/whole number/);
    expect(() => createExporterFromEntry(entry(5))).toThrow(/between 10 and 900/);
    expect(() => createExporterFromEntry(entry(3600))).toThrow(/between 10 and 900/);
  });
});
