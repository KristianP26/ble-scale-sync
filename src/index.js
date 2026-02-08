#!/usr/bin/env node

/**
 * Renpho Scale → Garmin Connect sync.
 *
 * 1. Connects to the scale via BLE (noble)
 * 2. Calculates body composition metrics
 * 3. Passes JSON to Python uploader via stdin
 */

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { config } from 'dotenv';

import { connectAndRead } from './ble.js';
import { RenphoCalculator } from './calculator.js';

// Load .env from project root
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
config({ path: join(ROOT, '.env') });

// ---------- Configuration ----------

function requireEnv(key) {
  const val = process.env[key];
  if (!val) {
    console.error(`Missing required env var: ${key}. Check your .env file.`);
    process.exit(1);
  }
  return val;
}

const SCALE_MAC   = requireEnv('SCALE_MAC');
const CHAR_NOTIFY = requireEnv('CHAR_NOTIFY');
const CHAR_WRITE  = requireEnv('CHAR_WRITE');
const CMD_UNLOCK  = requireEnv('CMD_UNLOCK')
  .split(',')
  .map((b) => parseInt(b.trim(), 16));

const USER_HEIGHT     = Number(requireEnv('USER_HEIGHT'));
const USER_AGE        = Number(requireEnv('USER_AGE'));
const USER_GENDER     = requireEnv('USER_GENDER').toLowerCase();
const USER_IS_ATHLETE = requireEnv('USER_IS_ATHLETE').toLowerCase() === 'true';

// ---------- Main ----------

async function main() {
  console.log(`\n[Sync] Renpho Scale → Garmin Connect`);
  console.log(`[Sync] Target: ${SCALE_MAC}\n`);

  // 1. BLE — connect and read measurement
  const { weight, impedance } = await connectAndRead({
    scaleMac: SCALE_MAC,
    charNotify: CHAR_NOTIFY,
    charWrite: CHAR_WRITE,
    cmdUnlock: CMD_UNLOCK,
    onLiveData(w, imp) {
      const impStr = imp > 0 ? `${imp} Ohm` : 'Measuring...';
      process.stdout.write(`\r  Weight: ${w.toFixed(2)} kg | Impedance: ${impStr}      `);
    },
  });

  console.log(`\n\n[Sync] Measurement received: ${weight} kg / ${impedance} Ohm`);

  // 2. Calculate body composition
  const calc = new RenphoCalculator(
    weight, impedance, USER_HEIGHT, USER_AGE, USER_GENDER, USER_IS_ATHLETE,
  );
  const metrics = calc.calculate();

  if (!metrics) {
    console.error('[Sync] Calculation failed (zero inputs).');
    process.exit(1);
  }

  console.log('[Sync] Body composition:');
  for (const [k, v] of Object.entries(metrics)) {
    console.log(`  ${k}: ${v}`);
  }

  // 3. Build payload for Python uploader
  const payload = {
    weight,
    impedance,
    ...metrics,
  };

  console.log('\n[Sync] Sending to Garmin uploader...');
  await uploadToGarmin(payload);
}

// ---------- Python bridge ----------

function uploadToGarmin(payload) {
  return new Promise((resolve, reject) => {
    const scriptPath = join(ROOT, 'scripts', 'garmin_upload.py');
    const py = spawn('python', [scriptPath], {
      stdio: ['pipe', 'inherit', 'inherit'],
      cwd: ROOT,
    });

    py.stdin.write(JSON.stringify(payload));
    py.stdin.end();

    py.on('close', (code) => {
      if (code === 0) {
        console.log('[Sync] Done.');
        resolve();
      } else {
        reject(new Error(`Python uploader exited with code ${code}`));
      }
    });

    py.on('error', (err) => {
      reject(new Error(`Failed to launch Python: ${err.message}`));
    });
  });
}

// ---------- Run ----------

main().catch((err) => {
  console.error(`\n[Error] ${err.message}`);
  process.exit(1);
});
