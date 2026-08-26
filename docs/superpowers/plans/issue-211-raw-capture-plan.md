# Plan: #211 debug branch — raw BLE frame capture for Sanitas SBF70

## Goal

Hand @snicket2100 a branch he can run on his Raspberry Pi that:

1. Dumps EVERY raw `0xFFE1` notify frame as hex to the log, including frames the
   BF710 path currently parses to `null` (the `0x59` finalize/composition frame).
2. Holds the GATT connection open past the weight-stable point so the scale
   actually transmits the `0x59` impedance frame before we disconnect.

This is a capture tool only. It does NOT decode `0x59` — that is the follow-up
once we see the bytes. It must be OFF by default and have zero effect on normal
runs.

## Why the current code never sees 0x59 (confirmed in source)

- `src/scales/beurer-sanitas.ts` `parseBf710Notification()` only decodes the
  `0x58` compact weight frame and returns `null` for everything else (so a
  `0x59` frame is dropped silently).
- `isComplete()` resolves on the BF710 stability window (3 weights within
  0.3 kg). Once `waitForRawReading()` (in `src/ble/shared.ts`) sees
  `isComplete`, it calls `init.cleanup()` and resolves; `scanAndReadRaw()`
  (`src/ble/handler-node-ble/scan.ts:320`) then `device.disconnect()`s. The
  link dies a few seconds BEFORE the scale finishes bioimpedance, so `0x59`
  never arrives over the (now dead) link. This matches the reporter's log:
  `Reading complete` prints ~3 s before the scale physically finishes.

## Design

Single, env-gated capture mode wired into `waitForRawReading()` only. Chosen
there because (a) it is the one place every notify frame from every handler
funnels through (`handleNotification`), and (b) it already owns the
resolve/disconnect lifecycle, so holding the connection is a local change. It is
also already unit-tested (`tests/ble/shared.test.ts`), so the new behavior is
testable without BLE hardware.

Generic (any adapter), not BF710-specific: a raw hex dump + connection hold is
useful for every future protocol-decode request, and being env-gated it cannot
affect production.

### Env knobs (two, each single-purpose, no ambiguity)

- `BLE_RAW_CAPTURE` — truthy enables capture. Disabled when unset/empty or one
  of `0`, `false`, `no`, `off` (case-insensitive). So `true`/`1`/`yes` enable.
- `BLE_RAW_CAPTURE_HOLD_SEC` — optional, hold window in seconds. Default 20.
  Parsed with `Number()`; only a finite value > 0 overrides the default.

Two booleans-vs-seconds knobs avoids the `1` = "enabled" vs "1 second"
ambiguity of a single overloaded var.

### Behavior when enabled

In `waitForRawReading()`:

1. Compute `const capture = getRawCaptureConfig()` once at the top of the
   promise body (reads env each call so tests can toggle without module reload).
2. At the very TOP of `handleNotification` (before the `if (resolved) return`
   and before `parseNotification`): when `capture.enabled`, log
   `bleLog.info('[RAW] ' + sourceUuid + ' (' + data.length + 'B): ' + toHex(data))`.
   This captures frames that parse to `null` (the `0x59` frame).
3. In the live-frame `isComplete` branch (the `if (adapter.isComplete(reading))`
   block): when `capture.enabled`, do NOT resolve. Instead:
   - record `lastCaptureReading = reading`,
   - if no hold timer yet, log once
     `Capture mode: weight stable, holding the connection for <N>s to record trailing frames (e.g. 0x59 composition). Stay on the scale.`
     and start `holdTimer = setTimeout(() => finishCapture(), holdMs)`,
   - `return` (keep the link open; unlock interval keeps firing).
4. `finishCapture()` resolves the promise with `lastCaptureReading` (history
   undefined), after `resolved = true`, `clearHold()`, `init.cleanup()`.
5. Disconnect handler: call `clearHold()` first. If `capture.enabled &&
   lastCaptureReading` and not resolved (and history empty — true for BF710),
   resolve gracefully with `lastCaptureReading` instead of rejecting. This
   avoids a scary "Scale disconnected before reading completed" + failed-GATT
   btmgmt churn on every weigh-in. The scale normally self-disconnects after
   `0x59`, so this is the common exit path; the hold timer is the safety net for
   scales that stay connected.
6. `subscribeAndInit().catch`: add `clearHold()` before reject (defensive; timer
   is not set at init time but keep all paths clean).

`RAW_READING_TIMEOUT_MS` is 120 s, far above the 20 s default hold, so the outer
`withTimeout` never interferes. (Doc note: keep `BLE_RAW_CAPTURE_HOLD_SEC` < 120.)

### Helpers (in `src/ble/shared.ts`)

- `export function getRawCaptureConfig(): { enabled: boolean; holdMs: number }`
  reads the two env vars.
