import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// Data from a peer is parsed in one place, src/ble/peer-input.ts, which checks
// size and shape and never lets `null` or an array through as an object (ADR
// D108). A second JSON.parse under src/ble would bring back the class of defect
// where a `null` frame throws inside a listener that nothing catches. This is a
// structural guard for the same reason as scan-result-name-escaped.test.ts: the
// risk is a transport added later that forgets, not a logic error in one.

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

describe('JSON from a peer', () => {
  it('is parsed only in src/ble/peer-input.ts', () => {
    const offenders = sourceFiles(BLE_DIR)
      .filter((f) => /JSON\.parse\(/.test(readFileSync(f, 'utf8')))
      .map((f) => relative(BLE_DIR, f));
    expect(offenders).toEqual(['peer-input.ts']);
  });

  it('guards every message listener of the MQTT proxy handler with guardedListener', () => {
    const dir = join(BLE_DIR, 'handler-mqtt-proxy');
    const lacking = sourceFiles(dir)
      .map((f) => {
        const text = readFileSync(f, 'utf8');
        return {
          file: relative(BLE_DIR, f),
          listeners: (text.match(/\.on\('message'/g) ?? []).length,
          guards: (text.match(/guardedListener\(/g) ?? []).length,
        };
      })
      .filter((f) => f.guards < f.listeners);
    expect(lacking).toEqual([]);
  });
});
