# ESPHome BT Proxy Phase 2 (GATT) Design

Issue: #116
Date: 2026-05-17
Status: Approved (brainstorming), pending implementation plan

## Problem

Phase 1 (shipped v1.10.0) added an ESPHome Bluetooth proxy transport that is
broadcast-only. GATT-only scales (e.g. Renpho Elis 1 / ES-30M, reported by
@deadhurricane) cannot produce readings over it: they require a GATT
connection, discovery, write/notify handshake. Users running an existing
ESPHome BLE proxy mesh for Home Assistant want to reuse it for ble-scale-sync
instead of deploying the dedicated ESP32 MQTT proxy.

Phase 2 adds full GATT support to the ESPHome proxy transport, with
multi-proxy routing, for both single-shot and continuous modes.

## Decisions (from brainstorming)

- **Full GATT parity.** Reuse the entire shared `waitForRawReading()` seam so
  `onConnected` handshakes, multi-char bindings, legacy unlock-command
  adapters, and cached-history replay all work unchanged. No ScaleAdapter or
  adapter changes.
- **Multi-proxy list + RSSI auto-pick.** Config takes a primary proxy plus an
  optional list of additional proxies. GATT connects route through the proxy
  that most recently saw the target MAC with the best RSSI, with fallback to
  the others.
- **Both single-shot and continuous.** GATT works in `scanAndReadRaw` (single
  run) and the persistent `ReadingWatcher` (continuous mode), consistent with
  the native and mqtt-proxy handlers.

## Architecture

### Module layout

