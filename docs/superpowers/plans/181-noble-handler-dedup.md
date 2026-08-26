# Plan: #181 deduplicate handler-noble and handler-noble-legacy

## Problem

`src/ble/handler-noble.ts` and `src/ble/handler-noble-legacy.ts` are ~600 lines
each and byte-for-byte identical except for the imported Noble package and the
adapter-state read. Every Noble-path fix must be applied twice (drift risk,
recurring maintenance cost).

## Exact diff between the two files

`diff` shows only these differences:

1. Import source: `@stoprocent/noble` (handler-noble) vs `@abandonware/noble`
   (handler-noble-legacy), for both the default import and the
   `Peripheral, Characteristic, Service` type import.
2. `waitForPoweredOn()` reads `noble.state` (stoprocent) vs `noble._state`
   (abandonware) at two sites (lines 37 and 58).
3. Two doc-comment lines (cosmetic): "Uses noble — works on Windows and macOS"
   vs "Uses @abandonware/noble — works on Windows, macOS, and Linux".

## Critical correctness note: state read is NOT interchangeable

This is the one trap. Both packages expose a `get state()` accessor with a
**lazy-init side effect**:

- `@abandonware/noble` (node_modules/@abandonware/noble/lib/noble.js:71-82):
  reading `.state` triggers `this._bindings.init()` on first access. The legacy
  handler deliberately reads the raw field `._state` to AVOID that side effect.
- `@stoprocent/noble` (node_modules/@stoprocent/noble/lib/noble.js:39-44):
  reading `.state` triggers `this._initializeBindings()`. The modern handler
  deliberately reads `.state` to TRIGGER that init.

So the read site differs by design per driver. A naive `noble.state ?? noble._state`
would access `.state` first and fire the abandonware init side effect, changing
legacy behaviour. The state read MUST stay driver-specific. We inject it.

## Approach

Extract all logic into one shared factory module
`src/ble/handler-noble-shared.ts`. The factory takes the Noble instance plus a
`getState` accessor as dependencies and returns the three public functions plus
`_internals`. Two thin entrypoints keep their own `import noble from '...'`,
supply the correct `getState`, and re-export.

Driver selection in `src/ble/index.ts` and `resolveHandlerKey()` is unchanged;
it still dynamically imports `./handler-noble.js` / `./handler-noble-legacy.js`,
which keep identical named exports (`scanAndReadRaw`, `scanAndRead`,
`scanDevices`, `_internals`).

### 1. New file: `src/ble/handler-noble-shared.ts`

- Import `Peripheral, Characteristic, Service` types from `@stoprocent/noble` as
  the canonical types (the actively maintained fork; both forks are structurally
  identical at runtime for every field used: `advertisement`, `connectable`,
  `id`, `address`, `connectAsync`, `disconnectAsync`, `discoverServicesAsync`,
  `once`, plus `Characteristic.subscribeAsync/writeAsync/readAsync/on`,
  `Service.characteristics/discoverCharacteristicsAsync`).
- Export a minimal structural `NobleApi` interface for the instance surface the
  shared code calls, using typed event overloads (no `any`, eslint-clean). It is
  exported so the legacy entrypoint can reuse it for its cast:

  ```ts
  export interface NobleApi {
    on(event: 'stateChange', listener: (state: string) => void): unknown;
    on(event: 'discover', listener: (peripheral: Peripheral) => void): unknown;
    removeListener(event: 'stateChange', listener: (state: string) => void): unknown;
    removeListener(event: 'discover', listener: (peripheral: Peripheral) => void): unknown;
    startScanningAsync(serviceUuids?: string[], allowDuplicates?: boolean): Promise<void>;
    stopScanningAsync(): Promise<void>;
  }
  ```

- Export a deps interface and factory. Let the factory RETURN TYPE be inferred
  (do not annotate `_internals` with `typeof broadcastScan` — broadcastScan is
  factory-local and that reference would not resolve in a top-level annotation):

  ```ts
  export interface NobleHandlerDeps {
    noble: NobleApi;
    /** Read the adapter state WITHOUT changing the driver's init semantics. */
    getState: () => string;
  }
  export function createNobleHandler(deps: NobleHandlerDeps) {
    // ... all logic ...
    return { scanAndReadRaw, scanAndRead, scanDevices, _internals: { broadcastScan } };
  }
  ```

  `index.ts` consumes these via its `CommonHandler` interface (structural), so an
  inferred return type is fine and keeps `_internals` typed for the tests.

