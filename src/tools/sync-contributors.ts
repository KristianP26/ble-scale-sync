import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Generate the README Contributors grid from the git history.
 *
 * The grid used to be maintained by hand and kept falling behind: people whose
 * pull requests had been merged months earlier were missing from it. The
 * GitHub Contributors API is no substitute: it only sees the default branch,
 * ignores co-authors, counts merge commits and bots, and serves data that can be
 * hours old.
 *
 * Counting rule:
 *   - a commit counts unless it is a merge (more than one parent) or empty (its
 *     tree equals its parent's tree), which is how GitHub's own graph counts;
 *   - its people are the git author plus every `Co-authored-by:` line anywhere
 *     in the message, each person at most once per commit. Not git's trailer
 *     parser: it ignores a co-author line sharing a paragraph with `Closes #N`,
 *     which GitHub still credits;
 *   - bots (`[bot]` in a name, email or login, or a non-User account type) and
 *     identities listed under `ignore` in .github/contributors.json are never
 *     credited.
 *
 * Emails are mapped to GitHub accounts through the REST API (an `ID+login`
 * noreply address through GET /user/{id}, any other author email through the
 * commit it authored) plus the aliases in .github/contributors.json for
 * addresses GitHub cannot link. Emails are never printed.
 *
 * The grid is sorted by commit count, then by first contribution, then by login.
 * Only the block between the README markers is written.
 *
 *   npm run sync:contributors:check   report what would change (default, writes nothing)
 *   npm run sync:contributors         write the README
 *
 * Exit codes: 0 up to date or written; 1 error, nothing written; 2 (check) the
 * README is stale; 3 like 0, but an identity could not be resolved and is left
 * out until it gets an alias.
 *
 * This file imports only node: builtins and uses only erasable TypeScript, so
 * CI runs it with bare `node` and no install step.
 */

// Anchored to the module rather than the cwd, so the CLI and the vitest guard
// behave identically wherever they are invoked from.
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const README_PATH = path.join(REPO_ROOT, 'README.md');
export const CONFIG_PATH = path.join(REPO_ROOT, '.github', 'contributors.json');

export const START_MARKER =
  '<!-- contributors:start - generated from git history by src/tools/sync-contributors.ts, do not edit by hand -->';
export const END_MARKER = '<!-- contributors:end -->';
const START_PREFIX = '<!-- contributors:start';

/** Fields separated by US (0x1f), records terminated by RS (0x1e). */
export const GIT_LOG_FORMAT = '%H%x1f%T%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%B%x1e';

/** GitHub's login rule. Also what keeps a login safe to put into the HTML. */
const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const NOREPLY_ID_RE = /^(\d+)\+([^@\s]+)@users\.noreply\.github\.com$/;
const NOREPLY_LOGIN_RE = /^([^@\s+]+)@users\.noreply\.github\.com$/;
const CO_AUTHOR_RE = /^[ \t]*co-authored-by:[ \t]*(.+?)[ \t]*<([^<>\s]+)>[ \t]*$/gim;
const SHA_RE = /^[0-9a-f]{40}$/;

export interface GitCommit {
  sha: string;
  tree: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  authorDate: string;
  body: string;
}

export interface Signature {
  name: string;
  email: string;
}

export interface ContributorsConfig {
  aliases: Record<string, string>;
  ignore: { emails: string[]; logins: string[] };
}

export interface Account {
  id: number;
  login: string;
  type: string;
}

/** The only network surface. The REST implementation is never used in tests. */
export interface Lookup {
  /** Author account GitHub linked to a pushed commit, or null when it linked none. */
  commitAuthor(sha: string): Promise<Account | null>;
  user(login: string): Promise<Account | null>;
  userById(id: number): Promise<Account | null>;
}

export type Classified =
  | { kind: 'ignored' }
  | { kind: 'alias'; login: string }
  | { kind: 'noreply-id'; id: number }
  | { kind: 'noreply-login'; login: string }
  | { kind: 'email' };

export interface Unresolved {
  name: string;
  sha: string;
}

export interface Resolution {
  /** Lowercased email -> the human account it is credited to. */
  byEmail: Map<string, Account>;
  /** Lowercased emails deliberately never credited (bots, ignore list, non-User accounts). */
  excluded: Set<string>;
  unresolved: Unresolved[];
}

export interface Contributor {
  login: string;
  id: number;
  commits: number;
  /** Earliest author date among the person's counted commits, epoch ms. */
  firstContribution: number;
}

export interface GridCell {
  login: string;
  id: number;
  /** null for a cell written before the grid carried counts. */
  commits: number | null;
}

export function parseGitLog(raw: string): GitCommit[] {
  const text = raw.replace(/\r\n/g, '\n');
  const commits: GitCommit[] = [];
  const records = text.split('\x1e');
  for (let i = 0; i < records.length; i++) {
    // git ends every formatted record with a newline, so each record after the
    // first starts with one, and the tail after the last separator is just that.
    const record = records[i].replace(/^\n/, '');
    if (i === records.length - 1) {
      if (record.trim() !== '') throw new Error('Unexpected git log output after the last record');
      break;
    }
    const fields = record.split('\x1f');
    if (fields.length !== 7) {
      throw new Error(`Unexpected git log record with ${fields.length} fields (expected 7)`);
    }
    const [sha, tree, parents, authorName, authorEmail, authorDate, body] = fields;
    const parentList = parents === '' ? [] : parents.split(' ');
    if (!SHA_RE.test(sha) || !SHA_RE.test(tree) || !parentList.every((p) => SHA_RE.test(p))) {
      throw new Error(`Unexpected git log record near ${sha.slice(0, 12)}`);
    }
    if (Number.isNaN(Date.parse(authorDate))) {
      throw new Error(`Unexpected author date on ${sha.slice(0, 7)}`);
    }
    commits.push({ sha, tree, parents: parentList, authorName, authorEmail, authorDate, body });
  }
  return commits;
}

/** Drop merge commits and empty commits (tree identical to the only parent's). */
export function countableCommits(all: GitCommit[]): GitCommit[] {
  const treeOf = new Map(all.map((c) => [c.sha, c.tree]));
  return all.filter((c) => {
    if (c.parents.length > 1) return false;
    if (c.parents.length === 0) return true;
    const parentTree = treeOf.get(c.parents[0]);
    if (parentTree === undefined) {
      throw new Error(`Parent of ${c.sha.slice(0, 7)} is missing from the history`);
    }
    return parentTree !== c.tree;
  });
}

/**
 * Every `Co-authored-by: Name <email>` line anywhere in the message, matched
 * per line and case-insensitively, which is what GitHub credits.
 */
export function coAuthorsOf(body: string): Signature[] {
  const out: Signature[] = [];
  for (const m of body.replace(/\r\n/g, '\n').matchAll(CO_AUTHOR_RE)) {
    out.push({ name: m[1].trim(), email: m[2] });
  }
  return out;
}

export function parseConfig(json: string): ContributorsConfig {
  const data: unknown = JSON.parse(json);
  if (!isObject(data)) throw new Error('contributors.json: expected an object');
  for (const key of Object.keys(data)) {
    if (!['$comment', 'aliases', 'ignore'].includes(key)) {
      throw new Error(`contributors.json: unknown key "${key}"`);
    }
  }
  const aliases: Record<string, string> = {};
  const rawAliases = data.aliases ?? {};
  if (!isObject(rawAliases)) throw new Error('contributors.json: "aliases" must be an object');
  Object.entries(rawAliases).forEach(([email, login], index) => {
    // The address itself is never echoed, only its position.
    if (!email.includes('@') || email !== email.toLowerCase()) {
      throw new Error(`contributors.json: alias #${index + 1} needs a lowercase email address`);
    }
    if (typeof login !== 'string' || !LOGIN_RE.test(login)) {
      throw new Error(`contributors.json: alias #${index + 1} points to an invalid login`);
    }
    aliases[email] = login;
  });
  const rawIgnore = data.ignore ?? {};
  if (!isObject(rawIgnore)) throw new Error('contributors.json: "ignore" must be an object');
  for (const key of Object.keys(rawIgnore)) {
    if (!['emails', 'logins'].includes(key)) {
      throw new Error(`contributors.json: unknown key "ignore.${key}"`);
    }
  }
  const emails = stringList(rawIgnore.emails, 'ignore.emails');
  emails.forEach((email, index) => {
    if (!email.includes('@') || email !== email.toLowerCase()) {
      throw new Error(`contributors.json: ignore.emails #${index + 1} must be a lowercase address`);
    }
  });
  const logins = stringList(rawIgnore.logins, 'ignore.logins');
  for (const login of logins) {
    if (!LOGIN_RE.test(login)) throw new Error(`contributors.json: invalid login "${login}"`);
  }
  return { aliases, ignore: { emails, logins } };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringList(value: unknown, name: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) {
    throw new Error(`contributors.json: "${name}" must be a list of strings`);
  }
  return value;
}

/** Offline part of the identity decision; the API is only asked about the rest. */
export function classify(sig: Signature, cfg: ContributorsConfig): Classified {
  const email = sig.email.toLowerCase();
  if (sig.name.includes('[bot]') || email.includes('[bot]')) return { kind: 'ignored' };
  if (cfg.ignore.emails.includes(email)) return { kind: 'ignored' };
  const alias = cfg.aliases[email];
  if (alias !== undefined) return { kind: 'alias', login: alias };
  const withId = NOREPLY_ID_RE.exec(email);
  if (withId) return { kind: 'noreply-id', id: Number(withId[1]) };
  const legacy = NOREPLY_LOGIN_RE.exec(email);
  if (legacy) {
    // The login part of the address keeps the original case of the account.
    return { kind: 'noreply-login', login: NOREPLY_LOGIN_RE.exec(sig.email)?.[1] ?? legacy[1] };
  }
  return { kind: 'email' };
}

interface SeenEmail {
  sig: Signature;
  /** First commit (in log order) the address appears on, for reporting. */
  firstSeenSha: string;
  /** Oldest counted commit the address authored, or null for a co-author only. */
  oldestAuthoredSha: string | null;
}

/**
 * Map every author and co-author email of the counted commits to a GitHub
 * account. Lookups run sequentially in a fixed order, and a failing lookup
 * rejects the whole resolution: a partial result must never reach the README.
 */
export async function resolveIdentities(
  commits: GitCommit[],
  cfg: ContributorsConfig,
  lookup: Lookup,
): Promise<Resolution> {
  const seen = new Map<string, SeenEmail>();
  for (const c of commits) {
    const sigs = [{ name: c.authorName, email: c.authorEmail }, ...coAuthorsOf(c.body)];
    sigs.forEach((sig, index) => {
      const key = sig.email.toLowerCase();
      let entry = seen.get(key);
      if (!entry) {
        entry = { sig, firstSeenSha: c.sha, oldestAuthoredSha: null };
        seen.set(key, entry);
      }
      // git log lists newer commits first, so the last one seen is the oldest.
      if (index === 0) entry.oldestAuthoredSha = c.sha;
    });
  }

  const byEmail = new Map<string, Account>();
  const excluded = new Set<string>();
  const unresolved: Unresolved[] = [];
  const byId = new Map<number, Account | null>();
  const byLogin = new Map<string, Account | null>();
  const pending: { key: string; login: string; alias: boolean }[] = [];

  const remember = (account: Account | null): Account | null => {
    if (account) {
      byId.set(account.id, account);
      byLogin.set(account.login.toLowerCase(), account);
    }
    return account;
  };
  const credit = (key: string, entry: SeenEmail, account: Account | null): void => {
    if (account) byEmail.set(key, account);
    else unresolved.push({ name: entry.sig.name, sha: entry.firstSeenSha.slice(0, 7) });
  };

  for (const key of [...seen.keys()].sort()) {
    const entry = seen.get(key)!;
    const kind = classify(entry.sig, cfg);
    if (kind.kind === 'ignored') {
      excluded.add(key);
    } else if (kind.kind === 'alias' || kind.kind === 'noreply-login') {
      pending.push({ key, login: kind.login, alias: kind.kind === 'alias' });
    } else if (kind.kind === 'noreply-id') {
      if (!byId.has(kind.id)) byId.set(kind.id, remember(await lookup.userById(kind.id)));
      credit(key, entry, byId.get(kind.id)!);
    } else if (entry.oldestAuthoredSha) {
      credit(key, entry, remember(await lookup.commitAuthor(entry.oldestAuthoredSha)));
    } else {
      // A co-author with a real address and no alias: REST cannot map it.
      credit(key, entry, null);
    }
  }

  // Legacy noreply addresses and alias targets join an account already found
  // by login first, so they cost a request only when nothing matched.
  for (const { key, login, alias } of pending) {
    const lower = login.toLowerCase();
    if (!byLogin.has(lower)) byLogin.set(lower, remember(await lookup.user(login)));
    const account = byLogin.get(lower) ?? null;
    if (!account && alias) {
      throw new Error(`contributors.json: alias target "${login}" is not a GitHub account`);
    }
    credit(key, seen.get(key)!, account);
  }

  const ignoredLogins = new Set(cfg.ignore.logins.map((l) => l.toLowerCase()));
  for (const [key, account] of byEmail) {
    if (
      account.type !== 'User' ||
      account.login.includes('[bot]') ||
      ignoredLogins.has(account.login.toLowerCase())
    ) {
      byEmail.delete(key);
      excluded.add(key);
    }
  }
  return { byEmail, excluded, unresolved };
}

export function tally(commits: GitCommit[], resolution: Resolution): Contributor[] {
  const people = new Map<number, Contributor>();
  for (const c of commits) {
    const when = Date.parse(c.authorDate);
    const credited = new Map<number, Account>();
    for (const sig of [{ name: c.authorName, email: c.authorEmail }, ...coAuthorsOf(c.body)]) {
      const account = resolution.byEmail.get(sig.email.toLowerCase());
      if (account) credited.set(account.id, account);
    }
    for (const account of credited.values()) {
      const person = people.get(account.id);
      if (person) {
        person.commits++;
        person.firstContribution = Math.min(person.firstContribution, when);
      } else {
        people.set(account.id, {
          login: account.login,
          id: account.id,
          commits: 1,
          firstContribution: when,
        });
      }
    }
  }
  return [...people.values()];
}

/** Count descending, then first contribution ascending, then login ignoring case. */
export function sortContributors(list: Contributor[]): Contributor[] {
  return [...list].sort((a, b) => {
    if (a.commits !== b.commits) return b.commits - a.commits;
    if (a.firstContribution !== b.firstContribution) {
      return a.firstContribution - b.firstContribution;
    }
    // Plain code-unit comparison: localeCompare depends on ICU and the locale.
    const la = a.login.toLowerCase();
    const lb = b.login.toLowerCase();
    return la < lb ? -1 : la > lb ? 1 : 0;
  });
}

export function formatCount(n: number): string {
  const digits = String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${digits} ${n === 1 ? 'commit' : 'commits'}`;
}

export function renderCell(c: Pick<Contributor, 'login' | 'id' | 'commits'>): string {
  if (!LOGIN_RE.test(c.login) || !Number.isSafeInteger(c.id) || c.id <= 0) {
    throw new Error(`Refusing to render an unexpected account "${c.login}"`);
  }
  return (
    `<td align="center"><a href="https://github.com/${c.login}">` +
    `<img src="https://avatars.githubusercontent.com/u/${c.id}?v=4" width="60" height="60" alt="${c.login}">` +
    `<br><sub>${c.login}</sub></a><br><sub>${formatCount(c.commits)}</sub></td>`
  );
}

export function renderGrid(
  list: Pick<Contributor, 'login' | 'id' | 'commits'>[],
  perRow = 8,
): string {
  const lines = ['<table><tr>'];
  list.forEach((c, i) => {
    if (i > 0 && i % perRow === 0) lines.push('</tr><tr>');
    lines.push(renderCell(c));
  });
  lines.push('</tr></table>');
  return lines.join('\n');
}

/**
 * Split the README around the generated block. `before` ends with the start
 * marker line, `after` starts with the end marker. Never guesses: a missing,
 * repeated or reversed marker is an error.
 */
export function findBlock(readme: string): { before: string; block: string; after: string } {
  const starts = readme.split(START_PREFIX).length - 1;
  const ends = readme.split(END_MARKER).length - 1;
  if (starts !== 1 || ends !== 1) {
    throw new Error(
      `README needs exactly one contributors start and end marker (found ${starts} and ${ends})`,
    );
  }
  const start = readme.indexOf(START_PREFIX);
  const startLineEnd = readme.indexOf('\n', start);
  const end = readme.indexOf(END_MARKER);
  if (startLineEnd === -1 || end < startLineEnd) {
    throw new Error('README contributors markers are out of order');
  }
  return {
    before: readme.slice(0, startLineEnd + 1),
    block: readme.slice(startLineEnd + 1, end),
    after: readme.slice(end),
  };
}

/** Read the cells of the current grid, with or without the count line. */
export function parseGrid(block: string): GridCell[] {
  const cells: GridCell[] = [];
  const re =
    /<td align="center"><a href="https:\/\/github\.com\/([^"]+)"><img src="https:\/\/avatars\.githubusercontent\.com\/u\/(\d+)\?v=4"[^>]*><br><sub>[^<]*<\/sub><\/a>(?:<br><sub>([\d,]+) commits?<\/sub>)?<\/td>/g;
  for (const m of block.matchAll(re)) {
    cells.push({
      login: m[1],
      id: Number(m[2]),
      commits: m[3] === undefined ? null : Number(m[3].replace(/,/g, '')),
    });
  }
  const tds = block.split('<td').length - 1;
  if (tds !== cells.length) {
    throw new Error(`README contributors grid has ${tds} cells but only ${cells.length} parse`);
  }
  return cells;
}

/**
 * Refuse a result that drops someone from the grid or lowers a count. Either is
 * far more likely to be an API outage, a wrong ref or a bug than a real change.
 */
export function guardChanges(
  old: GridCell[],
  next: Contributor[],
  cfg: ContributorsConfig,
  allowDecrease = false,
): void {
  const ignored = new Set(cfg.ignore.logins.map((l) => l.toLowerCase()));
  const nextById = new Map(next.map((c) => [c.id, c]));
  const problems: string[] = [];
  for (const cell of old) {
    const now = nextById.get(cell.id);
    if (!now) {
      if (!ignored.has(cell.login.toLowerCase())) {
        problems.push(`${cell.login} would disappear from the grid`);
      }
    } else if (cell.commits !== null && now.commits < cell.commits && !allowDecrease) {
      problems.push(`${cell.login} would drop from ${cell.commits} to ${now.commits}`);
    }
  }
  if (problems.length > 0) {
    throw new Error(
      `Refusing to rewrite the contributors grid:\n  ${problems.join('\n  ')}\n` +
        'Add an alias or an ignore entry to .github/contributors.json, or pass ' +
        '--allow-decrease for an intended drop.',
    );
  }
}

/** Replace the block between the markers, keeping the file's line endings. */
export function applyGrid(readme: string, grid: string): string {
  const { before, after } = findBlock(readme);
  const eol = readme.includes('\r\n') ? '\r\n' : '\n';
  return before + grid.split('\n').join(eol) + eol + after;
}

export function describeChanges(old: GridCell[], next: Contributor[]): string[] {
  const oldById = new Map(old.map((c) => [c.id, c]));
  const nextIds = new Set(next.map((c) => c.id));
  const lines: string[] = [];
  for (const c of next) {
    const before = oldById.get(c.id);
    if (!before) lines.push(`+ ${c.login} ${c.commits}`);
    else if (before.commits !== c.commits) {
      lines.push(`${c.login} ${before.commits ?? '?'} -> ${c.commits}`);
    }
  }
  for (const c of old) if (!nextIds.has(c.id)) lines.push(`- ${c.login}`);
  return lines;
}

/* ------------------------------------------------------------------------ */
/* CLI                                                                      */
/* ------------------------------------------------------------------------ */

class RestLookup implements Lookup {
  private readonly api: string;
  private readonly repo: string;
  private readonly token: string | undefined;

  constructor(api: string, repo: string, token: string | undefined) {
    this.api = api.replace(/\/+$/, '');
    this.repo = repo;
    this.token = token;
  }

  async commitAuthor(sha: string): Promise<Account | null> {
    const data = await this.get(`/repos/${this.repo}/commits?sha=${sha}&per_page=1`);
    if (!Array.isArray(data) || data.length === 0) return null;
    const first: unknown = data[0];
    if (!isObject(first) || first.sha !== sha) return null;
    return first.author === null ? null : toAccount(first.author);
  }

  async user(login: string): Promise<Account | null> {
    const data = await this.get(`/users/${encodeURIComponent(login)}`);
    return data === null ? null : toAccount(data);
  }

  async userById(id: number): Promise<Account | null> {
    const data = await this.get(`/user/${id}`);
    return data === null ? null : toAccount(data);
  }

  /** null for 404 and 422 (unknown commit or account); throws on anything else. */
  private async get(route: string): Promise<unknown> {
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'ble-scale-sync-contributors',
    };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    for (let attempt = 1; ; attempt++) {
      let res: Response;
      try {
        res = await fetch(this.api + route, { headers, signal: AbortSignal.timeout(15_000) });
      } catch (err) {
        if (attempt < 2) {
          await sleep(2000);
          continue;
        }
        throw new Error(`GitHub API unreachable: ${err instanceof Error ? err.message : err}`);
      }
      if (res.ok) return res.json();
      if (res.status === 404 || res.status === 422) return null;
      if (
        (res.status === 403 || res.status === 429) &&
        res.headers.get('x-ratelimit-remaining') === '0'
      ) {
        const reset = Number(res.headers.get('x-ratelimit-reset'));
        const when = Number.isFinite(reset) ? new Date(reset * 1000).toISOString() : 'unknown';
        throw new Error(`GitHub API rate limit exhausted, resets at ${when}`);
      }
      if (res.status >= 500 && attempt < 2) {
        await sleep(2000);
        continue;
      }
      throw new Error(`GitHub API ${res.status} for ${route.split('?')[0]}`);
    }
  }
}

function toAccount(value: unknown): Account {
  if (
    !isObject(value) ||
    typeof value.id !== 'number' ||
    typeof value.login !== 'string' ||
    typeof value.type !== 'string'
  ) {
    throw new Error('Unexpected account shape in a GitHub API response');
  }
  return { id: value.id, login: value.login, type: value.type };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function git(args: string[]): string {
  return execFileSync('git', ['-C', REPO_ROOT, '-c', 'log.showSignature=false', ...args], {
    encoding: 'utf8',
    // The full history is over 1 MiB, the default, and would be cut short.
    maxBuffer: 256 * 1024 * 1024,
  });
}

async function main(argv: string[]): Promise<number> {
  const write = argv.includes('write');
  const allowDecrease = argv.includes('--allow-decrease');
  const inActions = process.env.GITHUB_ACTIONS === 'true';
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || undefined;

  if (git(['rev-parse', '--is-shallow-repository']).trim() === 'true') {
    throw new Error('Needs the full git history (actions/checkout fetch-depth: 0)');
  }
  const cfg = parseConfig(readFileSync(CONFIG_PATH, 'utf8'));
  const readme = readFileSync(README_PATH, 'utf8');
  const old = parseGrid(findBlock(readme).block.replace(/\r\n/g, '\n'));
  // The anonymous limit is per IP, and hosted runners share theirs.
  if (inActions && !token) throw new Error('GITHUB_TOKEN is required in GitHub Actions');

  // Pinned once, so the summary names the commit that was actually counted.
  const head = git(['rev-parse', 'HEAD']).trim();
  const commits = countableCommits(
    parseGitLog(git(['log', '--no-color', `--format=${GIT_LOG_FORMAT}`, head])),
  );
  const lookup = new RestLookup(
    process.env.GITHUB_API_URL || 'https://api.github.com',
    process.env.GITHUB_REPOSITORY || 'KristianP26/ble-scale-sync',
    token,
  );
  const resolution = await resolveIdentities(commits, cfg, lookup);
  const next = sortContributors(tally(commits, resolution));
  if (next.length === 0) throw new Error('No contributors found; refusing to write an empty grid');
  guardChanges(old, next, cfg, allowDecrease);

  const updated = applyGrid(readme, renderGrid(next));
  const changes = describeChanges(old, next);
  for (const line of changes) console.log(line);
  console.log(`${commits.length} commits on HEAD ${head.slice(0, 7)}, ${next.length} contributors`);

  let status = 0;
  if (updated !== readme) {
    if (write) {
      writeFileSync(README_PATH, updated, 'utf8');
      console.log('Wrote README.md');
    } else {
      console.error('README.md contributors grid is stale. Run: npm run sync:contributors');
      status = 2;
    }
  } else {
    console.log('README.md contributors grid is up to date');
  }

  if (resolution.unresolved.length > 0) {
    for (const u of resolution.unresolved) {
      const msg = `Unresolved identity ${u.name} (${u.sha}); add an alias to .github/contributors.json`;
      console.error(msg);
      if (inActions) console.log(`::warning::${msg}`);
    }
    if (status === 0) status = 3;
  }
  return status;
}

// Only run as a CLI, so importing this module in tests has no side effects.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    },
  );
}
