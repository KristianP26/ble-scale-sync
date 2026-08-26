# Plan: #243 unify single-user and multi-user processing pipeline in processor.ts

## Goal

`processSingleUser` (~64 lines) and `processMultiUser` (~116 lines) run the same
expand -> computeMetrics -> log -> display -> dispatchExports core but have drifted.
Extract one shared core `processReadingFrames`; make the two functions thin policy
wrappers differing only in user selection and genuinely user-count-specific side
effects (weight matching + drift + beeps + last_known_weight write). Give single-user a
runtime dedup anchor so the #164 replay dedup is uniform.

## Current behavioral differences (must be reconciled, not lost)

| Aspect | single-user | multi-user |
|---|---|---|
| user selection | `users[0]` always | `matchUserByWeight`; no-match -> beep(600,150,3) + return true |
| pre-loop log | none | `Raw reading: ...`, `Matched (tier)` |
| beep | none | beep(1200,200,2) on match |
| drift | none | `detectWeightDrift`; warn + driftWarning in last ExportContext |
| replay dedup | NONE (the #164 drift) | skip frame if `timestamp && last_known_weight !== null && abs(w-lkw) < 0.1` |
| dry-run signal | `exporters === undefined` (logged once pre-loop) | `ctx.dryRun` (logged per-frame) |
| checkAndLogUpdate | inside loop on `isLast` | once before loop |
| measurement log | `\n[tag ]Measurement received: ...` | `[tag] Measurement: ...` (no leading \n) |
| last_known_weight write | none | `updateLastKnownWeight` when yaml + configPath |

No test asserts the `Measurement received:` / `Raw reading:` / `Skipping replay` strings
(grep-verified), so the per-frame log wording can be unified. The fixed-order
`logBodyComp` output and the `dispatchExports`/`updateLastKnownWeight`/display calls ARE
asserted and must stay byte-identical in arguments.

## Runtime dedup anchor for single-user (#164)

Multi-user dedups against `user.last_known_weight` (persisted to config). Single-user
does not persist, so per the issue it gets a RUNTIME anchor (not config):

- Add `readonly lastExportedWeights: Map<string, number>` to `AppContext`
  (`src/runtime/context.ts`), initialized empty in `createAppContext`, NOT cleared in
  `setConfig` (dedup state must survive a config reload). Also add it to the test
  `makeCtx` (`tests/runtime/processor.test.ts:127`).
- Single-user wrapper reads `ctx.lastExportedWeights.get(slug) ?? null` as the dedup
  anchor (null on the first reading of a process -> no dedup, matching today), and after
  a non-dry export writes the live weight back.
- This means: on the FIRST reading after start, single-user does NOT dedup (anchor null),
  exactly preserving the existing test `single-user: does NOT dedup historical readings
  against last_known_weight` (fresh ctx, one call). On a LATER reconnect within the same
  process, cache replay now dedups against the runtime anchor (the #164 fix). Across a
  process RESTART single-user still re-exports (no persistence) — that is the stated
  design ("runtime state, not config").

## Shared core

```ts
interface FramePolicy {
  prefix: string;            // '' single, '[Name]' multi
  drift?: string;            // multi only; attached to last frame's ExportContext
  dedupAnchor: number | null; // multi: last_known_weight; single: runtime weight
}

async function processReadingFrames(
  ctx: AppContext,
  user: UserConfig,
  raw: RawReading,
  all: ScaleReading[],
  exporters: Exporter[] | undefined,
  policy: FramePolicy,
): Promise<{ lastSuccess: boolean; latestPayload: BodyComposition | null }>
```

Body:
- `profile = resolveUserProfile(user, ctx.config.scale)`.
- `skipExport = ctx.dryRun || exporters === undefined`. (Empty array is NOT skip — multi
  dispatches `[]`. The single-user `exporters === undefined` case keeps working even
  though `ctx.dryRun` is false in that test fixture.)
- `checkAndLogUpdate` is NOT in the core (see review #5): each wrapper calls it itself so
  the multi-user beep/update-check ordering is preserved exactly. The core assumes it has
  already fired.
- loop over `all` with `isLast`:
  - `tag = frameTag(policy.prefix, reading.timestamp)`; `tagPrefix = tag ? tag+' ' : ''`.
    where `frameTag` yields exactly the pre-refactor strings:
    ```ts
    function frameTag(prefix: string, ts: Date | undefined): string {
      const ht = historicTag(ts);
      if (prefix && ht) return `${prefix} ${ht}`;
      return prefix || ht; // '' when both empty
    }
    ```
  - dedup: if `reading.timestamp && policy.dedupAnchor !== null && abs(w - anchor) < DEDUP_KG_TOLERANCE` -> log skip + `continue`.
  - `payload = computeMetrics`; log `\n${tagPrefix}Measurement: ...`; `logBodyComp(payload, unit, tag)`.
  - if `skipExport` -> log `${tagPrefix}Dry run. Skipping export.` + `continue`.
  - if `isLast` -> `latestPayload = payload`.
  - if `isLast` -> `ctx.display?.reading(slug, name, reading.weight, reading.impedance, exporters!.map(e=>e.name))` (raw weight).
  - build `ExportContext` {userName, userSlug, userConfig, driftWarning if drift && isLast, timestamp if present}.
  - `dispatchExports(exporters!, payload, context)`.
  - if `isLast` -> `ctx.display?.result(slug, name, payload.weight, details)`; `lastSuccess = success`.
- return `{ lastSuccess, latestPayload }`.

The `exporters!` non-null assertions are safe: they are only reached when `!skipExport`,
which guarantees `exporters !== undefined`.

## Wrappers

`processSingleUser(ctx, raw, exporters)`:
- `user = users[0]`, `all = expandReadings(raw)`.
- `checkAndLogUpdate(ctx.config.update_check)` (was on isLast inside the loop; once-before
  is equivalent for single).
- `anchor = ctx.lastExportedWeights.get(user.slug) ?? null`.
- call core with `{ prefix: '', dedupAnchor: anchor }`.
- if `latestPayload` (i.e. a non-dry export happened) ->
  `ctx.lastExportedWeights.set(user.slug, all[all.length - 1].weight)` (NOT `all.at(-1)` —
  `.at()` returns `T | undefined` and fails `tsc --noEmit`, review #1).
- return `lastSuccess`.

`processMultiUser(ctx, raw, getExportersForUser)`:
- `all`, `latest`, `matchWeight`, `Raw reading` log (unchanged).
- `matchUserByWeight`; no-match -> `if (match.warning) log.warn(match.warning)` (keep the
  guard, review #4) + beep(600,150,3) + return true (unchanged).
- `Matched` log + `checkAndLogUpdate(ctx.config.update_check)` + beep(1200,200,2), in that
  order (unchanged from current lines 172-179, review #5).
- `exporters = getExportersForUser?.(slug) ?? []`; `drift = detectWeightDrift`; warn if drift.
- `previousLastKnown = user.last_known_weight`.
- call core with `{ prefix: '[name]', drift: drift ?? undefined, dedupAnchor: previousLastKnown }`.
- if `latestPayload && configSource === 'yaml' && configPath` -> `updateLastKnownWeight(configPath, slug, latest.weight, previousLastKnown)` (unchanged).
- return `lastSuccess`.

`processReading` dispatcher unchanged (routes by `users.length > 1`).

## Commits (logical, each green)

1. `refactor(runtime): add runtime lastExportedWeights anchor to AppContext` — context.ts
   field (required) + factory init + test `makeCtx` field (`lastExportedWeights: new
   Map()`). BLOCKING for step 2: `processSingleUser` will call `ctx.lastExportedWeights.get`,
   so every existing single-user test throws `TypeError` if `makeCtx` omits it (review #2).
   No behavior change (field unused yet).
2. `refactor(runtime): extract processReadingFrames shared core` — add the core + `frameTag`,
   route both wrappers through it, delete the duplicated bodies, wire the single-user
   runtime dedup anchor. All existing processor tests stay green (no edits).
3. `test(runtime): cover single-user runtime replay dedup` — additive tests: single-user
   dedups a historical frame on the SECOND processReading call (same ctx, anchor now set);
   first-call still dispatches all frames (existing behavior); dry-run does not advance the
   anchor.

(Three commits: the anchor field is standalone prep; the core extraction is the
substantive refactor green against existing tests; the new tests are additive coverage of
the #164 single-user behavior. Splitting the core extraction further would leave a
non-compiling intermediate.)

## Verification

- `npx tsc --noEmit`, `npx eslint src tests`, `npx vitest run tests/runtime/processor.test.ts`,
  full `npm test`, `prettier --check` on changed files.
- The existing 20 processor tests are the parity guard: dedup (multi), dry-run (both),
  last_known_weight write gating, display reading/result raw-vs-computed, drift in
  context, historical replay ordering, single-user no-dedup-on-first-reading. They must
  stay green with NO edits except the additive new-field in makeCtx and the new tests.

## Risks / review focus

- Dry-run signal: must remain `ctx.dryRun || exporters === undefined` so the existing
  single-user dry-run test (ctx.dryRun=false, exporters undefined) still skips.
- `checkAndLogUpdate` must fire exactly once per matched cycle and NOT on the no-match
  path (return before the core).
- Single-user runtime anchor: null on first call (no dedup), set only after a non-dry
  export; not cleared on reload.
- `latestPayload` gates BOTH the single-user anchor write and the multi-user config
  write, and is set only on a non-skip last frame — preserving "dry-run writes nothing".
- ExportContext field order/shape must match the asserted `toEqual` in the single-user
  dispatch test (no `driftWarning`/`timestamp` keys when absent).

## Out of scope

- Persisting single-user last weight to config across restarts (issue says runtime only).
- Changing multi-user's config-based anchor or the in-memory staleness of
  `user.last_known_weight` between reloads.
