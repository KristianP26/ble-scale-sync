/**
 * Is the running Node.js one this release supports?
 *
 * `engines.node` in package.json names the supported versions, and npm only
 * warns about it at install time (EBADENGINE). run() asks this module for one
 * line to log at startup, and the Dockerfile asks it whether the image's own
 * Node.js passes, so neither repeats the versions.
 *
 * Understood ranges: alternatives joined by `||`, each exactly `^X.Y.Z` (X at
 * least 1) or `>=X.Y.Z`, for example `^20.1.2 || >=22.3.4`. The running
 * version must be semver `X.Y.Z` with an optional prerelease (`-rc.1`,
 * `-nightly...`), and a prerelease is judged the way npm judges it with
 * includePrerelease: just below its own `X.Y.Z`.
 *
 * Anything else, a range in another form or a version that is not semver,
 * gives no answer at all rather than a guess: a wrong warning is worse than
 * none. tests/runtime/node-version.test.ts parses the real engines.node, so a
 * range this module cannot read fails CI instead of going quiet in production.
 *
 * No imports and no process access, so dist/runtime/node-version.js also runs
 * on its own (the Dockerfile check).
 */

export interface EnginesLine {
  /** `^X.Y.Z`: from X.Y.Z up to the next major; otherwise `>=X.Y.Z`. */
  readonly caret: boolean;
  readonly min: readonly [number, number, number];
}

type Triple = readonly [number, number, number];

interface NodeVersion {
  readonly core: Triple;
  readonly pre: boolean;
}

// No leading zero, and at most 15 digits so Number stays exact.
const NUM = '(0|[1-9]\\d{0,14})';
// A semver 2.0.0 prerelease identifier: numeric without a leading zero, or alphanumeric.
const PRE_ID = '(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)';
const VERSION_RE = new RegExp(`^${NUM}\\.${NUM}\\.${NUM}(-${PRE_ID}(?:\\.${PRE_ID})*)?$`);
const LINE_RE = new RegExp(`^(\\^|>=)${NUM}\\.${NUM}\\.${NUM}$`);

function triple(m: RegExpExecArray, from: number): Triple {
  return [Number(m[from]), Number(m[from + 1]), Number(m[from + 2])];
}

function parseVersion(running: string): NodeVersion | undefined {
  const m = VERSION_RE.exec(running);
  return m ? { core: triple(m, 1), pre: m[4] !== undefined } : undefined;
}

/**
 * The alternatives of an engines range, or undefined when any part of it is
 * not understood. One unknown part voids the whole range instead of being
 * skipped: `^20.1.2 || 21.x` read as just `^20.1.2` would warn on 21.0.0,
 * which the range accepts.
 */
export function parseEnginesRange(range: unknown): EnginesLine[] | undefined {
  if (typeof range !== 'string') return undefined;
  const lines: EnginesLine[] = [];
  for (const part of range.split('||')) {
    const m = LINE_RE.exec(part.trim());
    if (!m) return undefined;
    const line: EnginesLine = { caret: m[1] === '^', min: triple(m, 2) };
    // ^0.y.z means something else in semver (no major to stay within).
    if (line.caret && line.min[0] === 0) return undefined;
    lines.push(line);
  }
  return lines;
}

function compare(a: Triple, b: Triple): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

/** Under the line's minimum; a prerelease of the minimum itself is under it too. */
function below(v: NodeVersion, line: EnginesLine): boolean {
  const c = compare(v.core, line.min);
  return c < 0 || (c === 0 && v.pre);
}

function accepts(line: EnginesLine, v: NodeVersion): boolean {
  return !below(v, line) && (!line.caret || v.core[0] === line.min[0]);
}

function plus(line: EnginesLine): string {
  return `${line.min.join('.')}+`;
}

function list(lines: readonly EnginesLine[]): string {
  const items = lines.map(plus);
  return items.length === 1
    ? items[0]
    : `${items.slice(0, -1).join(', ')} or ${items[items.length - 1]}`;
}

/**
 * One line to log when `running` (process.versions.node) does not satisfy
 * `range` (engines.node), or undefined when it does or when either one is in
 * a form this module does not read.
 */
export function nodeVersionWarning(running: string, range: unknown): string | undefined {
  const lines = parseEnginesRange(range);
  const v = typeof running === 'string' ? parseVersion(running) : undefined;
  if (!lines || !v) return undefined;
  if (lines.some((l) => accepts(l, v))) return undefined;

  // A line of the same major that does not accept the version is one it is
  // below, so "older" is true; name the lowest minimum of that major.
  const same = lines
    .filter((l) => l.min[0] === v.core[0])
    .reduce<EnginesLine | undefined>(
      (low, l) => (low === undefined || compare(l.min, low.min) < 0 ? l : low),
      undefined,
    );
  if (same) {
    return `Node.js ${running} is older than this release expects (${plus(same)}); update Node.js`;
  }
  if (lines.every((l) => below(v, l))) {
    return `Node.js ${running} is older than this release expects (${list(lines)}); update Node.js`;
  }
  // An odd line between two supported ones is not "older", and above lines
  // that are all ^ an update would be the wrong advice.
  return `Node.js ${running} is not supported by this release; use ${list(lines)}`;
}
