# BF720 Bond Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop `removeDevice()` from deleting a bonded scale's BlueZ pairing keys so a `requiresBonding` scale (Beurer BF720, #168) reads on every run, not just the first.

**Architecture:** Add a single bond-aware guard inside `removeDevice()` in `src/ble/handler-node-ble/discovery.ts`. Before issuing BlueZ `RemoveDevice` (which deletes the stored LTK), query the device's `Paired` property; if it is bonded, skip removal and keep the bond. This one chokepoint covers all three current callers (pre-connect scan, connect retry, post-failed-GATT cleanup) uniformly. No adapter knowledge is needed at the call site: "is it Paired" is the exact, device-agnostic condition.

**Tech Stack:** TypeScript (ES modules, `.js` import suffix), node-ble (BlueZ D-Bus), Vitest.

---

## Background (verified facts)

- **BlueZ `RemoveDevice` deletes bonding info.** org.bluez.Adapter1 docs: *"removes the remote device object at the given path including cached information such as bonding information."* So every `removeDevice()` call wipes the host-side LTK.
- **The bug (asymmetric bond).** Run 1: no bond, fresh `device.pair()` succeeds, reads 75.81 kg, host + scale both store the bond, `Trusted` is set. Run 2: `removeDevice()` at `scan.ts:159` wipes the host LTK before connect, so `ensureBonded`'s `isPaired()` returns false and it issues a fresh `device.pair()`; the scale still holds the run-1 bond and ignores a fresh pairing request, so pairing hits the 15s timeout (`BLE pairing timed out`), then the encrypted CCCD subscribe fails (`Not Connected`) and the scale drops the link. Confirmed by reporter's dev retest (works once, fails every subsequent run).
- **node-ble API (from `node_modules/node-ble/src/`):**
  - `Adapter.getDevice(uuid)` throws `Error('Device not found')` if the device is not in the BlueZ children; otherwise returns a `Device`. It accepts the colon form (`AA:BB:CC:DD:EE:FF`) and serializes internally.
  - `Device.isPaired()` returns `helper.prop('Paired')`. `BusHelper.prop` unwraps the dbus-next Variant (`rawProp.value`), so this resolves to a **raw JS boolean**, not a Variant. (`ensureBonded` already treats it as one via `as unknown as boolean`.)
  - The only `RemoveDevice` call in the codebase is inside `discovery.ts` `removeDevice()` (single chokepoint; verified by grep).
- **Reconnect path after the fix (expected; confirmed only by hardware retest).** With the host bond preserved, run 2 should reach `ensureBonded` -> `isPaired()` true -> `'Device already bonded'` -> skip `pair()`; subscribing to the encrypted CCCD then makes BlueZ auto-encrypt with the stored LTK. Re-encryption with an existing LTK needs no pairing agent (an agent is only needed for the initial key exchange), and `ensureBonded` best-effort-sets `Trusted=true` in run 1 (`scan.ts:84-89`), which BlueZ persists on-disk alongside the bond. This end-to-end behavior is **not** unit-testable here (it depends on the real controller initiating encryption) — the only validation is the reporter's retest. Treat "the read now succeeds on run 2" as a hypothesis the retest must confirm; this plan's automated scope is strictly the `removeDevice` guard.
- **Nothing else wipes bonds, and zombie-recovery still runs.** Addon `run.sh` reset is `btmgmt power off/on` (bonds are on-disk in `/var/lib/bluetooth`, survive power-cycle). Critically, `scan.ts:435-440` runs `resetConnection()` + `resetAdapterBtmgmt` (btmgmt power off/on) **unconditionally after any GATT attempt** (success or failure). That power-cycle is what actually clears the bluez#807 zombie-discovery / orphaned-subscription state at the controller level, and it preserves on-disk bonds. So the targeted `RemoveDevice` in the failed-GATT branch (`scan.ts:414-423`) is **redundant** with the power-cycle for zombie recovery; its only unique effect is wiping the bond — which is the bug. Skipping it for paired devices loses nothing the power-cycle does not already cover.
- **`formatMac('aa:bb:cc:dd:ee:ff')` -> `'AA:BB:CC:DD:EE:FF'`** (strips `:`/`-`, uppercases, rejoins with `:`); the BlueZ object path segment is `dev_AA_BB_CC_DD_EE_FF`.

---

## File Structure

- **Modify:** `src/ble/handler-node-ble/discovery.ts:139-149` — add a bond guard inline at the top of `removeDevice()`: query the device's `Paired` state and skip removal if bonded, fail-safe to "skip" on any non-`Device not found` D-Bus error so a transient failure can never wipe a real bond.
- **Create:** `tests/ble/remove-device-bond.test.ts` — unit tests for the guard, mocking the node-ble `Adapter`/`Device` surface (same hand-rolled-mock style as `tests/ble/rssi-freshness.test.ts`).

No call-site changes. The three existing `removeDevice()` callers each keep working correctly with the guard, but for different reasons (not "free" — justified per call site):

