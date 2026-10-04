import type { AppConfig } from '../config/schema.js';
import { resolveTokenDir, STRAVA_DEFAULT_TOKEN_DIR } from '../config/token-dirs.js';

export interface StravaExporterEntry {
  type: 'strava';
  client_id: string;
  client_secret: string;
  token_dir?: string;
}

export type StravaSelection =
  { ok: true; entry: StravaExporterEntry; owner: string } | { ok: false; error: string };

/**
 * Pick the strava entry `setup-strava` should authorize.
 *
 * It used to take the first strava entry in the file, so in a multi-user
 * config the second user's entry could never be authorized at all. With more
 * than one entry the caller must now name the user (`--user <name or slug>`).
 */
export function selectStravaEntry(config: AppConfig, user?: string): StravaSelection {
  const found: { entry: StravaExporterEntry; owner: string; user?: AppConfig['users'][number] }[] =
    [];
  for (const e of config.global_exporters ?? []) {
    if (e.type === 'strava')
      found.push({ entry: e as unknown as StravaExporterEntry, owner: 'global' });
  }
  for (const u of config.users) {
    for (const e of u.exporters ?? []) {
      if (e.type === 'strava')
        found.push({ entry: e as unknown as StravaExporterEntry, owner: u.name, user: u });
    }
  }

  if (found.length === 0) {
    return {
      ok: false,
      error:
        'No Strava exporter found in config.yaml. Add a strava exporter to your config first, ' +
        'then run this script again.',
    };
  }

  if (user !== undefined) {
    const want = user.trim().toLowerCase();
    const match = found.find(
      (f) => f.user && (f.user.slug.toLowerCase() === want || f.user.name.toLowerCase() === want),
    );
    if (!match) {
      return { ok: false, error: `No Strava exporter configured for user '${user}'.` };
    }
    return { ok: true, entry: match.entry, owner: match.owner };
  }

  if (found.length > 1) {
    return {
      ok: false,
      error:
        `Several Strava exporters are configured (${found.map((f) => f.owner).join(', ')}). ` +
        'Name the one to authorize with --user <name or slug>.',
    };
  }
  return { ok: true, entry: found[0].entry, owner: found[0].owner };
}

/**
 * The directory `setup-strava` writes the selected entry's tokens to: its
 * `token_dir`, or the default, with a relative path taken from `configDir`,
 * the directory config.yaml is in. The exporter reads from exactly there, and
 * from nowhere that depends on the working directory (F-11).
 */
export function stravaTokenDir(entry: StravaExporterEntry, configDir: string): string {
  return resolveTokenDir(entry.token_dir?.trim() || STRAVA_DEFAULT_TOKEN_DIR, configDir);
}