The existing single file `src/ble/handler-esphome-proxy.ts` (695 lines) is
split into a directory, mirroring the prior `handler-mqtt-proxy` split (#131)
and the 8-module `handler-node-ble` split:

```
src/ble/handler-esphome-proxy/
  index.ts     # public API re-export: scanAndReadRaw, scanAndRead, scanDevices,
               # ReadingWatcher, _internals. Stable import sites.
  client.ts    # createEsphomeClient, waitForConnected, safeDisconnect (moved as-is)
  advert.ts    # toBleDeviceInfo, formatMacAddress, parseManufacturerId,
               # extractBytes (moved as-is)
  pool.ts      # NEW: EsphomeProxyPool - N clients, advertisement aggregation,
               # auto-pick routing
  gatt.ts      # NEW: GATT bridge - BleChar/BleDevice over ESPHome GATT API,
               # UUID->handle resolution, notify wiring
  scan.ts      # scanAndReadRaw + scanDevices (broadcast + GATT branch)
  watcher.ts   # ReadingWatcher (continuous; broadcast + GATT branch)
```

No changes to `src/interfaces/scale-adapter.ts`, `src/scales/*`, or the shared
`src/ble/shared.ts`. The integration seam is the existing
`waitForRawReading(charMap, bleDevice, adapter, profile, deviceAddress, ...)`.

### Three units, clear boundaries

- **pool.ts** owns transport + routing. Knows nothing about adapters or
  readings. Input: proxy endpoint list. Output: merged advertisement stream
  and `connectGatt(mac)` GATT sessions.
- **gatt.ts** owns the adapter seam. Translates ESPHome handle-based GATT into
  the UUID-based `BleChar`/`BleDevice` interfaces `shared.ts` expects. Knows
  nothing about routing.
- **scan.ts / watcher.ts** own orchestration. Decide broadcast vs GATT per
  matched adapter, drive the pool and bridge, apply timeouts and dedup.

## Components

### EsphomeProxyPool (pool.ts)

- Holds one `Client` per configured proxy endpoint (Phase 1 = 1, mesh = N).
- Listens to the `ble` event on every client; maintains
  `Map<macLowercase, { proxyId, rssi, lastSeen }>` keeping the most recent /
  strongest sighting per MAC, with a TTL (~60s) so a powered-off proxy stops
  winning.
- `pickProxyFor(mac): proxyId | null` - proxy that last saw the MAC with the
  best RSSI; `null` if no proxy has seen it.
- Broadcast path: merges advertisements from all clients into one listener
  stream, deduped per MAC+frame using the existing `DEDUP_WINDOW_MS`.
- GATT path: `connectGatt(mac)` picks via `pickProxyFor`, fallback order =
  remaining proxies by recency; returns a GATT session bound to that client.
- Lifecycle: `start()` / `stop()` manage all clients. Started once for
  continuous mode, per-run for single-shot.

### GATT bridge (gatt.ts)

Implements exactly what `waitForRawReading` consumes:

- `connectBluetoothDeviceService(addrInt)`, then
  `listBluetoothGATTServicesService(addrInt)` -> build
  `Map<normalizedUuid, { handle }>`.
- `BleChar` per characteristic:
  - `read()` -> `readBluetoothGATTCharacteristicService(addr, handle)`
  - `write(buf, withResponse)` ->
    `writeBluetoothGATTCharacteristicService(addr, handle, Uint8Array, withResponse)`
    with MTU chunking if required (see Risks).
  - `subscribe(onData)` -> `notifyBluetoothGATTCharacteristicService(addr, handle)`
    plus binding the notify-data message event; returns an unsubscribe fn.
- `BleDevice.onDisconnect(cb)` -> bound to the ESPHome BLE peer disconnect
  message.
- The resulting `charMap` is passed straight into `waitForRawReading`, so
  `onConnected` handshakes, multi-char, legacy unlock, and history replay work
  unchanged (full parity).
- ESPHome GATT works with numeric handles and a uint64 integer address, not
  UUIDs or MAC strings. The bridge translates internally: MAC string ->
  uint64 (inverse of the existing `formatMacAddress`) for the ESPHome API,
  and discovered UUID -> handle for every `BleChar`. `resolveChar` in
  `shared.ts` stays UUID-based and untouched.
- `deviceAddress` passed into `waitForRawReading` is the uppercase,
  separator-free MAC (same form the native and mqtt-proxy handlers supply), so
  MAC-derived-key adapters (e.g. Eufy T9148/T9149) keep working over this
  transport.

## Data flow

### Single-shot (scanAndReadRaw)

1. Pool starts (all configured proxies).
2. Advertisement matches an adapter via `adapter.matches(info)`.
3. If broadcast yields a reading -> existing Phase 1 path (unchanged).
4. If adapter is GATT (no broadcast reading, has `charNotifyUuid`, not
   `preferPassive`) -> `pool.connectGatt(mac)` -> bridge builds charMap ->
   `waitForRawReading` -> reading.
5. `finally`: always `disconnectBluetoothDeviceService` (slot freed
   immediately). Pool stopped at end of run.

### Continuous (ReadingWatcher)

1. Pool lives for the process lifetime; broadcast path runs as today.
2. A GATT scale advertises (it wakes when stepped on) -> connect on-demand ->
   `waitForRawReading` -> push to queue -> disconnect immediately (no slot held
   between weigh-ins).
3. Per-MAC in-flight guard prevents a concurrent second connect to the same
   scale.

## Connection lifecycle and ESP32 slots

ESP32 ESPHome proxies have a limited active GATT connection count (default 3,
configured user-side in `bluetooth_proxy` / `esp32_ble_tracker`, outside our
control).

- Single-shot: connect -> read -> disconnect in `finally`, slot freed at once.
- Continuous: connect on-demand, disconnect right after the read; never hold a
  slot between weigh-ins.
- Slot exhaustion: if `connectBluetoothDeviceService` fails with a
  no-free-connections style error, auto-pick fallback tries the next proxy. If
  all are full -> warn once per MAC (LRU, like the existing `gattWarnedFor`
  tracker) and continue (continuous mode never dies on one scale).
- Connect timeout = existing `CONNECT_TIMEOUT_MS` (30s). A peer disconnect
  during the read is already handled by `waitForRawReading`
  (`onDisconnect` -> reject or history flush).

## Config schema and wizard

`EsphomeProxySchema` stays valid as-is (single `host`). An optional list of
additional proxies is added:

```yaml
ble:
  handler: esphome-proxy
  esphome_proxy:
    host: proxy1.home # primary (unchanged; Phase 1 configs keep working)
    port: 6053
    encryption_key: '...'
    additional_proxies: # NEW, optional
      - host: proxy2.home
        encryption_key: '...'
      - host: proxy3.home
        password: '...'
```

- Zod: `additional_proxies: z.array(<per-proxy shape>).default([])`. The pool
  normalizes `[primary, ...additional_proxies]` into a uniform
  `ProxyEndpoint[]`. No existing config breaks (empty default = today's
  behavior).
- Wizard: after the primary proxy, a new optional question "Do you have
  additional ESPHome proxies (mesh)?" with repeatable host/auth entry.
  Defaults to no.
- No `--` or em dash anywhere in config or prompts (project rule).

## Error handling

| Situation                                                        | Behavior                                                                                                                             |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| No proxy has seen the MAC                                        | `pickProxyFor` null -> broadcast wait continues (single-shot `BROADCAST_WAIT_MS` timeout); continuous just waits for the next advert |
| GATT connect fail (timeout / slot full)                          | auto-pick next proxy; all failed -> descriptive error (single-shot) / warn-once + continue (continuous)                              |
| Notify-data / disconnect event name mismatch across lib versions | resolved during the implementation spike; bridge isolates event mapping to one place                                                 |
| ESPHome client drops during a GATT session                       | `BleDevice.onDisconnect` fires -> `waitForRawReading` reject/flush; pool marks the proxy degraded, lib `reconnect:true` recovers     |
| Adapter needs exact MTU/timing (e.g. Eufy AES)                   | full parity attempt; chunk writes in `BleChar.write` if ESPHome MTU is small; real-hardware verification is a per-model follow-up    |

Philosophy matches the current handler: continuous never crashes on a single
scale; single-shot returns a clear error.

## Testing

- Unit (vitest, mocked ESPHome `Client`/`Connection`):
  - `pool`: auto-pick (RSSI/recency selection, fallback order, TTL expiry),
    advertisement merge + dedup across two proxies.
  - `gatt`: UUID->handle mapping from a mock `listBluetoothGATTServicesService`,
    `BleChar.read/write/subscribe` hitting the right handle, unsubscribe,
    `onDisconnect` routing.
  - `scan` / `watcher`: GATT adapter end-to-end through mock pool + bridge
    feeding the real `waitForRawReading` (mock notify frames -> complete
    reading; history replay; a legacy unlock-command adapter).
  - lifecycle: connect -> read -> disconnect always frees the slot;
    slot-exhaustion fallback; in-flight guard.
  - Backward compat: an existing single-host config parses and runs as Phase 1.
- No real hardware in CI; mock-driven. Target at least parity with the
  mqtt-proxy / node-ble test coverage. `_internals` export for testability,
  matching the current pattern.
- Pre-commit per CLAUDE.md: `tsc --noEmit`, lint, `npm test`, prettier.

## Scope

In scope: full GATT parity (onConnected, multi-char, legacy unlock, history
replay) over ESPHome proxy; multi-proxy list + RSSI auto-pick + fallback;
single-shot and continuous; config + wizard + docs + backward compat.

Non-goals: broadcast path stays functionally unchanged (only moved into
modules); no ScaleAdapter/adapter changes; no parallel multi-scale GATT
sessions (sequential per MAC); no manual per-scale proxy pin (auto-pick was
chosen).

## Risks (verify against `@2colors/esphome-native-api` source, not just README)

The context7 README does not expose enough detail; an implementation spike
must read the installed library source first:

1. Exact event/message name for GATT notify-data and BLE peer
   connect/disconnect. The bridge isolates this to one mapping point.
2. Handle vs UUID: confirm the `listBluetoothGATTServicesService` shape
   (services -> characteristics -> handle/uuid) and whether the CCCD
   descriptor must be written manually for notifications or
   `notifyBluetoothGATTCharacteristicService` handles the CCCD internally.
3. MTU / write-without-response size over ESPHome (default may be ~20-23
   bytes); chunk longer writes (Current Time, Eufy handshake payloads).
4. Active connection limit is a user-side ESP32 config; we can only react to
   the failure, not query it ahead of time.

The spike is a short verification phase at the start of the implementation
plan (read the lib source plus one throwaway connect test), not a separate
project.
