import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { fileURLToPath } from 'node:url';
import {
  CONFIG_PATH,
  END_MARKER,
  README_PATH,
  START_MARKER,
  applyGrid,
  classify,
  coAuthorsOf,
  countableCommits,
  findBlock,
  formatCount,
  guardChanges,
  parseConfig,
  parseGitLog,
  parseGrid,
  renderCell,
  renderGrid,
  resolveIdentities,
  sortContributors,
  tally,
  type Account,
  type ContributorsConfig,
  type Contributor,
  type GitCommit,
  type Lookup,
} from '../src/tools/sync-contributors.js';

/**
 * The contributors grid generator is tested on literal git log text and a fake
 * Lookup. The network is stubbed to throw, so a test that reached the real
 * GitHub API would fail instead of quietly depending on it.
 */
vi.stubGlobal('fetch', () => {
  throw new Error('network access in tests');
});

const TOOL_PATH = fileURLToPath(new URL('../src/tools/sync-contributors.ts', import.meta.url));

const sha = (n: number): string => n.toString(16).padStart(40, 'a');
const tree = (n: number): string => n.toString(16).padStart(40, 'b');

interface Rec {
  n: number;
  tree?: number;
  parents?: number[];
  name: string;
  email: string;
  date?: string;
  body?: string;
}

/** One record exactly as `git log --format=GIT_LOG_FORMAT` prints it. */
function rec(r: Rec): string {
  return (
    [
      sha(r.n),
      tree(r.tree ?? r.n),
      (r.parents ?? []).map(sha).join(' '),
      r.name,
      r.email,
      r.date ?? '2026-01-01T00:00:00+00:00',
      r.body ?? 'feat: something\n',
    ].join('\x1f') + '\x1e\n'
  );
}

/** Newest first, like git log. */
const log = (...recs: Rec[]): GitCommit[] => parseGitLog(recs.map(rec).join(''));

const CFG: ContributorsConfig = parseConfig(
  JSON.stringify({
    aliases: { 'milosz@example.com': 'Bretos' },
    ignore: { emails: ['noreply@anthropic.com'], logins: [] },
  }),
);

const acct = (id: number, login: string, type = 'User'): Account => ({ id, login, type });

/** Records every call so tests can assert which identities reached the API. */
function fakeLookup(data: {
  commits?: Record<string, Account | null>;
  users?: Record<string, Account | null>;
  ids?: Record<number, Account | null>;
}): Lookup & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async commitAuthor(s) {
      calls.push(`commit:${s.slice(-4)}`);
      return data.commits?.[s] ?? null;
    },
    async user(login) {
      calls.push(`user:${login}`);
      return data.users?.[login] ?? null;
    },
    async userById(id) {
      calls.push(`id:${id}`);
      return data.ids?.[id] ?? null;
    },
  };
}

// The last paragraph of b3239f8, byte for byte: git's trailer parser does not
// treat it as a trailer block because `Closes #354` is not a trailer.
const B3239F8_BODY = `fix(scales): something

Found by @JamieSBenson in #354. Taken as its own commit because that PR
also carries a height_unit reinterpretation and a package.json change
that cannot land with it.

Co-authored-by: Jamie Benson <21150960+JamieSBenson@users.noreply.github.com>
Closes #354
`;

describe('coAuthorsOf', () => {
  it('finds a co-author sharing a paragraph with Closes #N', () => {
    expect(coAuthorsOf(B3239F8_BODY)).toEqual([
      { name: 'Jamie Benson', email: '21150960+JamieSBenson@users.noreply.github.com' },
    ]);
  });

  it('matches any case and trims the name, but only whole lines with an address', () => {
    const body = [
      'feat: x',
      '',
      'Prose that mentions Co-authored-by: Someone <someone@example.com>',
      'Co-authored-by: no address here',
      '  Co-Authored-By:   Ada Lovelace   <ada@example.com>  ',
      'co-authored-by: Bob <bob@example.com>',
    ].join('\n');
    expect(coAuthorsOf(body)).toEqual([
      { name: 'Ada Lovelace', email: 'ada@example.com' },
      { name: 'Bob', email: 'bob@example.com' },
    ]);
  });
});

