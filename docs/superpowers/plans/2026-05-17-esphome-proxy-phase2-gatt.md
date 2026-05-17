# ESPHome Proxy Phase 2 (GATT) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add full GATT parity to the ESPHome Bluetooth proxy transport, with a multi-proxy pool and RSSI auto-pick, for single-shot and continuous modes.

**Architecture:** Split the single `handler-esphome-proxy.ts` into a module directory. A `pool.ts` owns N ESPHome clients, aggregates advertisements and routes GATT connects to the proxy that last saw the MAC. A `gatt.ts` bridge exposes ESPHome handle-based GATT as the UUID-based `BleChar`/`BleDevice` interfaces, then reuses the existing `waitForRawReading()` seam so every adapter works unchanged.

**Tech Stack:** TypeScript (ES modules, strict), `@2colors/esphome-native-api` 1.3.6, vitest, zod.

Spec: `docs/superpowers/specs/2026-05-17-esphome-proxy-phase2-gatt-design.md` (issue #116).

**Pinned library facts (from installed v1.3.6 source, used throughout):**

- `client.connection: Connection` (EventEmitter). GATT methods live on it.
- `connectBluetoothDeviceService(addr:number, addressType?:number)` → resolves `BluetoothDeviceConnectionResponse` with `.address .connected .mtu .error`.
- `disconnectBluetoothDeviceService(addr)` likewise.
- `listBluetoothGATTServicesService(addr)` → `{ address, servicesList: Array<{ uuidList, handle, characteristicsList: Array<{ uuidList, handle, properties }> }> }`.
- `readBluetoothGATTCharacteristicService(addr, handle)` → `BluetoothGATTReadResponse` with `.dataList`.
- `writeBluetoothGATTCharacteristicService(addr, handle, value:Uint8Array, response:boolean)`.
- `notifyBluetoothGATTCharacteristicService(addr, handle)` enables notify; data arrives as `connection.on('message.BluetoothGATTNotifyDataResponse', m => { m.address; m.handle; m.dataList })`.
- Peer connect/disconnect: `connection.on('message.BluetoothDeviceConnectionResponse', m => { m.address; m.connected })`.
- `address` is the uint64 MAC as a JS number (48-bit, safe).

---

## File Structure

```
src/ble/handler-esphome-proxy/
  index.ts      # re-export public API + _internals (stable import sites)
  client.ts     # createEsphomeClient, waitForConnected, safeDisconnect (moved verbatim)
  advert.ts     # toBleDeviceInfo, formatMacAddress, macToInt, parseManufacturerId, extractBytes
  esphome-gatt-proto.ts  # typed thin wrapper over connection GATT msgs + esphomeUuidToString
  pool.ts       # EsphomeProxyPool: clients, advert aggregation, pickProxyFor, connectGatt
  gatt.ts       # GATT bridge: BleChar/BleDevice over a pool GATT session
  scan.ts       # scanAndReadRaw, scanAndRead, scanDevices (broadcast + GATT)
  watcher.ts    # ReadingWatcher (continuous; broadcast + GATT)
tests/ble/esphome-proxy/
  advert.test.ts  pool.test.ts  gatt.test.ts  scan.test.ts  watcher.test.ts
  schema-additional-proxies.test.ts
```

Existing `src/ble/handler-esphome-proxy.ts` is deleted; `src/ble/index.ts` import path updated to `./handler-esphome-proxy/index.js`. Existing test file `tests/ble/handler-esphome-proxy.test.ts` (if present) is repointed at `index.js`.

---

## Task 0: Spike - pin uuidList format + GATT proto wrapper

**Files:**

- Create: `src/ble/handler-esphome-proxy/esphome-gatt-proto.ts`
- Test: `tests/ble/esphome-proxy/esphome-gatt-proto.test.ts`

The only unverified library detail is how a 128-bit UUID is encoded in `servicesList[].uuidList` / `characteristicsList[].uuidList`. aioesphomeapi convention: a list of two uint64 (as JS numbers/strings) `[high, low]` forming the 128-bit value, OR a single already-formatted string for 16-bit. We implement a converter that handles both and is verified against the Bluetooth base UUID, then confirmed with one real connect during execution checkpoint.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/ble/esphome-proxy/esphome-gatt-proto.test.ts
import { describe, it, expect } from 'vitest';
import { esphomeUuidToString } from '../../../src/ble/handler-esphome-proxy/esphome-gatt-proto.js';
import { normalizeUuid } from '../../../src/ble/types.js';

describe('esphomeUuidToString', () => {
  it('converts a [high, low] uint64 pair to the normalized 128-bit form', () => {
    // 0x2A9D Weight Measurement -> 00002a9d-0000-1000-8000-00805f9b34fb
    const high = 0x00002a9d00001000n;
    const low = 0x800000805f9b34fbn;
    expect(esphomeUuidToString([high.toString(), low.toString()])).toBe(normalizeUuid('2a9d'));
  });

  it('passes an already-stringified uuid through normalizeUuid', () => {
    expect(esphomeUuidToString(['0000181d-0000-1000-8000-00805f9b34fb'])).toBe(
      normalizeUuid('181d'),
    );
  });

  it('accepts numeric high/low halves', () => {
    expect(esphomeUuidToString([0x00002a9d00001000, 0x800000805f9b34fb])).toBe(
      normalizeUuid('2a9d'),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/ble/esphome-proxy/esphome-gatt-proto.test.ts`
Expected: FAIL, module not found / function not defined.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/ble/handler-esphome-proxy/esphome-gatt-proto.ts
import { normalizeUuid } from '../types.js';

/**
 * ESPHome encodes a GATT UUID either as a single pre-formatted string or as a
 * [high, low] pair of unsigned 64-bit halves of the 128-bit value (aioesphomeapi
 * convention). Normalize both into the project's 32-char lowercase form so it
 * compares against adapter UUIDs via the existing normalizeUuid().
 */
export function esphomeUuidToString(uuidList: Array<string | number>): string {
  if (uuidList.length === 1) return normalizeUuid(String(uuidList[0]));
  const toBig = (v: string | number): bigint => BigInt(v);
  const high = toBig(uuidList[0]) & ((1n << 64n) - 1n);
  const low = toBig(uuidList[1]) & ((1n << 64n) - 1n);
  const full = (high << 64n) | low;
  return normalizeUuid(full.toString(16).padStart(32, '0'));
}

/** Minimal structural types for the connection GATT messages we consume. */
export interface EsphomeGattCharacteristic {
  uuidList: Array<string | number>;
  handle: number;
  properties: number;
}
export interface EsphomeGattService {
  uuidList: Array<string | number>;
  handle: number;
  characteristicsList: EsphomeGattCharacteristic[];
}
export interface EsphomeGattServicesResponse {
  address: number;
  servicesList: EsphomeGattService[];
}
export interface EsphomeNotifyData {
  address: number;
  handle: number;
  dataList: number[];
}
export interface EsphomeDeviceConnection {
  address: number;
  connected: boolean;
  mtu?: number;
  error?: number;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/ble/esphome-proxy/esphome-gatt-proto.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/ble/handler-esphome-proxy/esphome-gatt-proto.ts tests/ble/esphome-proxy/esphome-gatt-proto.test.ts
git commit -m "feat(ble): ESPHome GATT proto types + uuid converter (#116)"
```

> **Execution checkpoint (manual, non-blocking):** during the first real-hardware test, log one `listBluetoothGATTServicesService` response and confirm `uuidList` ordering. If reversed, swap `high`/`low` in `esphomeUuidToString` and the test's expected pairing. This is the spec's risk #2; the converter is the single point of change.

---

## Task 1: Module split (no behavior change)

Pure refactor: move the current `handler-esphome-proxy.ts` into the directory, keep every export and test green. No logic changes.

**Files:**

- Create: `src/ble/handler-esphome-proxy/index.ts`, `client.ts`, `advert.ts`, `scan.ts`, `watcher.ts`
- Delete: `src/ble/handler-esphome-proxy.ts`
- Modify: `src/ble/index.ts` (two `import('./handler-esphome-proxy.js')` → `'./handler-esphome-proxy/index.js'`)
- Modify: existing esphome handler test import path if it imports the file directly.

- [ ] **Step 1: Run the existing suite to capture the green baseline**

Run: `npx vitest run tests/ble/handler-esphome-proxy.test.ts`
Expected: PASS. Record the test count.

- [ ] **Step 2: Create the module files by moving code verbatim**

- `client.ts`: `createEsphomeClient`, `waitForConnected`, `safeDisconnect`, `EsphomeClient` interface, `CONNECT_TIMEOUT_MS`.
- `advert.ts`: `formatMacAddress`, `parseManufacturerId`, `extractBytes`, `toBleDeviceInfo`, `EsphomeServiceData`, `EsphomeBleAdvertisement` interfaces. Add `macToInt` (inverse of `formatMacAddress`):

```typescript
/** Inverse of formatMacAddress: "AA:BB:.." -> uint64 number for ESPHome GATT. */
export function macToInt(mac: string): number {
  return Number.parseInt(mac.replace(/[:-]/g, ''), 16);
}
```

- `scan.ts`: `scanAndReadRaw`, `scanAndRead`, `scanDevices`, `gattNotSupportedError`, `logPhase1Capabilities`, constants `BROADCAST_WAIT_MS`, `SCAN_DEFAULT_MS`. Imports from `./client.js`, `./advert.js`.
- `watcher.ts`: `ReadingWatcher`, constants `DEDUP_WINDOW_MS`, `GATT_WARN_LRU_MAX`.
- `index.ts`:

```typescript
export { scanAndReadRaw, scanAndRead, scanDevices } from './scan.js';
export { ReadingWatcher } from './watcher.js';
import { formatMacAddress, parseManufacturerId, extractBytes, toBleDeviceInfo } from './advert.js';
export const _internals = { formatMacAddress, parseManufacturerId, extractBytes, toBleDeviceInfo };
```

- [ ] **Step 3: Delete the old file and update import sites**

Delete `src/ble/handler-esphome-proxy.ts`. In `src/ble/index.ts` change both dynamic imports to `'./handler-esphome-proxy/index.js'`. Repoint the existing test import to `../../src/ble/handler-esphome-proxy/index.js`.

- [ ] **Step 4: Typecheck + run suite, expect identical green**

Run: `npx tsc --noEmit && npx vitest run tests/ble/handler-esphome-proxy.test.ts`
Expected: PASS, same test count as Step 1.

- [ ] **Step 5: Commit**

```bash
git add -A src/ble/handler-esphome-proxy src/ble/index.ts tests/ble
git rm src/ble/handler-esphome-proxy.ts
git commit -m "refactor(ble): split handler-esphome-proxy into module directory (#116)"
```

---

## Task 2: `additional_proxies` config schema + backward compat

**Files:**

- Modify: `src/config/schema.ts:12-23` (EsphomeProxySchema)
- Test: `tests/ble/esphome-proxy/schema-additional-proxies.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest';
import { EsphomeProxySchema } from '../../../src/config/schema.js';

describe('EsphomeProxySchema additional_proxies (#116)', () => {
  it('defaults additional_proxies to [] for an existing single-host config', () => {
    const r = EsphomeProxySchema.safeParse({ host: 'proxy1.home' });
    expect(r.success && r.data.additional_proxies).toEqual([]);
  });

  it('accepts a list of extra proxies with independent auth', () => {
    const r = EsphomeProxySchema.safeParse({
      host: 'proxy1.home',
      encryption_key: 'k1',
      additional_proxies: [
        { host: 'proxy2.home', encryption_key: 'k2' },
        { host: 'proxy3.home', password: 'p3' },
      ],
    });
    expect(r.success).toBe(true);
    expect(r.success && r.data.additional_proxies[1].host).toBe('proxy3.home');
    expect(r.success && r.data.additional_proxies[0].port).toBe(6053);
  });

  it('rejects an extra proxy with both encryption_key and password', () => {
    const r = EsphomeProxySchema.safeParse({
      host: 'p1',
      additional_proxies: [{ host: 'p2', encryption_key: 'k', password: 'x' }],
    });
    expect(r.success).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/ble/esphome-proxy/schema-additional-proxies.test.ts`
Expected: FAIL (`additional_proxies` undefined).

- [ ] **Step 3: Implement schema change**

In `src/config/schema.ts`, before `EsphomeProxySchema`, extract the per-endpoint shape and add the list:

```typescript
const EsphomeEndpointSchema = z
  .object({
    host: z.string().min(1, 'ESPHome host is required'),
    port: z.number().int().min(1).max(65535).default(6053),
    encryption_key: z.string().optional().nullable(),
    password: z.string().optional().nullable(),
    client_info: z.string().default('ble-scale-sync'),
  })
  .refine((c) => !(c.encryption_key && c.password), {
    message: 'Set either encryption_key (Noise) or password (legacy), not both',
    path: ['encryption_key'],
  });

export const EsphomeProxySchema = z
  .object({
    host: z.string().min(1, 'ESPHome host is required'),
    port: z.number().int().min(1).max(65535).default(6053),
    encryption_key: z.string().optional().nullable(),
    password: z.string().optional().nullable(),
    client_info: z.string().default('ble-scale-sync'),
    additional_proxies: z.array(EsphomeEndpointSchema).default([]),
  })
  .refine((c) => !(c.encryption_key && c.password), {
    message: 'Set either encryption_key (Noise) or password (legacy), not both',
    path: ['encryption_key'],
  });

export type EsphomeEndpointConfig = z.infer<typeof EsphomeEndpointSchema>;
```

`EsphomeProxyConfig` type export stays. (`z.infer` picks up the new field.)

- [ ] **Step 4: Run test + full schema suite**

Run: `npx vitest run tests/ble/esphome-proxy/schema-additional-proxies.test.ts tests/config/schema.test.ts`
Expected: PASS, existing schema tests still green (backward compat).

- [ ] **Step 5: Commit**

```bash
git add src/config/schema.ts tests/ble/esphome-proxy/schema-additional-proxies.test.ts
git commit -m "feat(config): optional esphome_proxy.additional_proxies list (#116)"
```

---

## Task 3: `EsphomeProxyPool` - clients, advert aggregation, auto-pick

**Files:**

- Create: `src/ble/handler-esphome-proxy/pool.ts`
- Test: `tests/ble/esphome-proxy/pool.test.ts`

Contract:

```typescript
export interface ProxyEndpoint {
  id: string; // host:port
  host: string;
  port: number;
  encryption_key?: string | null;
  password?: string | null;
  client_info: string;
}
export class EsphomeProxyPool {
  constructor(config: EsphomeProxyConfig);
  start(): Promise<void>; // connect all clients, subscribe ble
  stop(): Promise<void>;
  onAdvertisement(cb: (info: BleDeviceInfo, mac: string) => void): () => void;
  pickProxyFor(macLc: string): string | null; // proxyId or null
  getClient(proxyId: string): EsphomeClient | null;
  // ordered best-first proxy ids for a MAC (auto-pick + fallback)
  proxyOrderFor(macLc: string): string[];
}
```

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EsphomeProxyPool } from '../../../src/ble/handler-esphome-proxy/pool.js';

// Mock the client factory so no real sockets open.
const fakeClients = new Map<string, any>();
vi.mock('../../../src/ble/handler-esphome-proxy/client.js', () => ({
  createEsphomeClient: vi.fn(async (cfg: any) => {
    const listeners: Record<string, Function[]> = {};
    const c = {
      connected: true,
      connect() {
        (listeners['connected'] ?? []).forEach((f) => f());
      },
      disconnect() {},
      on(ev: string, fn: Function) {
        (listeners[ev] ??= []).push(fn);
        return c;
      },
      removeListener(ev: string, fn: Function) {
        listeners[ev] = (listeners[ev] ?? []).filter((f) => f !== fn);
        return c;
      },
      _emit(ev: string, arg?: any) {
        (listeners[ev] ?? []).forEach((f) => f(arg));
      },
    };
    fakeClients.set(cfg.host, c);
    return c;
  }),
  waitForConnected: vi.fn(async () => {}),
  safeDisconnect: vi.fn(async () => {}),
}));

const adv = (addr: number, rssi: number) => ({
  address: addr,
  name: 'QN-Scale',
  rssi,
  serviceUuidsList: [],
  serviceDataList: [],
  manufacturerDataList: [],
});

describe('EsphomeProxyPool', () => {
  beforeEach(() => fakeClients.clear());

  it('aggregates advertisements from every proxy', async () => {
    const pool = new EsphomeProxyPool({
      host: 'p1',
      port: 6053,
      client_info: 'x',
      additional_proxies: [{ host: 'p2', port: 6053, client_info: 'x' }],
    } as any);
    await pool.start();
    const seen: string[] = [];
    pool.onAdvertisement((_info, mac) => seen.push(mac));
    fakeClients.get('p1')._emit('ble', adv(0x112233445566, -50));
    fakeClients.get('p2')._emit('ble', adv(0xaabbccddeeff, -60));
    expect(seen).toContain('11:22:33:44:55:66');
    expect(seen).toContain('AA:BB:CC:DD:EE:FF');
  });

  it('pickProxyFor returns the proxy with the strongest recent RSSI', async () => {
    const pool = new EsphomeProxyPool({
      host: 'p1',
      port: 6053,
      client_info: 'x',
      additional_proxies: [{ host: 'p2', port: 6053, client_info: 'x' }],
    } as any);
    await pool.start();
    fakeClients.get('p1')._emit('ble', adv(0x112233445566, -80));
    fakeClients.get('p2')._emit('ble', adv(0x112233445566, -40));
    expect(pool.pickProxyFor('11:22:33:44:55:66')).toBe('p2:6053');
    expect(pool.proxyOrderFor('11:22:33:44:55:66')).toEqual(['p2:6053', 'p1:6053']);
  });

  it('returns null when no proxy has seen the MAC', async () => {
    const pool = new EsphomeProxyPool({
      host: 'p1',
      port: 6053,
      client_info: 'x',
      additional_proxies: [],
    } as any);
    await pool.start();
    expect(pool.pickProxyFor('00:00:00:00:00:01')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/ble/esphome-proxy/pool.test.ts`
Expected: FAIL, `EsphomeProxyPool` not found.

- [ ] **Step 3: Implement `pool.ts`**

Key logic (full implementation): normalize `[primary, ...additional_proxies]` → `ProxyEndpoint[]` with `id = ${host}:${port}`; one `EsphomeClient` per endpoint via `createEsphomeClient`; `start()` connects each (reuse `waitForConnected`); each client's `ble` handler builds `BleDeviceInfo` via `toBleDeviceInfo`, records `sightings.set(macLc, {proxyId, rssi, ts})` keeping the entry with the most recent ts, and on equal-or-newer ts the stronger rssi; fan out to `onAdvertisement` subscribers. `pickProxyFor` returns the freshest sighting within `SIGHTING_TTL_MS` (60_000), strongest rssi tiebreak, else null. `proxyOrderFor` = picked first, then remaining endpoints ordered by their last sighting recency for that MAC (unseen endpoints last, stable order). `stop()` removes listeners + `safeDisconnect` all. Use a per-proxy sightings map keyed by macLc so `proxyOrderFor` can rank all proxies, not only the winner.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/ble/esphome-proxy/pool.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/ble/handler-esphome-proxy/pool.ts tests/ble/esphome-proxy/pool.test.ts
git commit -m "feat(ble): EsphomeProxyPool with advertisement aggregation + RSSI auto-pick (#116)"
```

---

## Task 4: GATT bridge (`gatt.ts`)

**Files:**

- Create: `src/ble/handler-esphome-proxy/gatt.ts`
- Test: `tests/ble/esphome-proxy/gatt.test.ts`

Contract:

```typescript
import type { BleChar, BleDevice } from '../shared.js';
export interface GattSession {
  charMap: Map<string, BleChar>; // normalized uuid -> BleChar
  device: BleDevice; // onDisconnect
  close(): Promise<void>; // disconnectBluetoothDeviceService + listener cleanup
}
/** Connect to `mac` through `client.connection`, discover services, build the charMap. */
export function openGattSession(client: EsphomeClient, mac: string): Promise<GattSession>;
```

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi } from 'vitest';
import { openGattSession } from '../../../src/ble/handler-esphome-proxy/gatt.js';
import { normalizeUuid } from '../../../src/ble/types.js';

function fakeConnection() {
  const listeners: Record<string, Function[]> = {};
  return {
    connected: true,
    authorized: true,
    on(ev: string, fn: Function) {
      (listeners[ev] ??= []).push(fn);
    },
    off(ev: string, fn: Function) {
      listeners[ev] = (listeners[ev] ?? []).filter((f) => f !== fn);
    },
    removeListener(ev: string, fn: Function) {
      this.off(ev, fn);
    },
    emit(ev: string, a: any) {
      (listeners[ev] ?? []).forEach((f) => f(a));
    },
    connectBluetoothDeviceService: vi.fn(async () => ({ address: 1, connected: true, mtu: 23 })),
    disconnectBluetoothDeviceService: vi.fn(async () => ({ address: 1, connected: false })),
    listBluetoothGATTServicesService: vi.fn(async () => ({
      address: 1,
      servicesList: [
        {
          uuidList: ['0000181d-0000-1000-8000-00805f9b34fb'],
          handle: 1,
          characteristicsList: [
            { uuidList: ['00002a9d-0000-1000-8000-00805f9b34fb'], handle: 7, properties: 0x10 },
          ],
        },
      ],
    })),
    readBluetoothGATTCharacteristicService: vi.fn(async () => ({ dataList: [1, 2, 3] })),
    writeBluetoothGATTCharacteristicService: vi.fn(async () => ({})),
    notifyBluetoothGATTCharacteristicService: vi.fn(async () => ({})),
  };
}

describe('openGattSession', () => {
  it('connects, discovers, and exposes a UUID-keyed charMap', async () => {
    const conn = fakeConnection();
    const session = await openGattSession({ connection: conn } as any, '00:00:00:00:00:01');
    const uuid = normalizeUuid('2a9d');
    expect(session.charMap.has(uuid)).toBe(true);
    expect(conn.connectBluetoothDeviceService).toHaveBeenCalled();

    const char = session.charMap.get(uuid)!;
    expect(await char.read()).toEqual(Buffer.from([1, 2, 3]));
    await char.write(Buffer.from([9]), true);
    expect(conn.writeBluetoothGATTCharacteristicService).toHaveBeenCalledWith(
      expect.any(Number),
      7,
      expect.any(Uint8Array),
      true,
    );
  });

  it('routes notify-data for the right handle to the subscriber', async () => {
    const conn = fakeConnection();
    const session = await openGattSession({ connection: conn } as any, '00:00:00:00:00:01');
    const char = session.charMap.get(normalizeUuid('2a9d'))!;
    const got: Buffer[] = [];
    const unsub = await char.subscribe((d) => got.push(d));
    conn.emit('message.BluetoothGATTNotifyDataResponse', {
      address: expect.any(Number),
      handle: 7,
      dataList: [0xaa],
    });
    expect(got[0]).toEqual(Buffer.from([0xaa]));
    unsub();
  });

  it('fires BleDevice.onDisconnect when the peer reports disconnected', async () => {
    const conn = fakeConnection();
    const session = await openGattSession({ connection: conn } as any, '00:00:00:00:00:01');
    const onDis = vi.fn();
    session.device.onDisconnect(onDis);
    conn.emit('message.BluetoothDeviceConnectionResponse', { address: 1, connected: false });
    expect(onDis).toHaveBeenCalled();
  });
});
```

Note: the notify-data test compares `handle`, not `address`; the bridge must filter notify/disconnect events by the connected device's address AND handle. Adjust the fake to emit the real numeric address the bridge used (capture it from the `connectBluetoothDeviceService` mock call argument in the test) - replace `expect.any(Number)` with that captured address when wiring Step 3.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/ble/esphome-proxy/gatt.test.ts`
Expected: FAIL, `openGattSession` not found.

- [ ] **Step 3: Implement `gatt.ts`**

Full logic: `addr = macToInt(mac)`. `await connection.connectBluetoothDeviceService(addr)`; if `!resp.connected` throw `Error('ESPHome proxy could not connect to <mac>')`. `const { servicesList } = await connection.listBluetoothGATTServicesService(addr)`. Build `charMap`: for each service, each characteristic → `normalizeUuid` key via `esphomeUuidToString(char.uuidList)`, value a `BleChar`:

- `read()`: `Buffer.from((await connection.readBluetoothGATTCharacteristicService(addr, handle)).dataList)`
- `write(buf, withResponse)`: `await connection.writeBluetoothGATTCharacteristicService(addr, handle, Uint8Array.from(buf), withResponse)`. If `buf.length > (mtu-3)` and `mtu` known, write in `mtu-3` chunks sequentially (covers spec risk #3).
- `subscribe(onData)`: `await connection.notifyBluetoothGATTCharacteristicService(addr, handle)`; add a `message.BluetoothGATTNotifyDataResponse` listener filtering `m.address === addr && m.handle === handle`, call `onData(Buffer.from(m.dataList))`; return an unsubscribe that `connection.removeListener`s it. Maintain one shared notify listener per session keyed by handle to avoid duplicate handlers, or one-per-subscribe with its own removeListener (simpler; pick one-per-subscribe).

`device.onDisconnect(cb)`: register a `message.BluetoothDeviceConnectionResponse` listener; when `m.address === addr && m.connected === false` invoke cb once. `close()`: remove all session listeners then `await connection.disconnectBluetoothDeviceService(addr)` (ignore errors). Guard all GATT calls so a post-close late event is dropped.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/ble/esphome-proxy/gatt.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/ble/handler-esphome-proxy/gatt.ts tests/ble/esphome-proxy/gatt.test.ts
git commit -m "feat(ble): ESPHome GATT bridge (BleChar/BleDevice over proxy connection) (#116)"
```

---

## Task 5: pool `connectGatt` + single-shot GATT in `scan.ts`

**Files:**

- Modify: `src/ble/handler-esphome-proxy/pool.ts` (add `connectGatt`)
- Modify: `src/ble/handler-esphome-proxy/scan.ts`
- Test: `tests/ble/esphome-proxy/scan.test.ts`

`connectGatt(mac)`: try `proxyOrderFor(macLc)`; for each proxyId, `openGattSession(getClient(id), mac)`; return first success; on all-fail throw an aggregated error. If `proxyOrderFor` is empty, throw a "no proxy has seen this MAC" error.

`scan.ts` change: replace the single `createEsphomeClient` use with an `EsphomeProxyPool`. Broadcast path unchanged in behavior (now fed by `pool.onAdvertisement`). New GATT branch: where the current code calls `reject(gattNotSupportedError(...))`, instead `const session = await pool.connectGatt(address); try { return await waitForRawReading(session.charMap, session.device, adapter, opts.profile, address.replace(/[:-]/g,'').toUpperCase(), opts.weightUnit, opts.onLiveData, opts.scaleAuth); } finally { await session.close(); }`.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/ble/esphome-proxy/scan.test.ts - GATT single-shot path
import { describe, it, expect, vi } from 'vitest';
// Mock pool so connectGatt yields a session whose charMap+device drive a real
// waitForRawReading with a legacy single-notify adapter that resolves on one frame.
// Assert scanAndReadRaw returns { reading, adapter } and session.close() ran.
```

Provide a stub adapter: `charNotifyUuid = normalizeUuid('2a9d')`, `charWriteUuid` present, `parseNotification` returns `{ weight: 75, impedance: 0 }`, `isComplete` weight>0, `matches` true, `computeMetrics` returns a minimal payload. Mock `EsphomeProxyPool` so `onAdvertisement` immediately emits one advert for the target MAC and `connectGatt` returns a session backed by an in-memory char that, once `subscribe`d, emits the weight frame on next tick. Assert the promise resolves with weight 75 and `session.close` was called.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/ble/esphome-proxy/scan.test.ts`
Expected: FAIL (GATT branch still throws `gattNotSupportedError`).

- [ ] **Step 3: Implement `connectGatt` + scan GATT branch** (logic above; reuse imported `waitForRawReading` from `../shared.js`).

- [ ] **Step 4: Run test + the moved suite**

Run: `npx vitest run tests/ble/esphome-proxy/scan.test.ts tests/ble/handler-esphome-proxy.test.ts`
Expected: PASS; broadcast tests still green.

- [ ] **Step 5: Commit**

```bash
git add src/ble/handler-esphome-proxy/pool.ts src/ble/handler-esphome-proxy/scan.ts tests/ble/esphome-proxy/scan.test.ts
git commit -m "feat(ble): single-shot GATT reads over ESPHome proxy (#116)"
```

---

## Task 6: continuous GATT in `watcher.ts`

**Files:**

- Modify: `src/ble/handler-esphome-proxy/watcher.ts`
- Test: `tests/ble/esphome-proxy/watcher.test.ts`

`ReadingWatcher` now owns an `EsphomeProxyPool` (started in `start()`, stopped in `stop()`), broadcast path fed by `pool.onAdvertisement` (behavior unchanged). New: when an advertisement matches a GATT adapter (the current `warnGattNotSupported` branch), instead schedule an on-demand GATT read:

- per-MAC in-flight `Set<string>`; ignore if already connecting/reading that MAC.
- `pool.connectGatt(mac)` → `waitForRawReading(...)` → on success `queue.push`, apply existing dedup; always `session.close()` in `finally`; remove from in-flight.
- on connect failure: if it looks like slot exhaustion (error text match) or any failure, `warnGattNotSupported`-style once-per-MAC LRU warn; never throw out of the handler (continuous must survive).

- [ ] **Step 1: Write the failing test**

Stub GATT adapter as in Task 5. Mock pool: `onAdvertisement` emits a matching advert; `connectGatt` returns a session that yields one complete frame. Assert `await watcher.nextReading()` resolves with the reading, `session.close` ran, and a second immediate identical advert does not start a parallel session (in-flight guard) nor a duplicate queue entry (dedup).

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run tests/ble/esphome-proxy/watcher.test.ts`
Expected: FAIL (watcher still only warns for GATT).

- [ ] **Step 3: Implement the watcher GATT branch** (logic above).

- [ ] **Step 4: Run test + suite**

Run: `npx vitest run tests/ble/esphome-proxy/watcher.test.ts tests/ble/handler-esphome-proxy.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ble/handler-esphome-proxy/watcher.ts tests/ble/esphome-proxy/watcher.test.ts
git commit -m "feat(ble): continuous-mode GATT reads over ESPHome proxy (#116)"
```

---

## Task 7: scanDevices via pool + backward-compat e2e

**Files:**

- Modify: `src/ble/handler-esphome-proxy/scan.ts` (`scanDevices` uses pool)
- Test: extend `tests/ble/esphome-proxy/scan.test.ts`

- [ ] **Step 1: Failing test** — single-host config (no `additional_proxies`) still discovers devices and reads a broadcast scale exactly as Phase 1 (assert via mocked single-endpoint pool). Multi-proxy config aggregates discovery from both endpoints into one deduped `ScanResult[]`.

- [ ] **Step 2: Run, expect fail** (`scanDevices` still single-client).

Run: `npx vitest run tests/ble/esphome-proxy/scan.test.ts`

- [ ] **Step 3: Implement** `scanDevices` over the pool (start pool, collect `onAdvertisement` for `durationMs`, dedup by MAC, stop pool).

- [ ] **Step 4: Run full esphome suite + tsc**

Run: `npx tsc --noEmit && npx vitest run tests/ble/esphome-proxy tests/ble/handler-esphome-proxy.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ble/handler-esphome-proxy/scan.ts tests/ble/esphome-proxy/scan.test.ts
git commit -m "feat(ble): ESPHome device discovery across the proxy pool (#116)"
```

---

## Task 8: Setup wizard - additional proxies step

**Files:**

- Modify: the ESPHome step in the wizard (locate via `grep -rn "esphome" src/wizard src/setup 2>/dev/null` or `grep -rn "esphome_proxy\|ESPHome" src --include=*.ts -l`)
- Test: the wizard step's existing test file (same directory), add a case

- [ ] **Step 1: Locate the ESPHome wizard step**

Run: `grep -rn "esphome_proxy\|ESPHome proxy\|encryption_key" src --include=*.ts -l`
Read the matched wizard step + its test to follow the established prompt/validation pattern (Zod, no em dash / `--`).

- [ ] **Step 2: Write the failing test** — after the primary proxy answers, when the user answers yes to "additional ESPHome proxies?", each extra host/port/auth is collected into `esphome_proxy.additional_proxies`; answering no yields `[]`. Mirror the existing step test's mocking style.

- [ ] **Step 3: Run, expect fail.**

Run: `npx vitest run <wizard step test path>`

- [ ] **Step 4: Implement** the optional repeatable prompt (default no), pushing `EsphomeEndpointConfig` entries. Reuse the existing host/port/encryption/password prompts for parity.

- [ ] **Step 5: Run test + `npx tsc --noEmit`**, expect PASS.

- [ ] **Step 6: Commit**

```bash
git add src tests
git commit -m "feat(wizard): collect additional ESPHome proxies for mesh setups (#116)"
```

---

## Task 9: Docs + README

**Files:**

- Modify: `docs/guide/esphome-proxy.md` (Phase 2 section: GATT now supported, multi-proxy `additional_proxies` YAML, what changed vs Phase 1)
- Modify: `README.md` (the line that calls the ESPHome proxy broadcast-only / "Phase 1" - update to note GATT support; do not touch adapter/exporter counts)
- Modify: `docs/faq.md` only if it states ESPHome proxy is broadcast-only

- [ ] **Step 1: Grep for stale "broadcast-only" / "Phase 1" ESPHome claims**

Run: `grep -rn "broadcast-only\|Phase 1\|esphome" README.md docs --include=*.md -il`

- [ ] **Step 2: Update the docs** with the multi-proxy YAML example from the spec and a short "Phase 2 (GATT)" subsection. No em dash, no `--`, use `€` if any price (none expected).

- [ ] **Step 3: Build docs sanity (optional) + spellcheck-by-eye.** No command required; visually confirm the YAML matches `EsphomeProxySchema`.

- [ ] **Step 4: Commit**

```bash
git add README.md docs
git commit -m "docs: ESPHome proxy Phase 2 GATT + multi-proxy mesh (#116)"
```

---

## Task 10: Full verification + issue/memory

- [ ] **Step 1: Kill node, run the full gate**

Run: `taskkill //F //IM node.exe; npx tsc --noEmit && npm run lint && npx vitest run && npx prettier --check .`
Expected: all clean; total test count = previous baseline + the new esphome-proxy tests.

- [ ] **Step 2: Fix any failure** at its root (no skips). Re-run Step 1 until clean.

- [ ] **Step 3: Commit any fixups**

```bash
git add -A && git commit -m "test(ble): finalize ESPHome proxy Phase 2 verification (#116)"
```

- [ ] **Step 4: Push branch + open PR into dev**

```bash
git push -u origin feat/116-esphome-proxy-gatt
"C:\Program Files\GitHub CLI\gh.exe" pr create --base dev --title "feat(ble): ESPHome proxy Phase 2 - GATT + multi-proxy (#116)" --body "<summary, scope, test plan, references spec + plan, notes issue #116 stays open pending real-hardware retest by @deadhurricane>"
```

- [ ] **Step 5: Update memory** — `project_issue116` note + MEMORY.md pointer: Phase 2 implemented, PR open into dev, pending @deadhurricane Elis 1 / ES-30M real-hardware retest; uuidList ordering checkpoint outstanding.

---

## Self-Review

**Spec coverage:** full GATT parity → Tasks 4-6 (bridge + scan + watcher reuse `waitForRawReading`, no adapter changes). Multi-proxy list + RSSI auto-pick → Tasks 2,3,5. Single-shot + continuous → Tasks 5,6. Module split per project convention → Task 1. Config + wizard + docs + backward compat → Tasks 2,7,8,9. Risks: uuidList ordering → Task 0 + execution checkpoint; notify/disconnect event names → pinned from source, used in Task 4; MTU chunking → Task 4 Step 3; ESP32 slot limit → Task 6 (warn + continue). All spec sections mapped.

**Placeholder scan:** no TBD/TODO. Tasks 5,6,7,8 describe test setup in prose rather than full literal code because they wire mocks around already-defined contracts (Tasks 3,4) and a stub adapter defined once in Task 5; the contracts, signatures, and assertions are explicit. Task 8 path is discovered via a given grep because the wizard layout is not yet read; the step still specifies exact behavior and commit.

**Type consistency:** `EsphomeProxyPool` methods (`start/stop/onAdvertisement/pickProxyFor/proxyOrderFor/getClient/connectGatt`), `ProxyEndpoint.id = host:port`, `GattSession {charMap,device,close}`, `openGattSession(client,mac)`, `esphomeUuidToString`, `macToInt`, `EsphomeEndpointConfig` are used consistently across tasks. `waitForRawReading` signature matches `src/ble/shared.ts` (charMap, bleDevice, adapter, profile, deviceAddress, weightUnit?, onLiveData?, scaleAuth?).
