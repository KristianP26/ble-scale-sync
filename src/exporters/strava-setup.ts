/**
 * Interactive Strava OAuth2 token setup.
 *
 * Usage: npm run setup-strava
 *
 * 1. Reads client_id and client_secret from config.yaml (first strava exporter found)
 * 2. Prints an authorization URL for the user to open in a browser
 * 3. User authorizes and copies the `code` parameter from the redirect URL
 * 4. Exchanges the code for access + refresh tokens
 * 5. Saves tokens to the configured token_dir
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { loadAppConfig } from '../config/load.js';
import { createLogger } from '../logger.js';

const log = createLogger('StravaSetup');

interface StravaExporterEntry {
  type: 'strava';
  client_id: string;
  client_secret: string;
  token_dir?: string;
}

function findStravaConfig(): StravaExporterEntry | undefined {
  const { config } = loadAppConfig();

  const allExporters = [
    ...(config.global_exporters ?? []),
    ...config.users.flatMap((u) => u.exporters ?? []),
  ];

  return allExporters.find((e) => e.type === 'strava') as StravaExporterEntry | undefined;
}

function prompt(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim()));
  });
}

async function main(): Promise<void> {
  const strava = findStravaConfig();
  if (!strava) {
    log.error('No Strava exporter found in config.yaml.');
    log.error('Add a strava exporter to your config first, then run this script again.');
    process.exit(1);
  }

  const { client_id, client_secret } = strava;
  const tokenDir = strava.token_dir ?? './strava-tokens';

  if (!client_id || !client_secret) {
    log.error('client_id and client_secret are required in your Strava exporter config.');
    process.exit(1);
  }

  const authUrl =
    `https://www.strava.com/oauth/authorize` +
    `?client_id=${encodeURIComponent(client_id)}` +
    `&redirect_uri=http://localhost` +
    `&response_type=code` +
    `&scope=profile:write`;

  console.log('\n--- Strava Authorization ---\n');
  console.log('1. Open this URL in your browser:\n');
  console.log(`   ${authUrl}\n`);
  console.log('2. Authorize the application');
  console.log('3. You will be redirected to http://localhost?code=XXXX (the page will not load)');
  console.log('4. Copy the "code" value from the URL bar\n');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  try {
    const code = await prompt(rl, 'Paste the authorization code: ');
    if (!code) {
      log.error('No code provided. Aborting.');
      process.exit(1);
    }

    log.info('Exchanging code for tokens...');

    const response = await fetch('https://www.strava.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id,
        client_secret,
        code,
        grant_type: 'authorization_code',
      }),
    });

    if (!response.ok) {
      // Bound the upstream body. This is the one path that has just transmitted
      // client_secret, and the log is routinely pasted into public issues.
      // Strava does not echo the secret back today, so this is hardening rather
      // than a fix - but an unbounded verbatim dump of a response body is not
      // something to rely on a third party's discretion for. Same cap and same
      // reasoning as notification-message.ts.
      const body = [...(await response.text())].slice(0, 200).join('');
      log.error(`Token exchange failed: HTTP ${response.status}`);
      log.error(body);
      process.exit(1);
    }

    const data = (await response.json()) as {
      access_token: string;
      refresh_token: string;
      expires_at: number;
    };

    const tokens = {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: data.expires_at,
    };

    const tokenPath = path.join(tokenDir, 'strava_tokens.json');
    if (!fs.existsSync(tokenDir)) {
      fs.mkdirSync(tokenDir, { recursive: true });
    }
    fs.writeFileSync(tokenPath, JSON.stringify(tokens, null, 2) + '\n', { mode: 0o600 });

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