describe('parseGitLog and countableCommits', () => {
  it('parses records and rejects a record with the wrong field count', () => {
    const [c] = log({ n: 1, name: 'A', email: 'a@example.com', body: 'x\r\ny\n' });
    expect(c.sha).toBe(sha(1));
    expect(c.body).toBe('x\ny\n');
    expect(() => parseGitLog('a\x1fb\x1e\n')).toThrow(/fields/);
  });

  it('skips merge and empty commits, keeps the root commit', () => {
    const all = log(
      { n: 4, parents: [3, 2], name: 'M', email: 'm@example.com' },
      { n: 3, tree: 2, parents: [2], name: 'E', email: 'e@example.com' },
      { n: 2, parents: [1], name: 'B', email: 'b@example.com' },
      { n: 1, name: 'R', email: 'r@example.com' },
    );
    expect(countableCommits(all).map((c) => c.authorName)).toEqual(['B', 'R']);
  });

  it('rejects output cut off mid-record, a malformed sha and a missing parent', () => {
    const two =
      rec({ n: 2, parents: [1], name: 'B', email: 'b@example.com' }) +
      rec({ n: 1, name: 'R', email: 'r@example.com' });
    expect(() => parseGitLog(two.slice(0, -20))).toThrow(/after the last record/);
    expect(() =>
      parseGitLog(two.replace(sha(1), 'not-a-sha-but-forty-characters-long-xxxx')),
    ).toThrow(/Unexpected git log record/);
    // A shallow history: the oldest commit's parent is not in the log.
    expect(() =>
      countableCommits(log({ n: 2, parents: [1], name: 'B', email: 'b@example.com' })),
    ).toThrow(/missing/);
  });
});

describe('classify', () => {
  it('ignores bots by name or address and the ignore list before anything else', () => {
    expect(classify({ name: 'dependabot[bot]', email: 'x@example.com' }, CFG).kind).toBe('ignored');
    expect(
      classify({ name: 'GH', email: '41898282+github-actions[bot]@users.noreply.github.com' }, CFG)
        .kind,
    ).toBe('ignored');
    expect(classify({ name: 'Claude', email: 'noreply@anthropic.com' }, CFG).kind).toBe('ignored');
  });
});

