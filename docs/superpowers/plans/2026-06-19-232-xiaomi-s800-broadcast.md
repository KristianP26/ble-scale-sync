# #232 Xiaomi Mijia S800 Weight-Only Broadcast Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a broadcast-only scale adapter for the Xiaomi Mijia 8-electrode Body Composition Scale S800 (`xiaomi.scales.ms116`) that decrypts the encrypted FE95 MiBeacon advertisement with a per-device bind key and reads weight.

**Architecture:** The S800 emits MiBeacon v5 advertisements in service data `0xFE95`, AES-CCM encrypted under a per-device bind key from the Mi cloud. During a weigh-in it sends object `0x4e16` (9-byte value) whose trailing `uint16` LE divided by 100 is the weight in kg (verified in-session against a ground-truth weigh-in: `0x18ab = 6315 -> 63.15 kg`). The full computed body composition (fat, water, muscle, BMR) is NOT in the broadcast (Mi Home derives it app-side; verified by brute-force correlation against ground truth, only weight maps cleanly); it lives behind the heavier encrypted Mi Standard Authentication GATT path, which is out of scope here. So this adapter reads weight passively and computes body composition from weight plus the user profile via the existing pipeline, exactly like the other broadcast-only adapters (qn-scale `parseBroadcast`).

**Tech Stack:** TypeScript (ES modules, `.js` import suffix), Node `crypto` AES-128-CCM (`createDecipheriv('aes-128-ccm', key, nonce, { authTagLength: 4 })`, built in, no new dependency), Zod config schema, Vitest.

## Global Constraints

- No em dash and no double dash in any commit, comment, code, or doc text.
- ES modules: all relative imports end in `.js`. TypeScript strict.
- Prettier: semicolons, single quotes, trailing commas, 100 char width. ESLint typescript-eslint recommended; `_` prefix for unused vars.
- Conventional Commits (`feat(scales): ...`).
- Never `git add -A` (it stages untracked `docs/superpowers/plans/*.md`). Stage explicit paths only.
- Pre-commit gate: `npx tsc --noEmit`, `npm run lint`, `npm run format:check`, `npm test`. Kill node first: `taskkill //F //IM node.exe` (bash) before any npm command.
- SECRET HANDLING: the real bind key and the reporter's real weigh-in bytes must never enter the repo (code, tests, fixtures, commits). All test vectors are SYNTHETIC (arbitrary weight, dummy key). The real decrypt was validated locally only.

## Verified protocol facts (from in-session decode)

- FE95 frame layout: `FC(2 LE) | PID(2 LE) | frameCounter(1) | [MAC(6) if FC bit 0x10] | cipher(n) | extCounter(3) | MIC(4)`.
- `macIncluded = (fc & 0x10) !== 0`. `encrypted = (fc & 0x08) !== 0`.
- PID for the S800 is `0x51E2` (= 20962, matches the `ms116` pdid). In the FE95 bytes that is `E2 51` at offset 2.
- AES-CCM decrypt: `key = bindKey (16 bytes)`, `nonce = macFrameOrder(6) || data[2..5) || extCounter(3)` (12 bytes), `AAD = [0x11]`, `authTagLength = 4`. `cipher = data[cipherStart .. len-7)` where `cipherStart = 11` if MAC included else `5`. `mic = data[len-4 ..]`. A wrong key or MAC fails the tag (decrypt throws), which the adapter treats as null.
- `macFrameOrder` is the device MAC in the byte order it appears in the frame (the reversed device MAC, e.g. device `04:AE:47:8F:A1:AB` -> `AB A1 8F 47 AE 04`). For MAC-included frames it is `data[5..11)`; for MAC-omitted frames (the rich `0x4e16` frames, FC `0x5948`) the adapter uses the MAC it cached from an earlier MAC-included frame in the same session.
- Decrypted payload is the MiBeacon object TLV directly: `type(2 LE) | len(1) | value(len)`. Idle = `01 52 01 00` (type `0x5201`). Weigh-in = `16 4e 09 <9-byte value>` (type `0x4e16`, len 9). Weight = `value.readUInt16LE(7) / 100`, accepted only when in `[10, 250]` (the gate rejects the other rich frames, whose trailing uint16 decodes to 0.72 / 277 / 430 / 604).

## File Structure

