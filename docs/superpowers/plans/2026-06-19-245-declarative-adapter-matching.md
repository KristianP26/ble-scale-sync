# Declarative Adapter Matching (#245) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the O(N^2) registry-order + hand-maintained `EXCLUDED` coupling in scale-adapter selection with a declarative per-adapter match descriptor, a single central resolver that derives precedence from data, and a startup overlap detector.

**Architecture:** Each adapter gains a declarative `match?: MatchDescriptor` (claims + explicit numeric `priority`). The member is OPTIONAL on the interface so the many `as unknown as ScaleAdapter` / strict-literal test mocks keep compiling without a `match`; `registry-check` enforces that every adapter in the real production registry declares it. A shared `matchesDescriptor()` evaluates the common predicates (name exact/includes/startsWith, advertised service UUIDs, post-discovery characteristic UUIDs). The 16 pure-data adapters reduce their `matches()` to a one-line call into that helper; the 11 adapters whose logic needs byte signatures, mutual exclusion, or instance side effects keep a custom `matches()` but still declare their descriptor (`custom: true`) so the resolver and registry-check can reason about their claims. A new `resolveAdapter(device, registry)` orders the GIVEN registry by `priority` (a unique total order, NOT array index; missing priority defaults to 0 and a stable sort preserves the input order for ties so mock-injected lists behave exactly like the old `find`) and returns the first match; all 15 call sites switch to it, passing their own local registry. `registry-check` asserts the documented ordering invariants as priority comparisons and errors on overlapping claims between non-custom adapters at startup. `standard-gatt` derives its exclusion set from the other adapters' claims instead of a hand-maintained 51-entry list.

**Tech Stack:** TypeScript (strict, ES2022, Node16, ESM with `.js` import extensions), Vitest, ESLint, Prettier.

## Global Constraints

- ES Modules: all relative imports MUST use the `.js` extension, even from `.ts` sources.
- TypeScript strict; run `npx tsc --noEmit` clean before every commit.
- Prettier: semicolons, single quotes, trailing commas, 100 char width. Run `npm run format` (or `npx prettier --write`) and `npx prettier --check` before commit.
- ESLint: `_` prefix for intentionally unused vars. Run `npm run lint` clean.
- Kill node before any npm command (bash): `taskkill //F //IM node.exe`.
- Never use an em dash or a double dash in code, comments, commit messages, or docs. Rewrite the sentence instead.
- Conventional Commits (`refactor:`, `feat:`, `test:`, `fix:`). Do NOT edit `package.json` / `CHANGELOG.md` versions by hand.
- NEVER `git add -A` in this repo (it stages untracked `docs/superpowers/plans/*.md`). Use explicit `git add <files>`.
- Behavior preservation is the dominant requirement: `tests/scales/registry-collision.test.ts` and `tests/scales/adapter-resolution.test.ts` are the parity oracle. They MUST stay green at every commit. Every existing per-adapter test MUST stay green.
- Test mocks: the BLE handler suites build fake adapters, some via `as unknown as ScaleAdapter` (compile-safe even if `match` is required) and some as STRICT object literals with no escape cast (`tests/ble/shared.test.ts` `createLegacyAdapter`, `tests/ble/esphome-proxy/scan.test.ts` `gattAdapter`, `tests/ble/advertisement.test.ts` `baseAdapter`). Making `match` OPTIONAL keeps all of them compiling untouched. The resolver MUST tolerate a missing `match` at runtime (`a.match?.priority ?? 0`).
- Branch: work on `dev` (already checked out). Do not touch `main`.

---

## Background facts (verified against the codebase, 2026-06-19)

Registry order today (`src/scales/index.ts`), precedence = array index, generic last:

| idx | class | `name` |
|----|-------|--------|
| 0 | EufyP2Adapter | `Eufy Smart Scale P2/P2 Pro` |
| 1 | SenssunAdapter | `Senssun Fat Scale` |
| 2 | QnScaleAdapter | `QN Scale` |
| 3 | RenphoScaleAdapter | `Renpho ES-WBE28` |
| 4 | RenphoEs26bbAdapter | `Renpho ES-26BB` |
| 5 | BeurerBf720Adapter | `Beurer BF720/BF105` |
| 6 | MiScale2Adapter | `Xiaomi Mi Scale 2` |
| 7 | XiaomiS800Adapter | `Xiaomi Mijia Scale S800` |
| 8 | YunmaiScaleAdapter | `Yunmai` |
| 9 | BeurerSanitasScaleAdapter | `Beurer / Sanitas` |
| 10 | SanitasSbf72Adapter | `Sanitas SBF72/73` |
| 11 | SoehnleScaleAdapter | `Soehnle Shape/Style` |
| 12 | MedisanaBs44xAdapter | `Medisana BS44x` |
| 13 | TrisaAdapter | `Trisa` |
| 14 | EsCs20mAdapter | `ES-CS20M` |
| 15 | ExingtechY1Adapter | `Exingtech Y1` |
| 16 | ExcelvanCF369Adapter | `Excelvan CF369` |
| 17 | HesleyScaleAdapter | `Hesley` |
| 18 | InlifeScaleAdapter | `Inlife` |
| 19 | DigooScaleAdapter | `Digoo` |
| 20 | OneByoneAdapter | `1byone (Eufy)` |
| 21 | OneByoneNewAdapter | `1byone Scale (new)` |
| 22 | ActiveEraAdapter | `Active Era BS-06` |
| 23 | RobiS9Adapter | `Robi S9` |
| 24 | MgbAdapter | `MGB (Swan/Icomon/YG)` |
| 25 | HoffenAdapter | `Hoffen BS-8107` |
| 26 | StandardGattScaleAdapter | `Standard GATT (BCS/WSS)` |

(`AdeA2Adapter` exists but is NOT registered; ignore it.)

