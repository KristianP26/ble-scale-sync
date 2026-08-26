# QN A2 weight anchor + Beurer #335 follow-ups

## 1. QN extended measurement trigger carries a weight anchor (#75, #235)

### Evidence
- `EXTENDED_MEASUREMENT_TRIGGER = [0xa2, 0x06, 0x01, 0x1e, 0x23, 0xea]`.
  `0x1e23 = 7715`, i.e. 77.15 kg. The GE CS 10 G capture's subject weighed ~78 kg.
- hedoric A/B on 1.25.0, same scale, same session:
  76 kg -> 0xB1 arrives every time; 65 kg -> handshake fine, then silence, every
  time; the same 65 kg person through the vendor app (which sends her real
  last-known weight) completes.
- So bytes [3..4] are a big-endian u16 of kg*100 and the scale uses it as a
  recognition/plausibility anchor. My shipped comment says the bytes are
  "constant across every session in the capture ... not derived from anything",
  which is now superseded.

### Change
- `UserProfile` gains `lastKnownWeight?: number` (kg).
- `resolveUserProfile` fills it: `user.last_known_weight` when set, else the
  midpoint of the required `weight_range`. Both already exist in the schema, so
  no new config key and no wizard change. `last_known_weight` is written back
  after every successful reading, so it self-corrects.
- qn-scale.ts: replace the constant with `buildMeasurementTrigger(kg)` producing
  `a2 06 01 <u16be(round(kg*100))> <checksum>`; clamp to 0..0xffff. Fall back to
  77.15 when the profile carries no hint (adapters are constructed with bare
  profiles in tests).
- Debug-log the anchor and where it came from.

### Explicitly NOT changed
- The ready-time A2 (`a2 06 01 0x32 <age> <ck>`) keeps openScale's shape. Same
  frame family, and under the new reading `0x32,<age>` decodes to ~128 kg, which
  would explain scales that go quiet at START, but there is no capture that
  shows the vendor app sending it, so it is a question for the reporters rather
  than a second blind edit in the same release.

## 2. Beurer #335 (martingebert9428, BF915, reproduced on hardware)

1. `onSessionEnd` warns about an unanswered consent even when the session
   produced a reading. The BF915 answers nothing on 2a9f and delivers the
   measurement on 2a9d anyway. Gate on `!this.readingEmitted`.
2. `staleBondMessage` says "See #290" only; #335 is the second, cleaner
   reproduction. Name both.
3. Stale bond is unrecoverable unattended: `removeDevice` refuses to touch a
   bonded device, so a peripheral that has forgotten its half locks the host out
   until someone runs `bluetoothctl remove`. Add opt-in
   `ble.auto_clear_stale_bond` (default false) that drops the bond once the
   existing evidence threshold is met and the device really is bonded, then
   retries. Opt-in because `le-connection-abort-by-local` has benign producers
   and a wrongly dropped bond costs a physical re-pair on these scales.
4. Correction to a claim I shipped: on the BF915 the scale's menu profiles ARE
   the SIG user slots (factory reset, create U:1 in the menu with no BLE at all,
   then Register New User returns index 2 and consent on index 1 returns the
   menu values). Fix the `beurer_register_new_user` doc comment and the docs.
5. Docs: removing the batteries does not wipe the slots on a BF915; factory
   reset and per-user delete are both the UNIT button (5 s / 4 s); the 6-digit
   passkey and the 4-digit consent code are different numbers.

## 3. Pull requests
- #355 salter clock: the weight-ceiling test is vacuous (passes through the
  no-clock gate). Verify, fix or ask, then merge.
- #360 salter read-newest: draft, stacked on #355, author still to validate on
  hardware. Review the second commit only.
- #354 beurer impedance: the beurer-bf720.ts hunk is wanted; the height_unit and
  package.json hunks are not. Author has not answered the offer to cherry-pick.

## Verification
`npm test`, `npm run lint`, `npx tsc --noEmit`, `npx prettier --check`.
