# Plan: #168 BF720 disconnects before subscribe completes

## Problem

BF720 (SIG-standard Beurer adapter, merged dev) connects, discovers services,
matches "Beurer BF720/BF105", logs `Multi-char mode: 5 bindings`, then the link
drops 1.6s later (D-Bus reset + btmgmt power-cycle) -> "Not Connected". There is
NO `Subscribed to N notification(s)` line, so the failure is inside the subscribe
loop in `subscribeAndInit` (src/ble/shared.ts:216-224), BEFORE `onConnected`
runs. BF105 works for another reporter with the same adapter.

## Root cause (leading hypothesis)

BF720's measurement characteristics are `indicate` and sit in SIG services that
typically require an encrypted/bonded link:
- 0x2A9D Weight Measurement (0x181D) -> indicate
- 0x2A9C Body Composition (0x181B) -> indicate
- 0x2A9F User Control Point (0x181C User Data) -> write, indicate

openScale on Android auto-bonds via the OS, so enabling the CCCDs succeeds. Our
BLE layer has NO pairing/bonding support (verified: no `device.pair()` anywhere;
node-ble gatt.ts subscribe is a bare `startNotifications()`). Without a bond,
BlueZ's CCCD write on a protected characteristic fails (NotAuthorized /
NotPermitted) and the scale drops the link, matching the symptom.

UNCERTAINTY: Lutzion's log does not show the exact org.bluez error thrown during
subscribe, so the bonding hypothesis is strong but unconfirmed. The plan
therefore ships BOTH a cheap diagnostic (to capture the real error on the next
retest) AND a best-effort bonding attempt (the likely fix), so a single retest
either fixes it or returns the definitive error.

## Changes

### 1. src/ble/shared.ts - diagnostic logging in the subscribe loop (fix #1)

In `subscribeAndInit`, multi-char branch (around line 216), log each binding
before subscribing and wrap `subscribeToChar` so a failure names the exact
characteristic + type and preserves the cause:
```js
for (const binding of notifyBindings) {
  if (binding.optional && !resolveChar(charMap, binding.uuid)) {
    bleLog.debug(`Skipping optional notify binding ${binding.uuid} (not present on device)`);
    continue;
  }
  bleLog.debug(`Subscribing to ${binding.uuid} (${binding.type})...`);
  try {
    const unsub = await subscribeToChar(charMap, binding.uuid, onNotification);
    unsubscribers.push(unsub);
    subscribed += 1;
  } catch (err) {
    throw new Error(
      `Failed to enable notifications on ${binding.uuid} (${binding.type}): ${errMsg(err)}. ` +
        'The scale may require a bonded/encrypted link.',
      { cause: err },
    );
  }
}
```
`errMsg` is already imported in shared.ts. Behavior is unchanged on success; on
failure the read still rejects but now with a message that names the failing
characteristic and the underlying BlueZ error.

### 2. src/interfaces/scale-adapter.ts - requiresBonding flag

Add to ScaleAdapter:
```js
/**
 * True if this adapter's characteristics need a bonded/encrypted BLE link
 * (e.g. SIG User Data Service on Beurer BF720). The node-ble handler attempts
 * a best-effort BLE pairing after connect and before subscribing. Best-effort:
 * a pairing failure is logged and the read proceeds unbonded.
 */
readonly requiresBonding?: boolean;
```

### 3. src/scales/beurer-bf720.ts - set the flag

Add `readonly requiresBonding = true;` next to the other readonly flags.

### 4. src/ble/handler-node-ble/scan.ts - best-effort bonding (fix #2)

Add a `BONDING_TIMEOUT_MS = 15_000` const and an `ensureBonded` helper:
```js
async function ensureBonded(device: Device): Promise<void> {
  try {
    const paired = (await device.isPaired()) as unknown as boolean;
    if (paired) {
      bleLog.debug('Device already bonded');
      return;
    }
    bleLog.info('Adapter requires bonding; attempting BLE pairing...');
    await withTimeout(device.pair(), BONDING_TIMEOUT_MS, 'BLE pairing timed out');
    bleLog.info('BLE pairing succeeded');
  } catch (err) {
    bleLog.warn(
      `BLE pairing failed (continuing unbonded): ${errMsg(err)}. ` +
        'A BlueZ pairing agent may be required for scales that mandate an encrypted link.',
    );
  }
}
```
Call it once, after the GATT char map is ready and before `waitForRawReading`
(scan.ts ~line 303, the single convergence point for both target-MAC and
auto-discovery paths):
```js
if (matchedAdapter.requiresBonding) {
  await ensureBonded(device);
}
```
`device` is the node-ble `Device` (type already imported); `withTimeout`,
`errMsg`, and `Device` are already imported in scan.ts. node-ble Device declares
`isPaired()` and `pair()` (verified in its index.d.ts). isPaired is mistyped as
Promise<string> there, hence the `as unknown as boolean` cast; the runtime value
is the BlueZ boolean Paired property.

Note: only the node-ble (BlueZ) handler gets bonding. The reporter is on node-ble
(HA add-on, hci0). noble bonding is a separate, more limited API and is out of
scope here.

### 5. Tests

- tests/ble/shared.test.ts: a multi-char adapter whose one notify char's
  `subscribe` rejects -> `waitForReading` rejects with a message naming that
  characteristic UUID (and not the generic disconnect message).
- tests/scales/beurer-bf720.test.ts: assert `new BeurerBf720Adapter().requiresBonding === true`.

(The bonding flow in scan.ts is node-ble/D-Bus glue and is not unit-tested here;
the existing handler tests do not mock the node-ble Device pair API. The flag +
helper are small and verified by tsc + the docker build.)

## Out of scope (deliberate)

- #3 indicate-vs-notify binding metadata: the bindings are declared `type:
  'notify'`, but the chars are `indicate`. On node-ble `startNotifications()`
  enables both, so they ARE subscribed correctly today. Reclassifying them to a
  new `'indicate'` type would require changing the shared notify-only subscribe
  filter (shared.ts:207) for ALL adapters, with regression risk and zero
  functional gain on the target platform. Defer until #1 proves it matters.
- beurer_pin verification: a missing/wrong PIN is the NEXT gate (consent write in
  onConnected), not this pre-subscribe disconnect. Confirm with the reporter when
  requesting the retest, but no code change.
- README update + commit + push + issue comment: NOT requested in this task.
  Per my recommendation, bonding should not ship blindly; defer the commit and
  the reporter retest comment until after this builds clean. (This task ends at
  implement -> review -> fix, per the user's instructions.)

## Verification

- `npx tsc --noEmit` clean.
- `npx vitest run tests/ble/shared.test.ts tests/scales/beurer-bf720.test.ts` green.
- Full `npm test`, `npm run lint`, `npx prettier --check` clean.
- Docker build (reporter runs the HA add-on / Docker): `docker build` of the
  image to confirm the change compiles in the linux container target.
- Kill node processes before npm: `taskkill //F //IM node.exe`.
