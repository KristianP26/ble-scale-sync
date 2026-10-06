import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stravaAuthStep } from '../../src/wizard/steps/strava-auth.js';
import type { WizardContext } from '../../src/wizard/types.js';
import type { AppConfig, UserConfig } from '../../src/config/schema.js';
import { scriptedPrompts, type ScriptedAnswer } from '../helpers/scripted-prompts.js';

function user(name: string, exporters: UserConfig['exporters']): UserConfig {
  return {
    name,
    slug: name.toLowerCase(),
    height: 175,
    birth_date: '1990-01-01',
    gender: 'male',
    is_athlete: false,
    weight_range: { min: 50, max: 100 },
    last_known_weight: null,
    exporters,
  };
}

describe('stravaAuthStep', () => {
  let dir: string;
  let out: string[];
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bss-strava-auth-'));
    out = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void out.push(a.join(' ')));
    fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ access_token: 'acc', refresh_token: 'ref', expires_at: 1234 }),
          { status: 200 },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  function ctxWith(config: Partial<AppConfig>, answers: Array<[RegExp, ScriptedAnswer]>) {
    const scripted = scriptedPrompts(answers);
    const ctx: WizardContext = {
      config,
      configPath: join(dir, 'config.yaml'),
      isEditMode: false,
      nonInteractive: false,
      platform: {
        os: 'linux',
        arch: 'x64',
        hasDocker: false,
        hasPython: false,
        pythonCommand: null,
      },
      prompts: scripted.prompts,
    };
    return { ctx, ...scripted };
  }

  it('runs only when a Strava exporter is configured', () => {
    const none = ctxWith({ users: [user('Alice', [{ type: 'file' }])] }, []).ctx;
    const one = ctxWith(
      { users: [user('Alice', [{ type: 'strava', client_id: '1', client_secret: 's' }])] },
      [],
    ).ctx;
    expect(stravaAuthStep.shouldRun!(none)).toBe(false);
    expect(stravaAuthStep.shouldRun!(one)).toBe(true);
  });

  // The wizard collected the client ID and secret and never authorized, so the
  // first weigh-in failed with "token file not found".
  it('exchanges the pasted code and writes the token file next to the config', async () => {
    vi.stubEnv('BSS_TEST_STRAVA_SECRET', 'real-secret');
    const { ctx } = ctxWith(
      {
        users: [
          user('Alice', [
            { type: 'strava', client_id: '42', client_secret: '${BSS_TEST_STRAVA_SECRET}' },
          ]),
        ],
      },
      [[/authorization code/, 'the-code']],
    );

    await stravaAuthStep.run(ctx);

    const tokenPath = join(dir, 'strava-tokens', 'strava_tokens.json');
    expect(JSON.parse(readFileSync(tokenPath, 'utf8'))).toEqual({
      access_token: 'acc',
      refresh_token: 'ref',
      expires_at: 1234,
    });
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ client_id: '42', client_secret: 'real-secret', code: 'the-code' });
    expect(out.join('\n')).toContain('client_id=42');
    // The config keeps the reference.
    expect((ctx.config.users![0].exporters![0] as { client_secret: string }).client_secret).toBe(
      '${BSS_TEST_STRAVA_SECRET}',
    );
  });

  it('asks for a new code after a refused exchange', async () => {
    fetchMock.mockResolvedValueOnce(new Response('bad code', { status: 400 }));
    const { ctx, asked } = ctxWith(
      { users: [user('Alice', [{ type: 'strava', client_id: '42', client_secret: 's' }])] },
      [
        [/authorization code/, 'used-code'],
        [/Try again/, true],
        [/authorization code/, 'fresh-code'],
      ],
    );

    await stravaAuthStep.run(ctx);

    expect(asked.filter((m) => /authorization code/.test(m))).toHaveLength(2);
    expect(out.join('\n')).toMatch(/HTTP 400/);
    expect(existsSync(join(dir, 'strava-tokens', 'strava_tokens.json'))).toBe(true);
  });

  it('skips on an empty code without calling Strava', async () => {
    const { ctx } = ctxWith(
      { users: [user('Alice', [{ type: 'strava', client_id: '42', client_secret: 's' }])] },
      [],
    );

    await stravaAuthStep.run(ctx);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(out.join('\n')).toMatch(/setup-strava/);
  });

  // The hint for a global entry among several was a bare setup-strava, which
  // refuses to pick one without --user, and --user cannot name a global entry.
  it('does not offer a setup-strava command that cannot select the entry', async () => {
    const { ctx } = ctxWith(
      {
        global_exporters: [
          { type: 'strava', client_id: '41', client_secret: 's', token_dir: './st/global' },
        ],
        users: [
          user('Alice', [
            { type: 'strava', client_id: '42', client_secret: 's', token_dir: './st/alice' },
          ]),
        ],
      },
      [
        [/^Authorize Strava now/, false],
        [/^Authorize Strava for Alice now/, false],
      ],
    );

    await stravaAuthStep.run(ctx);

    const text = out.join('\n');
    expect(text).toMatch(/can authorize a global Strava exporter only while it is the only/);
    expect(text).toMatch(/Run later with: .*setup-strava.* --user alice/);
    // Every command offered names the user.
    expect(text).not.toMatch(/Run later with: .*setup-strava$/m);
  });

  it('refuses two accounts sharing one token directory', async () => {
    const strava = { type: 'strava', client_id: '42', client_secret: 's' };
    const { ctx, asked } = ctxWith(
      { users: [user('Alice', [{ ...strava }]), user('Bob', [{ ...strava, client_id: '43' }])] },
      [],
    );

    await stravaAuthStep.run(ctx);

    expect(asked).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(out.join('\n')).toMatch(/same token directory/);
  });
});