- local `toHex(buf: Buffer): string` -> space-separated 2-char lowercase hex
  (mirror the existing unlock-write formatting style).

## Files to change

1. `src/ble/shared.ts`
   - add `getRawCaptureConfig()` + `toHex()`.
   - thread capture mode through `waitForRawReading()` (promise-scope
     `holdTimer`, `lastCaptureReading`, `clearHold()`; the 6 behavior points).
2. `tests/ble/shared.test.ts`
   - new `describe('waitForRawReading() — raw capture mode')`:
     - logs raw hex for every frame incl. ones that parse to null; spy on
       `bleLog.info` (or capture console) and assert the null-parsing frame is
       present.
     - does NOT resolve on `isComplete`; resolves with last reading on
       disconnect.
     - hold timer resolves with last reading after `holdMs` (vi fake timers).
     - disabled (default) path unchanged (existing tests already cover, add one
       explicit assert that a complete reading resolves immediately when the env
       is unset).
   - set/reset `process.env.BLE_RAW_CAPTURE*` in `beforeEach`/`afterEach` so no
     leak across tests.
3. `README.md`
   - short "Capturing raw BLE frames (debugging)" subsection: the two env vars,
     a one-line Docker example, and that it exports a weight-only reading.

## Out of scope (follow-up after the capture)

- Decoding the `0x59` E7-compact layout into impedance + fat/water/muscle/bone.
- Holding the connection in the real (non-debug) read path for registered SBF70.
  Those land once the reporter's capture reveals the byte layout.

## Verification

- `taskkill //F //IM node.exe` (bash) before npm.
- `npm test` (full vitest), `npm run lint`, `npx tsc --noEmit`,
  `npx prettier --check .`.
- Manual reasoning trace of the capture lifecycle (enabled + disabled) since no
  BLE hardware is available here.

## Git

- Branch `debug/issue-211-raw-frame-capture` off `dev`.
- Conventional Commit `feat(ble): env-gated raw BLE frame capture for protocol debugging (#211)`.
- Commit to the branch; do NOT push (offer it). No AI attribution, no em/double dash.

## Plan review (self-review, corrections folded in before implementation)

Found 6 issues in the draft above; the implementation uses these corrected forms:

- **A. Double-resolve race.** The hold timer and the disconnect handler can both
  fire. The hold-timer callback MUST start with `if (resolved) return;` (the
  disconnect handler already guards with `if (resolved) return;`). Without it,
  a self-disconnect during the hold window then the timer would call `resolve`
  twice. (Second `resolve` is a no-op for the Promise but would run
  `init.cleanup()` twice and log twice — guard it.)
- **B. TS null-safety.** `lastCaptureReading` is `ScaleReading | null`. Inside
  the timer/disconnect closures read it into a local `const r = lastCaptureReading;`
  and guard `if (!r) return;` before `resolve({ reading: r, ... })` so it
  type-narrows and never resolves with null.
- **C. No separate `finishCapture()`.** Inline the timer callback inside
  `setTimeout` so it does not reference `init` before its `const` declaration.
  `handleNotification` already legally references `init` because it only runs
  after `init` is assigned; the timer is created from inside `handleNotification`
  so it is equally safe, but inlining keeps it obviously correct.
- **D. DRY hex.** Reuse the new `toHex(buf)` for the existing unlock-write debug
  log too (it currently inlines the same map/padStart/join), so there is one hex
  formatter.
- **E. Test timers.** Use `vi.useFakeTimers()` +
  `await vi.advanceTimersByTimeAsync(...)` for the hold-resolve test (flushes the
  async subscribe microtasks between timers). Use REAL timers + a
  `Promise.race` sentinel for the "does not resolve early, resolves on
  disconnect" test. Restore real timers in `afterEach`.
- **F. Log spy.** Assert the raw dump via `vi.spyOn(bleLog, 'info')` (import
  `bleLog` from `../../src/ble/types.js`); shared.ts and the test share the same
  logger singleton. Trigger BOTH a complete `0x58`-style frame (sets
  `lastCaptureReading`) and a `null`-parsing `0x59`-style frame, assert the
  null frame's hex appears in an `[RAW]` line, then disconnect to settle the
  promise (capture-graceful resolve with the last reading).

Disconnect-handler final shape (capture branch added before the existing
reject, after the existing history branch):

```
bleDevice.onDisconnect(() => {
  if (resolved) return;
  clearHold();
  if (history.length > 0) { /* unchanged */ return; }
  const r = lastCaptureReading;
  if (capture.enabled && r) {
    resolved = true;
    init.cleanup();
    process.stdout.write('\r' + ' '.repeat(80) + '\r');
    bleLog.info('Capture mode: scale disconnected; recorded frames above. Returning weight-only reading.');
    resolve({ reading: r, adapter, history: undefined });
    return;
  }
  init.cleanup();
  reject(new Error('Scale disconnected before reading completed'));
});
```
