# Plan: #228 Robi S9 adapter (Lefu/Fitdays FFB0-new protocol)

## Decoded from the reporter's HCI snoop (handle 0x0014, MAC 50:fb:19:df:6f:6d)

The capture mixes 3 connections; the scale is on ACL handle 0x0014 (the e0:48..
device is a Samsung watch = noise). The Robi S9 uses service 0xFFB0 with
FFB1 [write], FFB2 [notify], FFB3 [indicate] + a Nordic DFU service (0x1530..),
but a DIFFERENT frame protocol than the openScale MGB adapter it is currently
mis-matched to (shared FFB0, like the #177/#235 collisions).

Frame format (20 bytes): `[seq][len][00][type][payload...][trailer]`.
- Phone -> scale (FFB1): types B0 (hello), B1 (16B: unix-timestamp BE + token
  `aa1e<NN>b2` + config), B2 (ack/echo token), BD.
- Scale -> phone: A0 (ack, counter), A1 (init), A2 (live, FFB2 notify, stage byte
  0x02 measuring -> 0x04 stable), A3/A4 (final, FFB3 INDICATE).

Why it disconnects now: MgbAdapter sends openScale MGB init (0xF7/0xFA/0xFB/..)
and only subscribes FFB2 notify. The Robi S9 ignores that init (it wants the
B0/B1/B2/BD handshake) and sends its result on FFB3 indicate, which MGB never
subscribes -> no data -> ~15s -> disconnect. Reporter's "needs init on FFB1"
hunch is correct.

## Known vs provisional

- KNOWN/confident: GATT layout, that it needs FFB3 indicate, the handshake byte
  sequences (captured verbatim), the frame framing, that A2 stage 0x04 / A3 mark
  a stable result.
- PROVISIONAL (single capture, no ground-truth weight): the exact weight byte
  offset + scale factor. The `01 2c` (=0x012C~300) field is constant across both
  this capture and the reporter's earlier nRF 77.4 kg session, so it is likely a
  config constant, NOT the weight. The trailer is a content-dependent checksum
  whose algorithm is not cracked. Impedance is most likely the `01 f4` (=0x01F4
  =500) field in the A3 frame (classic range).

Consequence: the handshake (verbatim replay) is the real fix for the disconnect.
The weight value will be best-effort and MUST be confirmed by a known-weight
DEBUG retest. Per ble-snoop-decode skill, do NOT crack the scrambled body-comp;
compute via BIA from weight + impedance + profile.

## Changes

### 1. New file src/scales/robi-s9.ts - RobiS9Adapter

- `name = 'Robi S9'`, multi-char bindings:
  `[{ffb1, write}, {ffb2, notify}, {ffb3, notify}]`.
  NOTE: FFB3 is physically an indicate characteristic, but the shared subscribe
  loop (shared.ts) only subscribes bindings whose `type === 'notify'`. node-ble
  `startNotifications()` / noble `subscribe()` enable indications transparently
  based on the char's real properties, so declare it `'notify'` to get it
  subscribed (same precedent as the BeurerBf720 adapter). Declaring `'indicate'`
  would skip it.
- legacy fallback fields (unused in multi-char): `charNotifyUuid = ffb2`,
  `charWriteUuid = ffb1`, `unlockCommand = []`, `unlockIntervalMs = 0`,
  `normalizesWeight = true`.
- `matches()`: name includes `'robi'`; OR (nameless) FFB0 service AND FFB3
  characteristic present (char-aware, to disambiguate from openScale-MGB which
  does not expose the FFB3-indicate result char). Never match a Swan/Icomon/YG
  name (those are MGB).
- `onConnected()`: replay the captured handshake verbatim on FFB1, in order, with
  small delays. The trailer is an un-cracked checksum and the B1 carries a
  timestamp+token, so regenerating is unsafe; replay the exact bytes. Frames
  (hex), seq 00..0a:
  ```
  000300b000000000000000000000000000000010
  011000b16a2eefa9003c01aa1e55b20f1b581403
  021000b16a2eefa9003c01aa1e55b20f1b581403
  030600b201aa1e55b20000000000000000000002
  040200bd09000000000000000000000000000006
  051000b16a2eefa9003c01aa1e55b20f1b581403
  061000b16a2eefa9003c01aa1e55b20f1b581403
  070600b201aa1e55b20000000000000000000002
  081000b16a2eefa9003c01aa1e55b20f1b581403
  090300b001000000000000000000000000000011
  0a0300b002000000000000000000000000000012
  ```
  Use `ctx.write(FFB1, bytes, true)` (capture used Write Request / with-response).
- `parseCharNotification(uuid, data)`:
  - Validate `data.length >= 11` and `data[2] === 0x00`.
  - `bleLog.debug('Robi S9 frame: ' + data.toString('hex'))` FIRST, so a DEBUG
    retest exposes the real bytes for a known weight regardless of parsing.
  - type = `data[3]`. Parse the final result ONLY from the A3 indicate frame
    (`type === 0xa3`); A2 frames differ in alignment and are treated as
    liveness/progress only. A3 layout `[..][a3][00][01 2c][00 76][01 f4]`:
    weight = `data.readUInt16BE(7)` (the field after the `01 2c` constant),
    impedance = `data.readUInt16BE(9)` (the `01 f4` field).
  - Cache + set `this.final = true`. Return `{ weight: w, impedance }` when
    `final && w > 0`, else null.
- Weight scale: `WEIGHT_DIV = 10` (PROVISIONAL guess; the `01 2c`=300 field is a
  constant in both captures so it is NOT the weight; the real offset/scale is
  unconfirmed pending a known-weight DEBUG retest). Heavy comment.
- `isComplete()`: `reading.weight > 0 && this.final`.
- `computeMetrics()`: `buildPayload(weight, impedance, {}, profile)` (BIA).

### 2. src/scales/index.ts - register before MgbAdapter

Insert `new RobiS9Adapter()` immediately before `new MgbAdapter()` so a Robi
device (by name or FFB3 char) resolves to it, while plain MGB scales still fall
through to MGB.

### 3. Tests - tests/scales/robi-s9.test.ts

- matches: `'Robi S9'` -> RobiS9; nameless FFB0+FFB3 -> RobiS9; `'icomon'` /
  `'swan'` still -> MGB (registry resolution via `adapters.find`).
- parse: feed the captured A3 frame bytes -> returns a reading with impedance 500
  and weight > 0; isComplete true.
- onConnected: a mock ctx records 11 FFB1 writes in order, first byte sequence
  00..0a.

### 4. docs / README

- README supported-scales line: add "Robi S9" (note: Fitdays/Lefu).
- gemini/scales.md or esp32 not needed. Keep minimal.

## Out of scope

- Cracking the frame checksum / regenerating the handshake with a live timestamp
  (verbatim replay instead; revisit if the stale timestamp is rejected).
- Decoding scrambled body-composition fields (BIA instead).
- Locking the weight scale factor / offset (needs a known-weight DEBUG capture;
  requested from the reporter in the issue comment).

## Verification

- `taskkill //F //IM node.exe` then `npx tsc --noEmit`, `npm test`,
  `npm run lint`, `npx prettier --check`.
- New tests green.

## Risks (state honestly in the issue comment)

- Verbatim handshake uses a stale timestamp; the scale may or may not accept it.
- Weight scaling is a guess; likely needs correction after the reporter's
  known-weight retest. The headline fix is the disconnect.
- Hardcoded token `aa1e..b2` is from the reporter's session; it varies within a
  session (55 -> 00) so it looks like a command parameter, not an account id,
  but if other Robi S9 units reject it that is a follow-up.
