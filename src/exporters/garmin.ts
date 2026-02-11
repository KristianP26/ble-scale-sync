import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';

import { createLogger } from '../logger.js';
import type { BodyComposition } from '../interfaces/scale-adapter.js';
import type { Exporter, ExportResult } from '../interfaces/exporter.js';
import { withRetry } from '../utils/retry.js';

const log = createLogger('Garmin');

const __dirname: string = dirname(fileURLToPath(import.meta.url));
const ROOT: string = join(__dirname, '..', '..');

const SUBPROCESS_TIMEOUT_MS = 60_000;

let cachedPython: string | undefined;

function findPython(): Promise<string> {
  if (cachedPython) return Promise.resolve(cachedPython);
  return new Promise((resolve) => {
    const check = spawn('python3', ['--version'], { stdio: 'ignore' });
    check.on('error', () => {
      cachedPython = 'python';
      resolve(cachedPython);
    });
    check.on('close', (code) => {
      cachedPython = code === 0 ? 'python3' : 'python';
      resolve(cachedPython);
    });
  });
}

/** @internal Reset cached python command — for testing only. */
export function _resetPythonCache(): void {
  cachedPython = undefined;
}

function uploadToGarmin(payload: BodyComposition, pythonCmd: string): Promise<ExportResult> {
  return new Promise<ExportResult>((resolve, reject) => {
    const scriptPath: string = join(ROOT, 'garmin-scripts', 'garmin_upload.py');
    const py = spawn(pythonCmd, [scriptPath], {
      stdio: ['pipe', 'pipe', 'inherit'],
      cwd: ROOT,
      timeout: SUBPROCESS_TIMEOUT_MS,
    });

    const chunks: Buffer[] = [];
    py.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));

    py.stdin.write(JSON.stringify(payload));
    py.stdin.end();

    py.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      if (signal === 'SIGTERM') {
        reject(new Error(`Python uploader timed out after ${SUBPROCESS_TIMEOUT_MS / 1000}s`));
        return;
      }
      const raw: string = Buffer.concat(chunks).toString().trim();
      if (!raw) {
        reject(new Error(`Python uploader exited with code ${code} and no output`));
        return;
      }
      try {
        const result: ExportResult = JSON.parse(raw);
        resolve(result);
      } catch {
        reject(new Error(`Invalid JSON from Python (exit ${code}): ${raw}`));
      }
    });

    py.on('error', (err: Error) => {
      reject(new Error(`Failed to launch Python: ${err.message}`));
    });
  });
}

export class GarminExporter implements Exporter {
  readonly name = 'garmin';

  async export(data: BodyComposition): Promise<ExportResult> {
    const pythonCmd = await findPython();

    return withRetry(
      async () => {
        const result = await uploadToGarmin(data, pythonCmd);
        if (result.success) log.info('Garmin upload succeeded.');
        return result;
      },
      { log, label: 'upload' },
    );
  }
}
