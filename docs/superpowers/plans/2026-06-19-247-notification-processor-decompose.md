# #247 Decompose `waitForRawReading` into NotificationProcessor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the history-buffer and completion-hold-timer concerns out of the `waitForRawReading` god-closure into named, independently unit-tested state machines, and route per-frame ACK writes through a characteristics-aware write-resolver so `characteristics[]`-only adapters can ack.

**Architecture:** New `src/ble/notification-processor.ts` holds two pure state machines — `HistoryBuffer` (cached-frame buffering with the 500-cap warn) and `HoldTimer` (the `completionHoldMs`/`isFinal` hold window). `src/ble/shared.ts` gains an exported `resolveWriteChar(charMap, adapter)` that finds the write characteristic from the adapter's `characteristics[]` write binding, falling back to the legacy `charWriteUuid`/`altCharWriteUuid`. `waitForRawReading` is rewired to compose these three pieces, so it reads as subscribe -> process -> resolve wiring with no nested mutable state.

**Tech Stack:** TypeScript (strict, ES2022, Node16, ESM with `.js` import specifiers), Vitest, Prettier, ESLint.

## Global Constraints

- ES Modules: `"type": "module"`, all relative imports use the `.js` extension.
- TypeScript strict, ES2022, Node16. Must pass `npx tsc --noEmit`.
- Prettier: semicolons, single quotes, trailing commas, 100 char width. Must pass `npx prettier --check`.
- ESLint typescript-eslint recommended; `_` prefix for intentionally unused vars. Must pass `npm run lint`.
- Never use an em dash or a double dash in code, comments, commits, or docs.
- Kill node processes before any npm command: `taskkill //F //IM node.exe` (bash).
- NEVER `git add -A` in this repo (it stages untracked `docs/superpowers/plans/*.md`). Use explicit `git add <files>`.
- Conventional Commits. This refactor is hidden from the public CHANGELOG by release-please config, but still use `refactor(ble): ...`.
- Behavior must be byte-for-byte preserved for every existing adapter. The existing `tests/ble/shared.test.ts` suite is the regression net and MUST stay green with zero edits to existing test bodies.

---

## File Structure

- `src/ble/notification-processor.ts` (CREATE) — `HistoryBuffer` + `HoldTimer` classes. Pure: no char-map, no BLE library objects, only `ScaleReading` + `bleLog`.
- `src/ble/shared.ts` (MODIFY) — add exported `resolveWriteChar`; rewire `waitForRawReading` to use `HistoryBuffer`, `HoldTimer`, `resolveWriteChar`. Remove the inline `history`/`historyCapWarned`/`holdTimer`/`heldReading`/`clearHold`/`ackWriteChar` locals.
- `tests/ble/notification-processor.test.ts` (CREATE) — isolated unit tests for `HistoryBuffer` + `HoldTimer`.
- `tests/ble/shared.test.ts` (MODIFY, additive only) — add `resolveWriteChar` unit tests + one integration test proving ACK routes through a `characteristics[]` write binding.

Why a new file: criterion 1 of the issue requires the buffer and hold-timer to be "extracted and unit-tested in isolation." Keeping them out of `shared.ts` (which depends on the BLE char map) lets the tests construct them directly with no GATT-session promise scaffolding.

Why `resolveWriteChar` stays in `shared.ts`: it needs the module-private `resolveChar(charMap, uuid)` helper and the `BleChar` type. Putting it in `notification-processor.ts` would force a circular import (`shared` <-> `notification-processor`). The two extracted state machines are pure and need neither, so they live in the new file and `shared.ts` imports them (one-way dependency, no cycle).

---

### Task 1: Extract `HistoryBuffer`

**Files:**
- Create: `src/ble/notification-processor.ts`
- Test: `tests/ble/notification-processor.test.ts`

**Interfaces:**
- Consumes: `ScaleReading` from `../interfaces/scale-adapter.js`; `bleLog` from `./types.js`.
- Produces:
  - `class HistoryBuffer`
    - `constructor(max: number, adapterName: string)`
    - `push(reading: ScaleReading): boolean` — buffers the frame and returns `true`; at capacity returns `false` and warns exactly once via `bleLog.warn`.
    - `get length(): number`
    - `popLatest(): ScaleReading | undefined` — removes and returns the newest buffered frame.
    - `snapshot(): ScaleReading[] | undefined` — defensive copy of remaining frames, or `undefined` when empty.

