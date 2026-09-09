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

/**
 * Default cap on one `garmin_upload.py` run.
 *
 * Was 60 s, which is the wrong side of the line for a background job with
 * nowhere to put the data: Garmin Connect's login and upload path is regularly
 * slower than a minute, and all three attempts then die and the reading is
 * gone. A reporter lost four weigh-ins over five days that way and has been
 * running 300 s locally since (#399).
 *
 * `withRetry` has no delay between attempts, so the worst case is exactly
 * three times this value. That is also why the default is not the reporter's
 * 300 s: 15 minutes of a failing Garmin would hold up the next scan cycle in
 * continuous mode, and delay the ntfy/Telegram summary that reports the
 * weigh-in. Raise it with `upload_timeout_sec` if your Garmin is habitually
 * slow.
 */
const DEFAULT_UPLOAD_TIMEOUT_MS = 180_000;

export const GARMIN_UPLOAD_TIMEOUT_MIN_SEC = 10;
export const GARMIN_UPLOAD_TIMEOUT_MAX_SEC = 900;

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
 * `garmin_upload.py` forwards as `add_body_composition(timestamp=...)`, and
 * `weight_only` tells the uploader to pass `None` for every derived metric so
 * Garmin records the weight alone.
 */
type GarminUploadPayload = BodyComposition & { timestamp?: string; weight_only?: boolean };

function uploadToGarmin(
  payload: GarminUploadPayload,
  pythonCmd: string,
  tokenDir: string | undefined,
  timeoutMs: number,
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
      timeout: timeoutMs,
    });

    const chunks: Buffer[] = [];
    py.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));

    py.stdin.write(JSON.stringify(payload));
    py.stdin.end();

    py.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      if (signal === 'SIGTERM') {
        reject(new Error(`Python uploader timed out after ${timeoutMs / 1000}s`));
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
  /**
   * Upload the weight alone, leaving BMI, body fat, water, bone, muscle,
   * visceral fat, physique rating and metabolic age unset in Garmin Connect.
   * For scales whose derived metrics you do not trust, or profiles where only
   * the weight trend matters.
   */
  weight_only?: boolean;
  /**
   * Seconds one upload attempt may take before the Python process is killed
   * (10-900). Three attempts are made, with no wait between them.
   */
  upload_timeout_sec?: number;
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
    {
      key: 'upload_timeout_sec',
      label: 'Upload timeout (seconds)',
      type: 'number',
      required: false,
      default: DEFAULT_UPLOAD_TIMEOUT_MS / 1000,
      description:
        'Seconds one upload attempt may take before it is killed (10-900). Three attempts are made. Raise it if Garmin Connect is often slow for you; press enter to keep the default',
      // The wizard only checks that a number is a number, so without this it
      // would happily write a value the registry rejects at startup.
      validate: (value: string) => {
        const num = Number(value);
        if (!Number.isInteger(num)) return 'Enter a whole number of seconds';
        return num >= GARMIN_UPLOAD_TIMEOUT_MIN_SEC && num <= GARMIN_UPLOAD_TIMEOUT_MAX_SEC
          ? null
          : `Enter a value between ${GARMIN_UPLOAD_TIMEOUT_MIN_SEC} and ${GARMIN_UPLOAD_TIMEOUT_MAX_SEC}`;
      },
    },
    {
      key: 'weight_only',
      label: 'Upload weight only',
      type: 'boolean',
      required: false,
      default: false,
      description:
        'Send only the weight; leave BMI, body fat, water, bone, muscle, visceral fat, physique rating and metabolic age unset',
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
    const payload: GarminUploadPayload = { ...data };
    if (context?.timestamp) payload.timestamp = context.timestamp.toISOString();
    if (this.entryConfig.weight_only) payload.weight_only = true;

    const configured = this.entryConfig.upload_timeout_sec;
    const timeoutMs = configured !== undefined ? configured * 1000 : DEFAULT_UPLOAD_TIMEOUT_MS;

    return withRetry(
      async () => {
        const result = await uploadToGarmin(
          payload,
          pythonCmd,
          this.entryConfig.token_dir,
          timeoutMs,
        );
        if (result.success) log.info('Garmin upload succeeded.');
        return result;
      },
      { log, label: 'upload' },
    );
  }
}
