# Plan: #242 unify broadcast-match + grace-timer + dedup across 5 handler sites

## Goal

Remove the copy-pasted broadcast-match + grace-timer + dedup state machine duplicated
across 5 BLE handler sites. Extract one pure decision function and two small stateful
helpers; route every site through them while keeping each handler's transport-specific
sink (emit vs queue vs resolve) intact. Close the existing drift, do not preserve it.

## The 5 sites (current behavior)

1. `src/ble/handler-noble-shared.ts` `broadcastScan` — single target, event-driven
   (repeated adverts), single-shot resolve. parse -> complete: resolve; partial: single
   grace timer (`graceTimer` var + `bestWeightOnly`); no usable reading: keep waiting.
   No GATT (it is the broadcast-only path), no dedup (resolves once).
2. `src/ble/handler-mqtt-proxy/scan.ts` `scanAndReadRaw` — single snapshot of scan
   results, single-shot. parse -> complete: return; partial: save `weightOnlyFallback`
   var (NO timer, cannot wait for future frames in one snapshot); wait/none: continue;
   gatt: connect. After loop, return `weightOnlyFallback` if any.
3. `src/ble/handler-mqtt-proxy/watcher.ts` `ReadingWatcher` — persistent stream. parse
   -> complete: cancel grace timer, dedup check, queue; partial: `graceTimers`/
   `graceReadings` Map + `IMPEDANCE_GRACE_MS` timer; wait: continue; none: continue;
   gatt: deferCount/auto_connect logic then `handleGattReading`. Has dedup Map.
4. `src/ble/handler-esphome-proxy/scan.ts` `scanAndReadRaw` — persistent advert stream
   inside a single Promise, single-shot resolve. parse -> complete: cancel grace,
   resolve; partial: `graceTimers`/`graceReadings` Map timer; wait: return; none:
   return; gatt: `connectGatt`. No dedup (resolves once).
5. `src/ble/handler-esphome-proxy/watcher.ts` `ReadingWatcher.handleAd` — persistent
   stream. parse -> complete: cancel grace, `pushDeduped`; partial: Map timer; then
   **straight to GATT if `charNotifyUuid`** — intentionally does NOT call
   `hasParseableBroadcastSource` (per the shared.ts doc comment: it GATT-connects QN
   Elis 1 from its per-advert stream). Has dedup Map (`pushDeduped`/`pruneDedup`).

## Key invariant differences to preserve

- **wait-vs-gatt on a null reading**: sites 1-4 gate "keep waiting" behind
  `hasParseableBroadcastSource`; site 5 (esphome watcher) skips that and GATT-connects
  directly. The pure function needs a `waitForBroadcast` option (default true; esphome
  watcher passes false).
