# Plan: #183 decouple processor.ts from mqtt-proxy display specifics

## Problem

`src/runtime/processor.ts` is not transport agnostic. Three helpers
(`notifyReading`, `notifyResult`, `notifyBeep`, lines 49-77) branch on
`ctx.bleHandler === 'mqtt-proxy'` and call MQTT-proxy display functions
(`publishDisplayReading`, `publishDisplayResult`, `publishBeep`) imported
directly from `../ble/handler-mqtt-proxy/index.js`. The processing layer should
not know about a specific transport.

## Acceptance criteria (from issue)

- No string comparison against a specific handler name in `processor.ts`.
- Display behaviour for mqtt-proxy unchanged.
- Other handlers unaffected (capability is optional).
- `processor.ts` logic is transport agnostic.

## Approach

Introduce an optional `DisplayNotifier` capability carried on `AppContext`.
`processor.ts` calls it generically via optional chaining
(`ctx.display?.reading(...)`), naming no transport. The mqtt-proxy
implementation is wired at the composition root (`src/index.ts`), the one place
that legitimately knows the handler kind (it already gates `bootstrapMqttProxy`
there).

### 1. New interface: `src/interfaces/display-notifier.ts`

Transport-neutral capability. Methods are fire-and-forget (`void`); the
implementation swallows its own async errors (matching today's `.catch(() => {})`).

```ts
export interface DisplayNotifier {
  /** Show the raw scale reading + target exporters on the display. */
  reading(
    slug: string,
    name: string,
    weight: number,
    impedance: number | undefined,
    exporterNames: string[],
  ): void;
  /** Show the export result (per-exporter ok/fail) on the display. */
  result(
    slug: string,
    name: string,
    weight: number,
    details: Array<{ name: string; ok: boolean }>,
  ): void;
  /** Emit an audible cue (matched vs unknown user). */
  beep(freq: number, duration: number, repeat: number): void;
}
```

### 2. `AppContext` gains an optional `display`

In `src/runtime/context.ts`:
- import `type { DisplayNotifier }`.
- Add an OPTIONAL field next to the other mqtt-proxy lifecycle handle:
  ```ts
  /** Display/beep capability (mqtt-proxy only; set after bootstrapMqttProxy). */
  display?: DisplayNotifier;
  ```
  Optional (not `| undefined` required) so existing `AppContext` object literals
  in tests do not all need a new key; `createAppContext` simply omits it.
- `setConfig` does NOT touch `display`: the notifier reads `ctx.mqttProxy`
  lazily through a getter (step 4), so hot-swap of the proxy config still works
  without rebuilding the notifier. (Mirrors how `mqttProxy` is the hot-swap
  field and the consumer reads it live.)

### 3. mqtt-proxy notifier factory: `src/ble/handler-mqtt-proxy/display-notifier.ts`

```ts
import type { DisplayNotifier } from '../../interfaces/display-notifier.js';
import type { MqttProxyConfig } from '../../config/schema.js';
import { publishBeep, publishDisplayReading, publishDisplayResult } from './display.js';

/**
 * DisplayNotifier backed by the ESP32 display over MQTT. Reads the (possibly
 * hot-swapped) config via the getter on each call so config reloads take effect
 * and a momentarily-undefined config no-ops instead of throwing.
 */
export function createMqttProxyDisplayNotifier(
  getConfig: () => MqttProxyConfig | undefined,
): DisplayNotifier {
  return {
    reading(slug, name, weight, impedance, exporterNames) {
      const config = getConfig();
      if (!config) return;
      publishDisplayReading(config, slug, name, weight, impedance, exporterNames).catch(() => {});
    },
    result(slug, name, weight, details) {
      const config = getConfig();
      if (!config) return;
      publishDisplayResult(config, slug, name, weight, details).catch(() => {});
    },
    beep(freq, duration, repeat) {
      const config = getConfig();
      if (!config) return;
      publishBeep(config, freq, duration, repeat).catch(() => {});
    },
  };
}
```

Re-export it from `src/ble/handler-mqtt-proxy/index.ts` alongside the existing
display exports so the composition root imports from the public barrel.

### 4. Wire at the composition root: `src/index.ts`

In the existing `if (ctx.bleHandler === 'mqtt-proxy' && ctx.mqttProxy)` block
(lines 169-173), after the bootstrap assignments, attach the notifier:

```ts
ctx.display = createMqttProxyDisplayNotifier(() => ctx.mqttProxy);
```

The arrow reads `ctx.mqttProxy` live, so the hot-swapped value is always used.
Add `createMqttProxyDisplayNotifier` to the EXISTING import in index.ts:5
(`import { setDisplayUsers } from './ble/handler-mqtt-proxy/index.js';`). The
barrel is already loaded at startup via that line, so this is net-neutral on
load (and `processor.ts` dropping its own barrel import changes nothing).

### 5. Rewrite `processor.ts` to be transport agnostic

- Remove the import of `publishBeep, publishDisplayReading, publishDisplayResult`
  from `../ble/handler-mqtt-proxy/index.js`.
- Delete the three `notify*` helper functions (lines 49-77).
- Replace each former `notify*` call site with a direct, transport-agnostic
  optional-chaining call, preserving the exact arguments and the surrounding
  raw-vs-computed comments:
  - `notifyReading(ctx, slug, name, w, imp, names)` ->
    `ctx.display?.reading(slug, name, w, imp, names)`
  - `notifyResult(ctx, slug, name, w, details)` ->
    `ctx.display?.result(slug, name, w, details)`
  - `notifyBeep(ctx, freq, dur, rep)` -> `ctx.display?.beep(freq, dur, rep)`
- Six call sites: reading x2 (single L154, multi L264), result x2 (single L174,
  multi L285), beep x2 (multi L202, L215).

Result: `processor.ts` imports nothing from `handler-mqtt-proxy` and contains no
`'mqtt-proxy'` literal.

## Out of scope (intentional)

The issue's secondary "Evidence" note about `sources.ts` `onSourceReload`
asymmetry is NOT addressed here. `sources.ts` is the composition root that
constructs the per-handler `ReadingWatcher` (mqtt vs esphome vs poll); branching
on handler kind there is appropriate and not a leak into the processing layer.
The acceptance criteria are all about `processor.ts`. Touching `sources.ts`
would widen scope and risk for no acceptance-criteria gain; left as-is.

## Tests

`tests/runtime/processor.test.ts` currently mocks the whole
`handler-mqtt-proxy/index.js` and asserts `publishDisplayReading/Result/Beep`
were called with `MQTT_PROXY`. That coupling is exactly what we remove, so:

- Drop the `vi.mock('../../src/ble/handler-mqtt-proxy/index.js', ...)` block and
  the imports of the three publish fns.
- `makeCtx` gains an optional injected `display` mock:
  `{ reading: vi.fn(), result: vi.fn(), beep: vi.fn() }` typed as
  `DisplayNotifier`. Default `display: undefined`.
- Rewrite the three coupling tests to assert against the injected notifier
  (arguments no longer include the `MQTT_PROXY` config, since the notifier closes
  over it):
  - single-user display test: `expect(display.reading).toHaveBeenCalledWith('dad','Dad',82,500,['webhook'])`
    and `expect(display.result).toHaveBeenCalledWith('dad','Dad',80,[{name:'webhook',ok:true}])`.
  - multi-user display+beep test: same plus `expect(display.beep).toHaveBeenCalledWith(1200,200,2)`.
  - unknown-user beep test: `expect(display.beep).toHaveBeenCalledWith(600,150,3)`.
  - "does not publish on non-mqtt handlers" is reframed to "undefined display is
    a safe no-op": build ctx with NO `display`, run the flow, assert it completes
    without throwing. (Gating non-mqtt handlers to no display now lives at the
    composition root, which only attaches `display` for mqtt-proxy; the processor
    is transport agnostic and simply no-ops when the capability is absent.)

New test `tests/ble/handler-mqtt-proxy-display-notifier.test.ts`:
- mock `./display.js` publish fns; assert `createMqttProxyDisplayNotifier`
  delegates with the live config from the getter, no-ops when the getter returns
  undefined, and swallows a rejected publish (no unhandled rejection).

## Verification

1. `taskkill //F //IM node.exe` then `npx tsc --noEmit`.
2. `npm run lint` + `npx prettier --check` on changed files.
3. `npx vitest run tests/runtime/processor.test.ts tests/runtime/loop.test.ts tests/ble/handler-mqtt-proxy-display-notifier.test.ts tests/ble/handler-mqtt-proxy.test.ts`
4. Full `npm test`.
5. Grep `processor.ts` for `mqtt-proxy` and `handler-mqtt-proxy`: zero hits.

## Acceptance criteria mapping

- No handler-name string in processor.ts. ✓ (step 5 + grep check)
- mqtt-proxy display behaviour unchanged. ✓ (notifier calls the same publish fns
  with the same args; wired for the same handler at the composition root)
- Other handlers unaffected. ✓ (`display` is undefined unless mqtt-proxy)
- processor.ts transport agnostic. ✓

## Docs

- `CONTRIBUTING.md`: if it lists the runtime module set, add a one-line mention
  of the `DisplayNotifier` capability; otherwise no change.
- README: pure internal refactor, no user-facing change (flag, do not fabricate).
