/**
 * The Strava OAuth2 code exchange, shared by `setup-strava` and the setup
 * wizard so both write the same token file the exporter reads.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { atomicWrite } from '../config/write.js';

/** The page the person opens to authorize the app; Strava then redirects to localhost. */
export function stravaAuthorizeUrl(clientId: string): string {
  return (
    `https://www.strava.com/oauth/authorize` +
    `?client_id=${encodeURIComponent(clientId)}` +
    `&redirect_uri=http://localhost` +
    `&response_type=code` +
    `&scope=profile:write`
  );
}

/** What to do with the URL, for a terminal. */
export function stravaAuthorizeInstructions(clientId: string): string[] {
  return [
    '1. Open this URL in your browser:',
    '',
    `   ${stravaAuthorizeUrl(clientId)}`,
    '',
    '2. Authorize the application',
    '3. You will be redirected to http://localhost?code=XXXX (the page will not load)',
    '4. Copy the "code" value from the URL bar',
  ];
}

/**
 * Strava refused the code (HTTP error), as opposed to a network or file
 * error. setup-strava reports only this one itself; anything else reaches its
 * outer "Setup failed:" handler, as it did before the exchange moved here.
 */
export class StravaTokenExchangeError extends Error {
  override name = 'StravaTokenExchangeError';
}

export interface StravaCodeExchange {
  clientId: string;
  clientSecret: string;
  code: string;
  /** Absolute directory the token file goes in. */
  tokenDir: string;
}

/**
 * Trade an authorization code for tokens and save them as
 * `<tokenDir>/strava_tokens.json`. Returns the file path; throws a
 * StravaTokenExchangeError on a refused exchange.
 */
export async function exchangeStravaCode(
  { clientId, clientSecret, code, tokenDir }: StravaCodeExchange,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const response = await fetchImpl('https://www.strava.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      grant_type: 'authorization_code',
    }),
  });

  if (!response.ok) {
    // Bound the upstream body. This is the one path that has just transmitted
    // client_secret, and the log is routinely pasted into public issues.
    // Strava does not echo the secret back today, so this is hardening rather
    // than a fix - but an unbounded verbatim dump of a response body is not
    // something to rely on a third party's discretion for. Same reasoning as
    // notification-message.ts, which caps forwarded error text at 120; 200
    // here because this body is read by the person debugging their own setup,
    // not forwarded to a channel.
    const body = [...(await response.text())].slice(0, 200).join('');
    throw new StravaTokenExchangeError(`Token exchange failed: HTTP ${response.status}\n${body}`);
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
    fs.mkdirSync(tokenDir, { recursive: true, mode: 0o700 });
  }
  // Through a fresh 0600 tmp file: a direct writeFileSync keeps the old
  // permissions of an existing token file, since mode applies only on create.
  atomicWrite(tokenPath, JSON.stringify(tokens, null, 2) + '\n');
  return tokenPath;
}
