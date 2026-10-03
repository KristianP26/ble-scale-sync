import { homedir } from 'node:os';
import { resolve } from 'node:path';

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
  strava: { label: 'Strava', defaultDir: () => './strava-tokens' },
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

function normaliseDir(dir: string): string {
  const expanded = dir === '~' || /^~[/\\]/.test(dir) ? homedir() + dir.slice(1) : dir;
  return resolve(expanded);
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

export function findTokenDirCollisions(config: ConfigLike): TokenDirCollision[] {
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
    const key = `${entry.type}\0${normaliseDir(dir)}`;
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
