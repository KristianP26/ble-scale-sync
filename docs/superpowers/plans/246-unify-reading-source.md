# Plan: #246 unify CommonHandler poll path and ReadingWatcher event path behind one ReadingSource

## Goal

Remove the parallel, non-unified handler contracts. `runtime/sources.ts` currently
hand-branches on `ctx.bleHandler === 'mqtt-proxy' / 'esphome-proxy'`, constructs each
`ReadingWatcher` with a different constructor arity (mqtt 4 args, esphome 5 + scaleAuth),
builds a transport-specific `onSourceReload` closure, and separately calls
`resolveHandlerKey` for the node-ble grace floor. The two `ReadingWatcher` classes are
independent types sharing only a method shape.

Unify behind one `Watcher` interface (BLE layer) and a single `createReadingSource`
factory that owns transport selection, so `runtime/sources.ts` never switches on handler
name and never calls `resolveHandlerKey`.

## Current state (verified)

- `CommonHandler { scanAndReadRaw, scanAndRead }` in `src/ble/index.ts:52` — the poll
  contract (used via `scanAndReadRaw` by `PollReadingSource`).
- mqtt `ReadingWatcher(config, adapters, targetMac?, profile?)`, `updateConfig(adapters,
  targetMac?, profile?)` — `src/ble/handler-mqtt-proxy/watcher.ts`.
- esphome `ReadingWatcher(config, adapters, targetMac?, profile?, scaleAuth?)`,
  `updateConfig(adapters, targetMac?, profile?, scaleAuth?)` — `handler-esphome-proxy/watcher.ts`.
- `runtime/sources.ts:33-80` branches on handler name, builds watcher + reload closure;
  `:104` calls `resolveHandlerKey(...) === 'node-ble'` for the grace floor.
- `ReadingSource { start?, stop?, nextReading }` in `runtime/loop.ts:11` — the loop's
  contract; both watchers and `PollReadingSource` already satisfy it.

The continuous loop (`loop.ts`) only ever calls `start?/stop?/nextReading` on the source
and `onSourceReload` from the bundle. `updateConfig` is called ONLY from the
`onSourceReload` closure in `sources.ts` (and directly in watcher unit tests).

## Design

### 1. `Watcher` interface + `WatcherConfig` (new `src/ble/reading-source.ts`)

```ts
export interface WatcherConfig {
  adapters: ScaleAdapter[];
  targetMac?: string;
  profile?: UserProfile;
  scaleAuth?: ScaleAuth;
}

/** Event-driven reading source (proxy transports). Satisfies the loop's
 *  ReadingSource (start/stop/nextReading) plus a uniform hot-reload hook. */
export interface Watcher {
  start(): Promise<void>;
  stop(): Promise<void>;
  nextReading(signal?: AbortSignal): Promise<RawReading>;
  updateConfig(config: WatcherConfig): void;
}
```

