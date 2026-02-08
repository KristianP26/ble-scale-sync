#!/usr/bin/env tsx

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { config } from 'dotenv';

import { connectAndRead } from './ble.js';
import { RenphoCalculator, type Gender, type RenphoMetrics } from './calculator.js';

const __dirname: string = dirname(fileURLToPath(import.meta.url));
const ROOT: string = join(__dirname, '..');
config({ path: join(ROOT, '.env') });

interface GarminPayload extends RenphoMetrics {
  weight: number;
  impedance: number;
}

function requireEnv(key: string): string {
  const val: string | undefined = process.env[key];
  if (!val) {
    console.error(`Missing required env var: ${key}. Check your .env file.`);
    process.exit(1);
  }
  return val;
}

const SCALE_MAC: string   = requireEnv('SCALE_MAC');
const CHAR_NOTIFY: string = requireEnv('CHAR_NOTIFY');
const CHAR_WRITE: string  = requireEnv('CHAR_WRITE');
const CMD_UNLOCK: number[] = requireEnv('CMD_UNLOCK')
  .split(',')
  .map((b): number => {
    const parsed = parseInt(b.trim(), 16);
    if (Number.isNaN(parsed)) throw new Error(`Invalid hex byte in CMD_UNLOCK: "${b.trim()}"`);
    return parsed;
  });

const USER_HEIGHT: number     = Number(requireEnv('USER_HEIGHT'));
const USER_AGE: number        = Number(requireEnv('USER_AGE'));
const USER_GENDER: Gender     = requireEnv('USER_GENDER').toLowerCase() as Gender;
const USER_IS_ATHLETE: boolean = requireEnv('USER_IS_ATHLETE').toLowerCase() === 'true';

async function main(): Promise<void> {
  console.log(`\n[Sync] Renpho Scale → Garmin Connect`);
  console.log(`[Sync] Target: ${SCALE_MAC}\n`);

  const { weight, impedance } = await connectAndRead({
    scaleMac: SCALE_MAC,
    charNotify: CHAR_NOTIFY,
    charWrite: CHAR_WRITE,
    cmdUnlock: CMD_UNLOCK,
    onLiveData(w: number, imp: number): void {
      const impStr: string = imp > 0 ? `${imp} Ohm` : 'Measuring...';
      process.stdout.write(`\r  Weight: ${w.toFixed(2)} kg | Impedance: ${impStr}      `);
    },
  });

  console.log(`\n\n[Sync] Measurement received: ${weight} kg / ${impedance} Ohm`);

  const calc = new RenphoCalculator(
    weight, impedance, USER_HEIGHT, USER_AGE, USER_GENDER, USER_IS_ATHLETE,
  );
  const metrics: RenphoMetrics | null = calc.calculate();

  if (!metrics) {
    console.error('[Sync] Calculation failed (zero inputs).');
    process.exit(1);
  }

  console.log('[Sync] Body composition:');
  for (const [k, v] of Object.entries(metrics)) {
    console.log(`  ${k}: ${v}`);
  }

  const payload: GarminPayload = {
    weight,
    impedance,
    ...metrics,
  };

  console.log('\n[Sync] Sending to Garmin uploader...');
  await uploadToGarmin(payload);
}

function uploadToGarmin(payload: GarminPayload): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const scriptPath: string = join(ROOT, 'scripts', 'garmin_upload.py');
    const py = spawn('python', [scriptPath], {
      stdio: ['pipe', 'inherit', 'inherit'],
      cwd: ROOT,
    });

    py.stdin.write(JSON.stringify(payload));
    py.stdin.end();

    py.on('close', (code: number | null) => {
      if (code === 0) {
        console.log('[Sync] Done.');
        resolve();
      } else {
        reject(new Error(`Python uploader exited with code ${code}`));
      }
    });

    py.on('error', (err: Error) => {
      reject(new Error(`Failed to launch Python: ${err.message}`));
    });
  });
}

main().catch((err: Error) => {
  console.error(`\n[Error] ${err.message}`);
  process.exit(1);
});