Documented ordering invariants that today live only as array position + comments:
1. `Senssun Fat Scale` before `QN Scale` (QN name-matches 'senssun').
2. `Eufy Smart Scale P2/P2 Pro` before `QN Scale` (P2 advertises FFF0).
3. `QN Scale` before `Renpho ES-WBE28` (#191 mutual exclusion).
4. `Beurer BF720/BF105` before `Xiaomi Mi Scale 2` (#168 shared 0x181B).
5. `Robi S9` before `MGB (Swan/Icomon/YG)` (#228 shared FFB0).
6. `Standard GATT (BCS/WSS)` is the unique lowest precedence (generic fallback).

15 production selection sites, all `adapters.find((a) => a.matches(info))` where `adapters` is a LOCAL parameter or a `this.adapters` FIELD (none of these files import the `adapters` module from `src/scales`; verified by grep):
- `src/ble/handler-noble-shared.ts:287,460,529,596` (`adapters` is a function parameter)
- `src/ble/handler-node-ble/discovery.ts:209` (parameter)
- `src/ble/handler-node-ble/scan.ts:219,266,519` (parameter)
- `src/ble/handler-mqtt-proxy/scan.ts:152,262` (parameter)
- `src/ble/handler-mqtt-proxy/watcher.ts:200,436` (`this.adapters` field)
- `src/ble/handler-esphome-proxy/watcher.ts:109` (`this.adapters` field)
- `src/ble/handler-esphome-proxy/scan.ts:95,207` (parameter)

Because the registry is INJECTED (production passes the real registry; `tests/ble/*` pass mock lists like `[gattAdapter()]` / `[MockBroadcast]`), the resolver MUST receive that local registry: `resolveAdapter(info, adapters)` / `resolveAdapter(info, this.adapters)`. Switching to the default module registry would ignore the mocks and break the handler suites.

(Note: `watcher.ts:434-445` is a multi-line `this.adapters.find((a) => { if (a.matches(info)) return true; if (a.charNotifyUuid && <chars match>) return true; return false; })` - a per-adapter OR of `matches()` and a charNotify check, evaluated in array order. Read it before editing; preserve the combined per-adapter OR, do not split it into a sequential `matches`-first-then-fallback which would change precedence.)

### Pure-data adapters (16) - `matches()` becomes `matchesDescriptor(device, this.match)`

renpho-es26bb, sanitas-sbf72, soehnle, medisana-bs44x, trisa, exingtech-y1, hesley, hoffen, senssun, one-byone (OneByoneNewAdapter), excelvan-cf369, digoo, active-era, es-cs20m, mgb, one-byone (OneByoneAdapter).

### Custom adapters (11) - keep bespoke `matches()`, add descriptor with `custom: true`

eufy-p2 (manufacturer byte signature), qn-scale (AABB byte sig + AE00 + brand names + #191 mutual exclusion + unnamed-only vendor fallback), renpho (name + QN-service mutual exclusion), beurer-bf720 (company id AND SIG service), mi-scale-2 (company-id/name exclusion + name + 0x181B service-data), xiaomi-s800 (FE95 service-data PID byte sig), yunmai (sets `this.isMini`), beurer-sanitas (sets `this.isBf710Type`), inlife (chars-present branch is exclusive, not OR), robi-s9 (swan/icomon/yg rejection + service-AND-char), standard-gatt (derived exclusion + broad BCS/WSS).

---

## Task 1: MatchDescriptor type and matchesDescriptor() helper

**Files:**
- Create: `src/scales/match-descriptor.ts`
- Test: `tests/scales/match-descriptor.test.ts`

**Interfaces:**
- Produces:
  - `interface NameClaim { exact?: string[]; includes?: string[]; startsWith?: string[] }`
  - `interface MatchDescriptor { priority: number; names?: NameClaim; serviceUuids?: string[]; charUuids?: string[]; manufacturerId?: number; custom?: boolean }`
  - `function matchesDescriptor(device: BleDeviceInfo, d: MatchDescriptor): boolean`
  - `function uuidClaimHits(claims: string[], deviceUuids: string[] | undefined): boolean`
  - `function descriptorNameTokens(d: MatchDescriptor): string[]` (union of exact+includes+startsWith, for exclusion derivation and overlap analysis)

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest';
import {
  matchesDescriptor,
  uuidClaimHits,
  descriptorNameTokens,
  type MatchDescriptor,
} from '../../src/scales/match-descriptor.js';
import { uuid16 } from '../../src/scales/body-comp-helpers.js';
import type { BleDeviceInfo } from '../../src/interfaces/scale-adapter.js';

const dev = (p: Partial<BleDeviceInfo>): BleDeviceInfo => ({
  localName: '',
  serviceUuids: [],
  ...p,
});

describe('matchesDescriptor', () => {
  it('matches exact name case-insensitively', () => {
    const d: MatchDescriptor = { priority: 100, names: { exact: ['senssun fat'] } };
    expect(matchesDescriptor(dev({ localName: 'Senssun Fat' }), d)).toBe(true);
    expect(matchesDescriptor(dev({ localName: 'senssun fat scale' }), d)).toBe(false);
  });

  it('matches name substring (includes) but never on empty name', () => {
    const d: MatchDescriptor = { priority: 100, names: { includes: ['yunmai'] } };
    expect(matchesDescriptor(dev({ localName: 'MY Yunmai X' }), d)).toBe(true);
    expect(matchesDescriptor(dev({ localName: '' }), d)).toBe(false);
  });

  it('matches name prefix (startsWith)', () => {
    const d: MatchDescriptor = { priority: 100, names: { startsWith: ['01257b'] } };
    expect(matchesDescriptor(dev({ localName: '01257B1234' }), d)).toBe(true);
    expect(matchesDescriptor(dev({ localName: 'X01257B' }), d)).toBe(false);
  });

  it('matches advertised service uuid in short or full form', () => {
    const d: MatchDescriptor = { priority: 100, serviceUuids: ['ffb0'] };
    expect(matchesDescriptor(dev({ serviceUuids: ['ffb0'] }), d)).toBe(true);
    expect(matchesDescriptor(dev({ serviceUuids: [uuid16(0xffb0)] }), d)).toBe(true);
    expect(matchesDescriptor(dev({ serviceUuids: ['FFB0'] }), d)).toBe(true);
  });

  it('matches a full 128-bit custom service uuid ignoring dashes', () => {
    const d: MatchDescriptor = {
      priority: 100,
      serviceUuids: ['f433bd8075b811e297d90002a5d5c51b'],
    };
    expect(
      matchesDescriptor(dev({ serviceUuids: ['f433bd80-75b8-11e2-97d9-0002a5d5c51b'] }), d),
    ).toBe(true);
  });

  it('matches a post-discovery characteristic uuid', () => {
    const d: MatchDescriptor = { priority: 100, charUuids: ['fff4'] };
    expect(matchesDescriptor(dev({ characteristicUuids: [uuid16(0xfff4)] }), d)).toBe(true);
    expect(matchesDescriptor(dev({ characteristicUuids: [] }), d)).toBe(false);
  });

  it('does not match when no claim hits', () => {
    const d: MatchDescriptor = { priority: 100, names: { exact: ['nope'] }, serviceUuids: ['1234'] };
    expect(matchesDescriptor(dev({ localName: 'other', serviceUuids: ['abcd'] }), d)).toBe(false);
  });

  it('descriptorNameTokens unions all name buckets', () => {
    const d: MatchDescriptor = {
      priority: 100,
      names: { exact: ['a'], includes: ['b'], startsWith: ['c'] },
    };
    expect(descriptorNameTokens(d).sort()).toEqual(['a', 'b', 'c']);
  });

  it('uuidClaimHits handles undefined device uuids', () => {
    expect(uuidClaimHits(['fff0'], undefined)).toBe(false);
    expect(uuidClaimHits(['fff0'], ['fff0'])).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (bash): `taskkill //F //IM node.exe 2>/dev/null; npx vitest run tests/scales/match-descriptor.test.ts`
Expected: FAIL - `Cannot find module '../../src/scales/match-descriptor.js'`.

- [ ] **Step 3: Write the implementation**

```typescript
import type { BleDeviceInfo } from '../interfaces/scale-adapter.js';

/** Name predicates an adapter claims. All tokens MUST be lowercase. */
export interface NameClaim {
  /** Full-name equality (device name === token). */
  exact?: string[];
  /** Substring (device name includes token). */
  includes?: string[];
  /** Prefix (device name starts with token). */
  startsWith?: string[];
}

/**
 * Declarative description of what a scale adapter claims, plus its precedence.
 *
 * `priority` is a unique total order across the registry (higher wins). It
 * replaces array position as the precedence mechanism, so the registry array
 * may be reordered without changing selection.
 *
 * `custom: true` marks adapters whose runtime `matches()` has logic this
 * descriptor cannot fully express (byte signatures, mutual exclusion, instance
 * side effects). The resolver still calls `matches()`; the descriptor is used
 * only for precedence ordering and for the overlap / exclusion analysis in
 * registry-check, where it represents the adapter's claims (a superset of the
 * names it can match).
 */
export interface MatchDescriptor {
  priority: number;
  names?: NameClaim;
  /** Advertised service UUIDs (16-bit short like 'fff0', or full 128-bit). */
  serviceUuids?: string[];
  /** Post-discovery characteristic UUIDs that positively identify the adapter. */
  charUuids?: string[];
  /** Manufacturer company id this adapter claims (a weak signal on its own). */
  manufacturerId?: number;
  custom?: boolean;
}

/** Lowercase and strip dashes from a UUID for comparison. */
function norm(u: string): string {
  return u.toLowerCase().replace(/-/g, '');
}

/** The Bluetooth SIG base UUID suffix; a 32-hex UUID using it is a 16-bit UUID. */
const SIG_BASE_SUFFIX = '00001000800000805f9b34fb';

/** Return the 16-bit form ('xxxx') if `n` is a SIG-based 128-bit UUID, else `n`. */
function to16(n: string): string {
  if (n.length === 32 && n.endsWith(SIG_BASE_SUFFIX) && n.startsWith('0000')) {
    return n.slice(4, 8);
  }
  return n;
}

/**
 * True if any claimed UUID equals any device UUID, comparing both raw
 * (dash-stripped, lowercase) and 16-bit-reduced forms so short ('fff0') and
 * full (uuid16(0xfff0)) advertisements match interchangeably.
 */
export function uuidClaimHits(claims: string[], deviceUuids: string[] | undefined): boolean {
  if (!deviceUuids || deviceUuids.length === 0) return false;
  const devSet = new Set<string>();
  for (const d of deviceUuids) {
    const n = norm(d);
    devSet.add(n);
    devSet.add(to16(n));
  }
  return claims.some((c) => {
    const n = norm(c);
    return devSet.has(n) || devSet.has(to16(n));
  });
}

/** Evaluate the common (data-expressible) match predicates. */
export function matchesDescriptor(device: BleDeviceInfo, d: MatchDescriptor): boolean {
  const name = (device.localName || '').toLowerCase();
  if (d.names) {
    if (name && d.names.exact?.includes(name)) return true;
    if (name && d.names.includes?.some((n) => name.includes(n))) return true;
    if (name && d.names.startsWith?.some((p) => name.startsWith(p))) return true;
  }
  if (d.serviceUuids && uuidClaimHits(d.serviceUuids, device.serviceUuids)) return true;
  if (d.charUuids && uuidClaimHits(d.charUuids, device.characteristicUuids)) return true;
  return false;
}

/** Union of every name token a descriptor claims (for exclusion / overlap analysis). */
export function descriptorNameTokens(d: MatchDescriptor): string[] {
  const n = d.names;
  if (!n) return [];
  return [...(n.exact ?? []), ...(n.includes ?? []), ...(n.startsWith ?? [])];
}
```

Note: `exact` is compared against the lowercased full name. `name &&` guards keep an empty name from matching `exact: ['']`-style edge cases and mirror current adapters that all derive from `localName || ''`.

- [ ] **Step 4: Run test to verify it passes**

Run (bash): `npx vitest run tests/scales/match-descriptor.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Typecheck, lint, format, commit**

```bash
taskkill //F //IM node.exe 2>/dev/null
npx tsc --noEmit && npm run lint && npx prettier --check src/scales/match-descriptor.ts tests/scales/match-descriptor.test.ts
git add src/scales/match-descriptor.ts tests/scales/match-descriptor.test.ts
git commit -m "feat(scales): add declarative MatchDescriptor and matchesDescriptor helper (#245)"
```

Expected: tsc/lint/prettier clean; commit succeeds.

---

## Task 2: Add `match` descriptor to the ScaleAdapter interface

**Files:**
- Modify: `src/interfaces/scale-adapter.ts` (add import + one interface member near `matches`)
- Test: covered by Task 3 onward (compile-time only here)

**Interfaces:**
- Consumes: `MatchDescriptor` from Task 1.
- Produces: `ScaleAdapter.match?: MatchDescriptor` (OPTIONAL member). Every PRODUCTION adapter declares it; `registry-check` (Task 5) errors if a registered adapter omits it. Optional keeps the strict-literal test mocks compiling untouched.

- [ ] **Step 1: Add the import at the top of `src/interfaces/scale-adapter.ts`**

Add after the existing top-of-file content (the file currently starts with `export type Gender`). Insert near the other type declarations a re-export-free import:

```typescript
import type { MatchDescriptor } from '../scales/match-descriptor.js';
```

Place this import as the FIRST line of the file (before `export type Gender = ...`). Then add `export type { MatchDescriptor };` immediately after it so existing `import ... from '../interfaces/scale-adapter.js'` consumers can pull the type from one place.

- [ ] **Step 2: Add the `match` member to the `ScaleAdapter` interface**

In the `ScaleAdapter` interface, immediately above the line `matches(device: BleDeviceInfo): boolean;` add:

```typescript
  /**
   * Declarative match descriptor: precedence (`priority`) plus the names,
   * services, characteristics, and manufacturer id this adapter claims.
   * OPTIONAL on the interface (so test mocks may omit it) but REQUIRED for every
   * adapter in the production registry, enforced by registry-check. The central
   * resolver orders adapters by `priority` and registry-check uses the claims
   * for overlap detection and to derive the generic adapter's exclusion set.
   * Adapters whose runtime predicate is not fully data expressible set
   * `custom: true` and keep a bespoke `matches()`.
   */
  readonly match?: MatchDescriptor;
```

- [ ] **Step 3: Verify the tree still compiles (member is optional)**

Run (bash): `taskkill //F //IM node.exe 2>/dev/null; npx tsc --noEmit`
Expected: CLEAN (the optional member breaks nothing). Tasks 3a/3b then add `match` to every production adapter; the registry-check presence rule (Task 5) is what guarantees no production adapter forgets it. Do NOT commit yet; commit at the end of Task 3b together with the adapter descriptors.

---

## Task 3a: Add `match` to the 16 pure-data adapters and reduce their `matches()`

**Files (modify each):**
`src/scales/renpho-es26bb.ts`, `sanitas-sbf72.ts`, `soehnle.ts`, `medisana-bs44x.ts`, `trisa.ts`, `exingtech-y1.ts`, `hesley.ts`, `hoffen.ts`, `senssun.ts`, `one-byone.ts` (OneByoneNewAdapter only), `excelvan-cf369.ts`, `digoo.ts`, `active-era.ts`, `es-cs20m.ts`, `mgb.ts`, `one-byone.ts` (OneByoneAdapter).

**Interfaces:**
- Consumes: `matchesDescriptor`, `MatchDescriptor` from Task 1.
- Produces: each listed adapter has `readonly match: MatchDescriptor` and a `matches()` body of exactly `return matchesDescriptor(device, this.match);`.

**Recipe (apply to every adapter in this task):**
1. Add to the adapter's import from `./match-descriptor.js`: `import { matchesDescriptor, type MatchDescriptor } from './match-descriptor.js';` (one new import line per file).
2. Add a `readonly match: MatchDescriptor = { ... }` class field (values from the table below).
3. Replace the entire `matches(device: BleDeviceInfo): boolean { ... }` body with `return matchesDescriptor(device, this.match);`. Keep any leading doc comment.
4. If the old `matches()` was the only consumer of a module-level constant array (e.g. `KNOWN_NAMES`, `KNOWN_PREFIXES`, `EXACT_NAMES`, `SVC_UUID`), inline those values into the descriptor and delete the now-unused constant to avoid an ESLint unused-var error. If the constant is still used elsewhere in the file, leave it.

**Descriptor values (priority is the unique total order; see Task 5 for why these numbers):**

| Adapter (`name`) | `match` descriptor |
|---|---|
| `Renpho ES-26BB` | `{ priority: 230, names: { exact: ['es-26bb-b'] } }` |
| `Sanitas SBF72/73` | `{ priority: 170, names: { includes: ['sbf72', 'sbf73', 'bf915'] } }` |
| `Soehnle Shape/Style` | `{ priority: 160, names: { startsWith: ['shape200', 'shape100', 'shape50', 'style100'] } }` |
| `Medisana BS44x` | `{ priority: 150, names: { exact: ['013197', '013198', '0202b6'], startsWith: ['0203b'] }, serviceUuids: ['78b2'] }` |
| `Trisa` | `{ priority: 140, names: { startsWith: ['01257b', '11257b'] } }` |
| `Exingtech Y1` | `{ priority: 120, names: { exact: ['vscale'] }, serviceUuids: ['f433bd8075b811e297d90002a5d5c51b'] }` |
| `Excelvan CF369` | `{ priority: 110, names: { exact: ['electronic scale'] } }` |
| `Hesley` | `{ priority: 100, names: { exact: ['yunchen'] } }` |
| `1byone (Eufy)` | `{ priority: 70, names: { includes: ['t9146', 't9147', 't9120', 'health scale'] }, charUuids: ['fff4'] }` |
| `1byone Scale (new)` | `{ priority: 60, names: { exact: ['1byone scale'] } }` |
| `Active Era BS-06` | `{ priority: 50, names: { includes: ['ae bs-06'] } }` |
| `MGB (Swan/Icomon/YG)` | `{ priority: 30, names: { startsWith: ['swan'], exact: ['icomon', 'yg'] }, serviceUuids: ['ffb0'] }` |
| `Hoffen BS-8107` | `{ priority: 20, names: { exact: ['hoffen bs-8107'] } }` |
| `Senssun Fat Scale` | `{ priority: 260, names: { exact: ['senssun fat'] } }` |
| `Digoo` | `{ priority: 80, names: { exact: ['mengii'] } }` |
| `ES-CS20M` | `{ priority: 130, names: { includes: ['es-cs20m', 'es-32md'], startsWith: ['113360_'] }, serviceUuids: ['1a10'] }` |

(Note: `1byone (Eufy)` uses name-includes OR char `fff4`. Its old `matches()` had no service branch, so the descriptor must NOT list `serviceUuids`; the plain OR in `matchesDescriptor` reproduces it exactly. `ES-CS20M` and `MGB` and `Medisana` and `Exingtech` keep their service fallback as `serviceUuids`. `Exingtech`'s service UUID is stored dash-free already; `uuidClaimHits` strips dashes from the device side too.)

- [ ] **Step 1: Apply the recipe to all 16 adapters.** For each file: add the import, add the `match` field, replace the `matches()` body, delete now-orphaned constants.

- [ ] **Step 2: Run every affected per-adapter test**

Run (bash):
```bash
taskkill //F //IM node.exe 2>/dev/null
npx vitest run tests/scales/renpho-es26bb.test.ts tests/scales/sanitas-sbf72.test.ts tests/scales/soehnle.test.ts tests/scales/medisana-bs44x.test.ts tests/scales/trisa.test.ts tests/scales/exingtech-y1.test.ts tests/scales/hesley.test.ts tests/scales/hoffen.test.ts tests/scales/senssun.test.ts tests/scales/excelvan-cf369.test.ts tests/scales/digoo.test.ts tests/scales/active-era.test.ts tests/scales/es-cs20m.test.ts tests/scales/mgb.test.ts tests/scales/one-byone.test.ts
```
Expected: ALL PASS. If any per-adapter test fails, the descriptor does not reproduce that adapter's predicate - fix the descriptor (do not weaken the test).

- [ ] **Step 3: Do NOT commit yet** - the custom adapters (Task 3b) still lack `match`, so `tsc --noEmit` is not green tree-wide. Proceed to Task 3b.

---

## Task 3b: Add `match` descriptors to the 11 custom adapters (keep bespoke `matches()`)

**Files (modify each):** `eufy-p2.ts`, `qn-scale.ts`, `renpho.ts`, `beurer-bf720.ts`, `mi-scale-2.ts`, `xiaomi-s800.ts`, `yunmai.ts`, `beurer-sanitas.ts`, `inlife.ts`, `robi-s9.ts`, `standard-gatt.ts`.

**Interfaces:**
- Consumes: `MatchDescriptor` type.
- Produces: each adapter has `readonly match: MatchDescriptor` with `custom: true`. Their `matches()` bodies are UNCHANGED in this task (standard-gatt is changed in Task 4).

**Recipe:** add `import type { MatchDescriptor } from './match-descriptor.js';` (or extend an existing match-descriptor import), then add the `match` field. Leave `matches()` as-is.

**Descriptor values (claims = a superset of what each custom `matches()` can match; `custom: true`):**

| Adapter (`name`) | `match` descriptor |
|---|---|
| `Eufy Smart Scale P2/P2 Pro` | `{ priority: 270, custom: true, names: { startsWith: ['eufy t9148', 'eufy t9149'], exact: ['eufy t9148', 'eufy t9149'] }, manufacturerId: 0xff48 }` |
| `QN Scale` | `{ priority: 250, custom: true, names: { includes: ['qn-scale', 'renpho', 'senssun', 'sencor'] }, serviceUuids: ['ae00', 'ffe0', 'fff0'], charUuids: ['ae01', 'ae02'], manufacturerId: 0xffff }` |
| `Renpho ES-WBE28` | `{ priority: 240, custom: true, names: { includes: ['renpho'] }, serviceUuids: ['181b', '181d'] }` |
| `Beurer BF720/BF105` | `{ priority: 220, custom: true, names: { includes: ['bf720', 'bf105'] }, serviceUuids: ['181d', '181b'], manufacturerId: 0x0611 }` |
| `Xiaomi Mi Scale 2` | `{ priority: 210, custom: true, names: { startsWith: ['mibcs', 'mibfs', 'mi scale', 'mi_scale'] }, serviceUuids: ['181b'] }` |
| `Xiaomi Mijia Scale S800` | `{ priority: 200, custom: true, names: { includes: ['mijia scale s800'] }, serviceUuids: ['fe95'] }` |
| `Yunmai` | `{ priority: 190, custom: true, names: { includes: ['yunmai'] } }` |
| `Beurer / Sanitas` | `{ priority: 180, custom: true, names: { includes: ['bf-700', 'beurer bf700', 'bf-800', 'beurer bf800', 'rt-libra-b', 'rt-libra-w', 'libra-b', 'libra-w', 'bf700', 'beurer bf710', 'sanitas sbf70', 'sbf75', 'aicdscale1'] } }` |
| `Inlife` | `{ priority: 90, custom: true, names: { exact: ['000fatscale01', '000fatscale02', '042fatscale01'] }, serviceUuids: ['fff0'], charUuids: ['fff2'] }` |
| `Robi S9` | `{ priority: 40, custom: true, names: { includes: ['robi'] }, serviceUuids: ['ffb0'], charUuids: ['ffb3'] }` |
| `Standard GATT (BCS/WSS)` | `{ priority: 0, custom: true, names: { includes: ['beurer', 'silvercrest', 'bf105', 'bf720', 'bf950', 'bf500', 'bf600', 'bf850', 'medisana'] }, serviceUuids: ['181b', '181d'] }` |

- [ ] **Step 1: Add the import + `match` field to all 11 adapters.** Do not modify their `matches()` bodies.

- [ ] **Step 2: Verify the whole tree compiles**

Run (bash): `taskkill //F //IM node.exe 2>/dev/null; npx tsc --noEmit`
Expected: CLEAN. If a `custom`/`priority` typo or a malformed descriptor literal remains, fix it.

- [ ] **Step 3: Run the full scales suite + the parity oracle**

Run (bash):
```bash
npx vitest run tests/scales/
```
Expected: ALL PASS, including `registry-collision.test.ts` and `adapter-resolution.test.ts` (still using `adapters.find((a) => a.matches(info))`; matches() behavior is unchanged so they must be green).

- [ ] **Step 4: Lint, format, commit Tasks 2+3a+3b together**

```bash
taskkill //F //IM node.exe 2>/dev/null
npm run lint && npx prettier --check "src/scales/*.ts" src/interfaces/scale-adapter.ts
npx prettier --write "src/scales/*.ts" src/interfaces/scale-adapter.ts   # if check failed
git add src/interfaces/scale-adapter.ts src/scales/
git commit -m "refactor(scales): declare a MatchDescriptor on every adapter (#245)"
```

Expected: clean; commit succeeds. (`git add src/scales/` stages only source; it does NOT touch `docs/superpowers/plans`.)

---

## Task 4: Derive standard-gatt exclusion from registry claims

**Files:**
- Modify: `src/scales/standard-gatt.ts` (replace the hand-maintained `EXCLUDED` array; change `matches()` to consult derived exclusions)
- Create: `src/scales/derived-excludes.ts` (computes the exclusion token set from the registry)
- Test: `tests/scales/standard-gatt-excludes.test.ts`

**Interfaces:**
- Consumes: `adapters` registry, `descriptorNameTokens` (Task 1).
- Produces: `function genericExcludedNameTokens(registry: readonly ScaleAdapter[]): string[]` - every name token claimed by a non-generic adapter that declares a `match`, plus the small `LEGACY_BROAD_EXCLUDES` supplement (documented below).

**Why a supplement:** the current `EXCLUDED` list uses broader substrings than some adapters' precise claims (e.g. `EXCLUDED` has `bf710` while Beurer claims `beurer bf710`; `es-26bb` vs `es-26bb-b`; `rt-libra` vs `rt-libra-b/-w`; `aicdscale` vs `aicdscale1`; `000fatscale`/`042fatscale` vs the `...01/...02` exact names; `sbf70` vs `sanitas sbf70`; `hoffen` vs `hoffen bs-8107`). A device literally named `bf710` (no vendor prefix) must still be kept away from the generic adapter even though no specific adapter matches that bare name in that advert. So derivation = (union of claimed tokens) PLUS a small explicit `LEGACY_BROAD_EXCLUDES` for the broad substrings that have no shorter-or-equal claim equivalent. This shrinks the hand-maintained list from 51 entries to 8 genuinely-broader tokens, and a test pins the full legacy set so nothing is silently dropped.

**Why no init injection (cycle-safe live binding):** `src/scales/index.ts` already imports `standard-gatt.ts`, so `standard-gatt.ts` cannot eagerly call into a fully-built registry at module-eval time. But it CAN import the live binding `import { adapters } from './index.js'` and read it lazily inside `matches()` (memoized on first call). By the time any `matches()` runs, `index.ts` has finished building `adapters`. This also works in `tests/scales/standard-gatt.test.ts`, which imports `standard-gatt.js` directly: that import transitively loads `index.js` (because standard-gatt now imports it), so `adapters` is populated and the exclusion derivation runs even though the test never imports `index.js` itself. (An earlier "lazy setter populated only by index.ts" idea is REJECTED: Vitest isolates module graphs per test file, so a setter called only from `index.ts` would never run in `standard-gatt.test.ts`, leaving exclusion a no-op and failing that file's `matches('QN-Scale',['181b']) === false` and `matches('Yunmai ISM',['181b']) === false` assertions.)

- [ ] **Step 1: Write the failing test (parity oracle for exclusions)**

```typescript
import { describe, it, expect } from 'vitest';
import { adapters } from '../../src/scales/index.js';
import { genericExcludedNameTokens } from '../../src/scales/derived-excludes.js';

// The exact legacy EXCLUDED list that standard-gatt.ts carried before #245.
// Every one of these names MUST remain excluded from the generic adapter.
const LEGACY_EXCLUDED = [
  'qn-scale', 'renpho', 'senssun', 'sencor', 'yunmai', 'mibcs', 'mibfs', 'mi_scale', 'mi scale',
  'es-26bb', 'es-cs20m', 'es-32md', '113360_', 'mengii', 'yunchen', 'vscale', 'electronic scale',
  '1byone scale', 'health scale', 't9120', 't9146', 't9147', 'ae bs-06', 'hoffen', 'swan', 'icomon',
  'shape200', 'shape100', 'shape50', 'style100', '01257b', '11257b', '000fatscale', '042fatscale',
  'bf-700', 'bf-800', 'rt-libra', 'libra-b', 'libra-w', 'bf700', 'bf710', 'sbf70', 'sbf72', 'sbf73',
  'sbf75', 'bf915', 'aicdscale', '013197', '013198', '0202b6', '0203b',
];

describe('genericExcludedNameTokens (#245 EXCLUDED derivation)', () => {
  const tokens = genericExcludedNameTokens(adapters);

  it('keeps every legacy-excluded name excluded (substring containment)', () => {
    // A legacy token L is still excluded if some derived token T satisfies
    // L.includes(T) (the generic check is name.includes(token), so a shorter or
    // equal derived token still rejects any name containing the legacy token).
    const missing = LEGACY_EXCLUDED.filter((l) => !tokens.some((t) => l.includes(t)));
    expect(missing, `Legacy excluded names no longer excluded: ${missing.join(', ')}`).toEqual([]);
  });

  it('does not exclude a plain generic name', () => {
    expect(tokens.some((t) => 'genericscale'.includes(t))).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run (bash): `taskkill //F //IM node.exe 2>/dev/null; npx vitest run tests/scales/standard-gatt-excludes.test.ts`
Expected: FAIL - `Cannot find module '../../src/scales/derived-excludes.js'`.

- [ ] **Step 3: Implement the derivation**

```typescript
import type { ScaleAdapter } from '../interfaces/scale-adapter.js';
import { descriptorNameTokens } from './match-descriptor.js';

/**
 * Broad legacy substrings the generic adapter excluded that have no exact
 * equivalent in any specific adapter's claims (the claims are precise: e.g.
 * Beurer claims 'beurer bf710', not the bare 'bf710'; Renpho ES-26BB claims
 * 'es-26bb-b', not 'es-26bb'). Keeping these few tokens preserves the pre-#245
 * guarantee that a bare-branded device never falls to the generic parser.
 */
export const LEGACY_BROAD_EXCLUDES = [
  'es-26bb',
  '000fatscale',
  '042fatscale',
  'rt-libra',
  'bf710',
  'sbf70',
  'aicdscale',
  'hoffen',
];

/**
 * Name tokens the generic StandardGattScaleAdapter must NOT match: every name
 * token claimed by any other (non-generic) adapter that declares a `match`,
 * plus the legacy broad substrings above. Derived from the registry so adding
 * an adapter automatically extends the exclusion set; no hand-maintained
 * 51-entry list. Adapters with `priority === 0` (the generic adapter) and any
 * adapter lacking a `match` are skipped.
 */
export function genericExcludedNameTokens(registry: readonly ScaleAdapter[]): string[] {
  const tokens = new Set<string>(LEGACY_BROAD_EXCLUDES);
  for (const a of registry) {
    if (!a.match || a.match.priority === 0) continue; // skip generic / matchless
    for (const t of descriptorNameTokens(a.match)) tokens.add(t);
  }
  return [...tokens];
}
```

- [ ] **Step 4: Rewrite `standard-gatt.ts` `matches()` to use the derived set (cycle-safe live binding)**

In `src/scales/standard-gatt.ts`:
1. Delete the module-level `EXCLUDED` array (the 51-entry list).
2. Add the live-binding import of the registry plus the derivation helper. The cycle `index.ts -> standard-gatt.ts -> index.ts` is benign because `adapters` is only READ at runtime inside `matches()`, by which point `index.ts` has finished constructing it. Memoize so the derivation runs once.

Concretely, add to `standard-gatt.ts`:

```typescript
import { adapters } from './index.js';
import { genericExcludedNameTokens } from './derived-excludes.js';

// Excluded name tokens, derived once (lazily) from the full registry. Reading
// `adapters` here is a deliberate import cycle (index.ts -> standard-gatt.ts ->
// index.ts); it is safe because the read happens at call time, after index.ts
// has finished building the array. Memoized so derivation runs only once.
let excludedTokens: string[] | null = null;
function getExcludedTokens(): string[] {
  if (excludedTokens === null) excludedTokens = genericExcludedNameTokens(adapters);
  return excludedTokens;
}
```

Then the new `matches()`:

```typescript
  matches(device: BleDeviceInfo): boolean {
    const name = (device.localName || '').toLowerCase();
    if (name && getExcludedTokens().some((e) => name.includes(e))) return false;

    const uuids = (device.serviceUuids || []).map((u) => u.toLowerCase());
    const hasBcs = uuids.some((u) => u === SVC_BODY_COMP_SHORT || u === uuid16(0x181b));
    const hasWss = uuids.some((u) => u === SVC_WEIGHT_SHORT || u === uuid16(0x181d));
    if (hasBcs || hasWss) return true;

    return KNOWN_NAMES.some((n) => name.includes(n));
  }
```

(Keep `KNOWN_NAMES`: it is the generic adapter's own positive name claims, also mirrored in its descriptor.)

- [ ] **Step 5: No registry wiring needed**

The live-binding import in Step 4 needs NO change to `index.ts` (no `initGenericExcludes` injection). Confirm `src/scales/index.ts` still imports `StandardGattScaleAdapter` (it does) and that nothing else is required here. Verify there is no eager top-level read of `adapters` inside `standard-gatt.ts` (only inside `getExcludedTokens()` / `matches()`), otherwise the cycle would throw at module load.

- [ ] **Step 6: Run exclusion test + standard-gatt test + parity oracle**

Run (bash):
```bash
taskkill //F //IM node.exe 2>/dev/null
npx tsc --noEmit && npx vitest run tests/scales/standard-gatt-excludes.test.ts tests/scales/standard-gatt.test.ts tests/scales/registry-collision.test.ts tests/scales/adapter-resolution.test.ts
```
Expected: ALL PASS, including the existing `standard-gatt.test.ts` exclusion cases (`matches('QN-Scale',['181b'])===false`, `matches('Yunmai ISM',['181b'])===false`) which prove the live-binding derivation runs even when the file is imported in isolation. The collision oracle proves the derived exclusion preserves selection.

- [ ] **Step 7: Lint, format, commit**

```bash
npm run lint && npx prettier --check src/scales/derived-excludes.ts src/scales/standard-gatt.ts tests/scales/standard-gatt-excludes.test.ts
git add src/scales/derived-excludes.ts src/scales/standard-gatt.ts tests/scales/standard-gatt-excludes.test.ts
git commit -m "refactor(scales): derive generic-adapter exclusions from registry claims (#245)"
```

---

## Task 5: Central resolver and startup invariant + overlap checks

**Files:**
- Create: `src/scales/resolve.ts` (`resolveAdapter`)
- Modify: `src/scales/registry-check.ts` (add priority-invariant assertions + overlap detection)
- Modify: `src/scales/index.ts` (export `resolveAdapter`; sort/validate at startup)
- Test: `tests/scales/resolve.test.ts`, extend `tests/scales/registry-check.test.ts`

**Interfaces:**
- Consumes: `adapters`, `ScaleAdapter`, `BleDeviceInfo`, `matchesDescriptor`/`descriptorNameTokens`.
- Produces:
  - `function resolveAdapter(device: BleDeviceInfo, registry?: readonly ScaleAdapter[]): ScaleAdapter | undefined`
  - extended `checkRegistryIntegrity()` returning errors for: duplicate priority, generic not unique-min, violated named invariants, and overlapping claims without a priority gap.

- [ ] **Step 1: Write the resolver test (parity with `adapters.find(matches)`)**

```typescript
import { describe, it, expect } from 'vitest';
import { adapters } from '../../src/scales/index.js';
import { resolveAdapter } from '../../src/scales/resolve.js';
import { uuid16 } from '../../src/scales/body-comp-helpers.js';
import type { BleDeviceInfo } from '../../src/interfaces/scale-adapter.js';

describe('resolveAdapter', () => {
  // The full set of fixtures from registry-collision.test.ts; resolveAdapter
  // MUST agree with adapters.find((a) => a.matches(info)) for each.
  const fixtures: BleDeviceInfo[] = [
    { localName: 'eufy T9149', serviceUuids: [] },
    { localName: 'QN-Scale', serviceUuids: ['fff0'] },
    { localName: 'Fit Plus', serviceUuids: [uuid16(0xfff0), uuid16(0xae00)] },
    {
      localName: 'eufy T9146',
      serviceUuids: [uuid16(0xfff0)],
      characteristicUuids: [uuid16(0xfff1), uuid16(0xfff4)],
    },
    {
      localName: '000fatscale01',
      serviceUuids: [uuid16(0xfff0)],
      characteristicUuids: [uuid16(0xfff1), uuid16(0xfff2)],
    },
    { localName: 'BF720', serviceUuids: [uuid16(0x181b)] },
    { localName: 'MIBFS', serviceUuids: [] },
    { localName: 'GenericScale', serviceUuids: ['181d'] },
    { localName: 'icomon', serviceUuids: [] },
    { localName: 'Robi S9', serviceUuids: [] },
  ];

  it('agrees with adapters.find(matches) on every fixture', () => {
    for (const info of fixtures) {
      const viaFind = adapters.find((a) => a.matches(info));
      const viaResolve = resolveAdapter(info);
      expect(viaResolve?.name, `mismatch for ${info.localName}`).toBe(viaFind?.name);
    }
  });

  it('returns undefined when nothing matches', () => {
    expect(resolveAdapter({ localName: 'totally-unknown', serviceUuids: [] })).toBeUndefined();
  });

  it('selects strictly by priority, independent of registry array order', () => {
    const shuffled = [...adapters].reverse();
    const info: BleDeviceInfo = { localName: 'QN-Scale', serviceUuids: ['fff0'] };
    expect(resolveAdapter(info, shuffled)?.name).toBe(resolveAdapter(info, adapters)?.name);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run (bash): `taskkill //F //IM node.exe 2>/dev/null; npx vitest run tests/scales/resolve.test.ts`
Expected: FAIL - `Cannot find module '../../src/scales/resolve.js'`.

- [ ] **Step 3: Implement `resolveAdapter`**

```typescript
import type { BleDeviceInfo, ScaleAdapter } from '../interfaces/scale-adapter.js';
import { adapters as defaultRegistry } from './index.js';

/**
 * Select the adapter for a device. Candidates in the GIVEN registry are ordered
 * by descriptor `priority` (higher wins) rather than array position, then the
 * first whose `matches()` returns true is returned. A missing `match` defaults
 * to priority 0; `Array.prototype.sort` is STABLE in V8/Node, so adapters that
 * tie (e.g. mock lists in tests where none declare a `match`) keep their input
 * order, making this behaviorally identical to the old
 * `registry.find((a) => a.matches(info))`. This is the single precedence
 * authority that replaces the scattered `adapters.find(...)` calls.
 */
export function resolveAdapter(
  device: BleDeviceInfo,
  registry: readonly ScaleAdapter[] = defaultRegistry,
): ScaleAdapter | undefined {
  const prio = (a: ScaleAdapter): number => a.match?.priority ?? 0;
  const ordered = [...registry].sort((a, b) => prio(b) - prio(a));
  return ordered.find((a) => a.matches(device));
}
```

(Importing `adapters` from `./index.js` as the default registry is one-way: `index.ts` does NOT import `resolve.ts` (see Task 5 Step 7, which deliberately does NOT re-export `resolveAdapter` from `index.ts`), so there is no cycle. Production handlers always pass their own registry explicitly, so the default is used only by the scales-module unit tests.)

- [ ] **Step 4: Run the resolver test**

Run (bash): `npx vitest run tests/scales/resolve.test.ts`
Expected: PASS (3 tests). If "selects strictly by priority" fails, two adapters share a priority - fix the descriptor numbers.

- [ ] **Step 5: Extend `registry-check.ts` with invariants + overlap detection**

Add to `checkRegistryIntegrity()` (after the existing duplicate-name and generic-last checks), and KEEP the existing checks:

```typescript
  // Every registered adapter MUST declare a match descriptor (the member is
  // optional on the interface only so test mocks can omit it).
  for (const a of adapters) {
    if (!a.match) {
      errors.push(`Adapter "${a.name}" is missing a match descriptor (required in the registry).`);
    }
  }
  // Work only with adapters that declared a descriptor; the loop above already
  // recorded an error for any that did not.
  const withMatch = adapters.filter(
    (a): a is ScaleAdapter & { match: MatchDescriptor } => a.match !== undefined,
  );

  // Priorities must be a unique total order; the resolver relies on it.
  const prioritySeen = new Map<number, string>();
  for (const a of withMatch) {
    const prev = prioritySeen.get(a.match.priority);
    if (prev !== undefined) {
      errors.push(
        `Duplicate match.priority ${a.match.priority} on "${a.name}" and "${prev}". ` +
          `Priorities must be unique so selection is deterministic.`,
      );
    } else {
      prioritySeen.set(a.match.priority, a.name);
    }
  }

  // The generic adapter must be the unique lowest priority.
  if (withMatch.length > 0) {
    const minPriority = Math.min(...withMatch.map((a) => a.match.priority));
    const generic = withMatch.find((a) => a instanceof StandardGattScaleAdapter);
    if (generic && generic.match.priority !== minPriority) {
      errors.push(
        `StandardGattScaleAdapter must have the lowest match.priority; it has ` +
          `${generic.match.priority} but the minimum is ${minPriority}.`,
      );
    }
  }

  // Documented ordering invariants, expressed as data (priority comparisons)
  // rather than array position. Each pair: [higher-precedence, lower].
  const byName = new Map(withMatch.map((a) => [a.name, a] as const));
  const INVARIANTS: ReadonlyArray<readonly [string, string]> = [
    ['Senssun Fat Scale', 'QN Scale'],
    ['Eufy Smart Scale P2/P2 Pro', 'QN Scale'],
    ['QN Scale', 'Renpho ES-WBE28'],
    ['Beurer BF720/BF105', 'Xiaomi Mi Scale 2'],
    ['Robi S9', 'MGB (Swan/Icomon/YG)'],
  ];
  for (const [hi, lo] of INVARIANTS) {
    const a = byName.get(hi);
    const b = byName.get(lo);
    if (!a || !b) continue; // a missing/renamed adapter is caught elsewhere
    if (a.match.priority <= b.match.priority) {
      errors.push(
        `Ordering invariant violated: "${hi}" (priority ${a.match.priority}) must ` +
          `outrank "${lo}" (priority ${b.match.priority}).`,
      );
    }
  }

  // Overlap detection: two NON-custom adapters that claim the same name token or
  // service UUID would shadow each other on descriptor data alone, with no
  // bespoke disambiguator. That is an error. Overlaps where at least one side is
  // `custom` (its matches() applies extra char/byte/exclusion logic) are
  // EXPECTED and intentionally NOT flagged, so the live registry produces zero
  // warnings and the existing `expect(warnings).toEqual([])` test stays green;
  // those custom-disambiguated overlaps are covered by the fixture-based
  // registry-collision.test.ts instead. The generic adapter overlaps many by
  // design and is skipped.
  for (let i = 0; i < withMatch.length; i++) {
    for (let j = i + 1; j < withMatch.length; j++) {
      const a = withMatch[i];
      const b = withMatch[j];
      if (a instanceof StandardGattScaleAdapter || b instanceof StandardGattScaleAdapter) continue;
      if (a.match.custom || b.match.custom) continue;
      const aNames = new Set(descriptorNameTokens(a.match));
      const sharedName = descriptorNameTokens(b.match).some((t) => aNames.has(t));
      const aSvc = new Set((a.match.serviceUuids ?? []).map((u) => u.toLowerCase()));
      const sharedSvc = (b.match.serviceUuids ?? []).some((u) => aSvc.has(u.toLowerCase()));
      if (!sharedName && !sharedSvc) continue;
      errors.push(
        `Adapters "${a.name}" and "${b.name}" claim the same name/service with ` +
          `no custom disambiguator. One will shadow the other.`,
      );
    }
  }
```

Add the imports at the top of `registry-check.ts`:

```typescript
import type { MatchDescriptor } from './match-descriptor.js';
import { descriptorNameTokens } from './match-descriptor.js';
```

Note: error-only (no `warnings.push`) for overlap keeps `tests/scales/registry-check.test.ts`'s `expect(warnings).toEqual([])` and `expect(assertRegistryIntegrity(adapters)).toEqual([])` green. Verified: no two non-custom (pure) adapters share a name token or service UUID in the current registry (pure service claims are `78b2`, `f433...`, `1a10`, `ffb0`; `ffb0` is also claimed by Robi which is `custom`, so that pair is skipped), so `errors` stays empty for the real registry.

- [ ] **Step 6: Extend `tests/scales/registry-check.test.ts`**

Add cases asserting: (a) the real registry passes `assertRegistryIntegrity` with no thrown error; (b) a synthetic registry with two equal priorities yields a duplicate-priority error; (c) a synthetic registry violating an invariant (e.g. QN priority above Senssun) yields an invariant error. Use minimal fake adapters implementing `ScaleAdapter` (reuse the pattern already in that test file; read it first to match its existing helpers).

```typescript
import { adapters } from '../../src/scales/index.js';
import { assertRegistryIntegrity, checkRegistryIntegrity } from '../../src/scales/registry-check.js';

it('the production registry passes integrity checks', () => {
  expect(() => assertRegistryIntegrity(adapters)).not.toThrow();
});
```

(For the synthetic-failure cases, construct objects of type `ScaleAdapter` with distinct `name` and `match.priority` values; only `match`, `name`, and `instanceof` matter for these checks, so a cast like `as unknown as ScaleAdapter` over a minimal literal is acceptable in the test.)

- [ ] **Step 7: Confirm startup integrity wiring (do NOT re-export resolveAdapter from index)**

1. Do NOT add `export { resolveAdapter } from './resolve.js';` to `src/scales/index.ts`. That would create the cycle `index.ts -> resolve.ts -> index.ts`. Handlers import `resolveAdapter` directly from `src/scales/resolve.js` (Task 6). Keeping `resolve.ts` out of `index.ts`'s import graph is what makes `resolve.ts`'s `import { adapters } from './index.js'` one-way and cycle-free.
2. `assertRegistryIntegrity(adapters)` is ALREADY called at startup in `src/index.ts:182` (verified; note it is the app entry `src/index.ts`, not `src/scales/index.ts`). The new checks therefore run automatically at process start. Do not add a second call. (Confirm with `grep -rn assertRegistryIntegrity src/`.)

- [ ] **Step 8: Run resolver + registry-check tests + full scales suite**

Run (bash):
```bash
taskkill //F //IM node.exe 2>/dev/null
npx tsc --noEmit && npx vitest run tests/scales/
```
Expected: ALL PASS (including `registry-check.test.ts` with its zero-warning assertion).

- [ ] **Step 9: Lint, format, commit**

```bash
npm run lint && npx prettier --check src/scales/resolve.ts src/scales/registry-check.ts tests/scales/resolve.test.ts tests/scales/registry-check.test.ts
git add src/scales/resolve.ts src/scales/registry-check.ts tests/scales/resolve.test.ts tests/scales/registry-check.test.ts
git commit -m "feat(scales): central resolveAdapter with priority-based precedence and startup overlap detection (#245)"
```

---

## Task 6: Switch the 15 production call sites to `resolveAdapter`

**Files (modify):**
- `src/ble/handler-noble-shared.ts` (4 sites: 287, 460, 529, 596; `adapters` is a parameter)
- `src/ble/handler-node-ble/discovery.ts` (209; parameter)
- `src/ble/handler-node-ble/scan.ts` (219, 266, 519; parameter)
- `src/ble/handler-mqtt-proxy/scan.ts` (152, 262; parameter)
- `src/ble/handler-mqtt-proxy/watcher.ts` (200, 434; `this.adapters` field)
- `src/ble/handler-esphome-proxy/watcher.ts` (109; `this.adapters` field)
- `src/ble/handler-esphome-proxy/scan.ts` (95, 207; parameter)

**Interfaces:**
- Consumes: `resolveAdapter` from `src/scales/resolve.js`. Each file needs a NEW import (none of them import the `adapters` module, so there is nothing to drop). Use the correct relative depth: from `src/ble/handler-*.ts` it is `'../scales/resolve.js'`; from `src/ble/handler-*/<file>.ts` (one directory deeper) it is `'../../scales/resolve.js'`.

- [ ] **Step 1: For each single-line site, replace `<reg>.find((a) => a.matches(<arg>))` with `resolveAdapter(<arg>, <reg>)`**

`<reg>` is the in-scope registry: the `adapters` PARAMETER, or `this.adapters` for the two field-based files. `<arg>` is the device-info variable at that site (`info`, `preInfo`, etc.). ALWAYS pass `<reg>` as the second argument; passing none would switch to the default module registry and break the `tests/ble/*` suites that inject mock adapter lists. Keep the same left-hand-side variable name. Add the `resolveAdapter` import (correct relative depth per above).

Example: `const matched = adapters.find((a) => a.matches(info));` becomes `const matched = resolveAdapter(info, adapters);`. Field example: `const adapter = this.adapters.find((a) => a.matches(info));` becomes `const adapter = resolveAdapter(info, this.adapters);`.

SPECIAL CASE `handler-mqtt-proxy/watcher.ts:434-445`: this is a multi-line `this.adapters.find((a) => { if (a.matches(info)) return true; if (a.charNotifyUuid && <chars include charNotifyUuid>) return true; return false; })` - a per-adapter OR of `matches()` and a charNotify check, evaluated in array order. Read lines 430-446 first. Do NOT split it into `resolveAdapter(info)` followed by a separate charNotify fallback (that changes precedence: it would let a low-priority `matches()` win over an earlier-array charNotify match). Instead preserve the combined per-adapter OR while moving precedence to priority order:

```typescript
const adapter = [...this.adapters]
  .sort((a, b) => (b.match?.priority ?? 0) - (a.match?.priority ?? 0))
  .find((a) => {
    if (a.matches(info)) return true;
    if (a.charNotifyUuid && /* existing chars-include-charNotifyUuid condition, verbatim */) {
      return true;
    }
    return false;
  });
```

(Copy the existing inner charNotify condition exactly; only the surrounding sort + find wrapper changes. This keeps mock lists working via the stable sort and matches `resolveAdapter`'s ordering.)

- [ ] **Step 2: Typecheck**

Run (bash): `taskkill //F //IM node.exe 2>/dev/null; npx tsc --noEmit`
Expected: CLEAN. If a site still references an unused symbol, fix it (no `adapters` module import exists to remove).

- [ ] **Step 3: Run the BLE handler suites + full test run**

Run (bash):
```bash
npx vitest run tests/ble/ tests/scales/
```
Expected: ALL PASS. These handler tests exercise the selection path; they confirm the resolver is behavior-equivalent in production wiring.

- [ ] **Step 4: Full suite + lint + format**

Run (bash):
```bash
taskkill //F //IM node.exe 2>/dev/null
npm test && npm run lint && npx prettier --check "src/ble/**/*.ts"
```
Expected: full suite green (~1756+ tests), lint clean, prettier clean.

- [ ] **Step 5: Commit**

```bash
git add src/ble/
git commit -m "refactor(ble): route adapter selection through resolveAdapter (#245)"
```

---

## Task 7: Final verification and cleanup

**Files:** none new; verification only.

- [ ] **Step 1: Confirm the scattered `<reg>.find((a) => a.matches(...))` selection pattern is gone from handlers**

Run (bash): `grep -rn "find((a) => a.matches(" src/ble/`
Expected: NO matches in `src/ble/` (all single-line sites now call `resolveAdapter`). The ONLY remaining inline `a.matches(` in `src/ble/` is the preserved combined-OR predicate in `handler-mqtt-proxy/watcher.ts` (the sort+find wrapper from Task 6), which is intentional. `resolveAdapter`'s own internal `.find((a) => a.matches(device))` lives in `src/scales/resolve.ts` and the adapters' own `matches()` definitions remain.

- [ ] **Step 2: Confirm the hand-maintained EXCLUDED array is gone**

Run (bash): `grep -n "EXCLUDED" src/scales/standard-gatt.ts || echo "EXCLUDED removed"`
Expected: `EXCLUDED removed`.

- [ ] **Step 3: Full gate**

Run (bash):
```bash
taskkill //F //IM node.exe 2>/dev/null
npx tsc --noEmit && npm run lint && npm test && npx prettier --check "src/**/*.ts" "tests/**/*.ts"
```
Expected: all green. Capture the test count.

- [ ] **Step 4: Verify the parity oracle explicitly**

Run (bash): `npx vitest run tests/scales/registry-collision.test.ts tests/scales/adapter-resolution.test.ts`
Expected: PASS. This is the proof that selection behavior is unchanged.

- [ ] **Step 5: Push to dev**

```bash
git push origin dev
```

---

## Acceptance criteria mapping (from issue #245)

1. "Ordering invariants are expressed as data and checked at startup, not array position." → `match.priority` numbers + the `INVARIANTS` priority-comparison checks and unique-priority + generic-min checks in `registry-check.ts`. `resolveAdapter` sorts by priority, proven order-independent by the resolver test. (Tasks 3, 5)
2. "standard-gatt.ts no longer carries a hand-maintained name exclusion list." → `EXCLUDED` deleted; `genericExcludedNameTokens` derives the set from registry claims, with a small documented `LEGACY_BROAD_EXCLUDES` supplement pinned by the parity test. (Task 4)
3. "An overlapping match between two adapters is detected by registry-check rather than discovered in the field." → pairwise claim-overlap detection in `checkRegistryIntegrity` errors on undisambiguated overlaps between non-custom adapters; custom-disambiguated overlaps are expected and covered by the fixture-based `registry-collision.test.ts`. (Task 5)

## Open design notes for the reviewer

- The `LEGACY_BROAD_EXCLUDES` supplement is a deliberate tradeoff: full elimination of every hand-written token would require either widening adapter name claims (which would break their precise `matches()` predicates) or running hypothetical-name matching. The supplement (8 tokens vs the original 51) plus the legacy-set parity test is the minimal-risk way to satisfy acceptance #2 while preserving behavior. Flag if a fuller derivation is wanted.
- `custom: true` adapters keep bespoke `matches()`. The descriptor for them is a claims SUPERSET used only for ordering + overlap analysis. An alternative (fully descriptor-driven matching with a `matchExtra()` escape hatch) was rejected as higher-risk for identical acceptance outcomes; revisit if the reviewer prefers it.
- The import cycle in Task 4 is `index.ts -> standard-gatt.ts -> index.ts`, made safe by reading `adapters` only at call time (memoized) inside `standard-gatt.ts`. This was chosen over an `initGenericExcludes` injection because Vitest module-graph isolation would leave the injection un-run in `standard-gatt.test.ts`.
- `match` is optional on the interface (so strict-literal test mocks compile) but required for every production adapter, enforced by the registry-check presence rule. The resolver defends against a missing `match` with `?? 0` + stable sort.

## Implementation deviations (recorded post-build)

- Task 4 cycle handling: the live-binding `import { adapters } from './index.js'` in `standard-gatt.ts` was NOT used. It crashed (`StandardGattScaleAdapter is not a constructor`) because `index.ts` constructs the generic adapter eagerly, so when `standard-gatt.ts` is the import entry the class is still in its TDZ during the cycle. Replaced with a registry-provider in `derived-excludes.ts` (`registerExclusionRegistry` called from `index.ts`; `standard-gatt.ts` imports only `derived-excludes.js`, no cycle). `standard-gatt.test.ts` gets a side-effect `import '../../src/scales/index.js'` so the registry is registered when the file runs in isolation.
- Task 4 exclusion semantics: a post-implementation review found that flattening every claim into a substring exclude over-excluded generic devices (e.g. MGB's `exact: ['yg']` rejected a generic scale named "MyGym"). Fixed by deriving a structured `GenericExcludes { exact, includes, startsWith }` and applying each claim with its original semantics (`exact` = full-name equality, `startsWith` = prefix, `includes` plus legacy broad tokens = substring). A regression test pins the "MyGym"/"Oxygym" case.
```
