import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';

import { createLogger } from '../logger.js';
import type { BodyComposition } from '../interfaces/scale-adapter.js';
import type { Exporter, ExportContext, ExportResult } from '../interfaces/exporter.js';
import type { ExporterSchema } from '../interfaces/exporter-schema.js';
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

function expandTilde(path: string): string {
  if (!path.startsWith('~')) return path;
  const home = process.env.HOME || process.env.USERPROFILE;
  if (!home) throw new Error('Cannot expand ~: HOME and USERPROFILE are both undefined');
  return path.replace(/^~/, home);
}

/** @internal Exported for testing only. */
export { expandTilde as _expandTilde };

/**
 * Wire payload handed to the Python uploader: live readings carry the metrics
 * only, historical replay (#164) adds an ISO 8601 `timestamp` field that
 * `garmin_upload.py` forwards as `add_body_composition(timestamp=...)`.
 */
type GarminUploadPayload = BodyComposition & { timestamp?: string };

function uploadToGarmin(
  payload: GarminUploadPayload,
  pythonCmd: string,
  tokenDir?: string,
): Promise<ExportResult> {
  return new Promise<ExportResult>((resolve, reject) => {
    const scriptPath: string = join(ROOT, 'garmin-scripts', 'garmin_upload.py');
    const args: string[] = [scriptPath];

    if (tokenDir) {
      args.push('--token-dir', expandTilde(tokenDir));
    }

    const py = spawn(pythonCmd, args, {
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

export interface GarminEntryConfig {
  email?: string;
  password?: string;
  token_dir?: string;
}

export const garminSchema: ExporterSchema = {
  name: 'garmin',
  displayName: 'Garmin Connect',
  description: 'Upload body composition data to Garmin Connect',
  fields: [
    {
      key: 'email',
      label: 'Garmin Email',
      type: 'string',
      required: true,
      description: 'Your Garmin Connect email address',
    },
    {
      key: 'password',
      label: 'Garmin Password',
      type: 'password',
      required: true,
      description: 'Your Garmin Connect password (supports ${ENV_VAR} references)',
    },
    {
      key: 'token_dir',
      label: 'Token Directory',
      type: 'string',
      required: false,
      default: './garmin-tokens',
      description: 'Directory for storing auth tokens',
    },
  ],
  supportsGlobal: false,
  supportsPerUser: true,
  dependencies: [
    {
      name: 'Python 3',
      checkCommand: 'python3 --version',
      fallbackCommand: 'python --version',
      installInstructions: 'Install Python 3: https://www.python.org/downloads/',
    },
  ],
};

export class GarminExporter implements Exporter {
  readonly name = 'garmin';
  readonly supportsBackdate = true;
  private readonly entryConfig: GarminEntryConfig;

  constructor(config?: GarminEntryConfig) {
    this.entryConfig = config ?? {};
  }

  async export(data: BodyComposition, context?: ExportContext): Promise<ExportResult> {
    const pythonCmd = await findPython();
    const payload: GarminUploadPayload = context?.timestamp
      ? { ...data, timestamp: context.timestamp.toISOString() }
      : data;

    return withRetry(
      async () => {
        const result = await uploadToGarmin(payload, pythonCmd, this.entryConfig.token_dir);
        if (result.success) log.info('Garmin upload succeeded.');
        return result;
      },
      { log, label: 'upload' },
    );
  }
}
