/**
 * Load .env BEFORE any other module initializes.
 * This must be the first import in index.ts so that noble (which reads
 * env vars at module load time) sees NOBLE_REPORT_ALL_HCI_EVENTS etc.
 */
import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname: string = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '.env') });

// On Linux, noble's HCI backend competes with BlueZ for HCI events.
// Without this flag, BlueZ can consume the LE Connection Complete event
// before noble sees it, causing peripheral.connect() to hang indefinitely.
if (!process.env.NOBLE_REPORT_ALL_HCI_EVENTS) {
  process.env.NOBLE_REPORT_ALL_HCI_EVENTS = '1';
}