- [ ] **Step 1: Write the failing tests**

Create `tests/ble/notification-processor.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { HistoryBuffer, HoldTimer } from '../../src/ble/notification-processor.js';
import { bleLog } from '../../src/ble/types.js';
import type { ScaleReading } from '../../src/interfaces/scale-adapter.js';

afterEach(() => {
  vi.restoreAllMocks();
});

const reading = (weight: number): ScaleReading => ({ weight, impedance: 400, timestamp: new Date(0) });

describe('HistoryBuffer', () => {
  it('buffers frames under the cap and reports length', () => {
    const buf = new HistoryBuffer(3, 'TestScale');
    expect(buf.push(reading(70))).toBe(true);
    expect(buf.push(reading(71))).toBe(true);
    expect(buf.length).toBe(2);
  });

  it('snapshot returns a defensive copy, undefined when empty', () => {
    const buf = new HistoryBuffer(3, 'TestScale');
    expect(buf.snapshot()).toBeUndefined();
    buf.push(reading(70));
    const snap = buf.snapshot()!;
    expect(snap).toHaveLength(1);
    snap.push(reading(99));
    expect(buf.length).toBe(1); // internal array not mutated by the snapshot
  });

  it('popLatest removes and returns the newest frame', () => {
    const buf = new HistoryBuffer(3, 'TestScale');
    buf.push(reading(70));
    buf.push(reading(71));
    expect(buf.popLatest()?.weight).toBe(71);
    expect(buf.length).toBe(1);
  });

  it('drops frames over the cap and warns exactly once', () => {
    const warnSpy = vi.spyOn(bleLog, 'warn').mockImplementation(() => {});
    const buf = new HistoryBuffer(2, 'TestScale');
    expect(buf.push(reading(70))).toBe(true);
    expect(buf.push(reading(71))).toBe(true);
    expect(buf.push(reading(72))).toBe(false);
    expect(buf.push(reading(73))).toBe(false);
    expect(buf.length).toBe(2);
    const capWarns = warnSpy.mock.calls.filter((a) => String(a[0] ?? '').includes('Cached frame buffer hit 2'));
    expect(capWarns).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/ble/notification-processor.test.ts`
Expected: FAIL — `HistoryBuffer`/`HoldTimer` not exported (module not found).

- [ ] **Step 3: Write the minimal implementation**

Create `src/ble/notification-processor.ts`:

```ts
import type { ScaleReading } from '../interfaces/scale-adapter.js';
import { bleLog } from './types.js';

/**
 * Buffers cached/offline historical frames dumped during a single GATT session,
 * oldest first, with a hard cap that protects a long-lived continuous-mode
 * process from a misbehaving scale or runaway cache replay. The cap warning is
 * emitted exactly once per buffer instance.
 */
export class HistoryBuffer {
  private readonly frames: ScaleReading[] = [];
  private capWarned = false;

  constructor(
    private readonly max: number,
    private readonly adapterName: string,
  ) {}

  /**
   * Buffer a historical frame. Returns true when stored, false when the cap is
   * already reached (in which case the frame is dropped and a single warning is
   * emitted across the buffer's lifetime).
   */
  push(reading: ScaleReading): boolean {
    if (this.frames.length >= this.max) {
      if (!this.capWarned) {
        bleLog.warn(
          `Cached frame buffer hit ${this.max}, dropping further historical readings ` +
            `from ${this.adapterName}. Misbehaving scale or runaway cache replay?`,
        );
        this.capWarned = true;
      }
      return false;
    }
    this.frames.push(reading);
    return true;
  }

  get length(): number {
    return this.frames.length;
  }

  /** Remove and return the newest buffered frame (disconnect-without-live path). */
  popLatest(): ScaleReading | undefined {
    return this.frames.pop();
  }

  /** Defensive copy of the remaining frames, or undefined when empty. */
  snapshot(): ScaleReading[] | undefined {
    return this.frames.length > 0 ? this.frames.slice() : undefined;
  }
}
```

- [ ] **Step 4: Run the tests to verify the HistoryBuffer block passes**