- **single-shot vs streaming**: sites 1, 2, 4 resolve once. Site 2 (mqtt single-shot)
  processes ONE snapshot and physically cannot run a grace timer that waits for a future
  frame, so it keeps its `weightOnlyFallback` variable. This is correct, not drift:
  document it. The acceptance bullet "mqtt single-shot uses the timer path" is declined
  with rationale (would require restructuring single-shot into a streaming loop with new
  timeout semantics; out of scope, regression risk on #201/#211 class). Single-shot
  noble (`broadcastScan`) and esphome scan DO receive repeated adverts, so they keep
  real grace timers.
- **dedup applies only to the 2 persistent watchers** (sites 3, 5). The single-shot
  paths resolve once so dedup is a no-op there; not added (the issue's "noble gains
  dedup" is declined: noble `broadcastScan` resolves once, dedup would be dead code).
- per-site logging strings, `onLiveData` calls, `registerScaleMac`, deferCount /
  auto_connect logic, autonomous-connect, GATT in-flight guards all stay at the call
  site.

## New module: `src/ble/advertisement.ts`

### 1. `evaluateAdvertisement(adapter, info, opts?)` (pure)

```ts
export type AdvertisementDecision =
  | { kind: 'complete'; reading: ScaleReading } // emit now
  | { kind: 'partial'; reading: ScaleReading }  // weight-only, start/refresh grace
  | { kind: 'wait' }                            // parseable broadcast source, keep waiting
  | { kind: 'gatt' }                            // fall through to GATT
  | { kind: 'none' };                           // matched, no broadcast and no GATT path

export interface EvaluateOptions {
  /** Default true. When false, a null reading never returns 'wait' even if a
   *  parseable broadcast source is present — it falls straight to 'gatt'/'none'.
   *  The esphome watcher sets false (connects QN Elis 1 from its advert stream). */
  waitForBroadcast?: boolean;
}

export function evaluateAdvertisement(
  adapter: ScaleAdapter,
  info: BleDeviceInfo,
  opts?: EvaluateOptions,
): AdvertisementDecision
```

Logic (verbatim from current parse + classify):
1. `reading = parseBroadcast(info.manufacturerData.data)` if `parseBroadcast` &&
   `manufacturerData`.
2. if `!reading` && `parseServiceData` && `serviceData`: iterate, break on first non-null.
3. `requiresStable = adapter.preferPassive === true`.
4. if `reading && (!requiresStable || isComplete(reading))` -> `complete`.
5. if `reading && requiresStable` -> `partial`.
6. if `opts.waitForBroadcast !== false && hasParseableBroadcastSource(adapter, info)`
   -> `wait`.
7. if `!adapter.charNotifyUuid` -> `none`.
8. -> `gatt`.

Imports `hasParseableBroadcastSource` from `./shared.js` (no cycle: shared.ts does not
import advertisement.ts).

### 2. `GraceTimers` (stateful, address-keyed)

```ts
export class GraceTimers {
  constructor(graceMs: number, onElapsed: (address: string, reading: RawReading) => void)
  hold(address: string, reading: RawReading): void  // record + arm timer if none for addr
  cancel(address: string): void                     // complete arrived: clear timer + reading
  clear(): void                                      // teardown: clear all
}
```

`hold` overwrites the stored reading and arms a timer only if one is not already running
for that address (matches all current sites). On elapse: delete timer, read+delete the
stored reading, call `onElapsed(address, reading)` if present. Mirrors the exact
setTimeout body duplicated in sites 3/4/5 and (single-key) site 1.

### 3. `DedupWindow` (stateful)

```ts
export class DedupWindow {
  constructor(windowMs: number, now?: () => number)  // now injectable for tests
  shouldEmit(address: string, weight: number): boolean // true if new; records it
}
```

key = `${address}:${weight.toFixed(1)}`; prune entries older than `windowMs` on each
call; return false if seen within window. `now` defaults to `Date.now`.

`shouldEmit` stays a call-site boolean check (NOT a control-flow wrapper): the mqtt
watcher must keep `continue` (skip this candidate, keep scanning the batch — see its
inline comment "Don't block other candidates"), the esphome watcher uses `return`. A
helper that early-exits would swap that control flow. (Review #5.)

Accepted cosmetic change (Review #4): the mqtt watcher's current debug line
`Dedup skip: ${key} (${…}s ago)` loses the `s ago` suffix because the boolean helper
does not expose `lastSeen`. Debug-level only, no test asserts the string (grep-verified).
The line becomes `Dedup skip: ${address}:${weight.toFixed(1)}`.

## Wiring (one commit per site, each independently green)

Helpers land first (own commits, no behavior change), then each site is routed:

- **Commit 1** `refactor(ble): add evaluateAdvertisement decision helper` —
  advertisement.ts with `evaluateAdvertisement` + `AdvertisementDecision` +
  `EvaluateOptions`; `tests/ble/advertisement.test.ts` covering complete / partial /
  wait / gatt / none, preferPassive gating, parseServiceData break, and
  `waitForBroadcast:false`.
- **Commit 2** `refactor(ble): add GraceTimers helper` — add class + tests (arm-once,
  overwrite reading, cancel, clear, elapse fires onElapsed). Use vitest fake timers.
- **Commit 3** `refactor(ble): add DedupWindow helper` — add class + tests (new emits,
  repeat within window suppressed, expiry re-emits, prune, injected now).
- **Commit 4** `refactor(ble): route noble broadcastScan through advertisement helpers`
  — build a bare `BleDeviceInfo` from the peripheral (manufacturerData via existing
  `parseMfgData`; serviceData as a plain `{uuid, data}` list with **RAW uuids** — do NOT
  reuse `toBleDeviceInfo`/`normalizeUuid`, noble passes raw short uuids to
  `parseServiceData` today, review #9), call `evaluateAdvertisement`; complete ->
  onLiveData + resolve; partial -> onLiveData + `GraceTimers.hold` (single key =
  targetAddr; onElapsed: cleanup + log + resolve); else (wait/gatt/none) -> return (keep
  waiting). Replace `graceTimer`/`bestWeightOnly`. cleanup() calls `grace.clear()`.
  HARD CONSTRAINT (review #10): `GraceTimers` deletes the address entry BEFORE invoking
  `onElapsed`, so the `grace.clear()` inside noble's cleanup cannot double-clear / the
  resolve fires exactly once.
- **Commit 5** `refactor(ble): route mqtt-proxy single-shot scan through evaluateAdvertisement`
  — replace the inline parse/classify block with `evaluateAdvertisement`. Mapping MUST
  preserve the call-site `weightOnlyFallback` guards (reviews #1, #2):
  - complete -> return reading (registerScaleMac + return).
  - partial -> `if (!weightOnlyFallback) weightOnlyFallback = { reading, adapter, address }`
    (first-wins), then `continue`.
  - wait -> `continue`.
  - gatt / none -> **`if (weightOnlyFallback) continue;`** first (a saved fallback means
    keep scanning, never GATT — matches current `if (weightOnlyFallback || hasParseable) continue`),
    then for `none` `continue`, for `gatt` do the existing GATT connect.
  Keep `weightOnlyFallback` var + post-loop return (documented single-shot).
  `hasParseableBroadcastSource` import becomes unused here -> drop it.
- **Commit 6** `refactor(ble): route mqtt-proxy watcher through advertisement helpers` —
  replace inline block + `graceTimers`/`graceReadings`/`dedup`/`pruneDedup` with
  `GraceTimers` + `DedupWindow`. complete -> `grace.cancel(addr)`, then
  `if (!dedup.shouldEmit(addr, weight)) { bleLog.debug('Dedup skip: …'); continue; }`
  (boolean at call site, keep `continue` — review #5), else log + registerScaleMac +
  queue.push. partial -> `grace.hold(addr, raw)`. The grace `onElapsed` pushes DIRECTLY
  (log + registerScaleMac + queue.push) and does NOT go through dedup (review #7: current
  grace elapse at watcher.ts:250 does not dedup). Keep
  deferCount/auto_connect/handleGattReading/autonomous logic untouched. stop() calls
  `grace.clear()`.
- **Commit 7** `refactor(ble): route esphome-proxy scan through advertisement helpers` —
  replace inline block + Maps with `GraceTimers` (onElapsed: log + resolve; complete:
  `grace.cancel(addr)` + resolve). clearGrace -> `grace.clear()`.
- **Commit 8** `refactor(ble): route esphome-proxy watcher through advertisement helpers`
  — replace `handleAd` inline block + Maps with `evaluateAdvertisement(..., {waitForBroadcast:false})`
  + `GraceTimers` + `DedupWindow`. complete -> `grace.cancel(addr)` + `pushDeduped`
  (which uses `DedupWindow.shouldEmit`). partial -> `grace.hold(addr, raw)`. The grace
  `onElapsed` pushes DIRECTLY to the queue (log + queue.push), NOT through `pushDeduped`
  (review #7: current grace elapse at watcher.ts:150 does not dedup). gatt -> readViaGatt;
  none -> nothing. `pushDeduped` keeps its log + queue, swaps its inline dedup Map for
  `DedupWindow.shouldEmit`; `pruneDedup` removed.

## Verification

- After each commit: `npx tsc --noEmit` + the touched test file(s).
- Final: `taskkill //F //IM node.exe` then `npm run lint`, `npx tsc --noEmit`,
  `npm test`, `npx prettier --check` on changed files.
- Parity is strongly guarded by existing end-to-end handler tests (mqtt grace
  partial-then-complete / partial-then-timeout, dedup-30s, #201 dual-mode GATT
  fallback, esphome scan/watcher grace + dedup). All must stay green with zero test
  edits except additive new-helper tests. If an existing test needs editing, that signals
  a behavior change -> stop and reassess.

## Out of scope

- mqtt watcher's local `normalizeUuid` (128-bit dashed) duplication — separate concern.
- Restructuring mqtt single-shot into a streaming/grace-timer loop.
- Any adapter changes.

## Risks

- Circular import: avoided (advertisement.ts -> shared.ts only).
- noble `broadcastScan` onElapsed must replicate cleanup-then-resolve order exactly to
  avoid a double-resolve or a leaked discover listener.
- esphome watcher `waitForBroadcast:false` must be the ONLY site passing false; double
  check sites 1-4 keep default-true so #201 wait-vs-gatt gating is unchanged.
