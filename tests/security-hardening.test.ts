import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, statSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicWrite } from '../src/config/write.js';
import { safeName } from '../src/ble/advertisement.js';

// Defects found in a security review of src/. Each test names the attacker and
// asserts the specific thing that used to go wrong, not a general property.

const ESC = String.fromCharCode(0x1b);

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'bss-sec-'));
  dirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('atomicWrite file mode', () => {
  // config.yaml holds the Garmin password and every exporter token in plaintext.
  // The wizard chmods it 0600 once, at save time - but updateLastKnownWeight()
  // calls atomicWrite on every non-dry weigh-in, and the rename replaced the
  // file along with its mode. The first export after setup therefore made the
  // credentials readable by any other local user, permanently.
  //
  // Attacker: another UID on the same host - a second user on a shared Pi, or a
  // sidecar container sharing the volume.
  it.skipIf(process.platform === 'win32')('keeps a 0600 target at 0600 when rewritten', () => {
    const dir = tempDir();
    const file = join(dir, 'config.yaml');
    writeFileSync(file, 'version: 1\n', { mode: 0o600 });
    expect(statSync(file).mode & 0o777).toBe(0o600);

    atomicWrite(file, 'version: 1\nusers: []\n');

    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, 'utf8')).toContain('users: []');
  });

  it.skipIf(process.platform === 'win32')('creates a new file 0600, not 0644', () => {
    const dir = tempDir();
    const file = join(dir, 'fresh.yaml');
    atomicWrite(file, 'version: 1\n');
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});

describe('safeName', () => {
  // The BLE local name arrives unfiltered from anyone with a radio in range, or
  // from anyone who can publish to a proxy topic, and it is logged for EVERY
  // advertisement seen during a scan - matched or not, so nothing gates it. A
  // crafted name carrying CR/LF forges log lines in journald or docker logs,
  // which is exactly what reporters are asked to paste into public issues.
  it('escapes CR and LF so a crafted name cannot forge a log line', () => {
    const forged = 'Scale\r\n[FAKE] Matched: Garmin (00:11:22:33:44:55)';
    const out = safeName(forged);
    expect(out).not.toContain('\n');
    expect(out).not.toContain('\r');
    expect(out).toContain('\\x0d\\x0a');
  });

  it('escapes ANSI escape sequences so a log cannot rewrite the terminal', () => {
    const out = safeName(`Scale${ESC}[2J${ESC}]0;pwned`);
    expect(out).not.toContain(ESC);
    expect(out).toContain('\\x1b');
  });

  it('escapes NUL and DEL', () => {
    const out = safeName(`a${String.fromCharCode(0)}b${String.fromCharCode(0x7f)}c`);
    expect(out).toBe('a\\x00b\\x7fc');
  });

  // C1 controls: xterm-family terminals honour U+009B as CSI and U+009D as OSC
  // even in UTF-8 mode, and a BLE name is UTF-8 decoded by every stack, so the
  // two-byte encoding arrives intact. A C0-only class lets these straight
  // through.
  it('escapes the C1 controls, including the 8-bit CSI and OSC introducers', () => {
    const out = safeName(`Scale${String.fromCharCode(0x9b)}2J${String.fromCharCode(0x9d)}0;x`);
    expect(out).not.toContain(String.fromCharCode(0x9b));
    expect(out).not.toContain(String.fromCharCode(0x9d));
    expect(out).toContain('\\x9b');
    expect(out).toContain('\\x9d');
  });

  // Anything that splits on Unicode newlines rather than on LF treats these as
  // line breaks, so they can still break a pasted log line apart.
  it('escapes the Unicode line and paragraph separators', () => {
    const out = safeName(`a${String.fromCharCode(0x2028)}b${String.fromCharCode(0x2029)}c`);
    expect(out).toBe('a\\u2028b\\u2029c');
  });

  // Without escaping the escape character, a name containing the four literal
  // characters \x0a renders identically to one containing a real LF - so the
  // "stays distinguishable" property the function claims would not hold.
  it('escapes the backslash so an escaped name is unambiguous', () => {
    // Escaped through the same \xNN form as everything else in the class, so a
    // real LF and a literal "\x0a" can never render alike.
    expect(safeName('a\nb')).toBe('a\\x0ab');
    expect(safeName('a\\x0ab')).toBe('a\\x5cx0ab');
    expect(safeName('a\\x0ab')).not.toBe(safeName('a\nb'));
  });

  it('leaves an ordinary name untouched, multibyte included', () => {
    expect(safeName('QN-Scale')).toBe('QN-Scale');
    expect(safeName('Vaha c. 2 µ')).toBe('Vaha c. 2 µ');
  });

  it('maps a missing name to the empty string', () => {
    expect(safeName(undefined)).toBe('');
    expect(safeName('')).toBe('');
  });
});
