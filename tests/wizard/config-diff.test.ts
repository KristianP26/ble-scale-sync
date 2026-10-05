import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  MASK,
  UNREADABLE_LINE,
  isSecretKey,
  renderConfigDiff,
} from '../../src/wizard/config-diff.js';
import { EXPORTER_SCHEMAS } from '../../src/exporters/registry.js';

const BASE = `version: 1
scale:
  weight_unit: kg
  height_unit: cm
users:
  - name: Alice
    slug: alice
    height: 175
  - name: Bob
    slug: bob
    height: 180
global_exporters:
  - type: file
    file_path: ./measurements.csv
`;

/** BASE with `extra` appended under global_exporters. */
function withExporter(extra: string): string {
  return BASE + extra;
}

function text(lines: string[] | null): string {
  return (lines ?? []).join('\n');
}

describe('renderConfigDiff', () => {
  it('returns null when nothing changed, whatever the formatting and comments', () => {
    const reformatted = BASE.replace('weight_unit: kg', "weight_unit: 'kg' # metric").replace(
      /\n/g,
      '\r\n',
    );
    expect(renderConfigDiff(BASE, BASE)).toBeNull();
    expect(renderConfigDiff(BASE, reformatted)).toBeNull();
  });

  it('shows a changed setting by its path, old and new value', () => {
    expect(renderConfigDiff(BASE, BASE.replace('weight_unit: kg', 'weight_unit: lbs'))).toEqual([
      '~ scale.weight_unit: kg -> lbs',
    ]);
  });

  it('keys users by slug, so removing one user does not shift the next', () => {
    const after = BASE.replace('  - name: Alice\n    slug: alice\n    height: 175\n', '').replace(
      'height: 180',
      'height: 181',
    );
    expect(renderConfigDiff(BASE, after)).toEqual([
      '- users[alice].name: Alice',
      '- users[alice].slug: alice',
      '- users[alice].height: 175',
      '~ users[bob].height: 180 -> 181',
    ]);
  });

  it('labels users by index when slugs are not unique', () => {
    const dup = BASE.replace('slug: bob', 'slug: alice');
    expect(renderConfigDiff(dup, dup.replace('height: 180', 'height: 181'))).toEqual([
      '~ users[1].height: 180 -> 181',
    ]);
  });

  it('lists every setting of an added or removed exporter, labelled with its type', () => {
    const after = withExporter('  - type: mqtt\n    broker_url: mqtt://broker.lan:1883\n');
    expect(renderConfigDiff(BASE, after)).toEqual([
      '+ global_exporters[1:mqtt].type: mqtt',
      '+ global_exporters[1:mqtt].broker_url: mqtt://broker.lan:1883',
    ]);
    expect(renderConfigDiff(after, BASE)).toEqual([
      '- global_exporters[1:mqtt].type: mqtt',
      '- global_exporters[1:mqtt].broker_url: mqtt://broker.lan:1883',
    ]);
  });

  it('follows the order of the new config, removed settings where they were', () => {
    const before = 'a: 1\nb: 2\nc: 3\n';
    const after = 'c: 30\nz: 0\na: 1\n';
    expect(renderConfigDiff(before, after)).toEqual(['~ c: 3 -> 30', '+ z: 0', '- b: 2']);
  });

  it('shows a whole scalar list as one value', () => {
    expect(renderConfigDiff('l: [a, b]\n', 'l: [a, b, c]\n')).toEqual(['~ l: [a, b] -> [a, b, c]']);
  });

  it('shows a type change of a setting as removed and added leaves', () => {
    expect(renderConfigDiff('a: 1\n', 'a:\n  b: 2\n')).toEqual(['- a: 1', '+ a.b: 2']);
  });

  it('treats an empty file as having no settings', () => {
    expect(renderConfigDiff('', 'a: 1\n')).toEqual(['+ a: 1']);
  });

  it('masks a secret and shows a changed one as (changed)', () => {
    const before = withExporter('  - type: ntfy\n    token: old-plain-token\n');
    const after = withExporter('  - type: ntfy\n    token: new-plain-token\n');
    const out = renderConfigDiff(before, after);
    expect(out).toEqual(['~ global_exporters[1:ntfy].token: (changed)']);
    expect(renderConfigDiff(BASE, after)).toContain(`+ global_exporters[1:ntfy].token: ${MASK}`);
  });

  it('shows a ${VAR} reference, it names the secret without revealing it', () => {
    const before = withExporter('  - type: garmin\n    password: hunter2-secret\n');
    const after = withExporter("  - type: garmin\n    password: '${GARMIN_PASSWORD}'\n");
    expect(renderConfigDiff(before, after)).toEqual([
      `~ global_exporters[1:garmin].password: ${MASK} -> \${GARMIN_PASSWORD}`,
    ]);
  });

  it('masks the local part of an email', () => {
    expect(renderConfigDiff('', 'email: alice.smith@example.com\n')).toEqual([
      '+ email: a***@example.com',
    ]);
  });

  it('truncates a long value and keeps it on one line', () => {
    const out = renderConfigDiff('', `title: "${'x'.repeat(100)}"\nmulti: "one\\ntwo"\n`)!;
    expect(out[0]).toBe(`+ title: ${'x'.repeat(60)}...`);
    expect(out[1]).toBe('+ multi: one\\ntwo');
  });

  it('caps a long list of changes', () => {
    const many = Array.from({ length: 300 }, (_, i) => `k${i}: ${i}`).join('\n');
    const out = renderConfigDiff('', many, { maxLines: 10 })!;
    expect(out).toHaveLength(11);
    expect(out[10]).toBe('... 290 more change(s) not shown');
  });

  it('says the changes cannot be shown when a side does not parse, without quoting it', () => {
    const broken = 'password: [unclosed-SECRET\nother: x\n';
    expect(renderConfigDiff(BASE, broken)).toEqual([UNREADABLE_LINE]);
    expect(renderConfigDiff(broken, BASE)).toEqual([UNREADABLE_LINE]);
    expect(renderConfigDiff('- just\n- a list\n', BASE)).toEqual([UNREADABLE_LINE]);
  });
});

