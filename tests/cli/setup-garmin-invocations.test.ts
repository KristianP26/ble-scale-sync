import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * Every place that ships a `setup_garmin.py` command line has to pass only
 * arguments its argparse accepts. The add-on passed the config path
 * positionally for months, argparse rejected it, and the add-on's Garmin login
 * never ran for anyone (#435). Nothing executes run.sh in CI, so this reads the
 * invocations and the parser definition as text.
 */
const script = readFileSync('garmin-scripts/setup_garmin.py', 'utf8');

/** `--flag` -> whether it takes a value (anything but store_true). */
const flags = new Map<string, boolean>();
for (const m of script.matchAll(/add_argument\(\s*"(--[\w-]+)"([^)]*)\)/g)) {
  flags.set(m[1], !/action="store_true"/.test(m[2]));
}

const SOURCES = ['ble-scale-sync-addon/run.sh', 'docker-entrypoint.sh'];

function invocations(): Array<{ source: string; args: string[] }> {
  const out: Array<{ source: string; args: string[] }> = [];
  for (const source of SOURCES) {
    for (const line of readFileSync(source, 'utf8').split('\n')) {
      if (line.trim().startsWith('#')) continue; // prose in comments, not a command
      const m = line.match(/setup_garmin\.py((?:\s+(?:"[^"]*"|[^\s;"|&]+))*)/);
      if (!m) continue;
      const args = [...m[1].matchAll(/"[^"]*"|[^\s"]+/g)].map((a) => a[0]);
      out.push({ source, args });
    }
  }
  return out;
}

describe('setup_garmin.py invocations (#435)', () => {
  it('finds the parser flags and the shipped invocations', () => {
    expect(flags.get('--from-config')).toBe(false);
    expect(flags.get('--config-path')).toBe(true);
    expect(invocations().some((i) => i.source.endsWith('run.sh'))).toBe(true);
  });

  it('passes only arguments argparse accepts, and no positional ones', () => {
    for (const { source, args } of invocations()) {
      for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '"$@"') continue; // the entrypoint forwards the user's own arguments
        expect(flags.has(a), `${source}: unexpected argument ${a} in ${args.join(' ')}`).toBe(true);
        if (flags.get(a)) i++; // skip its value
      }
    }
  });
});
