import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// A device-supplied name reaches a terminal through ScanResult, and nothing
// downstream escapes it: `npm run scan` prints `r.name` (src/scan.ts), and the
// wizard's device picker puts it in a console.log, a confirm prompt and an
// inquirer choice label (src/wizard/steps/ble.ts). So the escaping has to
// happen where each transport BUILDS the ScanResult.
//
// This is a structural guard rather than a behavioural test because the defect
// is a rollout gap, not a logic error: two separate rounds declared the
// safeName rollout complete and both were wrong, the second time missing
// node-ble, which is the default transport on Linux. A per-transport unit test
// would not have caught the transport nobody remembered to write a test for.
// This fails for any transport added later that forgets.

const BLE_DIR = join(process.cwd(), 'src', 'ble');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (entry.endsWith('.ts')) out.push(p);
  }
  return out;
}

// A ScanResult literal always carries `matchedAdapter:` next to `name:`, so
// pair them up rather than trusting either alone. `name: string;` in an
// interface and a `matchedAdapter` function parameter both look similar on one
// line and neither is a construction site.
function scanResultNameLines(file: string): Array<{ line: string; no: number }> {
  const lines = readFileSync(file, 'utf8').split('\n');
  const out: Array<{ line: string; no: number }> = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    // A value assignment inside an object literal, not a type annotation.
    if (!/^name:\s+\S.*,$/.test(line)) continue;
    // The sibling field within a few lines is what makes it a ScanResult.
    const near = lines.slice(Math.max(0, i - 4), i + 5).join('\n');
    if (!near.includes('matchedAdapter:')) continue;
    out.push({ line, no: i + 1 });
  }
  return out;
}

describe('ScanResult name escaping', () => {
  const producers = sourceFiles(BLE_DIR).filter((f) => scanResultNameLines(f).length > 0);

  it('finds every transport that builds a ScanResult', () => {
    // Guards the guard: if this drops, the assertions below go vacuous. Five
    // transports scan - noble, node-ble, esphome-proxy, mqtt-proxy and
    // ha-bluetooth.
    expect(producers.length).toBe(5);
  });

  it.each(producers)('%s escapes the name it puts in a ScanResult', (file) => {
    for (const { line, no } of scanResultNameLines(file)) {
      expect(`${file}:${no} ${line}`).toContain('safeName(');
    }
  });
});