`Watcher` is assignable to `ReadingSource` (loop.ts), so a `Watcher` can be used directly
as `bundle.source`. `ReadingSource` stays in loop.ts (it is the loop's contract); only the
event-source `Watcher` interface lives in the BLE layer, per the issue.

### 2. Unify both `updateConfig` to the object param

- mqtt `watcher.ts`: `updateConfig(config: WatcherConfig)` -> `this.adapters = config.adapters;
  this.targetMac = config.targetMac; if (config.profile) this.profile = config.profile;`
  (scaleAuth ignored, as today). Class `implements Watcher`.
- esphome `watcher.ts`: `updateConfig(config: WatcherConfig)` -> sets adapters,
  `targetMac = config.targetMac?.toLowerCase()`, profile if present, scaleAuth if present.
  Class `implements Watcher`.

Constructors stay positional (unchanged) — the `Watcher` interface does not constrain
constructors, and ~30 watcher unit tests construct positionally. Only `updateConfig`'s
arity changes.

### 3. `createReadingSource` factory in `src/ble/index.ts`

```ts
export interface ReadingSourceOptions {
  bleHandler?: BleHandlerName;
  mqttProxy?: MqttProxyConfig;
  esphomeProxy?: EsphomeProxyConfig;
  adapters: ScaleAdapter[];
  targetMac?: string;
  profile: UserProfile;
  scaleAuth?: ScaleAuth;
}

export type ReadingSourcePlan =
  | { kind: 'watcher'; watcher: Watcher; failureLogPrefix: string }
  | { kind: 'poll'; appliesGraceFloor: boolean };

export async function createReadingSource(opts: ReadingSourceOptions): Promise<ReadingSourcePlan> {
  const key = resolveHandlerKey(opts.bleHandler);
  if (key === 'mqtt-proxy' && opts.mqttProxy) {
    const w = new ReadingWatcher(opts.mqttProxy, opts.adapters, opts.targetMac, opts.profile);
    return { kind: 'watcher', watcher: w, failureLogPrefix: 'Error processing reading' };
  }
  if (key === 'esphome-proxy' && opts.esphomeProxy) {
    const { ReadingWatcher: EsphomeWatcher } = await import('./handler-esphome-proxy/index.js');
    const w = new EsphomeWatcher(opts.esphomeProxy, opts.adapters, opts.targetMac, opts.profile, opts.scaleAuth);
    return { kind: 'watcher', watcher: w, failureLogPrefix: 'Error processing ESPHome reading' };
  }
  return { kind: 'poll', appliesGraceFloor: key === 'node-ble' };
}
```

- Owns ALL transport selection in the BLE layer via the single `resolveHandlerKey`.
- mqtt `ReadingWatcher` is statically imported (already re-exported here); esphome stays
  a dynamic `import()` so its deps load only when used.
- Returns a poll PLAN (not a poll source) because `PollReadingSource` needs the runtime
  `ctx`; the orchestrator constructs it. This keeps the BLE-layer factory free of any
  runtime/ctx import.
- Parity with current branching: `resolveHandlerKey('mqtt-proxy') === 'mqtt-proxy'` etc.,
  and the `&& opts.mqttProxy` / `&& opts.esphomeProxy` guards reproduce the current
  fall-through-to-poll when a proxy is selected but its config is missing.

### 4. `runtime/sources.ts` — no handler-name branching, no resolveHandlerKey

```ts
const profile = () => resolveUserProfile(ctx.config.users[0], ctx.config.scale);
const scaleAuth = () => ({
  pin: ctx.config.users[0]?.beurer_pin,
  userIndex: ctx.config.users[0]?.beurer_user_index,
});

const plan = await createReadingSource({
  bleHandler: ctx.bleHandler,
  mqttProxy: ctx.mqttProxy,
  esphomeProxy: ctx.esphomeProxy,
  adapters,
  targetMac: ctx.scaleMac,
  profile: profile(),
  scaleAuth: scaleAuth(),
});

if (plan.kind === 'watcher') {
  return {
    source: plan.watcher,
    failureLogPrefix: plan.failureLogPrefix,
    onSourceReload: () =>
      plan.watcher.updateConfig({
        adapters,
        targetMac: ctx.scaleMac,
        profile: profile(),
        scaleAuth: scaleAuth(),
      }),
  };
}

// plan.kind === 'poll': PollReadingSource + watchdog (#154) + grace floor (#143).
// applyGraceFloor = plan.appliesGraceFloor (NOT a resolveHandlerKey call here).
```

The watchdog construction + `onSuccess`/`onFailure`/cooldown/grace-floor wiring is
unchanged except `applyGraceFloor` comes from `plan.appliesGraceFloor`. Drop the
`resolveHandlerKey` and `ReadingWatcher` imports from sources.ts; add `createReadingSource`.
The `if (plan.kind === 'watcher')` branch is a source-shape distinction (event vs poll),
not handler-name or instanceof branching — the acceptance bar.

## Commits (logical, each green)

1. `refactor(ble): unify watcher updateConfig behind a Watcher interface` — new
   `src/ble/reading-source.ts` (`Watcher` + `WatcherConfig`); both watcher classes
   `implements Watcher` with object `updateConfig`; update `sources.ts`'s two
   `updateConfig(...)` calls to the object form (construction still inline here); update
   the one positional `updateConfig` call in `handler-mqtt-proxy.test.ts:1105` and the two
   `updateConfig` arg assertions in `sources.test.ts:132,149` to the object shape.
2. `refactor(ble): add createReadingSource factory owning transport selection` — add
   `createReadingSource` + `ReadingSourceOptions` + `ReadingSourcePlan` to `ble/index.ts`;
   new `tests/ble/reading-source.test.ts` covering: mqtt-proxy -> watcher with ctor args
   `[mqttProxy, adapters, targetMac, profile]` (4-arg, scaleAuth DROPPED) + prefix
   'Error processing reading'; esphome-proxy -> watcher with ctor args
   `[esphomeProxy, adapters, targetMac, profile, scaleAuth]` (5-arg, scaleAuth forwarded)
   + prefix 'Error processing ESPHome reading'; proxy-selected-but-config-missing -> poll;
   node-ble -> poll appliesGraceFloor=true; noble -> poll appliesGraceFloor=false. These
   ctor-arg parity assertions move here from sources.test.ts (review #8b). Mock the two
   ReadingWatcher classes to capture ctor args. Not wired into sources.ts yet (additive).
3. `refactor(runtime): route buildReadingSource through createReadingSource` — rewrite
   `sources.ts` to call the factory and drop the handler-name branches +
   `resolveHandlerKey`/`ReadingWatcher` imports. The poll branch MUST still hard-code
   `failureLogPrefix: 'No scale found'` (review #6 — the factory's poll plan carries no
   prefix). Rewrite the `sources.test.ts` dispatch tests to mock `createReadingSource`:
   watcher case returns `{kind:'watcher', watcher: fake, failureLogPrefix}` and asserts
   source + prefix + reload calls `updateConfig` with the object; poll case returns
   `{kind:'poll', appliesGraceFloor}` and asserts `PollReadingSource` + watchdog hooks +
   cooldown sleep. The node-ble grace-floor test now drives `appliesGraceFloor:true` via
   the mocked `createReadingSource` return (review #8a — the old `resolveHandlerKey` mock
   is retired; sources.ts no longer calls it). Ctor-arg assertions are gone from here
   (moved to commit 2).

## Verification

- After each commit: `npx tsc --noEmit` + the touched test files.
- Final: `taskkill //F //IM node.exe`, then `npm run lint`, `npx tsc --noEmit`, `npm test`,
  `prettier --check` on changed files.
- Parity guards: the ~30 watcher behavior tests (mqtt + esphome) stay green unchanged
  except the single object-form `updateConfig` call; `resolve-handler-key.test.ts`
  unchanged; `loop.test.ts` unchanged (its fake source already matches ReadingSource).

## Risks / review focus

- `createReadingSource` selection MUST equal the current `sources.ts` branching: mqtt only
  when `key==='mqtt-proxy' && mqttProxy`; esphome only when `key==='esphome-proxy' &&
  esphomeProxy`; everything else poll. `appliesGraceFloor` only `key==='node-ble'`.
- failureLogPrefix per transport preserved ('Error processing reading' vs 'Error
  processing ESPHome reading').
- esphome scaleAuth forwarded to BOTH the constructor (factory) and the reload object;
  mqtt ignores scaleAuth in both ctor (4-arg) and updateConfig.
- esphome `ReadingWatcher` stays a dynamic import (lazy-load its native deps).
- esphome `updateConfig` keeps `targetMac?.toLowerCase()` (it lowercases; mqtt does not).
- No layering inversion: `ble/index.ts` / `ble/reading-source.ts` must not import from
  `runtime/*` (factory takes primitives, not `AppContext`).
- `Watcher.nextReading` signature: both watchers declare `nextReading(signal?: AbortSignal)`
  (optional signal). Keep the interface's signal optional to match.

## Out of scope

- The `CommonHandler` interface and `scanDevices` switch in `ble/index.ts` (the issue's
  H3 is the poll-vs-watcher orchestrator coupling; `scanDevices` is a separate shape-
  specific dispatch already isolated, and `CommonHandler` stays the poll contract behind
  `scanAndReadRaw`, which `PollReadingSource` uses).
- Renaming/moving `ReadingSource` out of loop.ts.
