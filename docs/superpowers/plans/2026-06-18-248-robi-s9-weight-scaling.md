# Plan: #248 Robi S9 weight scaling + impedance (v1.18.0 regression)

## Problem

Reporter @vanboxel on v1.18.0: Robi S9 reports 4966.40 kg / 0 Ohm. A3 final frame:

```
03 08 00 a3 00 | 01 2d c2 | 00 00 00 00 ...   (20 bytes, trailer 0x13)
```

Current `src/scales/robi-s9.ts:121` reads `data.readUInt16BE(7) / 10`:
`bytes[7,8] = c2 00 = 0xC200 = 49664 / 10 = 4966.4`. Wrong.

Reporter decode: weight is 3-byte big-endian grams at offset 5:
`01 2d c2 = 77250 g / 1000 = 77.25 kg`. Matches scale display.

Root cause: #228 decode assumed `01 2c` was a constant prefix (both prior captures were ~77 kg so the high grams bytes looked stable). They are the high bytes of the gram weight, not a constant.

## Scope

- FIX weight parse: 3-byte BE at offset 5, divisor 1000.
- Impedance: cannot pin offset from a single all-zero frame. Keep a provisional read, fall back to BIA (already happens). Open follow-up for a known-impedance DEBUG capture.
- Rewrite the existing A3 test (it was built on the wrong #228 layout).
- Update the provisional-decode comments.
- Do NOT touch handshake, matching, MGB adapter, other scales.

## Changes

### 1. `src/scales/robi-s9.ts`

Replace `WEIGHT_DIV = 10` block + the A3 parse.

Weight (3-byte BE grams at offset 5):

```ts
const w = data.readUIntBE(5, 3) / 1000;
```

Impedance: offset is UNKNOWN. The only real frame has all-zero bytes after the
weight, so reading any guessed offset risks surfacing garbage on a future
impedance-bearing frame. `buildPayload` does not use impedance numerically when
`comp` is empty (BIA via `estimateBodyFat(bmi)`), so emit `0` until a
known-impedance capture pins the offset:

```ts
this.cachedImpedance = 0; // offset unknown, pending DEBUG capture (#248)
```

Guard `data.length < 11` already covers reading up to offset 7; keep it.

Update the doc comment that calls `01 2c` constant; remove `WEIGHT_DIV` const.

### 2. `tests/scales/robi-s9.test.ts`

Rewrite the A3 parse test with the real reporter frame:

- A3 real frame `030800a300012dc2000000000000000000000013` -> expect weight `77.25`, impedance `0`, `isComplete` true.
- Keep the A2-ignored test (`1d0700a2...`).

## Verification

- `npx vitest run tests/scales/robi-s9.test.ts`
- `npm test`
- `npm run lint`, `npx tsc --noEmit`, `prettier --check`

## Follow-up (not in this change)

- Comment on #248: weight fixed, request full DEBUG frame dump (all A2 + A3 frames) of a barefoot full-body weigh-in to pin the real impedance offset.
- Reopen-link to #228.

## Commit

`fix(ble): correct Robi S9 weight scaling to 3-byte grams (#248)`