- `src/config/schema.ts` - add optional `ble.bind_key` (hex 32 chars).
- `src/interfaces/scale-adapter.ts` - add `AdapterRuntimeConfig` type and optional `configure?(opts)` method.
- `src/scales/xiaomi-s800.ts` (new) - pure decrypt + parse helpers, and the `XiaomiS800Adapter`.
- `src/scales/index.ts` - register the adapter.
- `src/index.ts` - inject the bind key into adapters at startup and on reload.
- `tests/scales/xiaomi-s800.test.ts` (new) - synthetic-vector tests.
- `tests/config/schema.test.ts` - bind_key validation cases.
- `docs/guide/supported-scales.md`, `docs/guide/configuration.md` - document the model and the bind_key option.

---

## Task 1: Config schema + adapter runtime-config interface

Add the `ble.bind_key` field and the optional `configure` hook adapters use to receive per-device secrets.

**Files:**
- Modify: `src/config/schema.ts:82-100` (BleSchema)
- Modify: `src/interfaces/scale-adapter.ts` (new type + optional method)
- Test: `tests/config/schema.test.ts`

**Interfaces:**
- Produces: `ble.bind_key?: string | null` on the parsed config (32 lowercase/uppercase hex chars).
- Produces: `interface AdapterRuntimeConfig { bindKey?: string }` and `ScaleAdapter.configure?(opts: AdapterRuntimeConfig): void`.

- [ ] **Step 1: Write the failing schema test**

In `tests/config/schema.test.ts`, reuse the existing `VALID_CONFIG` fixture (already defined in this file, with a complete valid `users` array; `AppConfigSchema` is already imported) and add near the other `AppConfigSchema` cases:

```typescript
it('accepts a 32-hex ble.bind_key', () => {
  const r = AppConfigSchema.safeParse({
    ...VALID_CONFIG,
    ble: { bind_key: '0123456789abcdef0123456789abcdef' },
  });
  expect(r.success).toBe(true);
});

it('rejects a malformed ble.bind_key', () => {
  const r = AppConfigSchema.safeParse({ ...VALID_CONFIG, ble: { bind_key: 'not-hex' } });
  expect(r.success).toBe(false);
});
```

Spreading `VALID_CONFIG` and overriding only `ble` isolates the bind_key validation. `ble: { bind_key }` is itself valid because `handler` defaults to `'auto'` and every other ble field is optional. Do NOT hand-build a partial `users` entry: `UserSchema` requires `name`, `slug`, `height`, `birth_date`, `gender`, `is_athlete`, and `weight_range`, so a partial user would fail for the wrong reason.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/config/schema.test.ts`
Expected: FAIL (the malformed-key case passes today because `bind_key` is an unknown key that Zod strips/ignores, so the "rejects" assertion fails).

- [ ] **Step 3: Add `bind_key` to BleSchema**

In `src/config/schema.ts`, inside the `BleSchema` `z.object({ ... })` (after the `scale_mac` field, before `noble_driver`):

```typescript
    bind_key: z
      .string()
      .regex(/^[0-9a-fA-F]{32}$/, 'Must be a 32-character hex bind key (16 bytes)')
      .optional()
      .nullable(),
