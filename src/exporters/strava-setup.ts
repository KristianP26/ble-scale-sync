/**
 * Interactive Strava OAuth2 token setup.
 *
 * Usage: npm run setup-strava [-- --user <name or slug>]
 *
 * 1. Reads client_id and client_secret from config.yaml (with several strava
 *    exporters, the one of the user named by --user <name or slug>)
 * 2. Prints an authorization URL for the user to open in a browser
 * 3. User authorizes and copies the `code` parameter from the redirect URL
 * 4. Exchanges the code for access + refresh tokens
 * 5. Saves tokens to the configured token_dir
 */

import * as path from 'node:path';
import * as readline from 'node:readline';
import { loadAppConfig } from '../config/load.js';
import { configDir } from '../config/paths.js';
import { createLogger } from '../logger.js';
import { selectStravaEntry, stravaTokenDir } from './strava-select.js';
import {
  exchangeStravaCode,
  stravaAuthorizeInstructions,
  StravaTokenExchangeError,
} from './strava-auth.js';

const log = createLogger('StravaSetup');

function userArg(argv: string[]): string | undefined {
  const i = argv.indexOf('--user');
  if (i >= 0) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith('--user='));
  return eq?.slice('--user='.length);
}

function prompt(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim()));
  });
}

async function main(): Promise<void> {
  const { config, configPath } = loadAppConfig();
  const selection = selectStravaEntry(config, userArg(process.argv.slice(2)));
  if (!selection.ok) {
    log.error(selection.error);
    process.exit(1);
  }
  const strava = selection.entry;
  log.info(`Authorizing the Strava exporter of ${selection.owner}.`);

  const { client_id, client_secret } = strava;
  const tokenDir = stravaTokenDir(strava, configPath ? path.dirname(configPath) : configDir());

  if (!client_id || !client_secret) {
    log.error('client_id and client_secret are required in your Strava exporter config.');
    process.exit(1);
  }

  console.log('\n--- Strava Authorization ---\n');
  for (const line of stravaAuthorizeInstructions(client_id)) console.log(line);
  console.log('');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  try {
    const code = await prompt(rl, 'Paste the authorization code: ');
    if (!code) {
      log.error('No code provided. Aborting.');
      process.exit(1);
    }

    log.info('Exchanging code for tokens...');

    let tokenPath: string;
    try {
      tokenPath = await exchangeStravaCode({
        clientId: client_id,
        clientSecret: client_secret,
        code,
        tokenDir,
      });
    } catch (err) {
      if (!(err instanceof StravaTokenExchangeError)) throw err;
      for (const line of err.message.split('\n')) log.error(line);
      process.exit(1);
    }

    log.info(`Tokens saved to ${tokenPath}`);
    console.log('\nStrava setup complete! You can now use the Strava exporter.\n');
  } finally {
    rl.close();
  }
}

main().catch((err) => {
  log.error(`Setup failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