- Move EVERY current function into the factory body (closing over `noble`,
  `getState`): `parseMfgData`, `waitForPoweredOn`, `peripheralAddress`,
  `matchesTarget`, `wrapChar`, `wrapPeripheral`, `connectWithRetries`,
  `wrapCharacteristics`, `discoverPeripheral`, `broadcastScan`, `scanAndReadRaw`,
  `scanAndRead`, `scanDevices`. Pure helpers that do NOT touch `noble`
  (`parseMfgData`, `peripheralAddress`, `matchesTarget`, `wrapChar`,
  `wrapPeripheral`, `wrapCharacteristics`) may live at module scope to keep the
  closure small; helpers that reference `noble`/`getState` live inside the
  factory. `adapterWarningLogged` becomes a `let` in the factory closure
  (per-instance, matches current per-module behaviour).
- Replace the two `noble.state`/`noble._state` reads in `waitForPoweredOn` with
  `getState()`.

### 2. Rewrite `src/ble/handler-noble.ts` (thin entrypoint)

```ts
import noble from '@stoprocent/noble';
import { createNobleHandler } from './handler-noble-shared.js';

// @stoprocent/noble: reading `.state` lazily initializes bindings — intended.
const handler = createNobleHandler({
  noble,
  getState: () => noble.state,
});

export const scanAndReadRaw = handler.scanAndReadRaw;
export const scanAndRead = handler.scanAndRead;
export const scanDevices = handler.scanDevices;
export const _internals = handler._internals;
```

### 3. Rewrite `src/ble/handler-noble-legacy.ts` (thin entrypoint)

```ts
import noble from '@abandonware/noble';
import { createNobleHandler, type NobleApi } from './handler-noble-shared.js';

// @abandonware/noble: reading `.state` triggers bindings.init() as a side
// effect, so read the raw `_state` field instead (preserves prior behaviour).
const handler = createNobleHandler({
  noble: noble as unknown as NobleApi,
  getState: () => (noble as unknown as { _state: string })._state,
});

export const scanAndReadRaw = handler.scanAndReadRaw;
export const scanAndRead = handler.scanAndRead;
export const scanDevices = handler.scanDevices;
export const _internals = handler._internals;
```

The `as unknown as NobleApi` cast on the abandonware default import is needed
because its bundled types differ slightly from the @stoprocent canonical types;
the runtime surface is identical. If plain assignment type-checks, drop the cast.

## What stays unchanged

- `src/ble/index.ts`, `resolveHandlerKey()`, handler precedence, public API.
- `src/ble/shared.ts`, `src/ble/types.ts`.
- Both `import noble from '...'` statements stay in their own entrypoint files,
  so the dynamic-import dead-code elimination still loads only the chosen driver.

## Tests

- `tests/ble/handler-noble.test.ts` and `tests/ble/handler-noble-legacy.test.ts`
  exercise `_internals.broadcastScan` through each entrypoint by mocking the
  respective package. They stay AS-IS and must remain green — they now prove the
  shared logic wires correctly for both drivers (broadcastScan never calls
  `getState`, so the state nuance is independent of these).
- The legacy mock already has both `_state` and `state`; the modern mock has
  `state`. Confirm both still pass.
- Add one focused test `tests/ble/handler-noble-shared.test.ts` asserting the
  `getState` injection: build the factory with a fake NobleApi whose `.state`
  getter throws / increments a counter, and a `_state`-style getter, to prove
  `waitForPoweredOn` reads through `getState()` and not a hard-coded field.
  (Optional but cheap insurance for the one real behavioural seam.)

## Verification

1. `taskkill //F //IM node.exe` then `npx tsc --noEmit` (clean).
2. `npm run lint` and `npx prettier --check` on the three files.
3. `npx vitest run tests/ble/handler-noble.test.ts tests/ble/handler-noble-legacy.test.ts tests/ble/resolve-handler-key.test.ts tests/ble/handler-noble-shared.test.ts`
4. Full `npm test`.
5. Confirm net line reduction: ~599 duplicated lines collapse to one shared
   module + two ~15-line entrypoints.

## Acceptance criteria mapping

- One shared implementation, two thin driver entrypoints. ✓ (steps 1-3)
- Net reduction ~590 lines. ✓ (two 599-line files → ~1 shared + 2 thin)
- Existing handler tests green, behaviour identical for both drivers. ✓ (Tests)
- No change to handler selection precedence or public API. ✓ (unchanged §)

## Docs

- README.md touch per project rule (no functional doc change needed; bump only
  if a sentence references the file layout — it does not, so a no-op review).
- `CONTRIBUTING.md` lines 114-115 list both handler files with one-line
  descriptions; add a one-line mention of `handler-noble-shared.ts`.
