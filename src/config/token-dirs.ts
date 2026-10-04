import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';

/** The Strava token directory when an entry sets none (registry, strava-setup). */
export const STRAVA_DEFAULT_TOKEN_DIR = './strava-tokens';

/** `dir` with a leading `~` (alone or before a separator) replaced by the home directory. */
export function expandHome(dir: string, home: string = homedir()): string {
  return dir === '~' || /^~[/\\]/.test(dir) ? home + dir.slice(1) : dir;
}

/**
 * Where a configured `token_dir` points: `~` expanded, and a relative path
 * taken from the directory config.yaml is in, never from the working
 * directory (F-11).
 *
 * Every consumer has to agree on this. The setup used to resolve a relative
 * path against wherever it was started and the Garmin uploader against the
 * package directory, so after an npm install `./garmin-tokens` meant two
 * different directories and uploads found no token. An absolute path is
 * returned as written.
 */
export function resolveTokenDir(dir: string, configDir: string): string {
  const expanded = expandHome(dir);
  return isAbsolute(expanded) ? expanded : resolve(configDir, expanded);
}

/**
 * Exporters that keep an account's auth tokens in a directory on disk.
 *
 * Two entries for DIFFERENT accounts must not share that directory. If they
 * do, whichever account authenticated last owns the token file, and every
 * other entry silently uploads into that account: one person's weight and
 * body composition end up in someone else's Garmin or Strava. That is exactly
 * what a multi-user config without `token_dir` used to produce, since every
 * entry fell back to the same default.
 */
const TOKEN_EXPORTERS: Record<string, { label: string; defaultDir: () => string }> = {
  // garmin_upload.py: --token-dir, else $TOKEN_DIR, else ~/.garmin_tokens.
  garmin: {
    label: 'Garmin',
    defaultDir: () => process.env.TOKEN_DIR?.trim() || '~/.garmin_tokens',
  },
  // registry.ts and strava-setup.ts both default to ./strava-tokens.
  strava: { label: 'Strava', defaultDir: () => STRAVA_DEFAULT_TOKEN_DIR },
};

interface EntryLike {
  type: string;
  [key: string]: unknown;
}

interface ConfigLike {
  users: { name: string; slug: string; exporters?: EntryLike[] }[];
  global_exporters?: EntryLike[];
}

export interface TokenDirCollision {
  /** Exporter type, e.g. 'garmin'. */
  type: string;
  /** Path of the second entry that reuses a directory, for the config error. */
  path: (string | number)[];
  message: string;
}

/**
 * The account an entry authenticates as, when the config says so. Garmin
 * entries name it with `email`; two entries for the same email may share a
 * directory, since they are the same account. Strava entries carry no account
 * identity, so any two of them sharing a directory are a collision.
 */
function accountOf(type: string, entry: EntryLike): string | undefined {
  if (type !== 'garmin' || typeof entry.email !== 'string') return undefined;
  const email = entry.email.trim().toLowerCase();
  return email || undefined;
}

/**
 * Entries of different accounts that share a token directory.
 *
 * `configDir` is the directory config.yaml is in: paths are compared exactly
 * as `resolveTokenDir` resolves them for the exporters and the setup, so an
 * absolute path and a relative one that name the same directory collide.
 */
export function findTokenDirCollisions(
  config: ConfigLike,
  configDir: string = process.cwd(),
): TokenDirCollision[] {
  const located: { owner: string; path: (string | number)[]; entry: EntryLike }[] = [];
  (config.global_exporters ?? []).forEach((entry, i) =>
    located.push({ owner: 'global_exporters', path: ['global_exporters', i], entry }),
  );
  config.users.forEach((user, ui) =>
    (user.exporters ?? []).forEach((entry, ei) =>
      located.push({
        owner: `user '${user.name}'`,
        path: ['users', ui, 'exporters', ei],
        entry,
      }),
    ),
  );

  const out: TokenDirCollision[] = [];
  const seen = new Map<string, { owner: string; account: string | undefined }>();
  for (const { owner, path, entry } of located) {
    const spec = TOKEN_EXPORTERS[entry.type];
    if (!spec) continue;
    const configured = typeof entry.token_dir === 'string' ? entry.token_dir.trim() : '';
    const dir = configured || spec.defaultDir();
    const key = `${entry.type}\0${resolve(resolveTokenDir(dir, configDir))}`;
    const account = accountOf(entry.type, entry);
    const first = seen.get(key);
    if (!first) {
      seen.set(key, { owner, account });
      continue;
    }
    if (first.account !== undefined && first.account === account) continue;
    out.push({
      type: entry.type,
      path: [...path, 'token_dir'],
      message:
        `${spec.label} exporters of ${first.owner} and ${owner} use the same token directory ` +
        `'${dir}'${configured ? '' : ' (the default, token_dir is not set)'}. ` +
        'Whichever account authenticates last would receive the readings of both. ' +
        'Give each one its own token_dir, e.g. ' +
        `'./${entry.type}-tokens/<user-slug>', then run the setup for each user again.`,
    });
  }
  return out;
}

/**
 * The config with every Garmin and Strava `token_dir` made absolute against
 * the directory config.yaml is in (`resolveTokenDir`), so the exporters, the
 * retry queue and a reload all see the directory the setup wrote to, whatever
 * the working directory. A Strava entry without `token_dir` gets its default
 * resolved the same way; a Garmin entry without one is left to the uploader's
 * own default (`$TOKEN_DIR`, else `~/.garmin_tokens`).
 */
export function resolveConfigTokenDirs<C extends ConfigLike>(config: C, configDir: string): C {
  const fix = <E extends EntryLike>(entry: E): E => {
    if (!(entry.type in TOKEN_EXPORTERS)) return entry;
    const configured = typeof entry.token_dir === 'string' ? entry.token_dir.trim() : '';
    if (!configured && entry.type !== 'strava') return entry;
    const dir = configured || STRAVA_DEFAULT_TOKEN_DIR;
    return { ...entry, token_dir: resolveTokenDir(dir, configDir) };
  };
  const out: C = {
    ...config,
    users: config.users.map((u) => (u.exporters ? { ...u, exporters: u.exporters.map(fix) } : u)),
  };
  if (config.global_exporters) out.global_exporters = config.global_exporters.map(fix);
  return out;
}