describe('isSecretKey', () => {
  it.each(['password', 'client_secret', 'bot_token', 'api_key', 'encryption_key', 'bind_key'])(
    '%s is secret',
    (key) => expect(isSecretKey(key)).toBe(true),
  );
  it.each(['beurer_pin', 'token', 'topic', 'Authorization', 'X-Auth-Token', 'headers', 'cookie'])(
    '%s is secret',
    (key) => expect(isSecretKey(key)).toBe(true),
  );
  it.each(['weight_unit', 'url', 'email', 'slug', 'type'])('%s is not secret', (key) =>
    expect(isSecretKey(key)).toBe(false),
  );
});

/**
 * Each of these got a secret past the line-based mask that came before the
 * structural diff. The diff is printed to a terminal whose scrollback ends up
 * pasted into public issues, so every case asserts that the secret does not
 * appear ANYWHERE in the output.
 */
describe('renderConfigDiff leak regressions', () => {
  it.each([
    [
      'a webhook headers string',
      "  - type: webhook\n    url: https://example.com/hook\n    headers: 'Authorization: Bearer HDRSTRSECRET, X-Other: v'\n",
      'HDRSTRSECRET',
    ],
    [
      'a headers mapping with a custom header name',
      '  - type: webhook\n    url: https://example.com/hook\n    headers:\n      X-Gotify-Key: GOTIFYSECRET\n',
      'GOTIFYSECRET',
    ],
    [
      'a quoted secret containing " #"',
      "  - type: garmin\n    password: 'abc #QUOTEDTAILSECRET'\n",
      'QUOTEDTAILSECRET',
    ],
    [
      'a Slack webhook URL',
      '  - type: webhook\n    url: https://hooks.slack.com/services/T000/B000/SLACKSECRET\n',
      'SLACKSECRET',
    ],
    [
      'a Discord webhook URL',
      '  - type: webhook\n    url: https://discord.com/api/webhooks/1234/DISCORDSECRET\n',
      'DISCORDSECRET',
    ],
    [
      'a Home Assistant webhook URL',
      '  - type: webhook\n    url: http://homeassistant.local:8123/api/webhook/HAHOOKSECRET\n',
      'HAHOOKSECRET',
    ],
    [
      'an ntfy URL with ?auth=',
      '  - type: ntfy\n    url: https://ntfy.example.com/scale?auth=NTFYAUTHSECRET\n    topic: scale\n',
      'NTFYAUTHSECRET',
    ],
    [
      'a token as URL userinfo',
      '  - type: webhook\n    url: https://TOKENUSERSECRET@example.com/hook\n',
      'TOKENUSERSECRET',
    ],
    [
      'a user:password URL',
      '  - type: mqtt\n    broker_url: mqtt://user:MQTTPASSSECRET@broker.lan:1883\n',
      'MQTTPASSSECRET',
    ],
    [
      'a block scalar password',
      '  - type: garmin\n    password: |\n      BLOCKSECRET\n',
      'BLOCKSECRET',
    ],
    [
      'a password on the next line',
      '  - type: garmin\n    password:\n      NEXTLINESECRET\n',
      'NEXTLINESECRET',
    ],
    [
      'a flow map password',
      '  - { type: mqtt, broker_url: "mqtt://broker.lan", password: FLOWSECRET }\n',
      'FLOWSECRET',
    ],
  ])('never prints %s', (_name, extra, secret) => {
    const added = renderConfigDiff(BASE, withExporter(extra));
    const removed = renderConfigDiff(withExporter(extra), BASE);
    expect(added).not.toBeNull();
    expect(text(added)).not.toContain(secret);
    expect(text(removed)).not.toContain(secret);
  });

  it('never prints a secret reached through an anchor and an alias', () => {
    // The anchor must come before its alias, so it sits in an earlier, harmless key.
    const anchored = `x-shared: &pw ALIASSECRET\n${BASE}  - type: garmin\n    password: *pw\n`;
    const out = renderConfigDiff(BASE, anchored);
    expect(out).not.toBeNull();
    expect(text(out)).not.toContain('ALIASSECRET');
  });

  it('never prints a commented-out password, and a comment alone is no change', () => {
    const after = BASE.replace(
      '    file_path: ./measurements.csv\n',
      '    file_path: ./measurements.csv\n    # password: COMMENTEDSECRET\n',
    );
    const out = renderConfigDiff(BASE, after);
    expect(text(out)).not.toContain('COMMENTEDSECRET');
    expect(out).toBeNull();
  });

  it('does not report a byte order mark as a change', () => {
    expect(renderConfigDiff(String.fromCharCode(0xfeff) + BASE, BASE)).toBeNull();
  });

  it('masks every password-type field of every exporter schema', () => {
    const entries = EXPORTER_SCHEMAS.map((s) => {
      const fields = s.fields
        .filter((f) => f.type === 'password')
        .map((f) => `    ${f.key}: PWLEAK-${s.name}-${f.key}\n`);
      return `  - type: ${s.name}\n${fields.join('')}`;
    });
    const out = renderConfigDiff(BASE, withExporter(entries.join('')));
    expect(out).not.toBeNull();
    expect(text(out)).not.toContain('PWLEAK');
  });
});

describe('renderConfigDiff masks a password field added to a schema later', () => {
  afterEach(() => {
    vi.doUnmock('../../src/exporters/registry.js');
    vi.resetModules();
  });

  it('takes the secret keys from the schemas, not from a hand-kept list', async () => {
    vi.resetModules();
    vi.doMock('../../src/exporters/registry.js', async (importOriginal) => {
      const real = await importOriginal<typeof import('../../src/exporters/registry.js')>();
      return {
        ...real,
        EXPORTER_SCHEMAS: [
          ...real.EXPORTER_SCHEMAS,
          { name: 'future', fields: [{ key: 'frobnicator', type: 'password' }] },
        ],
      };
    });
    const fresh = await import('../../src/wizard/config-diff.js');
    const out = fresh.renderConfigDiff(
      BASE,
      withExporter('  - type: future\n    frobnicator: FUTURESECRET\n'),
    );
    expect(out).not.toBeNull();
    expect(text(out)).not.toContain('FUTURESECRET');
  });
});