- **`scan.ts:159` (pre-connect, every cycle):** the direct cause of the run-2 failure. Must preserve the bond. ✓
- **`connect.ts:105` (connect retry):** purges a stale proxy on connect failure. For a paired device, removing it would re-wipe the bond and reintroduce the bug, so it must be skipped — and the fresh proxy is re-acquired anyway by the `startDiscoverySafe` + `waitDevice` that immediately follow (connect.ts:112-119), which construct a new `Device` wrapper independent of `RemoveDevice`. Note: BF720's failure is at pairing, not connect, so this path is not even on its failing flow; the guard here is defensive correctness, not the primary fix.
- **`scan.ts:422` (post-failed-GATT cleanup):** RemoveDevice here was an extra zombie-subscription cleanup. The unconditional `btmgmt power off/on` at `scan.ts:435-440` already clears that controller-level state for every GATT attempt and preserves the on-disk bond, so skipping the targeted RemoveDevice for paired devices loses no recovery. ✓

---

### Task 1: Bond-aware `removeDevice()` guard

**Files:**
- Modify: `src/ble/handler-node-ble/discovery.ts:139-149`
- Test: `tests/ble/remove-device-bond.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/ble/remove-device-bond.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { removeDevice } from '../../src/ble/handler-node-ble/discovery.js';
import type { Adapter } from '../../src/ble/handler-node-ble/dbus.js';

const MAC = 'aa:bb:cc:dd:ee:ff';
const EXPECTED_PATH = '/org/bluez/hci0/dev_AA_BB_CC_DD_EE_FF';

/**
 * Build a mock node-ble Adapter exposing the surface removeDevice() touches:
 * `helper.object` + `helper.callMethod` (via helperOf) and `getDevice()`.
 */
function makeAdapter(opts: {
  paired?: boolean;
  deviceInCache?: boolean; // default true
  isPairedThrows?: boolean;
  removeThrows?: boolean;
}) {
  const callMethod = vi.fn(async (method: string) => {
    if (method === 'RemoveDevice' && opts.removeThrows) {
      throw new Error('org.bluez.Error.DoesNotExist');
    }
    return undefined;
  });
  const isPaired = vi.fn(async () => {
    if (opts.isPairedThrows) throw new Error('org.freedesktop.DBus.Error.NoReply');
    return opts.paired ?? false;
  });
  const getDevice = vi.fn(async () => {
    if (opts.deviceInCache === false) throw new Error('Device not found');
    return { isPaired };
  });
  const adapter = {
    helper: { object: '/org/bluez/hci0', callMethod },
    getDevice,
  } as unknown as Adapter;
  return { adapter, callMethod, isPaired, getDevice };
}

describe('removeDevice() bond guard (#168)', () => {
  it('does NOT call RemoveDevice when the device is bonded (preserves LTK)', async () => {
    const { adapter, callMethod, getDevice } = makeAdapter({ paired: true });
    await removeDevice(adapter, MAC);
    expect(callMethod).not.toHaveBeenCalled();
    // Paired state is queried with the colon-form MAC, distinct from the
    // underscore path passed to RemoveDevice; guards against swapping the two.
    expect(getDevice).toHaveBeenCalledWith('AA:BB:CC:DD:EE:FF');
  });

  it('calls RemoveDevice with the correct path when the device is unpaired', async () => {
    const { adapter, callMethod } = makeAdapter({ paired: false });
    await removeDevice(adapter, MAC);
    expect(callMethod).toHaveBeenCalledWith('RemoveDevice', EXPECTED_PATH);
  });

  it('removes when the device is not in the BlueZ cache (getDevice throws)', async () => {
    const { adapter, callMethod } = makeAdapter({ deviceInCache: false });
    await removeDevice(adapter, MAC);
    expect(callMethod).toHaveBeenCalledWith('RemoveDevice', EXPECTED_PATH);
  });

  it('does NOT remove on a transient paired-state query error (fail safe, #168)', async () => {
    // getDevice succeeds (device IS cached) but isPaired throws transiently.
    // Removing here could wipe a real bond, so the guard must skip removal.
    const { adapter, callMethod } = makeAdapter({ isPairedThrows: true });
    await removeDevice(adapter, MAC);
    expect(callMethod).not.toHaveBeenCalled();
  });

  it('does not reject when RemoveDevice itself fails', async () => {
    const { adapter } = makeAdapter({ paired: false, removeThrows: true });
    await expect(removeDevice(adapter, MAC)).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run (kill node first per project rule):
```bash
taskkill //F //IM node.exe 2>/dev/null; npx vitest run tests/ble/remove-device-bond.test.ts
```
Expected: the bonded-case test and the transient-error test FAIL — current `removeDevice()` always calls `RemoveDevice`, so both `expect(callMethod).not.toHaveBeenCalled()` assertions fail. (The unpaired / not-in-cache / remove-throws tests may pass already; the skip behavior is the new logic.)

- [ ] **Step 3: Implement the guard**

In `src/ble/handler-node-ble/discovery.ts`, replace the existing `removeDevice` function (lines 139-149):

```typescript
/** Remove a device from BlueZ D-Bus cache to force a fresh proxy on re-discovery. */
export async function removeDevice(btAdapter: Adapter, mac: string): Promise<void> {
  const formatted = formatMac(mac);

  // Never remove a bonded device: BlueZ RemoveDevice deletes the stored pairing
  // keys (LTK), which desyncs the host bond from the scale's retained bond and
  // makes the next run's re-pair time out (#168 Beurer BF720). Only unpaired
  // devices need the fresh-proxy reset (#80/#81); bonded scales keep their bond
  // so the next connect re-encrypts with the stored LTK instead of pairing.
  let paired: boolean;
  try {
    const device = await btAdapter.getDevice(formatted);
    // node-ble types isPaired() loosely; BusHelper.prop unwraps the Variant to a
    // real boolean at runtime, so cast through unknown like ensureBonded does.
    paired = ((await device.isPaired()) as unknown as boolean) === true;
  } catch (err) {
    // 'Device not found' => not in the BlueZ cache, so there is no bond to
    // preserve and removal is a harmless no-op; proceed. Any OTHER error is a
    // transient D-Bus failure on a device that may well be bonded, so fail safe
    // and skip removal rather than risk wiping a real bond.
    if (!errMsg(err).includes('Device not found')) {
      bleLog.debug(`Skipping RemoveDevice: bond state unknown (${errMsg(err)})`);
      return;
    }
    paired = false;
  }
  if (paired) {
    bleLog.debug('Skipping RemoveDevice: device is bonded (preserving pairing keys)');
    return;
  }

  try {
    const devSerialized = `dev_${formatted.replace(/:/g, '_')}`;
    const adapterHelper = helperOf(btAdapter);
    await adapterHelper.callMethod('RemoveDevice', `${adapterHelper.object}/${devSerialized}`);
    bleLog.debug('Removed device from BlueZ cache');
  } catch {
    // Device wasn't in cache
  }
}
```

Note: `formatMac`, `bleLog`, `errMsg`, `helperOf`, and `Adapter` are already imported at the top of `discovery.ts` (lines 2-14) — no new imports needed.

- [ ] **Step 4: Run the test to verify it passes**

Run:
```bash
taskkill //F //IM node.exe 2>/dev/null; npx vitest run tests/ble/remove-device-bond.test.ts
```
Expected: all 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ble/handler-node-ble/discovery.ts tests/ble/remove-device-bond.test.ts
git commit -m "fix(ble): preserve bond by not RemoveDevice'ing paired scales (#168)"
```

