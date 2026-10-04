import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  DEDUP_MARKS_FILENAME,
  persistDedupMark,
  resolveDedupMarksPath,
  restoreDedupMarks,
} from '../../src/runtime/dedup-marks.js';
import { SalterAdapter } from '../../src/scales/salter.js';
import type { ScaleAdapter } from '../../src/interfaces/scale-adapter.js';

/**
 * Review D-15: the Salter high-water mark has to outlive the process, or a
 * restart inside the adapter's five-minute age bound exports the last weigh-in
 * again. These run the real adapter over a captured record (salter.test.ts,
 * REC_897_SLOT2) through the same save and restore the runtime does.
 */
const REC_897_SLOT2 = Buffer.from('0200fa148a6a81033801e40162012100f4063601', 'hex');
const STAMP = REC_897_SLOT2.readUInt32LE(2);

/** The scale's clock reply, `ageSec` after the record's stamp. */
function clockAfter(ageSec: number): Buffer {
  const b = Buffer.alloc(5);
  b[0] = 0x02;
  b.writeUInt32LE(STAMP + ageSec, 1);
  return b;
}

/** One session's worth of frames: the clock read, then the record. */
function session(adapter: SalterAdapter, ageSec: number) {
  adapter.onSessionStart();
  adapter.parseNotification(clockAfter(ageSec));
  return adapter.parseNotification(REC_897_SLOT2);
}

describe('adapter de-duplication marks (D-15)', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dedup-marks-'));
    file = path.join(dir, DEDUP_MARKS_FILENAME);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('keeps a restarted process from exporting the same Salter weigh-in again', () => {
    const before = new SalterAdapter();
    expect(session(before, 20)).not.toBeNull();
    persistDedupMark(file, before as ScaleAdapter);

    const after = new SalterAdapter();
    restoreDedupMarks(file, [after as ScaleAdapter]);
    expect(session(after, 140)).toBeNull();
  });

  it('writes the file 0600, keyed by adapter name', () => {
    const a = new SalterAdapter();
    session(a, 20);
    persistDedupMark(file, a as ScaleAdapter);
    expect(JSON.parse(fs.readFileSync(file, 'utf-8'))).toEqual({ Salter: STAMP });
    // Windows does not model POSIX permission bits, so assert only where it means something.
    if (process.platform !== 'win32') {
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    }
  });

  it('leaves the other adapters stored in the file alone', () => {
    fs.writeFileSync(file, JSON.stringify({ Other: 7 }));
    const a = new SalterAdapter();
    session(a, 20);
    persistDedupMark(file, a as ScaleAdapter);
    expect(JSON.parse(fs.readFileSync(file, 'utf-8'))).toEqual({ Other: 7, Salter: STAMP });
  });

  it('writes nothing for an adapter that keeps no mark', () => {
    const plain = { name: 'Plain' } as ScaleAdapter;
    persistDedupMark(file, plain);
    restoreDedupMarks(file, [plain]);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('starts as before from a missing or corrupt file instead of failing', () => {
    const fresh = new SalterAdapter();
    restoreDedupMarks(file, [fresh as ScaleAdapter]);
    expect(fresh.dedupMark()).toBeUndefined();

    fs.writeFileSync(file, '{not json');
    restoreDedupMarks(file, [fresh as ScaleAdapter]);
    fs.writeFileSync(file, JSON.stringify({ Salter: 'x' }));
    restoreDedupMarks(file, [fresh as ScaleAdapter]);
    expect(fresh.dedupMark()).toBeUndefined();
    expect(session(fresh, 20)).not.toBeNull();
  });

  it('lives next to config.yaml', () => {
    const cfg = path.join(dir, 'config.yaml');
    expect(resolveDedupMarksPath(cfg)).toBe(file);
  });
});