describe('resolveIdentities and tally', () => {
  it('credits a co-author found only by the line parser (JamieSBenson, b3239f8)', async () => {
    const commits = countableCommits(
      log({ n: 1, name: 'Owner', email: 'owner@example.com', body: B3239F8_BODY }),
    );
    const lookup = fakeLookup({
      commits: { [sha(1)]: acct(1, 'Owner') },
      ids: { 21150960: acct(21150960, 'JamieSBenson') },
    });
    const people = tally(commits, await resolveIdentities(commits, CFG, lookup));
    expect(people.map((p) => p.login).sort()).toEqual(['JamieSBenson', 'Owner']);
  });

  it('counts a person once per commit (alias co-author, two addresses)', async () => {
    const commits = countableCommits(
      log(
        {
          n: 2,
          parents: [1],
          name: 'Aleksandr Martynov',
          email: 'boildead@example.com',
          body: 'fix: y\n\nCo-Authored-By: boildead <boildead@users.noreply.github.com>\n',
        },
        {
          n: 1,
          name: 'Bretos',
          email: 'bretos@example.com',
          body: 'feat: x\n\nCo-authored-by: Milosz <milosz@example.com>\n',
        },
      ),
    );
    const lookup = fakeLookup({
      commits: { [sha(1)]: acct(4947212, 'Bretos'), [sha(2)]: acct(17303016, 'boildead') },
    });
    const people = tally(commits, await resolveIdentities(commits, CFG, lookup));
    expect(people.map((p) => [p.login, p.commits])).toEqual([
      ['boildead', 1],
      ['Bretos', 1],
    ]);
    // The legacy noreply and the alias joined accounts already found, no request.
    expect(lookup.calls.filter((c) => c.startsWith('user:'))).toEqual([]);
  });

  it('never sends bots or ignored addresses to the API', async () => {
    const commits = countableCommits(
      log(
        {
          n: 2,
          parents: [1],
          name: 'dependabot[bot]',
          email: '49699333+dependabot[bot]@users.noreply.github.com',
        },
        {
          n: 1,
          name: 'Owner',
          email: 'owner@example.com',
          body: 'feat: x\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n',
        },
      ),
    );
    const lookup = fakeLookup({ commits: { [sha(1)]: acct(1, 'Owner') } });
    const res = await resolveIdentities(commits, CFG, lookup);
    expect(lookup.calls).toEqual([`commit:${sha(1).slice(-4)}`]);
    expect(tally(commits, res).map((p) => p.login)).toEqual(['Owner']);
  });

  it('asks the current login by id, joins legacy noreply by login, one commit per email', async () => {
    const commits = countableCommits(
      log(
        // Authors only a merge commit: never counted, so never looked up.
        { n: 6, parents: [5, 3], name: 'Merger', email: 'merger@example.com' },
        {
          n: 5,
          parents: [4],
          name: 'Old Name',
          email: '21150960+OldName@users.noreply.github.com',
        },
        { n: 4, parents: [3], name: 'Ann', email: 'ann@example.com' },
        { n: 3, parents: [2], name: 'Ann', email: 'ann@example.com' },
        { n: 2, parents: [1], name: 'Legacy', email: 'newname@users.noreply.github.com' },
        { n: 1, name: 'Junaid', email: 'junaidk@users.noreply.github.com' },
      ),
    );
    const lookup = fakeLookup({
      commits: { [sha(3)]: acct(10, 'Ann') },
      ids: { 21150960: acct(21150960, 'NewName') },
      users: { junaidk: acct(1422281, 'junaidk') },
    });
    const people = sortContributors(tally(commits, await resolveIdentities(commits, CFG, lookup)));
    expect(people.map((p) => [p.login, p.commits])).toEqual([
      ['Ann', 2],
      ['NewName', 2],
      ['junaidk', 1],
    ]);
    // Ann once, with her OLDEST counted commit; NewName by id; junaidk by login.
    expect(lookup.calls.sort()).toEqual(
      [`commit:${sha(3).slice(-4)}`, 'id:21150960', 'user:junaidk'].sort(),
    );
  });

  it('leaves out an account typed Bot even without [bot] in its login (Copilot)', async () => {
    const commits = countableCommits(
      log(
        {
          n: 2,
          parents: [1],
          name: 'Copilot',
          email: '198982749+Copilot@users.noreply.github.com',
        },
        { n: 1, name: 'Owner', email: 'owner@example.com' },
      ),
    );
    const lookup = fakeLookup({
      commits: { [sha(1)]: acct(1, 'Owner') },
      ids: { 198982749: acct(198982749, 'Copilot', 'Bot') },
    });
    const res = await resolveIdentities(commits, CFG, lookup);
    expect(tally(commits, res).map((p) => p.login)).toEqual(['Owner']);
    expect(res.unresolved).toEqual([]);
  });

  it('reports a co-author with a real address and no alias by name and sha, never email', async () => {
    const commits = countableCommits(
      log({
        n: 1,
        name: 'Owner',
        email: 'owner@example.com',
        body: 'feat: x\n\nCo-authored-by: Someone Else <someone@example.com>\n',
      }),
    );
    const lookup = fakeLookup({ commits: { [sha(1)]: acct(1, 'Owner') } });
    const res = await resolveIdentities(commits, CFG, lookup);
    expect(res.unresolved).toEqual([{ name: 'Someone Else', sha: sha(1).slice(0, 7) }]);
    expect(JSON.stringify(res.unresolved)).not.toContain('@');
  });

  it('leaves out a login listed under ignore.logins, ignoring case', async () => {
    const commits = countableCommits(
      log(
        { n: 2, parents: [1], name: 'Helper', email: 'helper@example.com' },
        { n: 1, name: 'Owner', email: 'owner@example.com' },
      ),
    );
    const lookup = fakeLookup({
      commits: { [sha(1)]: acct(1, 'Owner'), [sha(2)]: acct(2, 'Helper-Agent') },
    });
    const cfg = { ...CFG, ignore: { emails: [], logins: ['helper-agent'] } };
    const res = await resolveIdentities(commits, cfg, lookup);
    expect(tally(commits, res).map((p) => p.login)).toEqual(['Owner']);
  });

  it('fails on an alias to a login GitHub does not know', async () => {
    const commits = countableCommits(
      log({
        n: 1,
        name: 'Owner',
        email: 'owner@example.com',
        body: 'feat: x\n\nCo-authored-by: Milosz <milosz@example.com>\n',
      }),
    );
    const lookup = fakeLookup({ commits: { [sha(1)]: acct(1, 'Owner') } });
    await expect(resolveIdentities(commits, CFG, lookup)).rejects.toThrow(/alias target "Bretos"/);
  });

  it('rejects as a whole when a lookup fails', async () => {
    const commits = countableCommits(log({ n: 1, name: 'Owner', email: 'owner@example.com' }));
    const lookup: Lookup = {
      commitAuthor: () => Promise.reject(new Error('boom')),
      user: () => Promise.reject(new Error('boom')),
      userById: () => Promise.reject(new Error('boom')),
    };
    await expect(resolveIdentities(commits, CFG, lookup)).rejects.toThrow('boom');
  });
});