---

### Task 2: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Type check**

Run:
```bash
taskkill //F //IM node.exe 2>/dev/null; npx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 2: Lint**

Run:
```bash
npx eslint .
```
Expected: no errors.

- [ ] **Step 3: Prettier check**

Run:
```bash
npx prettier --check "src/ble/handler-node-ble/discovery.ts" "tests/ble/remove-device-bond.test.ts"
```
Expected: both files pass. If not, run `npx prettier --write` on them and amend the Task 1 commit.

- [ ] **Step 4: Full test suite (no regressions)**

Run:
```bash
taskkill //F //IM node.exe 2>/dev/null; npm test
```
Expected: all tests pass (the prior green count plus the 5 new tests). Pay attention to `tests/ble/rssi-freshness.test.ts` and any test importing the node-ble handler — they must stay green.

- [ ] **Step 5: Commit any formatting fixups (if Step 3 required `--write`)**

```bash
git add -A
git commit -m "style: prettier formatting for bond guard (#168)"
```

---

## Self-Review

**1. Spec coverage:**
- Stop deleting bonded scale's keys -> Task 1 guard. ✓
- Cover all three `removeDevice` callers -> single chokepoint inside `removeDevice()`, each call site justified in File Structure. ✓
- Preserve `#80/#81` behavior for unpaired devices -> guard only skips when `Paired === true`; unpaired and not-in-cache devices still removed (Task 1 tests 2 + 3). ✓
- Transient D-Bus error must not wipe a bond -> fail-safe skip on any non-`Device not found` error (Task 1 test 4). ✓
- No regression in `ensureBonded` -> unchanged; its `isPaired()` short-circuit now actually fires on run 2 because the bond survives. ✓
- Zombie-subscription / Discovering-desync recovery preserved despite skipping the failed-GATT RemoveDevice -> covered by the unconditional `btmgmt power off/on` at `scan.ts:435-440`. ✓

**2. Placeholder scan:** No TBD/TODO/"handle errors"; every code step shows full code. ✓

**3. Type consistency:** Guard logic is inlined in `removeDevice` (no separate helper). `removeDevice(btAdapter: Adapter, mac: string)` signature unchanged, so all existing callers compile. `errMsg` is used (already imported). Mock in the test casts to `Adapter` and only exercises `helper.object`, `helper.callMethod`, `getDevice`, `isPaired` — the exact surface the implementation touches. ✓

## Out of scope / follow-ups (not in this plan)

- The consent PIN (`users[].beurer_pin`) plumbing already exists and is unchanged; once the link bonds, the scale still needs the right consent code to stream — that is a separate config concern, already documented on the issue.
- After implementation, reply on #168 asking @Lutzion to retest on dev: run twice, confirm the second run now logs `Device already bonded` (not `BLE pairing timed out`) and reads a weight. This is a comms step, not a code task.