Run: `npx vitest run tests/ble/notification-processor.test.ts -t HistoryBuffer`
Expected: PASS (4 tests). The `HoldTimer` describe block will still fail to import until Task 2; that is expected.

- [ ] **Step 5: Commit**

```bash
taskkill //F //IM node.exe || true
git add src/ble/notification-processor.ts tests/ble/notification-processor.test.ts
git commit -m "refactor(ble): extract HistoryBuffer from waitForRawReading (#247)"
```

---

### Task 2: Extract `HoldTimer`

**Files:**
- Modify: `src/ble/notification-processor.ts`
- Test: `tests/ble/notification-processor.test.ts` (add `HoldTimer` describe block)

**Interfaces:**
- Consumes: `ScaleReading`; `bleLog`.
- Produces:
  - `class HoldTimer`
    - `constructor(holdMs: number, onElapsed: (reading: ScaleReading) => void)`
    - `hold(reading: ScaleReading): void` — records the reading as the held one; arms the timer on the FIRST call only (subsequent calls update the held reading but do not re-arm), and logs the "Weight stable; holding..." info line on arming.
    - `get heldReading(): ScaleReading | null`
    - `clear(): void` — cancels the timer if armed; leaves the held reading intact (disconnect-during-hold path reads it afterwards).

- [ ] **Step 1: Write the failing tests**

Append to `tests/ble/notification-processor.test.ts`:

```ts
describe('HoldTimer', () => {
  it('arms once, fires onElapsed with the held reading after holdMs', () => {
    vi.useFakeTimers();
    try {
      const onElapsed = vi.fn();
      const t = new HoldTimer(15000, onElapsed);
      t.hold(reading(83));
      expect(onElapsed).not.toHaveBeenCalled();
      vi.advanceTimersByTime(15000);
      expect(onElapsed).toHaveBeenCalledTimes(1);
      expect(onElapsed.mock.calls[0][0].weight).toBe(83);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a second hold updates the held reading without re-arming the timer', () => {
    vi.useFakeTimers();
    try {
      const onElapsed = vi.fn();
      const t = new HoldTimer(15000, onElapsed);
      t.hold(reading(83));
      vi.advanceTimersByTime(10000);
      t.hold(reading(84)); // must NOT reset the 15s window
      expect(t.heldReading?.weight).toBe(84);
      vi.advanceTimersByTime(5000); // 15s since first hold
      expect(onElapsed).toHaveBeenCalledTimes(1);
      expect(onElapsed.mock.calls[0][0].weight).toBe(84);
    } finally {
      vi.useRealTimers();
    }
  });

  it('clear cancels the timer but keeps the held reading', () => {
    vi.useFakeTimers();
    try {
      const onElapsed = vi.fn();
      const t = new HoldTimer(15000, onElapsed);
      t.hold(reading(83));
      t.clear();
      vi.advanceTimersByTime(15000);
      expect(onElapsed).not.toHaveBeenCalled();
      expect(t.heldReading?.weight).toBe(83);
    } finally {
      vi.useRealTimers();
    }
  });

  it('heldReading is null before any hold', () => {
    const t = new HoldTimer(15000, vi.fn());
    expect(t.heldReading).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify the HoldTimer block fails**

Run: `npx vitest run tests/ble/notification-processor.test.ts -t HoldTimer`
Expected: FAIL — `HoldTimer is not a constructor` / not exported.

- [ ] **Step 3: Write the minimal implementation**

Append to `src/ble/notification-processor.ts`:

```ts
/**
 * Implements the `completionHoldMs` window: after a non-final complete reading,
 * keep the link open for up to `holdMs` so a richer frame (e.g. bioimpedance
 * composition sent a few seconds after the weight settles) can arrive. The
 * timer is armed once on the first held reading; later holds only update which
 * reading resolves when the window elapses. On timeout `onElapsed` receives the
 * most recently held reading.
 */
export class HoldTimer {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private held: ScaleReading | null = null;

  constructor(
    private readonly holdMs: number,
    private readonly onElapsed: (reading: ScaleReading) => void,
  ) {}

  hold(reading: ScaleReading): void {
    this.held = reading;
    if (this.timer) return;
    bleLog.info(
      `Weight stable; holding connection up to ` +
        `${Math.round(this.holdMs / 1000)}s for body composition...`,
    );
    this.timer = setTimeout(() => {
      this.timer = null;
      const r = this.held;
      if (r) this.onElapsed(r);
    }, this.holdMs);
  }

