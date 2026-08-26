# Watchdog Idle-Awareness (Liveness Probe) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the #154 continuous-mode watchdog from restarting the process on normal idle cycles (scale not advertising) by counting only failures where the BLE radio is genuinely unhealthy.

**Architecture:** A poll failure is classified as `idle` (radio alive, saw other adverts, scale just not on) or `wedge-suspect` (GATT engaged and failed, OR radio saw zero BLE activity = zombie-discovery wedge). The classification is computed inside node-ble's `scanAndReadRaw` (where the adapter handle lives), attached to the thrown error, and read by the runtime loop's `onFailure` hook, which only increments the watchdog for non-idle failures. A short adapter liveness probe (RSSI/device-set delta over a window) provides the "radio alive" signal.

**Tech Stack:** TypeScript (ES2022, Node16 ESM, `.js` import specifiers), node-ble (BlueZ D-Bus), Vitest.

---

## Background / Root Cause

`src/runtime/sources.ts` `onFailure` calls `watchdog.recordFailure()` on every failed poll cycle. `scanAndReadRaw` (target-MAC path) waits up to `DISCOVERY_TIMEOUT_MS` (120s) for `btAdapter.waitDevice(mac)`; a Renpho only advertises while someone stands on it, so an empty scan times out and counts as a failure. After `watchdog_max_consecutive_failures` (default 10) such idle timeouts the watchdog exits the process for a container restart, even though the radio is healthy (#213; reporter's log shows a restart at 06:17 after a successful read at 05:50 with only idle `No scale found` in between).

`gattAttempted` alone cannot gate this: the classic zombie-discovery wedge ("Discovering=true but not scanning") ALSO surfaces as "device not found" with `gattAttempted=false`, so gating on it would disable the watchdog for the very case it exists to recover. The only signal that separates idle from wedge is whether the radio still sees ANY advertisement traffic, which is what this plan adds.

## File Structure

- Create `src/ble/failure-kind.ts` — pure failure-classification helpers (tag/read error, `shouldCountAsWatchdogFailure`). No node-ble deps, used by both the ble layer and the runtime layer.
- Create `src/ble/handler-node-ble/liveness.ts` — `LivenessAdapter` abstraction + `probeLiveness` (RSSI/device-set delta). node-ble wrapping isolated from the pure probe so the probe is unit-testable with a plain object.
- Modify `src/ble/types.ts` — add `LIVENESS_PROBE_WINDOW_MS` constant.
- Modify `src/ble/handler-node-ble/scan.ts` — wrap the scan body in a `catch` that tags the error with its failure kind (running the liveness probe for non-GATT failures).
- Modify `src/runtime/sources.ts` — `onFailure` only records a watchdog failure for non-idle errors.
- Create `tests/ble/failure-kind.test.ts`, `tests/ble/liveness.test.ts`.
- Modify `docs/troubleshooting.md` + `README.md` — note idle-aware watchdog.

The `ConsecutiveFailureWatchdog` class (`src/ble/watchdog.ts`) is intentionally NOT modified; its existing tests stay green.

---

### Task 1: Failure-kind helpers

**Files:**
- Create: `src/ble/failure-kind.ts`
- Test: `tests/ble/failure-kind.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/ble/failure-kind.test.ts
import { describe, it, expect } from 'vitest';
import {
  tagBleFailure,
  bleFailureKind,
  shouldCountAsWatchdogFailure,
} from '../../src/ble/failure-kind.js';

describe('failure-kind', () => {
  it('tags an error and reads the kind back', () => {
    const err = tagBleFailure(new Error('not found'), 'idle');
    expect(bleFailureKind(err)).toBe('idle');
  });

  it('is idempotent: never overwrites an existing tag', () => {
    const err = tagBleFailure(new Error('x'), 'idle');
    tagBleFailure(err, 'wedge-suspect');
    expect(bleFailureKind(err)).toBe('idle');
  });

  it('returns undefined for untagged errors and non-objects', () => {
    expect(bleFailureKind(new Error('plain'))).toBeUndefined();
    expect(bleFailureKind('string error')).toBeUndefined();
    expect(bleFailureKind(null)).toBeUndefined();
  });

  it('counts everything except an explicit idle tag', () => {
    expect(shouldCountAsWatchdogFailure(tagBleFailure(new Error(), 'idle'))).toBe(false);
    expect(shouldCountAsWatchdogFailure(tagBleFailure(new Error(), 'wedge-suspect'))).toBe(true);
    expect(shouldCountAsWatchdogFailure(new Error('untagged'))).toBe(true);
    expect(shouldCountAsWatchdogFailure('string')).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/ble/failure-kind.test.ts`
Expected: FAIL ("Failed to resolve import .../failure-kind.js").

- [ ] **Step 3: Write minimal implementation**

```ts
// src/ble/failure-kind.ts
/**
 * Classifies a continuous-mode poll failure so the #154 watchdog counts only
 * failures that signal a genuinely unhealthy BLE stack, not the normal "nobody
 * is standing on the scale" idle case (#213).
 *
 *  - 'idle'          the scan found no scale but the radio is alive (it saw
 *                    other devices advertise). Neutral: do NOT count.
 *  - 'wedge-suspect' a GATT connect/read failure, or no BLE activity at all
 *                    (zombie-discovery wedge). Count toward the watchdog.
 *
 * Scales like Renpho only advertise while in use, so a `Device not found`
 * timeout is the EXPECTED idle state. The watchdog previously counted every such
 * timeout and restarted the process after N of them on a healthy radio (#213).
 */
export type BleFailureKind = 'idle' | 'wedge-suspect';

interface TaggedError {
  bleFailureKind?: BleFailureKind;
}

/** Attach a failure kind to an error. Idempotent: never overwrites an existing tag. */
export function tagBleFailure<E>(err: E, kind: BleFailureKind): E {
  if (err !== null && typeof err === 'object') {
    const tagged = err as TaggedError;
    if (tagged.bleFailureKind === undefined) tagged.bleFailureKind = kind;
  }
  return err;
}

/** Read the failure kind off an error, or undefined if untagged / not an object. */
export function bleFailureKind(err: unknown): BleFailureKind | undefined {
  if (err !== null && typeof err === 'object') {
    return (err as TaggedError).bleFailureKind;
  }
  return undefined;
}

/**
 * Whether a poll failure should increment the watchdog counter. Untagged errors
 * (non-node-ble handlers, infra errors) count, preserving prior behavior; only
 * an explicit 'idle' tag is treated as neutral.
 */
export function shouldCountAsWatchdogFailure(err: unknown): boolean {
  return bleFailureKind(err) !== 'idle';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/ble/failure-kind.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/ble/failure-kind.ts tests/ble/failure-kind.test.ts
git commit -m "feat(ble): add poll-failure classification helpers (#213)"
```

---

### Task 2: Adapter liveness probe

**Files:**
- Modify: `src/ble/types.ts` (add constant near the other timeouts, after `RSSI_FRESHNESS_MS` on line 68)
- Create: `src/ble/handler-node-ble/liveness.ts`
- Test: `tests/ble/liveness.test.ts`

- [ ] **Step 1: Add the constant**

In `src/ble/types.ts`, after the `RSSI_FRESHNESS_MS` declaration add:

```ts
/**
 * Observation window for the watchdog liveness probe (#213). After a failed idle
 * scan we watch advertisement activity for this long to tell a live-but-idle
 * radio (saw other adverts) from a wedged controller (saw nothing).
 */
export const LIVENESS_PROBE_WINDOW_MS = 3_000;
```

- [ ] **Step 2: Write the failing test**

```ts
// tests/ble/liveness.test.ts
import { describe, it, expect } from 'vitest';
import { probeLiveness, type LivenessAdapter } from '../../src/ble/handler-node-ble/liveness.js';

const noSleep = async () => {};

/** Fake adapter that returns a scripted sequence of (addresses, rssi-map) snapshots. */
function fakeAdapter(snapshots: Array<{ addrs: string[]; rssi: Record<string, number | undefined> }>): LivenessAdapter {
  let call = -1;
  return {
    listAddresses: async () => {
      call++;
      return snapshots[Math.min(call, snapshots.length - 1)].addrs;
    },
    rssiOf: async (addr) => snapshots[Math.min(call, snapshots.length - 1)].rssi[addr],
  };
}

describe('probeLiveness', () => {
  it('reports alive when a new device address appears between samples', async () => {
    const la = fakeAdapter([
      { addrs: ['AA'], rssi: { AA: -50 } },
      { addrs: ['AA', 'BB'], rssi: { AA: -50, BB: -60 } },
    ]);
    expect(await probeLiveness(la, { sleep: noSleep })).toBe(true);
  });

  it('reports alive when a known device RSSI moves between samples', async () => {
    const la = fakeAdapter([
      { addrs: ['AA'], rssi: { AA: -50 } },
      { addrs: ['AA'], rssi: { AA: -55 } },
    ]);
    expect(await probeLiveness(la, { sleep: noSleep })).toBe(true);
  });

  it('reports not-alive when nothing changes (wedged radio)', async () => {
    const la = fakeAdapter([
      { addrs: ['AA', 'BB'], rssi: { AA: -50, BB: -60 } },
      { addrs: ['AA', 'BB'], rssi: { AA: -50, BB: -60 } },
    ]);
    expect(await probeLiveness(la, { sleep: noSleep })).toBe(false);
  });

  it('reports not-alive when the cache is empty both samples', async () => {
    const la = fakeAdapter([
      { addrs: [], rssi: {} },
      { addrs: [], rssi: {} },
    ]);
    expect(await probeLiveness(la, { sleep: noSleep })).toBe(false);
  });

  it('does not treat undefined->number or number->undefined RSSI as movement', async () => {
    const la = fakeAdapter([
      { addrs: ['AA'], rssi: { AA: undefined } },
      { addrs: ['AA'], rssi: { AA: -50 } },
    ]);
    expect(await probeLiveness(la, { sleep: noSleep })).toBe(false);
  });

  it('returns not-alive when enumeration throws', async () => {
    const la: LivenessAdapter = {
      listAddresses: async () => {
        throw new Error('dbus down');
      },
      rssiOf: async () => undefined,
    };
    expect(await probeLiveness(la, { sleep: noSleep })).toBe(false);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/ble/liveness.test.ts`
Expected: FAIL ("Failed to resolve import .../liveness.js").

- [ ] **Step 4: Write the implementation**

```ts
// src/ble/handler-node-ble/liveness.ts
import { helperOf, type Adapter } from './dbus.js';
import { LIVENESS_PROBE_WINDOW_MS, sleep as defaultSleep } from '../types.js';

/**
 * Minimal adapter surface the liveness probe needs, abstracted from node-ble so
 * the probe logic is unit-testable with a plain object (no D-Bus mocks).
 */
export interface LivenessAdapter {
  /** Addresses BlueZ currently knows about (its discovery cache). */
  listAddresses(): Promise<string[]>;
  /** Last-seen RSSI for an address, or undefined if unreadable / absent. */
  rssiOf(addr: string): Promise<number | undefined>;
}

/** Wrap a real node-ble Adapter as a LivenessAdapter. */
export function makeLivenessAdapter(btAdapter: Adapter): LivenessAdapter {
  return {
    listAddresses: () => btAdapter.devices(),
    rssiOf: async (addr) => {
      try {
        const dev = await btAdapter.getDevice(addr);
        const rssi = await helperOf(dev).prop('RSSI');
        return typeof rssi === 'number' ? rssi : undefined;
      } catch {
        return undefined;
      }
    },
  };
}

interface ProbeOpts {
  windowMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Decide whether the BLE radio is still actively scanning ("alive") by watching
 * advertisement activity over a short window while discovery runs.
 *
 * BlueZ updates `org.bluez.Device1.RSSI` on every received advertisement, so the
 * radio is alive if, between two samples `windowMs` apart, either a new device
 * address appears OR a known device's RSSI value moves. A wedged controller
 * (Discovering=true but not scanning) shows neither. Returns false on total
 * enumeration failure, so the watchdog safety net stays armed when the adapter
 * cannot even be queried.
 */
export async function probeLiveness(la: LivenessAdapter, opts: ProbeOpts = {}): Promise<boolean> {
  const windowMs = opts.windowMs ?? LIVENESS_PROBE_WINDOW_MS;
  const sleep = opts.sleep ?? defaultSleep;

  let first: Map<string, number | undefined>;
  try {
    first = await sample(la);
  } catch {
    return false;
  }

  await sleep(windowMs);

  let second: Map<string, number | undefined>;
  try {
    second = await sample(la);
  } catch {
    return false;
  }

  for (const [addr, rssi] of second) {
    if (!first.has(addr)) return true; // a new advertiser appeared
    const prev = first.get(addr);
    if (rssi !== undefined && prev !== undefined && rssi !== prev) return true; // RSSI moved
  }
  return false;
}

async function sample(la: LivenessAdapter): Promise<Map<string, number | undefined>> {
  const m = new Map<string, number | undefined>();
  for (const addr of await la.listAddresses()) {
    m.set(addr, await la.rssiOf(addr));
  }
  return m;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/ble/liveness.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 6: Commit**

```bash
git add src/ble/types.ts src/ble/handler-node-ble/liveness.ts tests/ble/liveness.test.ts
git commit -m "feat(ble): add adapter liveness probe for watchdog classification (#213)"
```

---

### Task 3: Tag failures in scanAndReadRaw

**Files:**
- Modify: `src/ble/handler-node-ble/scan.ts`

No new unit test (scanAndReadRaw needs a full D-Bus mock that the suite does not currently provide); behavior is covered by the Task 1/2 unit tests plus the Task 4 wiring. Type-check + full suite must stay green.

- [ ] **Step 1: Add imports**

At the top of `src/ble/handler-node-ble/scan.ts`, alongside the existing local imports, add:

```ts
import { tagBleFailure, bleFailureKind } from '../failure-kind.js';
import { probeLiveness, makeLivenessAdapter } from './liveness.js';
```

- [ ] **Step 2: Track an adapter handle for the probe**

Inside `scanAndReadRaw`, declare a probe handle next to the other `let` declarations (after `let deviceMac: string = targetMac ?? '';`):

```ts
  let probeAdapter: Adapter | undefined;
```

After the adapter is resolved (immediately after the `getAdapter` try/catch block, before the `isPowered` check), set it:

```ts
    probeAdapter = btAdapter;
```

And immediately after `if (discoveryResult) btAdapter = discoveryResult;` keep it current:

```ts
    if (discoveryResult) btAdapter = discoveryResult;
    probeAdapter = btAdapter;
```

- [ ] **Step 3: Add the tagging catch**

Change the function's outer `try { ... } finally { ... }` into `try { ... } catch { ... } finally { ... }` by inserting this `catch` block between the `return raw;` line and the existing `} finally {`:

```ts
  } catch (err) {
    // Classify the failure for the #154 watchdog (#213). An idle no-show where
    // the radio still sees other advertisers must not count; a GATT failure or a
    // radio that sees nothing at all (zombie wedge) must. Skip on abort.
    if (!abortSignal?.aborted && bleFailureKind(err) === undefined) {
      if (gattAttempted || !probeAdapter) {
        tagBleFailure(err, 'wedge-suspect');
      } else {
        const alive = await probeLiveness(makeLivenessAdapter(probeAdapter));
        tagBleFailure(err, alive ? 'idle' : 'wedge-suspect');
      }
    }
    throw err;
  } finally {
```

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Run the BLE handler tests to confirm no regression**

Run: `npx vitest run tests/ble/`
Expected: PASS (all existing + new).

- [ ] **Step 6: Commit**

```bash
git add src/ble/handler-node-ble/scan.ts
git commit -m "fix(ble): tag idle vs wedge poll failures in scanAndReadRaw (#213)"
```

---

### Task 4: Gate the watchdog on failure kind

**Files:**
- Modify: `src/runtime/sources.ts:108-110`

- [ ] **Step 1: Add the import**

At the top of `src/runtime/sources.ts`, add:

```ts
import { shouldCountAsWatchdogFailure } from '../ble/failure-kind.js';
```

- [ ] **Step 2: Replace the onFailure hook**

Replace the existing:

```ts
    onFailure: () => {
      watchdog.recordFailure();
    },
```

with:

```ts
    onFailure: (err) => {
      // Idle cycles (radio alive, scale simply not advertising) must not trip
      // the watchdog (#213). Only GATT failures and dead-radio wedges count.
      if (shouldCountAsWatchdogFailure(err)) {
        watchdog.recordFailure();
      } else {
        log.debug('Idle cycle (radio alive, scale not on); not counting toward watchdog');
      }
    },
```

- [ ] **Step 3: Confirm the logger exposes `debug`**

Run: `npx vitest run tests/runtime/` and `npx tsc --noEmit`
Expected: PASS / no errors. (`createLogger` returns a logger with `.debug`; if tsc reports `debug` missing, use `log.info` instead.)

- [ ] **Step 4: Commit**

```bash
git add src/runtime/sources.ts
git commit -m "fix(runtime): watchdog ignores idle no-shows (#213)"
```

---

### Task 5: Docs

**Files:**
- Modify: `docs/troubleshooting.md` (watchdog / "won't discover after long uptime" section)
- Modify: `README.md`

- [ ] **Step 1: Update troubleshooting**

Find the watchdog / continuous-mode recovery section in `docs/troubleshooting.md` and add a sentence:

```markdown
The consecutive-failure watchdog only counts cycles where the Bluetooth radio
looks unhealthy (a connection/read failure, or no BLE advertisement traffic seen
at all). Normal idle cycles, where the radio still hears other devices but your
scale simply is not being stood on, do not count toward a restart.
```

- [ ] **Step 2: Update README**

In `README.md`, locate the continuous-mode / reliability mention (or the feature list) and add a brief line noting the watchdog is idle-aware so it does not restart when the scale is merely idle. Keep it to one sentence; no em dash or double dash.

- [ ] **Step 3: Commit**

```bash
git add docs/troubleshooting.md README.md
git commit -m "docs: note idle-aware watchdog behavior (#213)"
```

---

### Task 6: Full verification

- [ ] **Step 1: Kill node processes, then run the full gate**

```bash
taskkill //F //IM node.exe
npx tsc --noEmit
npm run lint
npx prettier --check .
npm test
```

Expected: type-check clean, ESLint clean, Prettier clean, all tests pass (existing count + the new failure-kind and liveness tests).

- [ ] **Step 2: Push to dev and comment on #213** (per user instruction; done outside the plan tasks)

---

## Self-Review

**Spec coverage:** Idle no-shows no longer count (Task 1 classification + Task 4 gate); zombie-wedge still counts via liveness probe returning false (Task 2/3); GATT failures still count via `gattAttempted` branch (Task 3). Covered.

**Resolved during review:**
- `tagBleFailure<E>` generic: after the `typeof err === 'object'` guard, narrow to a local `TaggedError` via `err as TaggedError` (all props optional, structurally assignable). If strict mode rejects the generic cast at implementation time, use `err as unknown as TaggedError`.
- `probeLiveness` treats only number->number RSSI deltas and brand-new addresses as "alive"; undefined<->number transitions are NOT movement (conservative: biases to `wedge-suspect`, keeps the watchdog armed). Asserted in tests.
- RF-quiet edge (live radio, zero neighbor adverts for the whole window) reports not-alive and counts; rare and self-corrects on the next real weigh-in. Documented in Task 5.
- ESLint `no-useless-catch` does not fire: the catch tags the error before rethrowing.

**Type consistency:** `BleFailureKind`, `tagBleFailure`, `bleFailureKind`, `shouldCountAsWatchdogFailure`, `LivenessAdapter`, `makeLivenessAdapter`, `probeLiveness`, `LIVENESS_PROBE_WINDOW_MS` are referenced with identical names across tasks. `sleep` and `Adapter`/`helperOf` import paths match existing usage (`../types.js`, `./dbus.js`).