describe('sortContributors', () => {
  const c = (login: string, commits: number, date: string): Contributor => ({
    login,
    id: login.length,
    commits,
    firstContribution: Date.parse(date),
  });

  it('orders by count, then first contribution, then login ignoring case', () => {
    const input = [
      c('Zeta', 1, '2026-01-01T00:00:00Z'),
      c('amy', 3, '2026-03-01T00:00:00Z'),
      c('alpha', 1, '2026-01-01T00:00:00Z'),
      c('bob', 3, '2026-02-01T00:00:00Z'),
    ];
    expect(sortContributors(input).map((p) => p.login)).toEqual(['bob', 'amy', 'alpha', 'Zeta']);
  });

  it('compares first contributions as instants, not strings', async () => {
    const commits = countableCommits(
      log(
        {
          n: 2,
          parents: [1],
          name: 'Late',
          email: 'late@example.com',
          date: '2026-02-01T09:30:00+00:00',
        },
        { n: 1, name: 'Early', email: 'early@example.com', date: '2026-02-01T10:00:00+02:00' },
      ),
    );
    const lookup = fakeLookup({
      commits: { [sha(1)]: acct(1, 'zz-early'), [sha(2)]: acct(2, 'aa-late') },
    });
    const people = sortContributors(tally(commits, await resolveIdentities(commits, CFG, lookup)));
    expect(people.map((p) => p.login)).toEqual(['zz-early', 'aa-late']);
  });
});

describe('rendering', () => {
  it('formats counts', () => {
    expect(formatCount(1)).toBe('1 commit');
    expect(formatCount(2)).toBe('2 commits');
    expect(formatCount(1089)).toBe('1,089 commits');
  });

  it('renders the exact cell', () => {
    expect(renderCell({ login: 'KristianP26', id: 28766334, commits: 962 })).toBe(
      '<td align="center"><a href="https://github.com/KristianP26"><img src="https://avatars.githubusercontent.com/u/28766334?v=4" width="60" height="60" alt="KristianP26"><br><sub>KristianP26</sub></a><br><sub>962 commits</sub></td>',
    );
  });

  // Logins from the API go into the HTML unescaped, so the renderer checks them too.
  it('refuses to render a login GitHub would not allow or a bad id', () => {
    expect(() => renderCell({ login: 'a"><script>', id: 1, commits: 1 })).toThrow(/unexpected/);
    expect(() => renderCell({ login: 'ok', id: 0, commits: 1 })).toThrow(/unexpected/);
  });

  it('wraps full rows of eight with no empty row at the end', () => {
    const people = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ login: `u${i}`, id: i + 1, commits: 1 }));
    const rowBreaks = (s: string) => s.split('</tr><tr>').length - 1;
    const nine = renderGrid(people(9)).split('\n');
    expect(nine[0]).toBe('<table><tr>');
    expect(nine[9]).toBe('</tr><tr>');
    expect(nine.at(-1)).toBe('</tr></table>');
    expect(nine).toHaveLength(12);
    expect(rowBreaks(renderGrid(people(8)))).toBe(0);
    expect(rowBreaks(renderGrid(people(16)))).toBe(1);
    expect(renderGrid(people(16))).not.toContain('<tr>\n</tr>');
  });
});

describe('parseConfig', () => {
  it('rejects an alias to an invalid login, which would end up in the HTML', () => {
    expect(() => parseConfig('{"aliases": {"x@example.com": "a\\"><script>"}}')).toThrow(/alias/);
  });

  it('rejects unknown keys and loads the real config', () => {
    expect(() => parseConfig('{"alias": {}}')).toThrow(/unknown key/);
    const real = parseConfig(readFileSync(CONFIG_PATH, 'utf8'));
    expect(real.ignore.emails).toContain('noreply@anthropic.com');
  });
});