  get heldReading(): ScaleReading | null {
    return this.held;
  }

  clear(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
```

- [ ] **Step 4: Run the full new test file to verify it passes**

Run: `npx vitest run tests/ble/notification-processor.test.ts`
Expected: PASS (all HistoryBuffer + HoldTimer tests).

- [ ] **Step 5: Commit**

```bash
taskkill //F //IM node.exe || true
git add src/ble/notification-processor.ts tests/ble/notification-processor.test.ts
git commit -m "refactor(ble): extract HoldTimer from waitForRawReading (#247)"
```

---

### Task 3: Add the characteristics-aware `resolveWriteChar`

**Files:**
- Modify: `src/ble/shared.ts` (add exported function near `resolveChar`, around line 58-60)
- Test: `tests/ble/shared.test.ts` (add a `resolveWriteChar()` describe block; import the new symbol)

**Interfaces:**
- Consumes: module-private `resolveChar(charMap, uuid)`; `BleChar`, `ScaleAdapter`.
- Produces:
  - `export function resolveWriteChar(charMap: Map<string, BleChar>, adapter: ScaleAdapter): BleChar | undefined`
    - If `adapter.characteristics` is defined and contains a `type: 'write'` binding whose UUID resolves in the map, return that char.
    - Otherwise fall back to `resolveChar(charMap, adapter.charWriteUuid)`, then `adapter.altCharWriteUuid`.
    - Returns `undefined` when no write char can be resolved (no throw).

- [ ] **Step 1: Write the failing tests**

Add to `tests/ble/shared.test.ts`. First extend the import on line 2-6:

```ts
import {
  waitForReading,
  waitForRawReading,
  findMissingCharacteristics,
  resolveWriteChar,
} from '../../src/ble/shared.js';
```

Then append this describe block at the end of the file:

```ts
describe('resolveWriteChar()', () => {
  const WRITE2_UUID = '0000fff500001000800000805f9b34fb';

  it('resolves the legacy charWriteUuid when no characteristics declared', () => {
    const writeChar = createMockChar();
    const { charMap } = createCharMap([[WRITE_UUID, writeChar]]);
    const adapter = createLegacyAdapter();
    expect(resolveWriteChar(charMap, adapter)).toBe(writeChar);
  });

  it('falls back to altCharWriteUuid when primary write char absent', () => {
    const altWriteChar = createMockChar();
    const ALT_WRITE = '0000ffe300001000800000805f9b34fb';
    const { charMap } = createCharMap([[ALT_WRITE, altWriteChar]]);
    const adapter = createLegacyAdapter({ altCharWriteUuid: ALT_WRITE });
    expect(resolveWriteChar(charMap, adapter)).toBe(altWriteChar);
  });

  it('resolves the characteristics[] write binding even when charWriteUuid is absent', () => {
    const writeChar = createMockChar();
    const { charMap } = createCharMap([[WRITE2_UUID, writeChar]]);
    const adapter = createLegacyAdapter({
      charWriteUuid: '0000dead00001000800000805f9b34fb', // not in the map
      characteristics: [
        { uuid: NOTIFY_UUID, type: 'notify' },
        { uuid: WRITE2_UUID, type: 'write' },
      ],
    });
    expect(resolveWriteChar(charMap, adapter)).toBe(writeChar);
  });

  it('returns undefined when nothing resolves', () => {
    const { charMap } = createCharMap([[NOTIFY_UUID, createMockChar()]]);
    const adapter = createLegacyAdapter({
      charWriteUuid: '0000dead00001000800000805f9b34fb',
    });
    expect(resolveWriteChar(charMap, adapter)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/ble/shared.test.ts -t resolveWriteChar`
Expected: FAIL — `resolveWriteChar is not a function` (not yet exported).

- [ ] **Step 3: Write the implementation**

In `src/ble/shared.ts`, immediately after the `resolveChar` function (currently ends at line 60), add:

```ts
/**
 * Resolve the characteristic this adapter writes to for handler-driven writes
 * (per-frame ACKs). Prefers the `characteristics[]` write binding so a
 * multi-char adapter that declares no legacy `charWriteUuid` can still ack,
 * then falls back to the legacy `charWriteUuid` / `altCharWriteUuid` pair.
 * Returns undefined when no write char is present (caller no-ops).
 */
export function resolveWriteChar(
  charMap: Map<string, BleChar>,
  adapter: ScaleAdapter,
): BleChar | undefined {
  if (adapter.characteristics) {
    const writeBinding = adapter.characteristics.find((b) => b.type === 'write');
    if (writeBinding) {
      const char = resolveChar(charMap, writeBinding.uuid);
      if (char) return char;
    }
  }
  return (
    resolveChar(charMap, adapter.charWriteUuid) ??
    (adapter.altCharWriteUuid ? resolveChar(charMap, adapter.altCharWriteUuid) : undefined)
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/ble/shared.test.ts -t resolveWriteChar`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
taskkill //F //IM node.exe || true
git add src/ble/shared.ts tests/ble/shared.test.ts
git commit -m "refactor(ble): add characteristics-aware resolveWriteChar (#247)"
```

---

### Task 4: Rewire `waitForRawReading` to compose the three helpers

**Files:**
- Modify: `src/ble/shared.ts` (`waitForRawReading`, lines 318-469; add import at top)
- Test: `tests/ble/shared.test.ts` (add ONE new integration test; do not edit existing tests)

**Interfaces:**
- Consumes: `HistoryBuffer`, `HoldTimer` from `./notification-processor.js`; `resolveWriteChar` (same module).
- Produces: no signature change to `waitForRawReading` — pure internal restructure. All existing exports and behavior preserved.

- [ ] **Step 1: Write the failing integration test (acceptance criterion 2)**

Append to the `describe('waitForRawReading() — per-frame ACK + completion hold', ...)` block in `tests/ble/shared.test.ts`:

```ts
  it('routes per-frame ACK through the characteristics[] write binding (not charWriteUuid)', async () => {
    const notifyChar = createMockChar();
    const writeChar = createMockChar();
    const device = createMockDevice();
    const WRITE2 = '0000fff500001000800000805f9b34fb';
    const { charMap } = createCharMap([
      [NOTIFY_UUID, notifyChar],
      [WRITE2, writeChar],
    ]);

    const adapter = createLegacyAdapter({
      charWriteUuid: '0000dead00001000800000805f9b34fb', // absent: old code could not ack
      characteristics: [
        { uuid: NOTIFY_UUID, type: 'notify' },
        { uuid: WRITE2, type: 'write' },
      ],
      onConnected: vi.fn(),
      buildAck: vi.fn(() => [0xaa, 0xbb]),
      parseNotification: vi.fn((d: Buffer) => (d[0] === 0x99 ? { weight: 75, impedance: 500 } : null)),
    });

    const promise = waitForRawReading(charMap, device, adapter, PROFILE, '');
    await vi.waitFor(() => expect(notifyChar.subscribeCalled).toBe(true));

    notifyChar.triggerData(Buffer.from([0x01]));
    await vi.waitFor(() =>
      expect(writeChar.writtenData.some((b) => b.equals(Buffer.from([0xaa, 0xbb])))).toBe(true),
    );

    notifyChar.triggerData(Buffer.from([0x99]));
    await promise;
  });
```

- [ ] **Step 2: Run the new test to verify it fails against the current code**

Run: `npx vitest run tests/ble/shared.test.ts -t "characteristics\\[\\] write binding"`
Expected: FAIL — current `ackWriteChar` only looks at `charWriteUuid` (`0000dead...`), so no ACK is ever written and `vi.waitFor` times out.

- [ ] **Step 3: Add the import**

At the top of `src/ble/shared.ts`, after the existing `import { LBS_TO_KG, normalizeUuid, errMsg, bleLog } from './types.js';` line, add:

```ts
import { HistoryBuffer, HoldTimer } from './notification-processor.js';
```

- [ ] **Step 4: Replace the body of `waitForRawReading`**

Replace the entire Promise executor (current lines 328-468, from `return new Promise<RawReading>((resolve, reject) => {` through the closing `});` of `subscribeAndInit(...).catch(...)`) with:

```ts
  return new Promise<RawReading>((resolve, reject) => {
    let resolved = false;
    const history = new HistoryBuffer(MAX_HISTORY_FRAMES, adapter.name);
    const ackWriteChar = resolveWriteChar(charMap, adapter);

    const finishWith = (r: ScaleReading): void => {
      resolved = true;
      hold.clear();
      init.cleanup();
      process.stdout.write('\r' + ' '.repeat(80) + '\r');
      bleLog.info(`Reading complete: ${r.weight.toFixed(2)} kg / ${r.impedance} Ohm`);
      resolve({ reading: r, adapter, history: history.snapshot() });
    };

    // Armed only for adapters with completionHoldMs; the hold() call below is
    // gated on it, so a 0 ms timer is never started for other adapters.
    const hold = new HoldTimer(adapter.completionHoldMs ?? 0, (r) => {
      if (!resolved) finishWith(r);
    });

    const handleNotification = (sourceUuid: string, data: Buffer): void => {
      if (resolved) return;

      if (adapter.buildAck && ackWriteChar) {
        const ack = adapter.buildAck(data);
        if (ack) {
          const ackBuf = Buffer.isBuffer(ack) ? ack : Buffer.from(ack);
          void ackWriteChar.write(ackBuf, true).catch((e: unknown) => {
            if (!resolved) bleLog.debug(`ACK write error: ${errMsg(e)}`);
          });
        }
      }

      const reading: ScaleReading | null = adapter.parseCharNotification
        ? adapter.parseCharNotification(sourceUuid, data)
        : adapter.parseNotification(data);
      if (!reading) return;

      if (weightUnit === 'lbs' && !adapter.normalizesWeight) {
        reading.weight *= LBS_TO_KG;
      }

      if (onLiveData) onLiveData(reading);

      if (reading.timestamp) {
        if (!adapter.isComplete(reading)) return;
        if (history.push(reading)) {
          bleLog.debug(
            `Historical reading buffered: ${reading.weight.toFixed(2)} kg / ` +
              `${reading.impedance} Ohm @ ${reading.timestamp.toISOString()}`,
          );
        }
        return;
      }

      if (adapter.isComplete(reading)) {
        const final = adapter.isFinal ? adapter.isFinal(reading) : true;
        if (adapter.completionHoldMs && !final) {
          hold.hold(reading);
          return;
        }
        finishWith(reading);
      }
    };

    const unsubscribers: (() => void)[] = [];
    const init = initializeAdapter(
      charMap,
      adapter,
      profile,
      deviceAddress,
      () => resolved,
      handleNotification,
      unsubscribers,
      scaleAuth,
    );

    bleDevice.onDisconnect(() => {
      if (resolved) return;
      hold.clear();
      if (history.length > 0) {
        resolved = true;
        init.cleanup();
        const latest = history.popLatest()!;
        process.stdout.write('\r' + ' '.repeat(80) + '\r');
        bleLog.info(
          `Disconnected after cache replay (${history.length + 1} historical reading(s)); ` +
            `no live frame.`,
        );
        resolve({ reading: latest, adapter, history: history.snapshot() });
        return;
      }
      const held = hold.heldReading;
      if (held) {
        finishWith(held);
        return;
      }
      init.cleanup();
      reject(new Error('Scale disconnected before reading completed'));
    });

    // Subscribe to notifications and start adapter init.
    // Errors are caught and forwarded to the Promise's reject.
    subscribeAndInit(charMap, adapter, handleNotification, init.start, unsubscribers).catch((e) => {
      if (!resolved) {
        init.cleanup();
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  });
```

After this edit, confirm `MAX_HISTORY_FRAMES` STAYS (it is now consumed by `new HistoryBuffer(MAX_HISTORY_FRAMES, adapter.name)` on the first line of the executor) and that the old locals (`historyCapWarned`, `holdTimer`, `heldReading`, `clearHold`, the inline `ackWriteChar` derivation, and the old inline `history` array) are gone.

- [ ] **Step 5: Run the full shared suite + the new file**

Run: `npx vitest run tests/ble/shared.test.ts tests/ble/notification-processor.test.ts`
Expected: PASS — every pre-existing test plus the new ACK integration test. Pay special attention to:
- `history collection` block (4 tests) — buffering, disconnect-with-history, skip-incomplete, MAX cap warn once.
- `per-frame ACK + completion hold` block (5 tests now) — hold non-final, hold elapse, disconnect-during-hold, ack-every-frame, the new characteristics binding ack.

- [ ] **Step 6: Commit**

```bash
taskkill //F //IM node.exe || true
git add src/ble/shared.ts tests/ble/shared.test.ts
git commit -m "refactor(ble): rewire waitForRawReading via NotificationProcessor helpers (#247)"
```

---

### Task 5: Full verification gate

**Files:** none (verification only; commit only if Prettier rewrites anything).

- [ ] **Step 1: Type check**

Run: `taskkill //F //IM node.exe; npx tsc --noEmit`
Expected: no output (exit 0). Watch for "declared but never used" on any removed local.

- [ ] **Step 2: Lint**

Run: `npm run lint`
Expected: 0 errors, 0 warnings.

- [ ] **Step 3: Prettier**

Run: `npx prettier --check src/ble/notification-processor.ts src/ble/shared.ts tests/ble/notification-processor.test.ts tests/ble/shared.test.ts`
Expected: "All matched files use Prettier code style!" If it reports a file, run `npx prettier --write <files>` and commit the formatting fix.

- [ ] **Step 4: Full test suite**

Run: `npx vitest run`
Expected: all suites green (baseline was 1756 tests on dev; this adds 8 unit + 4 resolver + 1 integration = 13 new). No existing test edited.

- [ ] **Step 5: Commit any formatting**

```bash
taskkill //F //IM node.exe || true
git add src/ble/shared.ts src/ble/notification-processor.ts tests/ble/shared.test.ts tests/ble/notification-processor.test.ts
git commit -m "style: prettier formatting for notification-processor extraction (#247)" || true
```

---

## Self-Review

**1. Spec coverage** (issue #247 acceptance):
- "history-buffer and hold-timer concerns are extracted and unit-tested in isolation" -> Tasks 1 & 2 create `HistoryBuffer` + `HoldTimer` in their own file with direct unit tests (no GATT promise scaffolding).
- "ACK writes go through the same write-resolver, not a re-derived char" -> Task 3 adds `resolveWriteChar`; Task 4 wires it into the ACK path; the Task 4 integration test proves a `characteristics[]`-only adapter now acks (the bug the issue calls out).
- "`waitForRawReading` reads as subscribe -> process -> resolve wiring" -> Task 4 removes all nested mutable state (`history`, `historyCapWarned`, `holdTimer`, `heldReading`, `clearHold`) so the function body is helper construction + `handleNotification` + disconnect + `subscribeAndInit`.

**2. Placeholder scan:** No TBD/TODO; every code step shows complete code; every command shows expected output.

**3. Type consistency:** `HistoryBuffer.push` returns `boolean` and is consumed as `if (history.push(reading))` in Task 4. `HistoryBuffer.snapshot()` returns `ScaleReading[] | undefined`, fed directly to `RawReading.history` (whose type is `ScaleReading[] | undefined`). `HoldTimer.heldReading` is `ScaleReading | null`, checked with `if (held)`. `resolveWriteChar` returns `BleChar | undefined`, consumed as `ackWriteChar` with the existing `&& ackWriteChar` guard. `HoldTimer` constructor `onElapsed: (reading: ScaleReading) => void` matches the `(r) => { if (!resolved) finishWith(r); }` callback.

**Scope deliberately excluded (documented):** The legacy unlock-command write-char derivation inside `initializeAdapter` is left untouched. Switching it to `resolveWriteChar` would make it characteristics-aware and could change behavior for a hypothetical `characteristics[]`-only adapter without `onConnected` (it would start sending unlock writes where the old code resolved nothing). That is a behavior change, not a pure refactor, so it is out of scope for #247. The ACK path is the only consumer of `resolveWriteChar`.

## Notes for the Implementer

- `bleLog` is the structured logger from `src/ble/types.js`. Tests spy on `bleLog.warn` / `bleLog.info` directly, never on `console`, because the sink/format can change.
- Under fake timers, flush the fire-and-forget subscribe microtask with `await vi.advanceTimersByTimeAsync(1)` (see the existing "hold window elapses" test) rather than `vi.waitFor`, which will not advance a faked clock.
- The `init` and `hold` consts are referenced inside `finishWith`/`handleNotification` before their declaration lines, exactly as in the current code. This is safe: those closures are only invoked asynchronously (after both bindings are initialized), so there is no temporal-dead-zone hit at runtime.
