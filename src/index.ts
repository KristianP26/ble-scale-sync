#!/usr/bin/env tsx

// Load .env FIRST — before noble initializes and reads env vars
import './env.js';

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';

import { scanAndRead } from './ble.js';
import { adapters } from './scales/index.js';
import { loadConfig } from './validate-env.js';
import type { GarminPayload } from './interfaces/scale-adapter.js';

const __dirname: string = dirname(fileURLToPath(import.meta.url));
const ROOT: string = join(__dirname, '..');

interface UploadResult {
  success: boolean;
  data?: Record<string, number>;
  error?: string;
}

const { profile, scaleMac: SCALE_MAC, weightUnit } = loadConfig();

const KG_TO_LBS = 2.20462;

function fmtWeight(kg: number): string {
  if (weightUnit === 'lbs') return `${(kg * KG_TO_LBS).toFixed(2)} lbs`;
  return `${kg.toFixed(2)} kg`;
}

function findPython(): Promise<string> {
  return new Promise((resolve) => {
    const check = spawn('python3', ['--version'], { stdio: 'ignore' });
    check.on('error', () => resolve('python'));
    check.on('close', (code) => resolve(code === 0 ? 'python3' : 'python'));
  });
}

async function main(): Promise<void> {
  console.log(`\n[Sync] Scale → Garmin Connect`);
  if (SCALE_MAC) {
    console.log(`[Sync] Scanning for scale ${SCALE_MAC}...`);
  } else {
    console.log(`[Sync] Scanning for any recognized scale...`);
  }
  console.log(`[Sync] Adapters: ${adapters.map((a) => a.name).join(', ')}\n`);

  const payload: GarminPayload = await scanAndRead({
    targetMac: SCALE_MAC,
    adapters,
    profile,
    weightUnit,
    onLiveData(reading) {
      const impStr: string = reading.impedance > 0 ? `${reading.impedance} Ohm` : 'Measuring...';
      process.stdout.write(`\r  Weight: ${fmtWeight(reading.weight)} | Impedance: ${impStr}      `);
    },
  });

  console.log(
    `\n\n[Sync] Measurement received: ${fmtWeight(payload.weight)} / ${payload.impedance} Ohm`,
  );
  console.log('[Sync] Body composition:');
  const kgMetrics = new Set(['boneMass', 'muscleMass']);
  const { weight: _w, impedance: _i, ...metrics } = payload;
  for (const [k, v] of Object.entries(metrics)) {
    const display = kgMetrics.has(k) ? fmtWeight(v) : String(v);
    console.log(`  ${k}: ${display}`);
  }

  console.log('\n[Sync] Sending to Garmin uploader...');

  const pythonCmd: string = await findPython();
  const MAX_RETRIES = 2;
  let lastError: string | undefined;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      console.log(`[Sync] Retrying upload (${attempt}/${MAX_RETRIES})...`);
    }

    const result: UploadResult = await uploadToGarmin(payload, pythonCmd);

    if (result.success) {
      console.log('[Sync] Done.');
      return;
    }

    lastError = result.error;
    console.error(`[Sync] Upload failed: ${lastError}`);
  }

  console.error(`[Sync] All upload attempts failed.`);
  process.exit(1);
}

function uploadToGarmin(payload: GarminPayload, pythonCmd: string): Promise<UploadResult> {
  return new Promise<UploadResult>((resolve, reject) => {
    const scriptPath: string = join(ROOT, 'scripts', 'garmin_upload.py');
    const py = spawn(pythonCmd, [scriptPath], {
      stdio: ['pipe', 'pipe', 'inherit'],
      cwd: ROOT,
    });

    const chunks: Buffer[] = [];
    py.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));

    py.stdin.write(JSON.stringify(payload));
    py.stdin.end();

    py.on('close', (code: number | null) => {
      const raw: string = Buffer.concat(chunks).toString().trim();
      if (!raw) {
        reject(new Error(`Python uploader exited with code ${code} and no output`));
        return;
      }
      try {
        const result: UploadResult = JSON.parse(raw);
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

main().catch((err: Error) => {
  console.error(`\n[Error] ${err.message}`);
  process.exit(1);
});