```

- [ ] **Step 4: Add the adapter runtime-config interface**

In `src/interfaces/scale-adapter.ts`, add this type just above `export interface ScaleAdapter {`:

```typescript
/**
 * Per-device runtime configuration injected into adapters at startup (and on
 * config reload) by the composition root. Distinct from the static registry:
 * carries credentials that only exist in the user's config, e.g. the Xiaomi
 * S800 MiBeacon bind key. Adapters that do not need it omit `configure`.
 */
export interface AdapterRuntimeConfig {
  /** MiBeacon bind key (32 hex chars) for broadcast-encrypted scales (Xiaomi S800). */
  bindKey?: string;
}
```

Then add this optional member inside `interface ScaleAdapter` (right after the `preferPassive` block, before `requiresBonding`):

```typescript
  /**
   * Receive per-device runtime config (e.g. a MiBeacon bind key) from the
   * composition root at startup and on config reload. Optional: only adapters
   * that decrypt a per-device secret implement it.
   */
  configure?(opts: AdapterRuntimeConfig): void;
```

- [ ] **Step 5: Run the schema test to verify it passes**

Run: `npx vitest run tests/config/schema.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/config/schema.ts src/interfaces/scale-adapter.ts tests/config/schema.test.ts
git commit -m "feat(config): add ble.bind_key and adapter configure() hook (#232)"
```

---

## Task 2: Xiaomi S800 adapter with decrypt + parse helpers

Implement the adapter and its pure MiBeacon helpers, tested entirely with synthetic vectors.

**Files:**
- Create: `src/scales/xiaomi-s800.ts`
- Test: `tests/scales/xiaomi-s800.test.ts`

**Interfaces:**
- Consumes: `AdapterRuntimeConfig` (Task 1), `buildPayload`/`computeBiaFat` from `./body-comp-helpers.js`, `ScaleAdapter`/`BleDeviceInfo`/`ScaleReading`/`UserProfile`/`BodyComposition` from `../interfaces/scale-adapter.js`.
- Produces: `class XiaomiS800Adapter implements ScaleAdapter`. Exported pure helpers `decryptMiBeaconV5(data: Buffer, bindKey: Buffer, macFrameOrder: Buffer): Buffer | null`, `macFrameOrderFromFrame(data: Buffer): Buffer | null`, `parseS800Object(decrypted: Buffer): ScaleReading | null`, and constant `S800_PID = 0x51e2`.

- [ ] **Step 1: Write the failing adapter tests**

Create `tests/scales/xiaomi-s800.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { createCipheriv } from 'node:crypto';
import {
  XiaomiS800Adapter,
  decryptMiBeaconV5,
  macFrameOrderFromFrame,
  parseS800Object,
  S800_PID,
} from '../../src/scales/xiaomi-s800.js';

// SYNTHETIC test data only. No real bind key, no real weigh-in bytes.
const DUMMY_KEY = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex');
const MAC_FRAME = Buffer.from('aba18f47ae04', 'hex'); // arbitrary reversed MAC

// Build the 12-byte decrypted 0x4e16 object for a given weight (kg).
function weightObject(kg: number): Buffer {
  const raw = Math.round(kg * 100);
  const value = Buffer.from([0x90, 0, 0, 0x05, 0x2b, 0, 0, raw & 0xff, (raw >> 8) & 0xff]); // 9 bytes
  return Buffer.concat([Buffer.from([0x16, 0x4e, 0x09]), value]);
}

// Encrypt an object into a full FE95 frame (MAC-included variant, FC 0x5958).
function buildFrame(obj: Buffer, key: Buffer, macFrame: Buffer, cnt = 0x5b): Buffer {
  const fc = Buffer.from([0x58, 0x59]);
  const pid = Buffer.from([0xe2, 0x51]);
  const ext = Buffer.from([0x01, 0x00, 0x00]);
  const nonce = Buffer.concat([macFrame, Buffer.from([pid[0], pid[1], cnt]), ext]);
  const cipher = createCipheriv('aes-128-ccm', key, nonce, { authTagLength: 4 });
  cipher.setAAD(Buffer.from([0x11]), { plaintextLength: obj.length });
  const enc = Buffer.concat([cipher.update(obj), cipher.final()]);
  const mic = cipher.getAuthTag();
  return Buffer.concat([fc, pid, Buffer.from([cnt]), macFrame, enc, ext, mic]);
}

describe('parseS800Object', () => {
  it('reads weight from a 0x4e16 object', () => {
    expect(parseS800Object(weightObject(75))).toEqual({ weight: 75, impedance: 0 });
  });

  it('rejects an out-of-range trailing value', () => {
    // trailing uint16 = 0x0048 = 72 -> 0.72 kg, out of [10,250]
    const obj = Buffer.from([0x16, 0x4e, 0x09, 0x90, 0, 0, 0x05, 0x2b, 0, 0, 0x48, 0x00]);
    expect(parseS800Object(obj)).toBeNull();
  });

  it('ignores the idle 0x5201 object', () => {
    expect(parseS800Object(Buffer.from([0x01, 0x52, 0x01, 0x00]))).toBeNull();
  });
});

describe('decryptMiBeaconV5', () => {
  it('round-trips a synthetic encrypted frame', () => {
    const frame = buildFrame(weightObject(75), DUMMY_KEY, MAC_FRAME);
    const dec = decryptMiBeaconV5(frame, DUMMY_KEY, macFrameOrderFromFrame(frame)!);
    expect(dec).not.toBeNull();
    expect(parseS800Object(dec!)).toEqual({ weight: 75, impedance: 0 });
  });

  it('returns null on a wrong key (tag mismatch)', () => {
    const frame = buildFrame(weightObject(75), DUMMY_KEY, MAC_FRAME);
    const wrong = Buffer.alloc(16, 0xff);
    expect(decryptMiBeaconV5(frame, wrong, macFrameOrderFromFrame(frame)!)).toBeNull();
  });

  it('extracts the frame MAC only when FC marks it present', () => {
    const withMac = buildFrame(weightObject(75), DUMMY_KEY, MAC_FRAME);
    expect(macFrameOrderFromFrame(withMac)?.toString('hex')).toBe(MAC_FRAME.toString('hex'));
  });
});

describe('XiaomiS800Adapter', () => {
  const adapter = new XiaomiS800Adapter();

  it('matches an FE95 advertisement carrying the S800 product id', () => {
    const sd = Buffer.from([0x58, 0x59, 0xe2, 0x51, 0x5b, 0, 0, 0, 0, 0, 0]);
    expect(
      adapter.matches({ localName: '', serviceUuids: [], serviceData: [{ uuid: 'fe95', data: sd }] }),
    ).toBe(true);
  });

  it('matches by the S800 advertised name', () => {
    expect(
      adapter.matches({ localName: 'Mijia Scale S800 A1AB', serviceUuids: [], serviceData: [] }),
    ).toBe(true);
  });

  it('does not match an unrelated device', () => {
    expect(adapter.matches({ localName: 'QN-Scale', serviceUuids: ['fff0'], serviceData: [] })).toBe(
      false,
    );
  });

  it('decrypts a configured weigh-in advert into a weight reading', () => {
    const a = new XiaomiS800Adapter();
    a.configure({ bindKey: DUMMY_KEY.toString('hex') });
    const frame = buildFrame(weightObject(82.4), DUMMY_KEY, MAC_FRAME);
    expect(a.parseServiceData('fe95', frame)).toEqual({ weight: 82.4, impedance: 0 });
  });

  it('returns null when no bind key is configured', () => {
    const a = new XiaomiS800Adapter();
    const frame = buildFrame(weightObject(82.4), DUMMY_KEY, MAC_FRAME);
    expect(a.parseServiceData('fe95', frame)).toBeNull();
  });

  it('caches the MAC from a MAC-included frame to decrypt a MAC-omitted rich frame', () => {
    const a = new XiaomiS800Adapter();
    a.configure({ bindKey: DUMMY_KEY.toString('hex') });
    // Prime the cache with a MAC-included frame (idle object).
    const idle = buildFrame(Buffer.from([0x01, 0x52, 0x01, 0x00]), DUMMY_KEY, MAC_FRAME);
    expect(a.parseServiceData('fe95', idle)).toBeNull();
    // MAC-omitted rich frame (FC 0x5948): same key + nonce uses the cached MAC.
    const obj = weightObject(82.4);
    const ext = Buffer.from([0x01, 0x00, 0x00]);
    const cnt = 0x5c;
    const nonce = Buffer.concat([MAC_FRAME, Buffer.from([0xe2, 0x51, cnt]), ext]);
    const c = createCipheriv('aes-128-ccm', DUMMY_KEY, nonce, { authTagLength: 4 });
    c.setAAD(Buffer.from([0x11]), { plaintextLength: obj.length });
    const enc = Buffer.concat([c.update(obj), c.final()]);
    const rich = Buffer.concat([
      Buffer.from([0x48, 0x59, 0xe2, 0x51, cnt]),
      enc,
      ext,
      c.getAuthTag(),
    ]);
    expect(a.parseServiceData('fe95', rich)).toEqual({ weight: 82.4, impedance: 0 });
  });

  it('computes body composition from weight when impedance is 0', () => {
    const profile = { height: 174, age: 38, gender: 'male' as const, isAthlete: false };
    const comp = adapter.computeMetrics({ weight: 75, impedance: 0 }, profile);
    expect(comp.weight).toBe(75);
    expect(comp.bmi).toBeGreaterThan(20);
    expect(comp.bodyFatPercent).toBeGreaterThan(0);
  });

  it('exposes the S800 product id constant', () => {
    expect(S800_PID).toBe(0x51e2);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/scales/xiaomi-s800.test.ts`
Expected: FAIL (module `xiaomi-s800.js` does not exist yet).

- [ ] **Step 3: Implement the adapter**

Create `src/scales/xiaomi-s800.ts`:

```typescript
import { createDecipheriv } from 'node:crypto';
import type {
  AdapterRuntimeConfig,
  BleDeviceInfo,
  BodyComposition,
  ScaleAdapter,
  ScaleReading,
  UserProfile,
} from '../interfaces/scale-adapter.js';
import { buildPayload, computeBiaFat } from './body-comp-helpers.js';
import { bleLog } from '../ble/types.js';

/** Xiaomi MiService advertisement service UUID. */
const SVC_FE95 = '0000fe9500001000800000805f9b34fb';

/** Product id of the Mijia Scale S800 (xiaomi.scales.ms116, pdid 20962). */
export const S800_PID = 0x51e2;

/** MiBeacon frame-control bits. */
const FC_ENCRYPTED = 0x08;
const FC_MAC_INCLUDED = 0x10;

/** MiBeacon object id carrying the weigh-in measurement (9-byte value). */
const OBJ_MEASUREMENT = 0x4e16;

/** Plausible human-weight gate (kg) for the decoded trailing uint16. */
const WEIGHT_MIN = 10;
const WEIGHT_MAX = 250;

/** Normalize a service-data UUID (short, dashed, or 128-bit) to 32-char hex. */
function normUuid(uuid: string): string {
  const s = uuid.toLowerCase().replace(/[-{}]/g, '');
  if (s.length === 4) return `0000${s}00001000800000805f9b34fb`;
  if (s.length === 8) return `${s}00001000800000805f9b34fb`;
  return s;
}

/** Return the 6-byte frame-order MAC if the FE95 frame includes it, else null. */
export function macFrameOrderFromFrame(data: Buffer): Buffer | null {
  if (data.length < 11) return null;
  const fc = data.readUInt16LE(0);
  if ((fc & FC_MAC_INCLUDED) === 0) return null;
  return data.subarray(5, 11);
}

/**
 * Decrypt a MiBeacon v5 FE95 advertisement. Returns the decrypted object TLV
 * (`type(2 LE) | len | value`) or null when the frame is unencrypted, malformed,
 * or fails the AES-CCM tag (wrong key / wrong MAC).
 *
 * Layout: FC(2 LE) | PID(2) | cnt(1) | [MAC(6) if FC&0x10] | cipher | extCnt(3) | MIC(4).
 * nonce = macFrameOrder(6) || data[2..5) || extCnt(3); AAD = 0x11; tag = 4 bytes.
 */
export function decryptMiBeaconV5(
  data: Buffer,
  bindKey: Buffer,
  macFrameOrder: Buffer,
): Buffer | null {
  if (data.length < 12 || bindKey.length !== 16 || macFrameOrder.length !== 6) return null;
  const fc = data.readUInt16LE(0);
  if ((fc & FC_ENCRYPTED) === 0) return null;
  const cipherStart = (fc & FC_MAC_INCLUDED) !== 0 ? 11 : 5;
  if (data.length < cipherStart + 7) return null;
  const cipher = data.subarray(cipherStart, data.length - 7);
  const extCnt = data.subarray(data.length - 7, data.length - 4);
  const mic = data.subarray(data.length - 4);
  const nonce = Buffer.concat([macFrameOrder, data.subarray(2, 5), extCnt]);
  try {
    const dec = createDecipheriv('aes-128-ccm', bindKey, nonce, { authTagLength: 4 });
    dec.setAuthTag(mic);
    dec.setAAD(Buffer.from([0x11]), { plaintextLength: cipher.length });
    return Buffer.concat([dec.update(cipher), dec.final()]);
  } catch {
    return null;
  }
}

/**
 * Parse a decrypted MiBeacon object TLV. Returns a weight reading when it is the
 * 0x4e16 measurement object whose trailing uint16 LE / 100 is a plausible weight,
 * else null (idle 0x5201, wrong object, or a non-weight rich frame).
 */
export function parseS800Object(decrypted: Buffer): ScaleReading | null {
  if (decrypted.length < 3) return null;
  const type = decrypted.readUInt16LE(0);
  const len = decrypted[2];
  if (type !== OBJ_MEASUREMENT || len < 9 || decrypted.length < 3 + len) return null;
  const value = decrypted.subarray(3, 3 + len);
  const weight = value.readUInt16LE(7) / 100;
  if (weight < WEIGHT_MIN || weight > WEIGHT_MAX) return null;
  return { weight, impedance: 0 };
}

/**
 * Xiaomi Mijia 8-electrode Body Composition Scale S800 (xiaomi.scales.ms116).
 *
 * Broadcast-only adapter. The S800 advertises encrypted MiBeacon v5 in service
 * data 0xFE95; the weigh-in object 0x4e16 carries weight (uint16 LE / 100). The
 * frames are AES-CCM encrypted under a per-device bind key from the Mi cloud,
 * configured as `ble.bind_key`. The full segmental body composition is only on
 * the encrypted Mi-auth GATT path (per-user token) and is out of scope; weight
 * plus the user profile drives the existing body-composition pipeline (#232).
 */
export class XiaomiS800Adapter implements ScaleAdapter {
  readonly name = 'Xiaomi Mijia Scale S800';
  // Broadcast-only: no GATT characteristics. preferPassive forces the broadcast
  // path even though the scale is connectable.
  readonly charNotifyUuid = '';
  readonly charWriteUuid = '';
  readonly unlockCommand: number[] = [];
  readonly unlockIntervalMs = 0;
  readonly normalizesWeight = true;
  readonly preferPassive = true;

  private bindKey: Buffer | null = null;
  /** Real device MAC (frame byte order) cached from a MAC-included frame. */
  private cachedMac: Buffer | null = null;
  private warnedNoKey = false;

  configure(opts: AdapterRuntimeConfig): void {
    this.bindKey =
      opts.bindKey && /^[0-9a-fA-F]{32}$/.test(opts.bindKey)
        ? Buffer.from(opts.bindKey, 'hex')
        : null;
  }

  matches(device: BleDeviceInfo): boolean {
    const name = (device.localName || '').toLowerCase();
    if (name.includes('mijia scale s800')) return true;
    for (const sd of device.serviceData ?? []) {
      if (
        normUuid(sd.uuid) === SVC_FE95 &&
        sd.data.length >= 4 &&
        sd.data.readUInt16LE(2) === S800_PID
      ) {
        return true;
      }
    }
    return false;
  }

  parseServiceData(uuid: string, data: Buffer): ScaleReading | null {
    if (normUuid(uuid) !== SVC_FE95) return null;
    if (data.length >= 4 && data.readUInt16LE(2) !== S800_PID) return null;

    // Cache the real MAC from any MAC-included frame so MAC-omitted rich frames
    // (FC 0x5948) can build the AES-CCM nonce.
    const frameMac = macFrameOrderFromFrame(data);
    if (frameMac) this.cachedMac = Buffer.from(frameMac);

    if (!this.bindKey) {
      if (!this.warnedNoKey) {
        this.warnedNoKey = true;
        bleLog.warn('Xiaomi S800 detected but ble.bind_key is not configured; cannot decode weight');
      }
      return null;
    }

    const mac = frameMac ?? this.cachedMac;
    if (!mac) return null; // no MAC seen yet this session
    const decrypted = decryptMiBeaconV5(data, this.bindKey, mac);
    if (!decrypted) return null;
    return parseS800Object(decrypted);
  }

  // Broadcast-only: no GATT notifications.
  parseNotification(): ScaleReading | null {
    return null;
  }

  isComplete(reading: ScaleReading): boolean {
    // Broadcast weight has impedance 0; accept any plausible weight.
    return reading.weight > WEIGHT_MIN;
  }

  computeMetrics(reading: ScaleReading, profile: UserProfile): BodyComposition {
    const fat =
      reading.impedance > 0 ? computeBiaFat(reading.weight, reading.impedance, profile) : undefined;
    return buildPayload(reading.weight, reading.impedance, { fat }, profile);
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/scales/xiaomi-s800.test.ts`
Expected: PASS (all cases green).

- [ ] **Step 5: Type-check, lint, format**

Run: `npx tsc --noEmit && npm run lint && npm run format:check`
Expected: clean. (If format fails, run `npm run format` and re-stage.)

- [ ] **Step 6: Commit**

```bash
git add src/scales/xiaomi-s800.ts tests/scales/xiaomi-s800.test.ts
git commit -m "feat(scales): add Xiaomi Mijia S800 broadcast adapter (#232)"
```

---

## Task 3: Register the adapter and inject the bind key

Add the adapter to the registry and pass `ble.bind_key` into adapters at startup and on reload.

**Files:**
- Modify: `src/scales/index.ts` (import + registry entry)
- Modify: `src/index.ts` (inject config into adapters at startup and in `onReload`)
- Test: `tests/scales/adapter-resolution.test.ts` (S800 resolves from its advert)

**Interfaces:**
- Consumes: `XiaomiS800Adapter` (Task 2), `ScaleAdapter.configure` (Task 1).

- [ ] **Step 1: Write the failing resolution test**

In `tests/scales/adapter-resolution.test.ts`, add a case asserting the registry resolves an S800 FE95 advert to the new adapter:

```typescript
it('resolves a Xiaomi S800 FE95 advertisement to the S800 adapter', () => {
  const sd = Buffer.from([0x58, 0x59, 0xe2, 0x51, 0x5b, 0, 0, 0, 0, 0, 0]);
  const match = adapters.find((a) =>
    a.matches({ localName: 'Mijia Scale S800 A1AB', serviceUuids: [], serviceData: [{ uuid: 'fe95', data: sd }] }),
  );
  expect(match?.name).toBe('Xiaomi Mijia Scale S800');
});
```

(Match the existing assertion style in this file; if it uses a helper to build `BleDeviceInfo`, reuse it instead of the inline object.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/scales/adapter-resolution.test.ts`
Expected: FAIL (`match` is undefined; the adapter is not registered yet).

- [ ] **Step 3: Register the adapter**

In `src/scales/index.ts`, add the import next to the other Xiaomi import:

```typescript
import { XiaomiS800Adapter } from './xiaomi-s800.js';
```

And add it to the `adapters` array right after `new MiScale2Adapter(),` (group the Xiaomi adapters; the S800 matches only FE95 + PID or its own name, so it does not collide with any other entry):

```typescript
  new XiaomiS800Adapter(),
```

- [ ] **Step 3b: Add the registry-collision fixture (REQUIRED)**

`tests/scales/registry-collision.test.ts` enforces one representative `BleDeviceInfo` per registered adapter (`it.each(adapters.map(...))` fails with "No fixture for registered adapter" otherwise). Add an entry to the `FIXTURES` record (keyed by the exact adapter name), near the `'Xiaomi Mi Scale 2'` entry:

```typescript
  'Xiaomi Mijia Scale S800': { localName: 'Mijia Scale S800 A1AB', serviceUuids: [] },
```

This name-only fixture resolves uniquely to the S800 (no other adapter matches `mijia scale s800`, and the S800 matches no other fixture). Run `npx vitest run tests/scales/registry-collision.test.ts` and confirm it passes; if it reports a collision, the S800 `matches()` is too broad or another adapter shadows it, so fix precedence before continuing.

- [ ] **Step 4: Inject the bind key at the composition root**

In `src/index.ts`, add a small helper near the top-level imports usage (after the `adapters` import is in scope) — place the function definition above the run function or as a module-level const:

```typescript
function applyAdapterBindKey(bindKey: string | undefined): void {
  for (const a of adapters) a.configure?.({ bindKey });
}
```

(Taking the key string directly, not the config object, avoids coupling the helper to the `AppConfig` type.) Call it once at startup, right after the `Adapters: ...` log line (`src/index.ts:185`):

```typescript
  applyAdapterBindKey(ctx.config.ble?.bind_key ?? undefined);
```

And call it again inside `onReload`, right after `await reloadAppConfig(ctx, displaySnapshotRef);` (so a hot-edited bind key takes effect):

```typescript
    applyAdapterBindKey(ctx.config.ble?.bind_key ?? undefined);
```

- [ ] **Step 5: Run the resolution test and the full suite**

Run: `npx vitest run tests/scales/adapter-resolution.test.ts tests/scales/registry-check.test.ts`
Expected: PASS (S800 resolves, registry integrity intact with StandardGatt still last).

- [ ] **Step 6: Type-check, lint, format, full test**

Run: `taskkill //F //IM node.exe; npx tsc --noEmit && npm run lint && npm run format:check && npm test`
Expected: clean, all tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/scales/index.ts src/index.ts tests/scales/adapter-resolution.test.ts tests/scales/registry-collision.test.ts
git commit -m "feat(scales): register Xiaomi S800 and inject bind key at startup (#232)"
```

---

## Task 4: Documentation

Document the new model and the `bind_key` option.

**Files:**
- Modify: `docs/guide/supported-scales.md`
- Modify: `docs/guide/configuration.md`

- [ ] **Step 1: Add the S800 to the supported-scales page**

In `docs/guide/supported-scales.md`, add a row/entry for the Xiaomi Mijia Body Composition Scale S800 in the same format as the existing entries. Note it is weight-only over an encrypted broadcast and requires `ble.bind_key`. Body composition is estimated from weight plus profile (segmental data needs the unsupported encrypted GATT path). Do not use em dash or double dash.

- [ ] **Step 2: Document `ble.bind_key` in the configuration page**

In `docs/guide/configuration.md`, in the `ble` section, document `bind_key`: a 32-character hex per-device key from the Mi cloud (extract with the community Xiaomi-cloud-tokens-extractor), used only to decrypt the device's own FE95 broadcast. Required for the Xiaomi S800. Keep it secret (it is a credential). Example:

```yaml
ble:
  scale_mac: "AA:BB:CC:DD:EE:FF"
  bind_key: "0123456789abcdef0123456789abcdef"
```

Use a generic placeholder MAC and key in the docs, not the reporter's real device values.

- [ ] **Step 3: Commit**

```bash
git add docs/guide/supported-scales.md docs/guide/configuration.md
git commit -m "docs: document Xiaomi S800 support and ble.bind_key (#232)"
```

---

## Verification (whole-plan)

- [ ] `taskkill //F //IM node.exe; npm test` -> all pass (new S800 suite + schema + resolution).
- [ ] `npx tsc --noEmit` -> clean.
- [ ] `npm run lint && npm run format:check` -> clean.
- [ ] `git grep -n "9c449b\|b1d95ff\|04:AE:47:8F:A1:AB"` -> NO matches anywhere in tracked files (the real bind key, token, and reporter MAC never entered the repo; docs use a generic placeholder MAC). The untracked plan file under `docs/superpowers/plans/` is not committed and not searched by `git grep`.

## Out of scope (and why)

- Full 8-electrode segmental body composition (fat, water, muscle, BMR): not in the broadcast (Mi Home computes it app-side; confirmed by ground-truth correlation). It lives behind the encrypted Mi Standard Authentication GATT path (per-user token, full Mi auth stack). Deferred as a separate, heavier feature.
- Real impedance: Mi Home does not surface it and the broadcast bytes beyond weight did not correlate to any ground-truth value, so body composition uses the Deurenberg estimate (the same path every other broadcast-only adapter uses).
- Wizard prompt for `bind_key`: it is an advanced per-device credential; the schema accepts it and the docs explain it. A wizard step can be added later if demand appears.
- Multi-scale bind keys: the config is single-device (`ble.scale_mac` / `ble.bind_key`), matching the rest of the project.

## Self-Review

**Spec coverage:** Solution 1 (weight-only broadcast adapter) is implemented across Task 2 (adapter + decrypt + parse), Task 1 (bind_key config + configure hook), Task 3 (registration + injection), Task 4 (docs). The verified weight extraction (`0x4e16` value uint16 LE @7 / 100, gated [10,250]) is the core of `parseS800Object`. MAC caching handles the MAC-omitted rich frames. Body composition via `buildPayload` Deurenberg fallback (impedance 0).

**Placeholder scan:** No TBD. Every code step shows complete code; the only prose-only steps are the two docs edits, which describe exact content and the format to mirror.

**Type consistency:** `configure(opts: AdapterRuntimeConfig)` defined in Task 1 is implemented in Task 2 and called in Task 3 as `a.configure?.({ bindKey })`. `decryptMiBeaconV5(data, bindKey: Buffer, macFrameOrder: Buffer)` and `parseS800Object(decrypted) -> ScaleReading | null` and `macFrameOrderFromFrame(data) -> Buffer | null` and `S800_PID` are defined and exported in Task 2 and consumed by the Task 2 tests with matching signatures. `XiaomiS800Adapter.name` is the exact string `'Xiaomi Mijia Scale S800'` asserted in the Task 3 resolution test.
