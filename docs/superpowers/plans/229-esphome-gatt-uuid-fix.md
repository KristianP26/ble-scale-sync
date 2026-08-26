# Plan: #229 ESPHome proxy GATT `reading 'length'` crash

## Problem (verified root cause)

`@2colors/esphome-native-api` 1.3.6 runs every decoded message through
`mapMessageByType()` (lib/utils/mapMessageByType.js:130). For
`BluetoothGATTGetServicesResponse` (lines 154-178) it strips `uuidList` off every
service/characteristic/descriptor and replaces it with a pre-decoded `uuid`
**string** (full dashed 128-bit form via `uuidDecode`).

Our `gatt.ts:84` reads `ch.uuidList` (now `undefined`) and passes it to
`esphomeUuidToString()` (esphome-gatt-proto.ts:14), which does `uuidList.length`
on line 15 -> throws `Cannot read properties of undefined (reading 'length')`.
That is the exact error in #229, after a successful connect + service discovery.

The existing test fixture (tests/ble/esphome-proxy/gatt.test.ts:27-42) invented a
shape (`uuidList: ['<dashed string>']`) that matches neither the real library nor
raw google-protobuf `toObject()`. It only happened to hit the `length===1` string
branch, so CI was green while real hardware crashed. #229 is the first real-HW
test of the Phase 2 GATT path.

## Goal

- Build `charMap` from the library's pre-decoded `uuid` string.
- Never let a single malformed characteristic entry throw and kill the whole
  session (defense in depth).
- Keep the `uuidList` `[high, low]` decoder as a fallback so the code still works
  if a different library version delivers the raw shape.
- Make the test fixture reflect the REAL library output and add a regression test.

## Changes

### 1. `src/ble/handler-esphome-proxy/esphome-gatt-proto.ts`

- Type: add `uuid?: string` to `EsphomeGattCharacteristic` and
  `EsphomeGattService`; make `uuidList` optional (`uuidList?: ...`).
- Harden `esphomeUuidToString`: if `uuidList` is missing or empty, return `''`
  instead of throwing. Signature becomes
  `esphomeUuidToString(uuidList?: Array<string | number | bigint>): string`. The
  `if (!uuidList || uuidList.length === 0) return '';` guard MUST come first so TS
  narrows the optional param to defined for the existing `length === 1` / `[0]` /
  `[1]` accesses (no non-null assertions needed).

### 2. `src/ble/handler-esphome-proxy/gatt.ts`

- Import `normalizeUuid` from `../types.js`.
- Replace the char UUID resolution:
  ```ts
  const uuid = ch.uuid ? normalizeUuid(ch.uuid) : esphomeUuidToString(ch.uuidList);
  if (!uuid) continue; // malformed entry, skip rather than crash
  ```
- Leave read/write/subscribe/notify untouched (already correct: `dataList`
  survives the default mapper case).

### 3. `tests/ble/esphome-proxy/gatt.test.ts`

- RED first: change the shared `fakeConnection().listBluetoothGATTServicesService`
  fixture to the real library shape (`uuid: '<dashed string>'`, NO `uuidList`) for
  both service and characteristic. This is the shared fixture, so every test that
  builds a charMap goes RED (throws on `uuidList.length`) before the fix - that is
  expected and is the proof of the bug.
- Keep existing behavioral assertions (charMap keyed by normalized `2a9d`,
  read/write/notify/disconnect). They should pass unchanged after the fix.
- Add one regression test asserting a characteristic whose entry has neither
  `uuid` nor `uuidList` is skipped (no throw), and a well-formed sibling char in
  the same service is still registered.

### 4. `tests/ble/esphome-proxy/esphome-gatt-proto.test.ts`

- Covers `esphomeUuidToString` with 5 cases (`[high, low]` pair, dashed string,
  bigint halves, single numeric 16-bit, single bigint 128-bit). All stay valid
  since the function is kept as the fallback path.
- Add a case: `esphomeUuidToString(undefined)` returns `''` (no throw), locking in
  the hardening.

## Verification

1. `npx vitest run tests/ble/esphome-proxy/gatt.test.ts` -> RED on the reshaped
   fixture before the fix, GREEN after.
2. `npm test` (full suite), `npm run lint`, `npx tsc --noEmit`,
   `npx prettier --check` on the touched files.
3. README.md updated (per project rule, every commit updates README).

## Out of scope

- No adapter changes. `normalizeUuid` already collapses dashed full UUIDs to the
  32-char form adapters use.
- Cannot fully close #229 without the reporter re-testing on the Beurer BF788;
  the comment will ask for that and note reopen-if-regression.

## Commit / ship

- Branch off `dev`, Conventional Commit `fix(ble): ...`, PR into `dev`.
- Comment on #229 with root cause + fix summary, request HW re-test.
