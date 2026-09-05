import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname: string = dirname(fileURLToPath(import.meta.url));

/** Repository root (two levels up from src/config). */
export const ROOT: string = join(__dirname, '..', '..');

/** Default config.yaml location at the repository root. */
export const DEFAULT_CONFIG_PATH: string = join(ROOT, 'config.yaml');

/** Default .env location at the repository root. */
export const DEFAULT_ENV_PATH: string = join(ROOT, '.env');
