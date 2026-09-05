import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { Writable, PassThrough } from 'node:stream';
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

function createVersionCheckProc(exitCode: number, errorMsg?: string): MockProc {
  const proc = new EventEmitter() as MockProc;
  proc.stdin = null;
  proc.stdout = null;
  proc.stderr = null;
  process.nextTick(() => {
    if (errorMsg) {
      proc.emit('error', new Error(errorMsg));
    } else {
      proc.emit('close', exitCode);
    }
  });
  return proc;
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

  it('falls back to python when python3 is not found', async () => {
    const uploadResult = JSON.stringify({ success: true });

    mockSpawn.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === '--version') return createVersionCheckProc(0, 'not found');
      return createUploadProc(uploadResult, 0);
    });

    const { GarminExporter } = await import('../../src/exporters/garmin.js');
    const exporter = new GarminExporter();
    const result = await exporter.export(samplePayload);

    expect(result.success).toBe(true);
    expect(mockSpawn).toHaveBeenCalledTimes(2);
    // Second spawn call should use 'python' (fallback)
    expect(mockSpawn.mock.calls[1][0]).toBe('python');
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

  it('does not pass --token-dir when token_dir is not set (backward compat)', async () => {
    const uploadResult = JSON.stringify({ success: true });

    mockSpawn.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === '--version') return createVersionCheckProc(0);
      return createUploadProc(uploadResult, 0);
    });

    const { GarminExporter } = await import('../../src/exporters/garmin.js');
    const exporter = new GarminExporter();
    const result = await exporter.export(samplePayload);

    expect(result.success).toBe(true);
    const uploadCall = mockSpawn.mock.calls[1];
    expect(uploadCall[1]).not.toContain('--token-dir');
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
});
