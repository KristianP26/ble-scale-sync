# Scale Adapter Capability Mixins (#244) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the `ScaleAdapter` god-interface into a small REQUIRED core plus named OPTIONAL capability-mixin interfaces, so capability presence is expressed through the type rather than as a flat bag of optional fields, and so `unlockCommand` / `unlockIntervalMs` become optional and adapters stop declaring placeholder empty unlocks just to satisfy the type.

**Architecture:** `ScaleAdapter` is decomposed into `ScaleAdapterCore` (the always-present members) and six capability-mixin interfaces (`GattWiring`, `Unlockable`, `BroadcastSource`, `MultiCharNotify`, `AckProtocol`, `HoldForComposition`) plus a small set of remaining optional members folded into core-optional. Three of the mixins are HARD CONTRACTS whose headline member is required (`GattWiring`: `charNotifyUuid` + `charWriteUuid`; `Unlockable`: `unlockCommand` + `unlockIntervalMs`; `AckProtocol`: `buildAck`); `MultiCharNotify` requires its single `parseCharNotification` method; the remaining two (`BroadcastSource`, `HoldForComposition`) are NAMED OPTIONAL GROUPINGS (all members optional, because adapters mix-and-match broadcast shapes and because `beurer-sanitas` exposes `completionHoldMs` through a `number | undefined` getter that a required member would reject with TS2416). The element type that the homogeneous production registry array (`src/scales/index.ts`) is typed by stays `ScaleAdapter`, defined as `ScaleAdapterCore` intersected with a `Partial<>` view of every mixin: `ScaleAdapter = ScaleAdapterCore & Partial<GattWiring> & Partial<Unlockable> & Partial<BroadcastSource> & Partial<MultiCharNotify> & Partial<AckProtocol> & Partial<HoldForComposition>`. Because every mixin member is optional in that intersection, ANY adapter and ANY existing strict-object-literal test mock is assignable to `ScaleAdapter`, and every property name those literals set remains a known member (so TypeScript's object-literal excess-property check still passes). Meanwhile each ADAPTER CLASS opts into the named mixins it actually satisfies via `implements ScaleAdapterCore, GattWiring, Unlockable` (etc.), giving author-facing clarity and compile-time checking of that specific bundle. `unlockCommand` and `unlockIntervalMs` move into `Unlockable` and become optional; `initializeAdapter` in `src/ble/shared.ts` treats their absence as "no legacy unlock" instead of forcing adapters to fake them. Every consumer that previously read the now-optional GATT-wiring fields off a bare `ScaleAdapter` is audited and guarded for absence. Behavior is preserved exactly; the parity oracle is the existing ~1806-test suite plus `tsc`.

**Tech Stack:** TypeScript (strict, ES2022, Node16, ESM with `.js` import extensions), Vitest, ESLint, Prettier.

## Global Constraints

- ES Modules: all relative imports use the `.js` extension even from `.ts` sources.
- TypeScript strict (ES2022, Node16). Run `npx tsc --noEmit` clean before every commit.
- Prettier: semicolons, single quotes, trailing commas, 100 char width. Run `npx prettier --check` before commit.
- ESLint clean; underscore prefix for intentionally unused vars.
- Kill node before any npm command (bash): `taskkill //F //IM node.exe`.
- Never use an em dash or a double dash anywhere (code, comments, commit messages, docs). Rewrite the sentence instead.
- Conventional Commits (`refactor:`, `test:`, `fix:`). Do NOT hand-edit `package.json` or `CHANGELOG.md` versions.
- NEVER `git add -A` (it stages untracked `docs/superpowers/plans/*.md`). Use explicit `git add` of named files.
- Work on the `dev` branch; do not touch `main`.
- Behavior preservation is the dominant requirement; every existing test MUST stay green at every step. `make-all-existing-tests-green + tsc-clean + lint-clean + prettier-clean` is an explicit gate in EVERY task.

---

## Background facts (verified against the codebase, 2026-06-19)

### The current `ScaleAdapter` interface (`src/interfaces/scale-adapter.ts`)

The interface spans lines 134 to 249. Its members, with current optionality:

| Member | Kind | Current optionality | Target group |
|---|---|---|---|
| `name` | data | required | Core |
| `matches(device)` | method | required | Core |
| `parseNotification(data)` | method | required | Core |
| `isComplete(reading)` | method | required | Core |
| `computeMetrics(reading, profile)` | method | required | Core |
| `charNotifyUuid` | data | **required** | GattWiring (becomes optional) |
| `charWriteUuid` | data | **required** | GattWiring (becomes optional) |
| `altCharNotifyUuid` | data | optional | GattWiring |
| `altCharWriteUuid` | data | optional | GattWiring |
| `characteristics` | data | optional | GattWiring |
| `unlockCommand` | data | **required** | Unlockable (becomes optional) |
| `unlockCommands` | data | optional | Unlockable |
| `unlockIntervalMs` | data | **required** | Unlockable (becomes optional) |
| `preferPassive` | data | optional | BroadcastSource |
| `parseBroadcast` | method | optional | BroadcastSource |
| `parseServiceData` | method | optional | BroadcastSource |
| `parseCharNotification` | method | optional | MultiCharNotify (GATT multi-char dispatch, NOT broadcast) |
| `buildAck` | method | optional | AckProtocol |
| `completionHoldMs` | data | optional | HoldForComposition |
| `isFinal` | method | optional | HoldForComposition |
| `configure` | method | optional | Core-optional (runtime config injection) |
| `requiresBonding` | data | optional | Core-optional (link-security flag) |
| `onConnected` | method | optional | Core-optional (init hook) |
| `normalizesWeight` | data | optional | Core-optional (unit flag) |
| `match` | data | optional (shipped #245) | Core-optional (already there; KEEP exactly) |

The interface already begins with `import type { MatchDescriptor } from '../scales/match-descriptor.js';` and `export type { MatchDescriptor };` (shipped by #245). `match?: MatchDescriptor` already exists at lines 233-243 as a readonly optional member. Do NOT regress it: it stays an optional member of `ScaleAdapterCore`.

### 27 classes implement `ScaleAdapter` (flat, no base class)

`grep implements ScaleAdapter` over `src/scales` returns 28 hits across 27 registered classes plus `AdeA2Adapter` (NOT registered) and the two classes in `one-byone.ts`. There is NO abstract base and NO `extends`; each adapter is flat. The registered registry is `src/scales/index.ts` (a single `ScaleAdapter[]`). `AdeA2Adapter` (`src/scales/ade-a2.ts`) exists but is NOT in the registry; it must still compile, so it is updated alongside the registered adapters.

### Placeholder unlock declarations to remove (acceptance #1)

`unlockCommand: number[] = []` placeholders that exist only to satisfy the required type, on REGISTERED adapters (15):

`hoffen.ts:32`, `inlife.ts:41`, `exingtech-y1.ts:37`, `medisana-bs44x.ts:37`, `excelvan-cf369.ts:33`, `mgb.ts:36`, `renpho-es26bb.ts:53`, `one-byone.ts:33` (OneByoneAdapter only; OneByoneNewAdapter has a REAL `unlockCommand`), `robi-s9.ts:77`, `qn-scale.ts:131`, `eufy-p2.ts:284`, `digoo.ts:34`, `beurer-bf720.ts:83`, `trisa.ts:71`, `xiaomi-s800.ts:117`. Plus `ade-a2.ts:144` (unregistered, also fixed).

`unlockIntervalMs = 0` declarations on REGISTERED adapters. CRITICAL DISTINCTION verified by reading the files: three adapters (`hesley.ts:32`, `es-cs20m.ts:46`, `active-era.ts:37`) declare `unlockIntervalMs = 0` together with a REAL non-empty `unlockCommand` and have NO `onConnected`. For these, the legacy interval path in `shared.ts` DOES fire: it sends the real `unlockCommand` once via `sendUnlock()` then arms `setInterval(fn, 0)` (the event loop clamps a 0 ms interval to a minimum, so it keeps re-sending). Their `unlockIntervalMs = 0` is therefore FUNCTIONAL behavior (fire immediately, then re-send continuously), NOT a placeholder that exists only to satisfy the type. Deleting it would CHANGE behavior (stop the periodic re-send). So `hesley`, `es-cs20m`, `active-era` KEEP `Unlockable` with BOTH real values unchanged. They are NOT touched in Task 4.

The `unlockIntervalMs = 0` values that ARE pure placeholders (the field exists only because the type forced it, the unlock never fires because an `onConnected` pre-empts the legacy branch or the adapter is broadcast-only) sit alongside the empty `unlockCommand: number[] = []` placeholders and are removed together. Full `unlockIntervalMs = 0` set on registered adapters, split: PLACEHOLDER (remove with the empty unlock): `beurer-bf720`, `eufy-p2`, `exingtech-y1`, `excelvan-cf369`, `hoffen`, `medisana-bs44x`, `mgb`, `one-byone.ts:34` (OneByoneAdapter), `qn-scale`, `renpho-es26bb`, `robi-s9`, `trisa`, `xiaomi-s800`. FUNCTIONAL (keep, real unlock, no onConnected): `hesley`, `es-cs20m`, `active-era`. Separate case: `one-byone.ts:118` is OneByoneNewAdapter which has a real multi-byte `unlockCommand`; verify whether it has an `onConnected` (Task 4) - if not, it KEEPS `Unlockable` with its real `unlockCommand` and `unlockIntervalMs = 0` functional value.

Adapters that declare a REAL legacy unlock and KEEP `Unlockable`, values unchanged: `mi-scale-2` (`unlockCommand` + `unlockIntervalMs = 3000`, no onConnected), `beurer-sanitas` (`get unlockCommand()` + `unlockIntervalMs = 5000`, no onConnected), `renpho` (`[0x10,0x01,0x00,0x11]` + 3000), `senssun` (IIFE-built `unlockCommand` + 5000), `sanitas-sbf72` (`[0x02,0x01,0x00,0x00]` + 5000), `soehnle` (`[0x09,0x01]` + 5000), `standard-gatt` (`[0x02,0x01,0x00,0x00]` + 5000), `yunmai` (`[0x0d,...]` + 5000), `hesley`/`es-cs20m`/`active-era` (per above), `one-byone.ts:114` OneByoneNewAdapter (per above). Note `digoo` (`unlockIntervalMs = 5000`, `unlockCommand` `[]`, HAS `onConnected`) and `inlife` (`unlockIntervalMs = 5000`, `unlockCommand` `[]`, HAS `onConnected`): these have a non-zero interval but an EMPTY `unlockCommand` and an `onConnected`, so their unlock never fires; the empty `unlockCommand` is a placeholder to remove, and once removed the `unlockIntervalMs = 5000` would be an orphan `Unlockable` member that can never run, so DROP `Unlockable` from digoo and inlife entirely (remove both fields). The exact KEEP-vs-DROP decision is made per adapter in Task 4 by reading the file; the rule is simple and verifiable: an adapter KEEPS `Unlockable` if and only if the legacy interval path in `shared.ts` can actually fire for it, i.e. it has NO `onConnected` AND a non-empty `unlockCommand`. Adapters with an `onConnected` never reach the legacy branch, so their `unlockCommand` / `unlockIntervalMs` are pure placeholders and are dropped.

> Verification rule used throughout Task 4: in `shared.ts:163`, `initializeAdapter` runs `adapter.onConnected` if present and ONLY falls to the legacy unlock branch (`shared.ts:189-215`) when `onConnected` is absent. So any adapter that defines `onConnected` cannot use `unlockCommand` / `unlockIntervalMs` at runtime; both are placeholders and must be dropped (acceptance #1). An adapter without `onConnected` and with a non-empty `unlockCommand` KEEPS `Unlockable`.

### The ONLY consumer of the legacy unlock fields: `src/ble/shared.ts`

`initializeAdapter` (lines 141-219). The legacy `else` branch (lines 189-215) is the sole reader of `unlockCommand` / `unlockCommands` / `unlockIntervalMs`:

```
189      } else {
190        // Legacy unlock command interval
191        const writeChar =
192          resolveChar(charMap, adapter.charWriteUuid) ??
193          (adapter.altCharWriteUuid ? resolveChar(charMap, adapter.altCharWriteUuid) : undefined);
194        if (!writeChar) return;
195
196        const commands = adapter.unlockCommands
197          ? adapter.unlockCommands.map((c) => Buffer.from(c))
198          : [Buffer.from(adapter.unlockCommand)];
...
214        unlockInterval = setInterval(() => void sendUnlock(), adapter.unlockIntervalMs);
215      }
```

After this refactor `adapter.charWriteUuid`, `adapter.unlockCommand` and `adapter.unlockIntervalMs` are all optional. The branch must (a) guard `charWriteUuid` absence (already effectively does via `resolveChar` returning undefined, but the argument type changes to `string | undefined`, so `resolveChar`'s signature path must accept that, see Task 5), and (b) treat absent `unlockCommand` as "no legacy unlock" and return early. The new branch shape (Task 5): if there is no `unlockCommands` and no non-empty `unlockCommand`, do nothing (no interval armed); otherwise build the command list and use `adapter.unlockIntervalMs ?? <safe default>` for the timer. Acceptance #3.

### GATT-wiring read sites that must guard absence (after `charNotifyUuid`/`charWriteUuid` become optional)

`charNotifyUuid` / `charWriteUuid` are currently REQUIRED. Moving them into optional `GattWiring` means every read site must compile under `string | undefined`. Enumerated reads across `src/ble` and `src/runtime` (none in `src/runtime`):

| File:line | Expression | Guard needed |
|---|---|---|
| `src/ble/shared.ts:82` | `resolveChar(charMap, adapter.charWriteUuid)` | `resolveChar` accepts `string \| undefined` (Task 5) |
| `src/ble/shared.ts:83` | `adapter.altCharWriteUuid ? resolveChar(...) : undefined` | already optional-guarded |
| `src/ble/shared.ts:115` | `resolveChar(charMap, adapter.charNotifyUuid)` | `resolveChar` undefined-tolerant |
| `src/ble/shared.ts:116` | `adapter.altCharNotifyUuid && resolveChar(...)` | already optional-guarded |
| `src/ble/shared.ts:117` | `missing.push(adapter.charNotifyUuid)` | push only when defined / coalesce label |
| `src/ble/shared.ts:120` | `resolveChar(charMap, adapter.charWriteUuid)` | `resolveChar` undefined-tolerant |
| `src/ble/shared.ts:122` | `missing.push(adapter.charWriteUuid)` | push only when defined / coalesce label |
| `src/ble/shared.ts:192-193` | legacy `charWriteUuid` / `altCharWriteUuid` reads | `resolveChar` undefined-tolerant |
| `src/ble/shared.ts:269-272` | log string interpolation of all four | template strings accept `undefined` (prints `undefined`); replace with `?? '<none>'` for clean logs |
| `src/ble/shared.ts:276-277` | legacy notify resolve | `resolveChar` undefined-tolerant |
| `src/ble/shared.ts:279-280` | legacy write resolve | `resolveChar` undefined-tolerant |
| `src/ble/shared.ts:285-286` | error-message interpolation | template strings tolerate `undefined`; optional cosmetic `?? '<none>'` |
| `src/ble/shared.ts:291-293` | `effectiveNotifyUuid` selection + `altCharNotifyUuid!` | path runs only after notifyChar resolved; keep, but see Task 5 |
| `src/ble/advertisement.ts:82` | `if (!adapter.charNotifyUuid)` | ALREADY tolerates absence (falsy check). No change needed. |
| `src/ble/handler-mqtt-proxy/watcher.ts:446-448` | `if (a.charNotifyUuid) { normalizeUuid(a.charNotifyUuid) ... }` | ALREADY guarded by truthy `if`. No change needed. |
| `src/ble/handler-esphome-proxy/scan.ts:31` | `else if (a.charNotifyUuid)` | ALREADY truthy-guarded. No change needed. |

So the ONLY file with reads that need real edits is `src/ble/shared.ts` (the `resolveChar` signature + the `missing.push` / log lines + the legacy unlock branch). The mqtt-proxy watcher, esphome-proxy scan, and advertisement decision already guard `charNotifyUuid` with a truthy check, so they keep compiling once the field is `string | undefined`.

### Optional capability member read sites (BroadcastSource / MultiCharNotify / AckProtocol / HoldForComposition)

These members are ALREADY optional today, so moving them into mixins (where `ScaleAdapter` exposes them as `Partial<>`) does not change their type. Every read is already absence-guarded. Enumerated for completeness (no edits required for these except possibly type imports):

| File:line | Member | Already guarded |
|---|---|---|
| `src/ble/shared.ts:39-40` | `parseBroadcast`, `parseServiceData` | `if (adapter.parseBroadcast && ...)` yes |
| `src/ble/shared.ts:74-75,106-107,229-232` | `characteristics` | `if (adapter.characteristics)` yes |
| `src/ble/shared.ts:369` | `completionHoldMs` | `adapter.completionHoldMs ?? 0` yes |
| `src/ble/shared.ts:376-377` | `buildAck` | `if (adapter.buildAck && ackWriteChar)` yes |
| `src/ble/shared.ts:386-387` | `parseCharNotification` (MultiCharNotify) | ternary on truthiness yes |
| `src/ble/shared.ts:391` | `normalizesWeight` | `!adapter.normalizesWeight` yes |
| `src/ble/shared.ts:409-410` | `isFinal`, `completionHoldMs` | `adapter.isFinal ? ... : true` yes |
| `src/ble/advertisement.ts:41-47` | `parseBroadcast`, `parseServiceData` | truthy guards yes |
| `src/ble/advertisement.ts:71` | `preferPassive` | `=== true` yes |
| `src/ble/handler-noble-shared.ts:466,469` | `preferPassive`, `parseBroadcast`, `parseServiceData` | optional-chained / truthy yes |
| `src/ble/handler-esphome-proxy/scan.ts:29` | `parseBroadcast`, `parseServiceData` | `typeof === 'function'` yes |
| `src/ble/handler-node-ble/broadcast.ts:123` | `parseServiceData!` | non-null assertion, path pre-checks; keep |
| `src/ble/handler-node-ble/scan.ts:222,293,357` | `preferPassive`, `parseServiceData`, `requiresBonding` | truthy guards yes |
| `src/index.ts:191` | `configure` | `a.configure?.(...)` yes |

8 files under `src/ble` / `src/runtime` reference these optional members and all already guard them. No behavioral edits needed; they keep compiling because the `Partial<>` mixin view preserves the same optional shape.

### Test mocks that build adapters as STRICT object literals (HARD CONSTRAINT)

The decisive constraint. These builders produce adapter objects; some via an escape cast (tolerant of any interface change), some as a BARE object literal whose type is the `: ScaleAdapter` return annotation (subject to object-literal EXCESS-PROPERTY checking). For a bare literal: every property name it sets MUST remain a known member of the target type, and no member it omits may become required.

BARE literals (NO escape cast) — must keep compiling untouched:

| File:func (line) | Fields set | Cast? |
|---|---|---|
| `tests/ble/shared.test.ts` `createLegacyAdapter` (112) | name, charNotifyUuid, charWriteUuid, unlockCommand, unlockIntervalMs, normalizesWeight, matches, parseNotification, isComplete, computeMetrics | none |
| `tests/ble/handler-mqtt-proxy.test.ts` `createBroadcastAdapter` (107) | name, charNotifyUuid, charWriteUuid, unlockCommand, unlockIntervalMs, parseBroadcast, matches, parseNotification, isComplete, computeMetrics | none |
| `tests/ble/handler-mqtt-proxy.test.ts` `createGattAdapter` (162) | name, charNotifyUuid, charWriteUuid, unlockCommand, unlockIntervalMs, matches, parseNotification, isComplete, computeMetrics | none |
| `tests/ble/handler-mqtt-proxy.test.ts` `createDualModeAdapter` (190) | name, charNotifyUuid, charWriteUuid, unlockCommand, unlockIntervalMs, parseBroadcast, matches, parseNotification, isComplete, computeMetrics | none |

CAST literals (`as ScaleAdapter` / `as unknown as ScaleAdapter`) — tolerant, no constraint:

`tests/ble/advertisement.test.ts` `baseAdapter` (12, `as ScaleAdapter`), `tests/ble/esphome-proxy/scan.test.ts` `gattAdapter` (78, `as ScaleAdapter`), `tests/ble/esphome-proxy/watcher.test.ts` `gattAdapter` (71, `as ScaleAdapter`), `tests/ble/handler-mqtt-proxy.test.ts` `createPassiveAdapter` (126, `as unknown as ScaleAdapter`), `tests/ble/handler-noble.test.ts` / `handler-noble-legacy.test.ts` / `handler-node-ble-grace.test.ts` (each `as unknown as ScaleAdapter`, all set `charNotifyUuid: undefined as unknown as string`), `tests/ble/handler-esphome-proxy.test.ts` (4 builders, all `as unknown as ScaleAdapter`), `tests/runtime/processor.test.ts` `fakeAdapter` (63, `as unknown as ScaleAdapter`), `tests/ble/reading-source.test.ts` / `tests/runtime/sources.test.ts` (`[{ name: 'A' }] as unknown as ScaleAdapter[]`), `tests/scales/registry-check.test.ts` `fake` (53, `as unknown as ScaleAdapter`).

**Proof the chosen type keeps every BARE literal compiling without edits:**

The chosen `ScaleAdapter = ScaleAdapterCore & Partial<GattWiring> & Partial<Unlockable> & Partial<BroadcastSource> & Partial<MultiCharNotify> & Partial<AckProtocol> & Partial<HoldForComposition>`.

1. Every property the four bare literals set is one of: `name`, `matches`, `parseNotification`, `isComplete`, `computeMetrics` (all in `ScaleAdapterCore`, still required, all four literals set them), `charNotifyUuid`, `charWriteUuid` (in `GattWiring`, now optional via `Partial<GattWiring>` so they remain KNOWN members and are accepted whether present or not), `unlockCommand`, `unlockIntervalMs` (in `Unlockable`, optional via `Partial<Unlockable>`, remain KNOWN members), `parseBroadcast` (in `BroadcastSource`, optional via `Partial<BroadcastSource>`, KNOWN), `normalizesWeight` (Core-optional, KNOWN). No literal sets a property that ceases to be a member, so NO excess-property error arises.
2. The only members that become required are the five `ScaleAdapterCore` methods/`name`, all of which every bare literal already sets. So NO "missing required property" error arises.
3. Therefore all four bare literals compile unchanged. The cast literals are unaffected by definition.

This is acceptance criterion 2 in action: the array element type stays uniformly assignable (Partial of every mixin), while individual classes get named bundles via `implements`. A flat optional bag (status quo) is rejected because it offers no named capability interfaces. A discriminated union is rejected because a multi-capability adapter (e.g. QN Scale: GattWiring + BroadcastSource) would be unassignable to any single variant and could not live in the homogeneous array.

### `match` (shipped #245) classification

`match?: MatchDescriptor` is already an optional member used by `resolveAdapter` (priority ordering) and `registry-check` (overlap detection, exclusion derivation). It is data the resolver reads off ANY array element, so it must stay on the homogeneous element type as an OPTIONAL core member (`ScaleAdapterCore.match?`). It is NOT a capability mixin: it is not a behavior the BLE handlers branch on; it is selection metadata every adapter in the registry carries. Keeping it optional on core preserves the #245 strict-literal compatibility (registry-check's `fake(...)` sets only `name` + `match`) and the resolver's `a.match?.priority ?? 0` defense. Do NOT move it into a mixin and do NOT make it required.

### `onConnected` classification (resolve explicitly per issue)

`onConnected` stays a CORE-OPTIONAL member rather than its own mixin. Justification: (1) it is consumed in `shared.ts` as the PRIMARY init path that PRE-EMPTS the `Unlockable` legacy branch (`if (adapter.onConnected) {...} else {legacy unlock}`), so it is logically the counterpart of `Unlockable`, not a peer capability layered on top; modeling it as a sibling mixin would wrongly suggest it composes with `Unlockable` when in fact it replaces it. (2) Eleven-plus adapters across every protocol family (digoo, inlife, mgb, one-byone, medisana, exingtech, excelvan, hoffen, hesley, es-cs20m, active-era, plus the custom handshake adapters) implement it; it is near-ubiquitous, not a niche capability, so a dedicated `Initializable` mixin would be opted into by most classes and add ceremony without discrimination value. (3) It pairs with `requiresBonding`, `configure`, and `availableChars` as generic connection-lifecycle concerns that belong with the core connection contract. A one-line note in the plan records that a future split into an `Initializable` mixin is possible if a third init strategy appears, but for now core-optional is cleaner. The remaining optional members `configure`, `requiresBonding`, `normalizesWeight` are likewise folded into core-optional for the same reason: they are cross-cutting flags/hooks read generically by the handler or composition root, not a cohesive named capability bundle an adapter "is a kind of".

### Grouping summary (final)

- `ScaleAdapterCore` (always present): `name`, `matches`, `parseNotification`, `isComplete`, `computeMetrics`. Plus CORE-OPTIONAL: `match?`, `onConnected?`, `configure?`, `requiresBonding?`, `normalizesWeight?`.
- `GattWiring` (mixin): `charNotifyUuid`, `charWriteUuid`, `altCharNotifyUuid?`, `altCharWriteUuid?`, `characteristics?`.
- `Unlockable` (mixin): `unlockCommand`, `unlockCommands?`, `unlockIntervalMs`.
- `BroadcastSource` (mixin): `preferPassive?`, `parseBroadcast?`, `parseServiceData?`. (NOTE: `parseCharNotification` is NOT here; it is a GATT notify concern, see `MultiCharNotify`.)
- `MultiCharNotify` (mixin): `parseCharNotification`. The multi-characteristic GATT notification dispatcher. This is a GATT concern (the handler calls it INSTEAD OF `parseNotification` for every notify frame, passing the source char UUID), NOT a passive-broadcast parser, so it lives in its own small mixin rather than inside `BroadcastSource`. Declared by GATT multi-char adapters: `trisa.ts:157`, `beurer-bf720.ts:167`, `eufy-p2.ts:333`, `robi-s9.ts:121`, `ade-a2.ts:155` (verified by grep). It pairs with `GattWiring` (these adapters declare `characteristics` and an `onConnected`), never with broadcast-only adapters.
- `AckProtocol` (mixin): `buildAck`.
- `HoldForComposition` (mixin): `completionHoldMs?`, `isFinal?` (all-optional grouping; see below).

There are TWO kinds of mixin in this set, and the plan does NOT claim the same enforcement for both:

- HARD CONTRACTS (headline member required): `GattWiring` (`charNotifyUuid` + `charWriteUuid` required), `Unlockable` (`unlockCommand` + `unlockIntervalMs` required), `AckProtocol` (`buildAck` required). For these, `implements <Mixin>` genuinely forces the class to provide the headline member, so capability presence is compile-time enforced. Sub-members that are optional even within the capability (`altChar*`, `characteristics`, `unlockCommands`) stay optional inside the mixin.
- NAMED OPTIONAL GROUPINGS (no enforceable required member): `BroadcastSource` (all four members optional by design, see note) and `HoldForComposition` (`completionHoldMs` MUST be optional because `beurer-sanitas` exposes it through a getter typed `number | undefined`; making it required triggers TS2416 on `implements HoldForComposition`, so the class would not build). For these, `implements <Mixin>` is documentation-of-intent plus an editor signal plus a shape check on any member the class DOES declare (the method signatures must still match), but it does not force the headline member to exist. This is acceptable for acceptance #2: a NAMED interface still beats a flat optional bag even when its members are all optional. The plan does NOT pretend these two are hard required-member contracts.

The `Partial<Mixin>` wrapper in the `ScaleAdapter` element type then relaxes EVERYTHING for the homogeneous array, which is what keeps the bare test literals and the single registry array type-correct.

> Note on `BroadcastSource`: all four of its members are optional even inside the mixin, because adapters mix-and-match (some only `parseServiceData`, some only `parseBroadcast`, some add `preferPassive`). A class still gains value from `implements BroadcastSource` as documentation of intent and from the method-signature shape check on whichever members it declares. This is acceptable: the mixin's worth here is the NAMED grouping and the editor signal, not a hard required-member contract.

> Note on `HoldForComposition.completionHoldMs` (defect-driven, verified against `src/scales/beurer-sanitas.ts:111`): `BeurerSanitasScaleAdapter` implements `completionHoldMs` as `get completionHoldMs(): number | undefined` (returns `BF710_COMPOSITION_HOLD_MS` for the BF710/SBF70 variant, `undefined` for BF700/800). A required `readonly completionHoldMs: number` in the mixin is NOT assignable from a `number | undefined` getter (reproduced as `error TS2416 'Type number | undefined is not assignable to type number'`), so Task 3's `implements ... HoldForComposition` on that class would FAIL to build and the "all tests green + tsc clean" gate could not pass. Therefore `completionHoldMs` is OPTIONAL inside the mixin. Runtime is already undefined-safe: `shared.ts:369` uses `adapter.completionHoldMs ?? 0` (the hold timer) and `shared.ts:409-410` gates on `adapter.completionHoldMs && !final`, so an absent or undefined value means "no hold" exactly as today. Behavior is preserved; the getter stays as-is.

---

## Task 1: Define `ScaleAdapterCore` + the six capability-mixin interfaces and the composed `ScaleAdapter` type

**Files:**
- Modify: `src/interfaces/scale-adapter.ts` (split the one `ScaleAdapter` interface into core + mixins + composed alias; move members; change `charNotifyUuid` / `charWriteUuid` / `unlockCommand` / `unlockIntervalMs` to live in optional-wrapped mixins)
- Create: `tests/interfaces/scale-adapter-types.test.ts` (compile-time type assertions)
- Create: `tsconfig.test-types.json` (the REAL test-typecheck gate; see "Why a dedicated test-typecheck config is required" below)

> **Why a dedicated test-typecheck config is required (verified 2026-06-19).** The repo's default `npx tsc --noEmit` uses `tsconfig.json`, whose `include` is `["src"]` and `rootDir` is `"src"`. It therefore does NOT type-check anything under `tests/`: a deliberately broken type in a test file passes `tsc` with exit 0 (verified). Vitest has NO config file (`vitest.config.*` / `vite.config.*` do not exist) and transforms via esbuild, which STRIPS types without checking them, so the `expectType<...>()` assertions and the bare-literal annotations in `scale-adapter-types.test.ts` are RUNTIME NO-OPS that prove nothing about assignability (a real mock-breaking type error would ship green under vitest). And `tsconfig.eslint.json` cannot be run as `tsc -p tsconfig.eslint.json --noEmit` because it extends `tsconfig.json` and inherits `rootDir: "src"`, so every test file errors with TS6059 ("not under rootDir 'src'") (verified). `npm run lint` (`eslint src tests` with the typed parser) does NOT surface plain assignability errors either; ESLint only runs lint rules, not whole-program type checking. CONCLUSION: without a dedicated config the plan's "the four bare literals compile" and "the compile-time type assertion test" claims are unverified by any command the plan runs. This task adds one that actually type-checks the relevant test code.
>
> **Why the config is SCOPED, not whole-tree (verified 2026-06-19).** A whole-tree `tsconfig.test.json` with `include: ["src","tests"]` and `rootDir` relaxed surfaces 74 PRE-EXISTING type errors across ~29 test files (e.g. `tests/ble/connect-recovery-rssi-skip.test.ts` TS2430, `tests/ble/esphome-proxy/gatt.test.ts` TS2322, `tests/ble/handler-mqtt-proxy.test.ts` TS2348/TS2739, plus many `tests/scales/*.test.ts`). These exist TODAY and are unrelated to #244 (the test suite is simply never type-checked by `tsc`). A whole-tree gate would fail immediately on that pre-existing baseline and could not be used as a clean "is my refactor type-safe" check. Verified that `src` + `tests/ble/shared.test.ts` type-checks CLEAN in isolation, and the four bare-literal adapter builders the proof depends on (`createLegacyAdapter` in shared.test.ts; `createBroadcastAdapter`/`createGattAdapter`/`createDualModeAdapter` in handler-mqtt-proxy.test.ts) are themselves fine; the pre-existing errors in handler-mqtt-proxy.test.ts are in unrelated config-object/`vi.fn()` mock lines, not the adapter builders. So the new gate type-checks `src` plus ONLY the two clean, refactor-relevant test files; the bare-literal proof is reproduced inside `scale-adapter-types.test.ts` itself (which we control and keep clean) so the gate does not depend on the noisy mqtt file.

Create `tsconfig.test-types.json` (Step 1a below) with content:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noEmit": true,
    "rootDir": "."
  },
  "include": ["src", "tests/interfaces/scale-adapter-types.test.ts", "tests/ble/shared.test.ts"]
}
```

(`rootDir: "."` overrides the inherited `rootDir: "src"` so the included test files are allowed; `noEmit` because it is a check-only config. Keep this config out of the eslint/vitest paths so it does not change their behavior.)

**Interfaces:**
- Produces: `ScaleAdapterCore`, `GattWiring`, `Unlockable`, `BroadcastSource`, `MultiCharNotify`, `AckProtocol`, `HoldForComposition`, and `ScaleAdapter` (the composed alias). All exported. `ScaleAuth`, `ConnectionContext`, `CharacteristicBinding`, `AdapterRuntimeConfig`, `BleDeviceInfo`, `ScaleReading`, `BodyComposition`, `UserProfile`, `Gender` are UNCHANGED.
- Consumes: `MatchDescriptor` (already imported at top of file).

- [ ] **Step 1: Write the type-assertion test file**

This task is type-only. The assertions below are checked by `tsc -p tsconfig.test-types.json` (Step 1a + Steps 2/4), NOT by vitest: under esbuild the `expectType<...>()` calls and the typed literals are stripped to no-ops at runtime, so vitest can only confirm the file imports and the `expect(...)` runtime assertions, never the assignability. The real type gate is `tsc` against the dedicated config. Create `tests/interfaces/scale-adapter-types.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import type {
  ScaleAdapter,
  ScaleAdapterCore,
  GattWiring,
  Unlockable,
  BroadcastSource,
  MultiCharNotify,
  AckProtocol,
  HoldForComposition,
  ScaleReading,
  BodyComposition,
  UserProfile,
  BleDeviceInfo,
} from '../../src/interfaces/scale-adapter.js';

// ─── Compile-time assertions (no runtime effect) ──────────────────────────────

/** Assert that T is assignable to U at compile time. */
type Assignable<T, U> = T extends U ? true : false;
/** Assert exact boolean literal. */
function expectType<T extends true>(): void {
  void 0 as unknown as T;
}

// A bare core-only adapter (no GATT, no unlock, no broadcast) is a valid ScaleAdapter.
const coreOnly: ScaleAdapter = {
  name: 'CoreOnly',
  matches: (_d: BleDeviceInfo) => true,
  parseNotification: (): ScaleReading | null => null,
  isComplete: (r: ScaleReading) => r.weight > 0,
  computeMetrics: (): BodyComposition => ({}) as never,
};

// A GATT + Unlockable adapter is assignable.
const gattUnlock: ScaleAdapter = {
  ...coreOnly,
  charNotifyUuid: 'fff1',
  charWriteUuid: 'fff2',
  unlockCommand: [0x01],
  unlockIntervalMs: 5000,
};

// A multi-capability adapter (GATT + BroadcastSource) is assignable to the SAME
// element type (proves no discriminated union splits it out).
const multi: ScaleAdapter = {
  ...coreOnly,
  charNotifyUuid: 'fff1',
  charWriteUuid: 'fff2',
  parseBroadcast: () => null,
  preferPassive: true,
};

describe('ScaleAdapter capability types', () => {
  it('exposes ScaleAdapter as a superset of ScaleAdapterCore', () => {
    expectType<Assignable<ScaleAdapter, ScaleAdapterCore>>();
    expect(true).toBe(true);
  });

  it('keeps charNotifyUuid optional on the element type (bare object compiles)', () => {
    // coreOnly omits charNotifyUuid yet is a valid ScaleAdapter.
    expect(coreOnly.charNotifyUuid).toBeUndefined();
  });

  it('accepts a GATT + Unlockable literal', () => {
    expect(gattUnlock.unlockIntervalMs).toBe(5000);
  });

  it('accepts a multi-capability literal as the same element type', () => {
    expect(multi.preferPassive).toBe(true);
  });

  it('GattWiring requires the headline char UUIDs', () => {
    const w: GattWiring = { charNotifyUuid: 'a', charWriteUuid: 'b' };
    expect(w.charNotifyUuid).toBe('a');
  });

  it('Unlockable requires command + interval', () => {
    const u: Unlockable = { unlockCommand: [0x01], unlockIntervalMs: 3000 };
    expect(u.unlockIntervalMs).toBe(3000);
  });

  it('AckProtocol requires buildAck', () => {
    const a: AckProtocol = { buildAck: () => null };
    expect(a.buildAck(Buffer.alloc(0))).toBeNull();
  });

  it('MultiCharNotify requires parseCharNotification (GATT dispatch, not broadcast)', () => {
    const m: MultiCharNotify = { parseCharNotification: () => null };
    expect(m.parseCharNotification('fff1', Buffer.alloc(0))).toBeNull();
  });

  it('HoldForComposition is a named all-optional grouping (completionHoldMs may be a getter returning number | undefined)', () => {
    // Empty object is assignable: the mixin is a named grouping, not a hard
    // required-member contract (the beurer-sanitas getter returns
    // `number | undefined`, which only assigns if completionHoldMs is optional).
    const empty: HoldForComposition = {};
    expect(empty.completionHoldMs).toBeUndefined();
    // A getter-typed `number | undefined` value (the exact beurer-sanitas
    // shape) is assignable to completionHoldMs only because it is optional.
    const variant: number | undefined = 4000;
    const h: HoldForComposition = { completionHoldMs: variant };
    expect(h.completionHoldMs).toBe(4000);
  });

  it('BroadcastSource is an all-optional grouping', () => {
    const b: BroadcastSource = {};
    expect(b.parseBroadcast).toBeUndefined();
  });
});
```

> The two "all-optional grouping" assertions above (`HoldForComposition`,
> `BroadcastSource`) are the canonical proof for defect-class "headline member
> not enforceable": both mixins type-check from `{}`, so `implements
> HoldForComposition` / `implements BroadcastSource` is documentation-only for an
> adapter that forgets the headline member. This is intentional (see the
> grouping note); GattWiring, Unlockable, AckProtocol, and MultiCharNotify remain
> HARD contracts whose `{ ... }` literal above WILL fail to compile if the
> headline member is omitted.

- [ ] **Step 1a: Create the dedicated test-typecheck config `tsconfig.test-types.json`**

Create `tsconfig.test-types.json` at the repo root with the content shown in the Files section above (`extends ./tsconfig.json`, `rootDir: "."`, `noEmit: true`, `include: ["src", "tests/interfaces/scale-adapter-types.test.ts", "tests/ble/shared.test.ts"]`). This is the config that actually type-checks the type-assertion test against `src`. Do NOT add it to `include` of any other config and do NOT reference it from eslint or vitest; it is invoked explicitly via `tsc -p`.

- [ ] **Step 2: Run the gate to verify it is RED (types do not exist yet)**

Two independent reds. The vitest run confirms the file resolves; the `tsc -p` run is the REAL type gate.

Run (bash):
```bash
taskkill //F //IM node.exe 2>/dev/null
npx vitest run tests/interfaces/scale-adapter-types.test.ts
npx tsc -p tsconfig.test-types.json
```
Expected: BOTH fail at this point because the symbols `ScaleAdapterCore`, `GattWiring`, `MultiCharNotify`, etc. do not exist yet (esbuild import resolution fails for vitest; `tsc` reports the missing exported types). The `tsc -p tsconfig.test-types.json` red is the meaningful one: it is the command that will GREEN only once the types are defined AND the bare/typed literals in the test file are assignable.

- [ ] **Step 3: Rewrite the interface block in `src/interfaces/scale-adapter.ts`**

Keep the file's top (`import type { MatchDescriptor }` + `export type { MatchDescriptor };` + `Gender` + `BleDeviceInfo` + `ScaleReading` + `UserProfile` + `BodyComposition` + `CharacteristicBinding` + `ScaleAuth` + `ConnectionContext` + `AdapterRuntimeConfig`) EXACTLY as-is. Replace ONLY the `export interface ScaleAdapter { ... }` block (lines 134-249) with the following:

```typescript
/**
 * The always-present contract every scale adapter satisfies, plus the
 * cross-cutting optional hooks/flags the BLE handler and composition root read
 * generically (selection metadata, init hook, link-security flag, unit flag,
 * runtime-config injection). Capability bundles that only SOME adapters provide
 * live in the separate mixin interfaces below; an adapter opts into them with
 * `implements ScaleAdapterCore, GattWiring, ...`.
 */
export interface ScaleAdapterCore {
  readonly name: string;

  /**
   * Declarative match descriptor: precedence (`priority`) plus the names,
   * services, characteristics, and manufacturer id this adapter claims.
   * OPTIONAL on the interface (so test mocks may omit it) but REQUIRED for every
   * adapter in the production registry, enforced by registry-check. Selection
   * metadata, not a capability: the resolver reads it off every array element.
   */
  readonly match?: MatchDescriptor;

  /** True if parseNotification() already converts any non-kg reading to kg. */
  readonly normalizesWeight?: boolean;

  /**
   * True if this adapter's characteristics need a bonded/encrypted BLE link
   * (e.g. the SIG User Data Service on the Beurer BF720). The node-ble handler
   * attempts a best-effort BLE pairing after connect and before subscribing.
   * Best-effort: a pairing failure is logged and the read proceeds unbonded.
   */
  readonly requiresBonding?: boolean;

  /**
   * Receive per-device runtime config (e.g. a MiBeacon bind key) from the
   * composition root at startup and on config reload. Optional: only adapters
   * that decrypt a per-device secret implement it.
   */
  configure?(opts: AdapterRuntimeConfig): void;

  /**
   * Multi-step init hook called after BLE connection and service discovery.
   * When defined, replaces the legacy unlockCommand periodic-write logic
   * entirely (see Unlockable). Use the ConnectionContext helpers to write,
   * read, subscribe during init. Kept on core rather than a mixin because it is
   * the primary init path that PRE-EMPTS Unlockable, not a capability layered on
   * top of it.
   */
  onConnected?(context: ConnectionContext): Promise<void> | void;

  matches(device: BleDeviceInfo): boolean;
  parseNotification(data: Buffer): ScaleReading | null;
  isComplete(reading: ScaleReading): boolean;
  computeMetrics(reading: ScaleReading, profile: UserProfile): BodyComposition;
}

/**
 * Legacy single/dual GATT characteristic wiring. An adapter that connects over
 * GATT and is driven by the handler's notify+write seam declares this. Adapters
 * that are broadcast-only (no GATT) omit it entirely.
 */
export interface GattWiring {
  readonly charNotifyUuid: string;
  readonly charWriteUuid: string;
  /** Fallback notify UUID when the primary isn't found (e.g. QN Type 1 FFE1). */
  readonly altCharNotifyUuid?: string;
  /** Fallback write UUID when the primary isn't found (e.g. QN Type 1 FFE3). */
  readonly altCharWriteUuid?: string;
  /**
   * All characteristics this adapter needs (notify, write, read). When defined,
   * the handler subscribes to ALL 'notify' bindings and discovers all
   * 'write'/'read' ones. When absent, the handler falls back to the
   * charNotifyUuid + charWriteUuid pair.
   */
  readonly characteristics?: CharacteristicBinding[];
}

/**
 * Legacy periodic unlock-command capability. An adapter WITHOUT an `onConnected`
 * hook that needs the scale woken by a repeated write declares this. The handler
 * writes `unlockCommand` (or each of `unlockCommands`) to the write
 * characteristic every `unlockIntervalMs`. Adapters that handshake in
 * `onConnected` (which pre-empts this path) MUST NOT declare Unlockable; doing so
 * would be a placeholder, which this refactor removes.
 */
export interface Unlockable {
  readonly unlockCommand: number[];
  /** Multiple unlock commands to try in sequence (e.g. firmware variants). */
  readonly unlockCommands?: number[][];
  readonly unlockIntervalMs: number;
}

/**
 * Passive advertisement / broadcast parsing capability. Adapters that read a
 * weight (and sometimes impedance) directly from advertisement manufacturer or
 * service data declare the relevant members. All members are optional within the
 * capability because adapters mix and match (broadcast-only, service-data-only,
 * dual GATT+broadcast). This is a NAMED OPTIONAL GROUPING, not a hard contract:
 * `implements BroadcastSource` documents intent and shape-checks whatever member
 * the class declares, but does not force any single member to exist.
 */
export interface BroadcastSource {
  /**
   * True if this adapter prefers passive advertisement scanning over a GATT
   * connection. When set, broadcastScan is used even for connectable devices.
   * Adapters that set this must implement parseServiceData or parseBroadcast.
   */
  readonly preferPassive?: boolean;

  /**
   * Parse a weight reading from BLE advertisement manufacturer data. When
   * defined, the handler can extract a reading during scan without connecting.
   */
  parseBroadcast?(manufacturerData: Buffer): ScaleReading | null;

  /**
   * Parse a weight reading from a single BLE advertisement service-data entry.
   * Called for each service-data UUID/value pair on each advertisement. Return
   * null to keep waiting. Combine with preferPassive=true to skip GATT entirely.
   */
  parseServiceData?(uuid: string, data: Buffer): ScaleReading | null;
}

/**
 * Multi-characteristic GATT notification dispatch capability. When an adapter
 * declares this, the handler calls parseCharNotification() INSTEAD OF
 * parseNotification() for every notify frame, passing the source characteristic
 * UUID so the adapter can route by char. This is a GATT notify concern (it pairs
 * with GattWiring `characteristics` and an `onConnected` handshake), NOT a
 * passive-broadcast parser, which is why it is its own mixin and not part of
 * BroadcastSource. Declared by trisa, beurer-bf720, eufy-p2, robi-s9, ade-a2.
 */
export interface MultiCharNotify {
  /**
   * Extended notification parser that receives the source characteristic UUID.
   * When defined, the handler calls this INSTEAD OF parseNotification() for every
   * notification. Enables multi-char dispatch.
   */
  parseCharNotification(charUuid: string, data: Buffer): ScaleReading | null;
}

/**
 * Per-frame acknowledgement capability. Some protocols gate multipart streaming
 * behind a per-frame echo (e.g. Beurer/Sanitas 0x59 composition). The handler
 * resolves the write char once and fires `buildAck` write-and-forget for every
 * notify frame, including frames that parseNotification drops.
 */
export interface AckProtocol {
  /**
   * Build an immediate per-frame acknowledgement to write back to the write
   * characteristic after each notification. Return null to write nothing.
   */
  buildAck(data: Buffer): Buffer | number[] | null;
}

/**
 * Hold-open-for-composition capability. After `isComplete()` first returns true
 * for a non-final reading the handler keeps the GATT link open for up to
 * `completionHoldMs`, still feeding frames, so a richer reading (e.g.
 * bioimpedance composition arriving a few seconds after the weight settles) can
 * land. On timeout the last complete reading resolves.
 */
export interface HoldForComposition {
  /**
   * Hold window in milliseconds. OPTIONAL inside the mixin because a real
   * adapter (Beurer/Sanitas) exposes it through a getter typed
   * `number | undefined` that returns undefined for the BF700/800 variant
   * (no hold) and a number for the BF710/SBF70 variant. `shared.ts` already
   * treats absence as "no hold" (`adapter.completionHoldMs ?? 0` at the timer
   * site and `adapter.completionHoldMs && !final` at the gate), so undefined is
   * safe. See the grouping note: HoldForComposition is a NAMED optional
   * grouping, not a hard required-member contract.
   */
  readonly completionHoldMs?: number;
  /**
   * Return true when the reading is the rich/final one (e.g. carries
   * composition) so the handler resolves immediately instead of waiting out the
   * hold window. Only consulted while completionHoldMs is set.
   */
  isFinal?(reading: ScaleReading): boolean;
}

/**
 * The registry element type. Core is required; every capability mixin is folded
 * in as a Partial so ANY adapter (and any strict-object-literal test mock) is
 * assignable, the production `ScaleAdapter[]` registry stays homogeneous, and
 * every capability property name remains a known optional member (so the
 * handler's existing absence-guarded reads keep compiling). Individual adapter
 * CLASSES opt into the named mixins they satisfy via
 * `implements ScaleAdapterCore, GattWiring, Unlockable` for author-facing
 * clarity and compile-time checking of that specific bundle.
 */
export type ScaleAdapter = ScaleAdapterCore &
  Partial<GattWiring> &
  Partial<Unlockable> &
  Partial<BroadcastSource> &
  Partial<MultiCharNotify> &
  Partial<AckProtocol> &
  Partial<HoldForComposition>;
```

- [ ] **Step 4: Run the src typecheck + the dedicated test typecheck + the type test**

Run (bash):
```bash
taskkill //F //IM node.exe 2>/dev/null
npx tsc --noEmit
npx tsc -p tsconfig.test-types.json
```
The first command type-checks `src` ONLY (its config is `include: ["src"]`); the second is the REAL proof that the type-assertion test and `tests/ble/shared.test.ts` (the bare-literal builder file) compile against the new types. Both must be CLEAN.

Expected (`npx tsc --noEmit`, src only): CLEAN. Adapter classes still say `implements ScaleAdapter` (now a type alias to an object intersection, which TypeScript permits in an `implements` clause). No errors should arise from the interface change itself because all current members still exist on `ScaleAdapter`, just relaxed to optional. If `tsc` flags any adapter for a now-"missing" required member, a member was wrongly dropped from `ScaleAdapter`; re-check the Partial composition.

Expected (`npx tsc -p tsconfig.test-types.json`): CLEAN. This GREENs only because the new exported types exist and every typed literal in `scale-adapter-types.test.ts` (the `coreOnly` bare `ScaleAdapter`, the GATT+Unlockable and multi-capability literals, the GattWiring/Unlockable/AckProtocol/MultiCharNotify hard-contract literals, and the BroadcastSource/HoldForComposition empty-object grouping literals) plus the bare adapter builders in `tests/ble/shared.test.ts` are assignable. THIS is the command that catches a real test-only type regression that `npx tsc --noEmit` (src-only) and vitest (esbuild strips types) would both miss.

Note: `implements ScaleAdapter` (a type alias to an intersection) keeps working. The adapter classes are migrated to `implements ScaleAdapterCore, GattWiring, ...` in Tasks 3 and 4; this task only proves the type composition compiles and the type-level test passes.

Run (bash): `npx vitest run tests/interfaces/scale-adapter-types.test.ts`
Expected: PASS (10 tests). NOTE: vitest passing here proves only that the file imports and the runtime `expect(...)` assertions hold; it does NOT verify the type assertions (esbuild strips them). The `tsc -p tsconfig.test-types.json` run above is what verifies the types.

- [ ] **Step 5: Gate (tsc + lint + prettier + full suite) and commit**

```bash
taskkill //F //IM node.exe 2>/dev/null
npx tsc --noEmit && npx tsc -p tsconfig.test-types.json && npm run lint && npm test && npx prettier --check src/interfaces/scale-adapter.ts tests/interfaces/scale-adapter-types.test.ts
git add src/interfaces/scale-adapter.ts tests/interfaces/scale-adapter-types.test.ts tsconfig.test-types.json
git commit -m "refactor(scales): split ScaleAdapter into core plus capability mixins (#244)"
```

Expected: ALL existing tests green (the relaxation to optional cannot break any runtime behavior, and every bare test literal still compiles per the proof above), tsc/lint/prettier clean. This is the load-bearing commit: at this point `ScaleAdapter` is the composed type and the WHOLE suite must be green before touching adapters or `shared.ts`.

---

## Task 2: Make `initializeAdapter` (and `resolveChar` callers) tolerate absent unlock + GATT-write wiring

**Files:**
- Modify: `src/ble/shared.ts` (`resolveChar` signature; `initializeAdapter` legacy branch; `findMissingCharacteristics` push labels; legacy log/error strings; `effectiveNotifyUuid` path)
- Test: extend `tests/ble/shared.test.ts` with an "adapter with no unlock wiring" case

**Interfaces:**
- Consumes: the relaxed `ScaleAdapter` (charNotifyUuid/charWriteUuid/unlockCommand/unlockIntervalMs now `... | undefined`).
- Produces: `initializeAdapter` that arms NO unlock interval when the adapter declares neither `unlockCommands` nor a non-empty `unlockCommand` (acceptance #3). `resolveChar(charMap, uuid: string | undefined)` returning undefined for an undefined uuid.

- [ ] **Step 1: Write the failing test**

Add to `tests/ble/shared.test.ts` (it already imports everything needed; reuse `createMockChar`, `createMockDevice`, `createCharMap`, `PROFILE`). The new adapter is a BARE legacy adapter that OMITS `unlockCommand` and `unlockIntervalMs` entirely (only legal now that they are optional) and has no `onConnected`. Assert that the write characteristic receives NO unlock write, while a complete reading still resolves.

```typescript
describe('waitForReading() — adapter with no unlock wiring (#244)', () => {
  it('arms no unlock interval and writes nothing when unlock fields are absent', async () => {
    const notifyChar = createMockChar();
    const writeChar = createMockChar();
    const device = createMockDevice();
    const { charMap } = createCharMap([
      [NOTIFY_UUID, notifyChar],
      [WRITE_UUID, writeChar],
    ]);

    // No unlockCommand / unlockIntervalMs, no onConnected: a pure
    // notify-and-parse adapter. Legal because Unlockable is now opt-in.
    const adapter: ScaleAdapter = {
      name: 'NoUnlock',
      charNotifyUuid: NOTIFY_UUID,
      charWriteUuid: WRITE_UUID,
      matches: (_i: BleDeviceInfo) => true,
      parseNotification: (data: Buffer) =>
        data[0] === 0x10 ? { weight: 75.5, impedance: 500 } : null,
      isComplete: (r: ScaleReading) => r.weight > 0 && r.impedance > 0,
      computeMetrics: () => SAMPLE_BODY_COMP,
    };

    const promise = waitForReading(charMap, device, adapter, PROFILE, '');
    await vi.waitFor(() => expect(notifyChar.subscribeCalled).toBe(true));
    notifyChar.triggerData(Buffer.from([0x10]));

    const result = await promise;
    expect(result).toEqual(SAMPLE_BODY_COMP);
    // No legacy unlock write was issued.
    expect(writeChar.writtenData.length).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run (bash): `taskkill //F //IM node.exe 2>/dev/null; npx vitest run tests/ble/shared.test.ts`
Expected: FAIL. Today `initializeAdapter` reaches `[Buffer.from(adapter.unlockCommand)]` with `adapter.unlockCommand === undefined`, throwing `TypeError` (`Buffer.from(undefined)`), so the promise rejects rather than resolving. (Confirm the failure mode is the throw; that is exactly what acceptance #3 fixes.)

- [ ] **Step 3: Update `resolveChar` to accept an optional uuid**

In `src/ble/shared.ts`, change:

```typescript
function resolveChar(charMap: Map<string, BleChar>, uuid: string): BleChar | undefined {
  return charMap.get(normalizeUuid(uuid));
}
```

to:

```typescript
function resolveChar(charMap: Map<string, BleChar>, uuid: string | undefined): BleChar | undefined {
  if (uuid === undefined) return undefined;
  return charMap.get(normalizeUuid(uuid));
}
```

This makes every `resolveChar(charMap, adapter.charNotifyUuid)` / `adapter.charWriteUuid` call (now `string | undefined`) compile without a per-call guard, returning undefined for an absent UUID exactly as a missing char does today.

- [ ] **Step 4: Rewrite the legacy unlock branch in `initializeAdapter`**

Replace the `else` branch body (lines 189-215) so it no-ops when there is no real unlock command, and uses a safe default interval when `unlockIntervalMs` is absent (it can only be absent now if `unlockCommands` is present without `unlockIntervalMs`; keep the original interval otherwise):

```typescript
    } else {
      // Legacy unlock command interval. Absent unlock fields mean this adapter
      // has no legacy unlock; do nothing (it is a pure notify-and-parse or a
      // broadcast adapter). #244: no adapter fakes an empty unlock anymore.
      const writeChar =
        resolveChar(charMap, adapter.charWriteUuid) ??
        (adapter.altCharWriteUuid ? resolveChar(charMap, adapter.altCharWriteUuid) : undefined);
      if (!writeChar) return;

      const hasMultiple = adapter.unlockCommands && adapter.unlockCommands.length > 0;
      const hasSingle = adapter.unlockCommand && adapter.unlockCommand.length > 0;
      if (!hasMultiple && !hasSingle) return; // no legacy unlock to send

      const commands = hasMultiple
        ? adapter.unlockCommands!.map((c) => Buffer.from(c))
        : [Buffer.from(adapter.unlockCommand!)];
      const sendUnlock = async (): Promise<void> => {
        if (isResolved()) return;
        for (const buf of commands) {
          try {
            await writeChar.write(buf, false);
            bleLog.debug(
              `Unlock write: [${[...buf].map((b) => b.toString(16).padStart(2, '0')).join(' ')}]`,
            );
          } catch (e: unknown) {
            if (!isResolved()) bleLog.error(`Unlock write error: ${errMsg(e)}`);
          }
        }
      };

      sendUnlock();
      unlockInterval = setInterval(() => void sendUnlock(), adapter.unlockIntervalMs ?? 5000);
    }
```

(The `?? 5000` is a defensive default for the impossible-in-practice case of `unlockCommands` set without `unlockIntervalMs`; every real adapter that keeps `Unlockable` declares both. 5000 ms mirrors the predominant existing interval. Document this inline.)

- [ ] **Step 5: Guard the `findMissingCharacteristics` push labels and legacy log/error strings**

In `findMissingCharacteristics` (lines 100-125), the legacy branch pushes `adapter.charNotifyUuid` / `adapter.charWriteUuid` into a `string[]`. Now they are `string | undefined`. Change the pushes to coalesce so the array stays `string[]`:

```typescript
  const hasNotify =
    !!resolveChar(charMap, adapter.charNotifyUuid) ||
    (!!adapter.altCharNotifyUuid && !!resolveChar(charMap, adapter.altCharNotifyUuid));
  if (!hasNotify) missing.push(adapter.charNotifyUuid ?? '<no notify uuid>');

  const hasWrite =
    !!resolveChar(charMap, adapter.charWriteUuid) ||
    (!!adapter.altCharWriteUuid && !!resolveChar(charMap, adapter.altCharWriteUuid));
  if (!hasWrite) missing.push(adapter.charWriteUuid ?? '<no write uuid>');
```

In `subscribeAndInit` (legacy branch, lines 268-293), the log/error template strings interpolate the four UUIDs. Template literals accept `undefined` (printing `"undefined"`), so they compile, but for clean diagnostics coalesce the two required ones:

- Line 269 / 271: `notify=${adapter.charNotifyUuid ?? '<none>'}` and `write=${adapter.charWriteUuid ?? '<none>'}`.
- Lines 285-286 in the thrown error: same `?? '<none>'`.
- `effectiveNotifyUuid` (lines 291-293): this path runs only after `notifyChar` is confirmed non-undefined (the `if (!notifyChar || !writeChar) throw` above guarantees one of `charNotifyUuid` / `altCharNotifyUuid` resolved). The expression `resolveChar(charMap, adapter.charNotifyUuid) ? adapter.charNotifyUuid : adapter.altCharNotifyUuid!` now has `adapter.charNotifyUuid` typed `string | undefined`. Since the truthy branch only fires when `resolveChar` found it (so it is a string), and the falsy branch asserts `altCharNotifyUuid!`, the resulting type is `string`. If `tsc` narrows incorrectly, change to:

```typescript
    const effectiveNotifyUuid: string = resolveChar(charMap, adapter.charNotifyUuid)
      ? adapter.charNotifyUuid!
      : adapter.altCharNotifyUuid!;
```

(Add the `!` on `adapter.charNotifyUuid` in the truthy branch; it is provably defined there because `resolveChar(undefined)` returns undefined and would have taken the else branch.)

- [ ] **Step 6: Run the new test + full shared suite + typecheck**

Run (bash):
```bash
taskkill //F //IM node.exe 2>/dev/null
npx tsc --noEmit && npx tsc -p tsconfig.test-types.json && npx vitest run tests/ble/shared.test.ts
```
The `tsc -p tsconfig.test-types.json` run type-checks the modified `tests/ble/shared.test.ts` (including the new bare no-unlock adapter literal, which OMITS `unlockCommand`/`unlockIntervalMs` and must still be assignable to `ScaleAdapter`); a plain `npx tsc --noEmit` would NOT cover that test file. Expected: PASS, including the new no-unlock case (writeChar received zero writes) and ALL pre-existing legacy/multi-char/hold/ack cases (behavior for adapters that DO declare unlock is unchanged: `hasSingle`/`hasMultiple` reproduce the old `unlockCommands ? ... : [unlockCommand]` selection exactly when the fields are present and non-empty).

- [ ] **Step 7: Gate + commit**

```bash
taskkill //F //IM node.exe 2>/dev/null
npx tsc --noEmit && npx tsc -p tsconfig.test-types.json && npm run lint && npm test && npx prettier --check src/ble/shared.ts tests/ble/shared.test.ts
git add src/ble/shared.ts tests/ble/shared.test.ts
git commit -m "refactor(ble): treat absent unlock and write wiring as no-op in initializeAdapter (#244)"
```

Expected: full suite green, tsc/lint/prettier clean.

---

## Task 3: Migrate the GATT/Unlockable/Broadcast/Ack/Hold adapter CLASSES to named `implements` clauses (no placeholder removal yet)

**Goal of this task:** switch every adapter class's `implements ScaleAdapter` to the precise named bundle it satisfies, WITHOUT yet deleting any placeholder unlock fields. This isolates the "named bundles" change (acceptance #2 at the class level) from the "delete placeholders" change (acceptance #1, Task 4), so a regression in either is bisectable.

**Files (modify each registered adapter + `ade-a2.ts`):** all 27 registered adapter files plus `src/scales/ade-a2.ts`. Grouped by the bundle they will declare (derived by reading each file's members; the per-file bundle is the set of mixins whose headline members the class actually declares):

- GATT + Unlockable (legacy notify+write, no onConnected, real unlock): `mi-scale-2.ts`, `renpho.ts`, `senssun.ts`, `sanitas-sbf72.ts`, `soehnle.ts`, `yunmai.ts`, `one-byone.ts` (OneByoneNewAdapter), `standard-gatt.ts`, `hesley.ts`, `es-cs20m.ts`, `active-era.ts` (the last three: real `unlockCommand` + functional `unlockIntervalMs = 0`, NO onConnected, verified by reading - they fire the real unlock via the legacy interval path, so they KEEP `Unlockable`).
- GATT + Unlockable + AckProtocol + HoldForComposition (Beurer/Sanitas): `beurer-sanitas.ts` (declares `buildAck`, a `get completionHoldMs(): number | undefined` getter, `get unlockCommand()` + interval, NO onConnected). Because that getter returns `number | undefined`, `HoldForComposition.completionHoldMs` MUST be optional in the mixin (Task 1) or `implements HoldForComposition` fails with TS2416; this is why HoldForComposition is a NAMED optional grouping, not a hard contract. The getter is NOT modified; only the mixin member's optionality accommodates it.
- GATT only (onConnected-driven, NO firing unlock, NO broadcast/multi-char member): `digoo.ts`, `inlife.ts`, `mgb.ts`, `one-byone.ts` (OneByoneAdapter), `medisana-bs44x.ts`, `exingtech-y1.ts`, `excelvan-cf369.ts`, `hoffen.ts`, `renpho-es26bb.ts`. These declare ONLY `ScaleAdapterCore, GattWiring` (verified by grep that they have NONE of `parseBroadcast`/`parseServiceData`/`parseCharNotification`/`preferPassive`). `renpho-es26bb.ts` in particular has an `onConnected` and NONE of the broadcast/multi-char members (grep-verified), so it is GATT-only and MUST NOT declare `BroadcastSource` or `MultiCharNotify`; it drops its placeholder `Unlockable` in Task 4. (`digoo` and `inlife` have a non-zero `unlockIntervalMs` but an EMPTY `unlockCommand` and an `onConnected`, so the unlock never fires; they are GATT-only and DROP `Unlockable` in Task 4.)
- GATT + MultiCharNotify (multi-characteristic GATT dispatch, onConnected handshake, NO broadcast): `trisa.ts` (`parseCharNotification` at trisa.ts:157), `beurer-bf720.ts` (beurer-bf720.ts:167), `robi-s9.ts` (robi-s9.ts:121), `ade-a2.ts` (ade-a2.ts:155). Each declares `ScaleAdapterCore, GattWiring, MultiCharNotify`. `parseCharNotification` is a GATT notify concern, NOT broadcast; do NOT give these `BroadcastSource`.
- GATT + MultiCharNotify + BroadcastSource (genuine mixed case): `eufy-p2.ts` declares BOTH `parseCharNotification` (eufy-p2.ts:333) AND a real `parseBroadcast` (eufy-p2.ts:354), so its bundle is `ScaleAdapterCore, GattWiring, MultiCharNotify, BroadcastSource`.
- GATT + BroadcastSource (dual GATT + advertisement): `qn-scale.ts` declares `parseBroadcast` (qn-scale.ts:695) on top of its GATT/onConnected path, so it is `ScaleAdapterCore, GattWiring, BroadcastSource`.
- BroadcastSource-primary (broadcast + preferPassive): `mi-scale-2.ts` (preferPassive at mi-scale-2.ts:54 + parseServiceData at :124) ADDS `BroadcastSource` on top of its GATT+Unlockable bundle; `xiaomi-s800.ts` (preferPassive at xiaomi-s800.ts:120 + parseServiceData at :149 + configure, broadcast-only, no GATT read path) declares `ScaleAdapterCore, BroadcastSource` (it drops its placeholder `GattWiring` char fields in Task 4, see Task 4 Step 1 xiaomi recipe).

> The per-file bundles above are the SINGLE SOURCE OF TRUTH and were derived from grep (`parseCharNotification|parseBroadcast|parseServiceData|preferPassive` over `src/scales`): `parseCharNotification` -> trisa, beurer-bf720, eufy-p2, robi-s9, ade-a2; `parseBroadcast` -> eufy-p2, qn-scale; `parseServiceData`/`preferPassive` -> mi-scale-2, xiaomi-s800. No `?? verify` markers remain. The RULE below must agree with this list; where they could disagree, this list wins.

> RULE (must agree with the per-file list above; the list wins on any conflict). A class declares `GattWiring` iff it has a real `charNotifyUuid`/`charWriteUuid` it uses (or `characteristics`); `Unlockable` iff (no `onConnected`) AND a non-empty `unlockCommand`; `BroadcastSource` iff it declares any of `preferPassive`/`parseBroadcast`/`parseServiceData` (NOTE: `parseCharNotification` is NOT a `BroadcastSource` trigger); `MultiCharNotify` iff it declares `parseCharNotification`; `AckProtocol` iff it declares `buildAck`; `HoldForComposition` iff it declares `completionHoldMs` (including a `get completionHoldMs()` getter). Always lead with `ScaleAdapterCore`. A class may carry BOTH `MultiCharNotify` and `BroadcastSource` (eufy-p2 declares both `parseCharNotification` and a real `parseBroadcast`); they are independent.

**Interfaces:**
- Consumes: `ScaleAdapterCore`, `GattWiring`, `Unlockable`, `BroadcastSource`, `MultiCharNotify`, `AckProtocol`, `HoldForComposition` from `../interfaces/scale-adapter.js`.
- Produces: each class header reads `export class XAdapter implements ScaleAdapterCore, <mixins...> {`. The `import type { ScaleAdapter }` becomes `import type { ScaleAdapterCore, GattWiring, ... }` (only the names that file uses). Members are UNCHANGED in this task.

- [ ] **Step 1: For each adapter file, read it, determine the bundle by the RULE above, and change the `implements` clause + the type import.**

For example, `src/scales/yunmai.ts` (real unlock, no onConnected, GATT): `import type { ScaleAdapterCore, GattWiring, Unlockable } from '../interfaces/scale-adapter.js';` and `export class YunmaiScaleAdapter implements ScaleAdapterCore, GattWiring, Unlockable {`. `src/scales/qn-scale.ts` (onConnected, GATT, parseBroadcast): `implements ScaleAdapterCore, GattWiring, BroadcastSource`. `src/scales/trisa.ts` (onConnected, GATT, parseCharNotification, NO broadcast): `implements ScaleAdapterCore, GattWiring, MultiCharNotify`. `src/scales/eufy-p2.ts` (onConnected, GATT, parseCharNotification AND real parseBroadcast): `implements ScaleAdapterCore, GattWiring, MultiCharNotify, BroadcastSource`. `src/scales/beurer-sanitas.ts`: `implements ScaleAdapterCore, GattWiring, Unlockable, AckProtocol, HoldForComposition`. Keep any OTHER imports the file already has (e.g. `BleDeviceInfo`, `ScaleReading`, `ConnectionContext`, `CharacteristicBinding`, `AdapterRuntimeConfig`) - those interfaces are unchanged and still exported from the same module.

Note `one-byone.ts` has TWO classes; give each its own correct clause (OneByoneAdapter = GATT only via onConnected; OneByoneNewAdapter = GATT + Unlockable).

- [ ] **Step 2: Typecheck after EVERY few files (incremental).**

Run (bash): `taskkill //F //IM node.exe 2>/dev/null; npx tsc --noEmit`
Expected: CLEAN once all classes are migrated. If a class declares `implements Unlockable` but `tsc` complains it is missing `unlockCommand` / `unlockIntervalMs`, that class actually still HAS those fields (this task does not delete them), so the only errors here are mismatched bundles: e.g. declaring `GattWiring` on a class that has no `charNotifyUuid`. Fix the clause to match the real members. Declaring `AckProtocol` requires a `buildAck` method present (it is, for beurer-sanitas). At this point NO placeholder is removed, so every `implements Unlockable` class still satisfies it (even the placeholder `unlockCommand: number[] = []` satisfies `Unlockable.unlockCommand: number[]`). That is fine; Task 4 removes the placeholders and simultaneously drops `Unlockable` from those classes.

> Subtlety: a class with a PLACEHOLDER `unlockCommand: number[] = []` and an `onConnected` should, by the RULE, NOT declare `Unlockable` (its unlock never fires). But it still HAS the field this task. Declaring or not declaring `Unlockable` both typecheck while the field is present. CHOICE: in this task, do NOT add `Unlockable` to onConnected-driven classes even though the field is still there. The field becomes an EXTRA property not part of the declared interface, which is legal (a class may have members beyond its `implements` interfaces). Then Task 4 deletes the field cleanly with no clause change needed for those classes. This keeps Task 3 = "clauses" and Task 4 = "delete placeholders" cleanly separated.

- [ ] **Step 3: Run the full scales suite + handler suites + parity oracle.**

Run (bash):
```bash
npx vitest run tests/scales/ tests/ble/
```
Expected: ALL PASS. No runtime behavior changed (only `implements` clauses and type imports). `registry-check.test.ts`, `registry-collision.test.ts`, `adapter-resolution.test.ts` green.

- [ ] **Step 4: Gate + commit**

```bash
taskkill //F //IM node.exe 2>/dev/null
npx tsc --noEmit && npx tsc -p tsconfig.test-types.json && npm run lint && npm test && npx prettier --check "src/scales/*.ts"
git add src/scales/
git commit -m "refactor(scales): declare named capability mixins on each adapter class (#244)"
```

Expected: full suite green; tsc/lint/prettier clean. (`git add src/scales/` stages only source.)

---

## Task 4: Remove placeholder empty unlock declarations (acceptance #1)

**Files (modify each onConnected-driven / broadcast-only adapter that has a PLACEHOLDER unlock):** the registered placeholder adapters + `ade-a2.ts`: `hoffen.ts`, `inlife.ts`, `exingtech-y1.ts`, `medisana-bs44x.ts`, `excelvan-cf369.ts`, `mgb.ts`, `renpho-es26bb.ts`, `one-byone.ts` (OneByoneAdapter only), `robi-s9.ts`, `qn-scale.ts`, `eufy-p2.ts`, `digoo.ts`, `beurer-bf720.ts`, `trisa.ts`, `xiaomi-s800.ts`, `ade-a2.ts`.

DO NOT TOUCH `hesley.ts`, `es-cs20m.ts`, `active-era.ts` in this task. Verified by reading: each has a REAL non-empty `unlockCommand`, NO `onConnected`, and `unlockIntervalMs = 0`. The legacy interval path in `shared.ts` DOES fire for them (one-shot `sendUnlock` then `setInterval(fn, 0)`), so their `unlockCommand` is consumed and their `unlockIntervalMs = 0` is functional behavior, not a type-placeholder. They keep `Unlockable` (declared in Task 3) with both values unchanged. Removing anything from them would be a behavior change.

`digoo.ts` and `inlife.ts` ARE in scope: each has an EMPTY `unlockCommand: number[] = []`, an `onConnected`, and a NON-ZERO `unlockIntervalMs` (5000). The empty `unlockCommand` is the placeholder; once it is removed, the `unlockIntervalMs = 5000` is an orphan that can never fire (the `onConnected` pre-empts the legacy branch), so remove BOTH fields and ensure their clause is GATT-only (no `Unlockable`).

**Interfaces:**
- Consumes: nothing new.
- Produces: zero `unlockCommand: number[] = []` in the registered adapters (acceptance #1). Zero `unlockIntervalMs = 0` that exists only to satisfy the type (the three functional `= 0` on hesley/es-cs20m/active-era remain because they are real behavior, not type-placeholders). Classes that had ONLY a placeholder unlock no longer carry those members and do not declare `Unlockable`.

**Recipe (per file in the in-scope list):**
1. Confirm the class has an `onConnected` (so the legacy unlock path never runs) OR is broadcast-only (no GATT read path), AND its `unlockCommand` is the empty placeholder. Grep within the file for `this.unlockCommand` / `this.unlockIntervalMs` to confirm nothing INSIDE the class reads them (the legacy path in `shared.ts` is the only external reader and it is gated behind `!onConnected`).
2. Delete the `readonly unlockCommand: number[] = [];` line.
3. Delete the `readonly unlockIntervalMs = 0;` (or `= 5000` for digoo/inlife) line.
4. Ensure the class's `implements` clause (set in Task 3) does NOT list `Unlockable` (per Task 3 it should not). If it does, remove `Unlockable` and its now-unused import name.
5. For `xiaomi-s800.ts` (broadcast-only: `charNotifyUuid = ''`, `charWriteUuid = ''`, `preferPassive`, `parseServiceData`): its GATT char fields are ALSO placeholders never used for a read. Drop `GattWiring` from its clause and remove the two empty `charNotifyUuid`/`charWriteUuid` fields together with the empty unlock; its clause becomes `implements ScaleAdapterCore, BroadcastSource`. This is the same class of type-only fake the issue targets. (Verify `advertisement.ts:82` `if (!adapter.charNotifyUuid)` still routes it to `none`/broadcast: with the field ABSENT, `!adapter.charNotifyUuid` is `!undefined === true`, identical to today's `!'' === true`, so behavior is unchanged.) For any OTHER broadcast-only adapter with empty GATT fields, apply the same; if a file uses its `charWriteUuid` inside `onConnected`, KEEP `GattWiring` and only drop the unlock.

- [ ] **Step 1: Read each in-scope placeholder file, apply the recipe.**

Example (`src/scales/mgb.ts`): has `onConnected` writing via `ctx.write(this.charWriteUuid, ...)`; delete `readonly unlockCommand: number[] = [];` and `readonly unlockIntervalMs = 0;`. Its clause stays `implements ScaleAdapterCore, GattWiring` (no Unlockable). Done.

Example (`src/scales/digoo.ts`): has `onConnected` (`ctx.write(this.charWriteUuid, cmd, false)`), empty `unlockCommand`, `unlockIntervalMs = 5000`. Delete both fields; clause is `implements ScaleAdapterCore, GattWiring`.

Example (`src/scales/xiaomi-s800.ts`): broadcast-only; delete empty `unlockCommand`, `unlockIntervalMs = 0`, AND the empty `charNotifyUuid`/`charWriteUuid`; clause becomes `implements ScaleAdapterCore, BroadcastSource`. Keep `configure` (Core-optional) and `parseServiceData`/`preferPassive` (BroadcastSource).

- [ ] **Step 2: Typecheck.**

Run (bash): `taskkill //F //IM node.exe 2>/dev/null; npx tsc --noEmit`
Expected: CLEAN. If a class still `implements Unlockable` after its fields were deleted, `tsc` errors with "missing unlockCommand/unlockIntervalMs"; remove `Unlockable` from that clause and its import. If a deleted field was read somewhere, `tsc` flags the read; fix per recipe step 1 (inline const).

- [ ] **Step 3: Run the affected per-adapter tests + handler suites + parity oracle.**

Run (bash):
```bash
npx vitest run tests/scales/ tests/ble/
```
Expected: ALL PASS. The removed placeholders were never executed (onConnected pre-empts the legacy branch; broadcast-only adapters never enter `initializeAdapter`'s legacy path with a write char), and Task 2 made the legacy branch no-op on absence, so behavior is identical. If a test fails, it was implicitly depending on the placeholder (unlikely); investigate via systematic-debugging, do not weaken the test.

- [ ] **Step 4: Verify acceptance #1 mechanically.**

The RELIABLE acceptance check is the empty-`unlockCommand` grep. The `unlockIntervalMs = 0` grep is ADVISORY ONLY, because `= 0` cannot distinguish a placeholder from a functional value paired with a real `unlockCommand` (OneByoneNewAdapter is exactly such a real case).

Run (bash):
```bash
grep -rn "unlockCommand: number\[\] = \[\]" src/scales/ && echo "STILL HAS PLACEHOLDER UNLOCK" || echo "no empty unlockCommand placeholders"
```
Expected (the load-bearing acceptance check): prints `no empty unlockCommand placeholders` (zero empty `unlockCommand` remain; the grep finds nothing so the `|| echo` fires). If any file is listed, a placeholder was missed; remove it.

Advisory only (NOT an acceptance gate):
```bash
grep -rln "unlockIntervalMs = 0" src/scales/
```
Expected: FOUR files appear and ALL FOUR are legitimate, so the `= 0` grep is informational, not a pass/fail check: `hesley.ts`, `es-cs20m.ts`, `active-era.ts` (real non-empty `unlockCommand`, NO onConnected, functional interval), AND `one-byone.ts` (OneByoneNewAdapter has a REAL 20-byte `unlockCommand` at one-byone.ts:114-117, NO onConnected, so its `unlockIntervalMs = 0` at one-byone.ts:118 is FUNCTIONAL: it fires the real unlock then re-sends via the `setInterval(fn, 0)` legacy path). Do NOT treat one-byone.ts appearing here as a missed placeholder and do NOT delete its unlock; that would stop the real unlock command from being sent. OneByoneAdapter (the OTHER class in one-byone.ts) had the empty placeholder removed in this task, but OneByoneNewAdapter keeps its real unlock, which is why the file still matches the `= 0` grep.

Because the `= 0` grep cannot tell a placeholder from OneByoneNewAdapter's real unlock, use this per-class assertion as the definitive "no placeholder unlock survives" check instead:
```bash
grep -rln "unlockIntervalMs" src/scales/ | while read f; do
  grep -q "unlockCommand: number\[\] = \[\]" "$f" && echo "DEFECT: empty unlockCommand + unlockIntervalMs both present in $f";
done; echo "per-class check done"
```
Expected: prints only `per-class check done` (no `DEFECT:` line): no class carries BOTH an empty `unlockCommand: number[] = []` AND an `unlockIntervalMs`. Acceptance #1 forbids only the satisfy-the-type case; every surviving `unlockIntervalMs` is paired with a real unlock, so the criterion is met.

- [ ] **Step 5: Gate + commit.**

```bash
taskkill //F //IM node.exe 2>/dev/null
npx tsc --noEmit && npx tsc -p tsconfig.test-types.json && npm run lint && npm test && npx prettier --check "src/scales/*.ts"
git add src/scales/
git commit -m "refactor(scales): drop placeholder empty unlock declarations (#244)"
```

Expected: full suite green; tsc/lint/prettier clean.

---

## Task 5: Final verification, acceptance mapping, and push

**Files:** none new; verification only.

- [ ] **Step 1: Confirm capability presence is type-expressed (acceptance #2).**

Run (bash): `grep -rn "implements ScaleAdapterCore" src/scales/ | wc -l`
Expected: 28 (27 registered classes + AdeA2Adapter). Then confirm no class still uses the bare alias:
Run (bash): `grep -rn "implements ScaleAdapter\b" src/scales/ && echo "BARE IMPLEMENTS REMAINS" || echo "all classes use named mixins"`
Expected: `all classes use named mixins` (no class declares only `implements ScaleAdapter`; every one leads with `ScaleAdapterCore` plus named mixins).

- [ ] **Step 2: Confirm `initializeAdapter` handles absent unlock without faked values (acceptance #3).**

Run (bash): `grep -n "no legacy unlock to send" src/ble/shared.ts`
Expected: one hit (the early-return guard added in Task 2). The new-no-unlock test in `tests/ble/shared.test.ts` proves it at runtime.

- [ ] **Step 3: Full gate.**

Run (bash):
```bash
taskkill //F //IM node.exe 2>/dev/null
npx tsc --noEmit && npx tsc -p tsconfig.test-types.json && npm run lint && npm test && npx prettier --check "src/**/*.ts" "tests/**/*.ts"
```
Expected: all green. `npx tsc --noEmit` checks `src`; `npx tsc -p tsconfig.test-types.json` checks the two refactor-relevant test files against the new types (the real test-type gate, since the default config excludes `tests/` and vitest strips types). Capture the test count (about 1806+; the only NET-new tests are the type-assertion file and the one no-unlock shared test).

> Why this full gate does NOT run a whole-tree `tsc` over `tests/`: there are 74 pre-existing type errors in the test suite today (unrelated to #244; the suite is never `tsc`-checked) that a whole-tree gate would trip on. The scoped `tsconfig.test-types.json` checks exactly the two files this refactor's type-safety proof depends on, which are clean today. Optionally, a separate follow-up issue can adopt a whole-tree `tests/` typecheck after the 74 pre-existing errors are fixed; that cleanup is OUT OF SCOPE for #244.

- [ ] **Step 4: Explicit parity oracle.**

Run (bash): `npx vitest run tests/scales/registry-collision.test.ts tests/scales/adapter-resolution.test.ts tests/scales/registry-check.test.ts`
Expected: PASS. Proves selection + registry integrity unchanged by the interface split.

- [ ] **Step 5: Push to dev.**

```bash
git push origin dev
```

---

## Acceptance criteria mapping (from issue #244)

1. "No adapter declares a placeholder empty unlock (no `unlockCommand: []` purely to satisfy the type, and no `unlockIntervalMs: 0` purely to satisfy the type)." -> Task 4 deletes all 15 (+ade-a2) empty `unlockCommand` placeholders and the placeholder `unlockIntervalMs` values that pair with them; mechanically verified by the Task 4 Step 4 greps. Real-unlock adapters (mi-scale-2, renpho, senssun, sanitas-sbf72, soehnle, yunmai, beurer-sanitas, standard-gatt, OneByoneNewAdapter, and hesley/es-cs20m/active-era) keep `Unlockable` with their genuine values; for hesley/es-cs20m/active-era AND OneByoneNewAdapter (one-byone.ts:118, real 20-byte `unlockCommand` at one-byone.ts:114-117, no onConnected) the `unlockIntervalMs = 0` is FUNCTIONAL behavior (real `unlockCommand` fired then re-sent via the legacy interval path), not a type-placeholder, so it is correctly retained and the criterion (which forbids only the satisfy-the-type case) is still met. Consequently the advisory `grep "unlockIntervalMs = 0"` returns FOUR files (those three plus one-byone.ts); the empty-`unlockCommand` grep is the load-bearing acceptance check (see Task 4 Step 4).
2. "Capability presence is expressed THROUGH THE TYPE (named mixin interfaces adapters opt into), not as a flat bag of optional fields." -> Task 1 defines `GattWiring`, `Unlockable`, `BroadcastSource`, `MultiCharNotify`, `AckProtocol`, `HoldForComposition`; Task 3 makes every class `implements ScaleAdapterCore, <its mixins>`. The homogeneous registry element type `ScaleAdapter = ScaleAdapterCore & Partial<GattWiring> & Partial<Unlockable> & Partial<BroadcastSource> & Partial<MultiCharNotify> & Partial<AckProtocol> & Partial<HoldForComposition>` keeps the array type-correct AND assignable from every adapter and every strict test literal, while classes get named bundles. NOTE on enforcement strength: `GattWiring`, `Unlockable`, `AckProtocol`, and `MultiCharNotify` are HARD contracts (headline member required, compile-enforced on `implements`); `BroadcastSource` and `HoldForComposition` are NAMED OPTIONAL GROUPINGS (all members optional, so `implements` is documentation-of-intent plus a shape check, not a required-member contract). Both kinds still beat a flat optional bag for acceptance #2; the plan does not over-claim a hard contract for the two grouping mixins.
3. "`initializeAdapter` handles absent unlock without faked values." -> Task 2 rewrites the legacy branch to early-return when neither `unlockCommands` nor a non-empty `unlockCommand` is present, and makes `resolveChar` tolerate an undefined UUID; the new shared test asserts zero unlock writes and a clean resolve.

## Open design notes for the reviewer

- `onConnected`, `configure`, `requiresBonding`, `normalizesWeight`, and `match` are CORE-OPTIONAL, not mixins. `onConnected` is the primary init path that pre-empts `Unlockable`, so it is the core's connection-lifecycle counterpart, not a peer capability; the others are cross-cutting flags/hooks read generically. A future `Initializable` mixin could split `onConnected` out if a third init strategy appears; flagged, not done.
- `BroadcastSource` and `HoldForComposition` are NAMED OPTIONAL GROUPINGS, not hard required-member contracts. `BroadcastSource`'s members are all optional because adapters mix-and-match broadcast shapes; `HoldForComposition.completionHoldMs` is optional because `beurer-sanitas` exposes it via a `number | undefined` getter (a required member would fail `implements` with TS2416). `GattWiring`, `Unlockable`, `AckProtocol`, and `MultiCharNotify` ARE hard contracts (headline member required and compile-enforced). The plan does not claim a required-member contract for the two grouping mixins; their value is the named grouping, the editor signal, and the method-signature shape check on whatever members a class declares.
- `parseCharNotification` lives in its OWN mixin `MultiCharNotify`, NOT in `BroadcastSource`. It is a GATT multi-characteristic notification dispatcher (the handler calls it instead of `parseNotification` for every notify frame, passing the source char UUID), so grouping it under broadcast would mislabel the five GATT multi-char adapters (trisa, beurer-bf720, eufy-p2, robi-s9, ade-a2) as broadcast sources. `eufy-p2` is the one genuine mixed case: it declares BOTH `parseCharNotification` (MultiCharNotify) AND a real `parseBroadcast` (BroadcastSource).
- The `Partial<Mixin>` composition is deliberately chosen over (a) a flat optional bag (rejected: no named interfaces, fails acceptance #2) and (b) a discriminated union (rejected: a dual GATT+broadcast adapter like QN Scale would be unassignable to any single variant and could not sit in the homogeneous `ScaleAdapter[]`).
- The four BARE (uncast) test mock builders (`createLegacyAdapter`, mqtt-proxy `createBroadcastAdapter` / `createGattAdapter` / `createDualModeAdapter`) compile UNCHANGED: every property they set remains a known optional (or still-required core) member, and no member they omit becomes required. NO test-mock edits are required by this refactor. The only test FILE additions are the new compile-time type-assertion test (Task 1) and the one no-unlock runtime test (Task 2); no existing mock is renamed or has a field moved/removed.

## Per-change adapter counts (for the orchestrator)

- Interface split: 1 file (`scale-adapter.ts`).
- New build config: 1 file (`tsconfig.test-types.json`, the scoped test-typecheck gate; committed in Task 1).
- `shared.ts` consumer guards: 1 file.
- `implements` clause migration: 27 registered classes + `ade-a2.ts` = 28 classes across 27 files (one-byone.ts holds 2).
- Placeholder unlock removal: 15 registered files (+ade-a2.ts) drop the empty `unlockCommand` (and the placeholder `unlockIntervalMs` paired with it); digoo + inlife additionally drop `Unlockable` (empty unlock + orphan 5000 interval); xiaomi-s800 additionally drops `GattWiring` (empty char fields). hesley, es-cs20m, active-era are NOT touched (real unlock, functional `= 0`). standard-gatt is NOT touched for unlock (real unlock, keeps `Unlockable`). Total 16 files touched in Task 4.
- Test files added: 2 (`tests/interfaces/scale-adapter-types.test.ts`, plus one describe block appended to `tests/ble/shared.test.ts`). Zero existing mocks edited.