describe('README block', () => {
  const grid = renderGrid([{ login: 'a', id: 1, commits: 2 }]);
  const doc = (eol: string) =>
    ['# T', '', START_MARKER, '<table><tr>', 'old', '</tr></table>', END_MARKER, 'tail', ''].join(
      eol,
    );

  it('throws on a missing, repeated or reversed marker', () => {
    expect(() => findBlock('no markers')).toThrow(/exactly one/);
    expect(() => findBlock(`${START_MARKER}\n${START_MARKER}\n${END_MARKER}\n`)).toThrow(
      /exactly one/,
    );
    expect(() => findBlock(`${END_MARKER}\n${START_MARKER}\n`)).toThrow(/order/);
  });

  it('replaces only the block and keeps CRLF', () => {
    const crlf = doc('\r\n');
    const out = applyGrid(crlf, grid);
    expect(out.startsWith(`# T\r\n\r\n${START_MARKER}\r\n<table><tr>\r\n<td`)).toBe(true);
    expect(out.endsWith(`</tr></table>\r\n${END_MARKER}\r\ntail\r\n`)).toBe(true);
    expect(out.replace(/\r\n/g, '')).not.toContain('\n');
    expect(applyGrid(doc('\n'), grid)).toBe(out.replace(/\r\n/g, '\n'));
  });

  it('reads cells with and without the count', () => {
    const old =
      '<td align="center"><a href="https://github.com/x"><img src="https://avatars.githubusercontent.com/u/5?v=4" width="60" height="60" alt="x"><br><sub>x</sub></a></td>';
    expect(parseGrid(`<table><tr>\n${old}\n</tr></table>`)).toEqual([
      { login: 'x', id: 5, commits: null },
    ]);
    expect(parseGrid(renderGrid([{ login: 'y', id: 6, commits: 1089 }]))).toEqual([
      { login: 'y', id: 6, commits: 1089 },
    ]);
  });

  // A cell that does not parse would also escape the guard against dropping people.
  it('refuses a grid with a cell it cannot read', () => {
    const cell = renderCell({ login: 'y', id: 6, commits: 1 });
    expect(() => parseGrid(`<table><tr>\n${cell}\n<td>hand edit</td>\n</tr></table>`)).toThrow(
      /2 cells but only 1/,
    );
  });
});

// The counts themselves are not checked against the history here: the owner's
// count moves with every commit, so that check would fail after each one. This
// guards the shape, which is what a hand edit of the grid would break.
describe('README in the repository', () => {
  const readme = readFileSync(README_PATH, 'utf8').replace(/\r\n/g, '\n');

  it('carries the generated grid between the markers, exactly as rendered', () => {
    expect(readme).toContain(`\n${START_MARKER}\n`);
    expect(readme).toContain(`\n${END_MARKER}\n`);
    const { block } = findBlock(readme);
    const cells = parseGrid(block);
    expect(cells.length).toBeGreaterThan(0);
    const counted = cells.map((c) => ({ ...c, commits: c.commits ?? Number.NaN }));
    expect(counted.every((c) => Number.isInteger(c.commits))).toBe(true);
    expect(block).toBe(`${renderGrid(counted)}\n`);
  });

  it('is sorted by count, with unique logins and no bots', () => {
    const cells = parseGrid(findBlock(readme).block);
    const counts = cells.map((c) => c.commits ?? 0);
    expect(counts).toEqual([...counts].sort((a, b) => b - a));
    const logins = cells.map((c) => c.login.toLowerCase());
    expect(new Set(logins).size).toBe(logins.length);
    expect(logins.filter((l) => l.includes('[bot]'))).toEqual([]);
  });
});

describe('guardChanges', () => {
  const next: Contributor[] = [{ login: 'a', id: 1, commits: 5, firstContribution: 0 }];

  it('refuses to drop a person unless their login is ignored', () => {
    const old = [
      { login: 'a', id: 1, commits: 5 },
      { login: 'gone', id: 2, commits: 1 },
    ];
    expect(() => guardChanges(old, next, CFG)).toThrow(/gone would disappear/);
    const ignoring = { ...CFG, ignore: { emails: [], logins: ['Gone'] } };
    expect(() => guardChanges(old, next, ignoring)).not.toThrow();
  });

  it('refuses a lower count, accepts a first run without counts', () => {
    expect(() => guardChanges([{ login: 'a', id: 1, commits: 6 }], next, CFG)).toThrow(/drop/);
    expect(() => guardChanges([{ login: 'a', id: 1, commits: 6 }], next, CFG, true)).not.toThrow();
    expect(() => guardChanges([{ login: 'a', id: 1, commits: null }], next, CFG)).not.toThrow();
  });
});

describe('the generator source', () => {
  const src = readFileSync(TOOL_PATH, 'utf8');

  // CI runs it with bare `node` and no install, so a local or package import
  // would only fail at the next release. Network goes through global fetch,
  // which this file stubs.
  it('imports only node: builtins and no raw network module', () => {
    const specifiers = [...src.matchAll(/^import\s+(?:[^'"]*\sfrom\s+)?'([^']+)'/gm)].map(
      (m) => m[1],
    );
    expect(specifiers.length).toBeGreaterThan(0);
    for (const s of specifiers) {
      expect(s).toMatch(/^node:/);
      expect(['node:http', 'node:https', 'node:net']).not.toContain(s);
    }
    expect(src).not.toMatch(/\bimport\s*\(/);
  });

  it('uses only erasable TypeScript syntax', () => {
    expect(() => stripTypeScriptTypes(src, { mode: 'strip' })).not.toThrow();
  });
});
