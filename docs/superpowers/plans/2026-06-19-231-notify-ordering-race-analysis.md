# ble-scale-sync #231 - autonomous connect succeeds but no reading: notify-ordering race (analysis + design)

> Authoritative analysis (code-confirmed, 2026-06-19). The #231 implementation plan derives its scope from this. The firmware autonomous-connect chain (8 prior layers) is fully fixed; this is the 9th and final layer: a host/proxy notify-ordering race, not a firmware connect bug and not a RAM problem.

## Evidence

marcelorodrigo retest #8 (2026-06-19) on ESP32-S3 (8 MB PSRAM). The ESP32 REPL shows the autonomous connect now fully works and repeats in a loop:

```
Auto-connecting to FF:03:00:53:D6:4D (addr_type=0)...
IDF heap before connect: free=8414231 largest=8126464
Auto-connect: BLE connected to FF:03:00:53:D6:4D, discovering chars...
Auto-connect: notify enabled for 0000ae0200001000800000805f9b34fb
Auto-connect: notify enabled for 0000fff100001000800000805f9b34fb
Auto-connect to FF:03:00:53:D6:4D succeeded, 10 chars published to host
Streaming scan started
... (repeats, then a final "0 chars" as the scale powers off)
```

free=8414231 largest=8126464 (8 MB) proves this is NOT #139 (no RAM ceiling). The connect, discovery, notify-enable, and char publish all succeed. "Streaming scan started" after each success comes from the `__ble_disconnected__` handler, so the scale is disconnecting shortly after each connect, before a weight reading completes.

## Root cause (high confidence, confirmed in code)

QN / Renpho ES-CS20M is a NOTIFICATION-DRIVEN scale: the instant the FFF1 CCCD is written (notify enabled), the scale spontaneously emits its handshake-initiating 0x12 (scale info) frame; the central reacts to it (0x12 -> AE01 init -> 0x13 config -> ... -> 0x10 weight). See qn-scale.ts lines 33-40. The 0x12 is the first link and is triggered by the notify-enable, not by any central write.

In the MQTT proxy path the firmware enables BLE notify EAGERLY, before the host is listening:

- firmware/main.py `_auto_gatt_connect` (lines 224-234) and `handle_connect` (lines 448-457) are identical: right after connect they loop over notify-capable chars and call `bridge.start_notify(uuid, publish_fn)` (writes the CCCD), THEN publish the `connected` event.
- So the scale emits 0x12 the moment the firmware enables notify, and the firmware forwards it to MQTT `notify/0000fff1...` at QoS 0.
- The host subscribes to that MQTT notify topic only LATER: it receives `connected`, runs `handleAutonomousConnect` -> `buildCharMapFromPayload` (builds MqttBleChar objects but does NOT subscribe) -> `waitForRawReading` -> the adapter subscribes via `subscribeToChar` -> `char.subscribe()` (src/ble/shared.ts:130,138), which is where `MqttBleChar.subscribe()` (src/ble/handler-mqtt-proxy/gatt.ts:14-24) finally does `subscribeAsync(notify topic)`.
- Between the firmware enabling notify (scale sends 0x12) and the host subscribing to the MQTT notify topic, the topic has no subscriber, so the QoS 0 0x12 is dropped. The notification-driven handshake never starts, the scale auto-disconnects after its short window, the ESP32 resumes scanning, re-detects, and reconnects in a loop until the scale powers off.

### Why it hits QN specifically, and why native works but proxy does not
- Central-initiated scales (the central writes an unlock first, the scale then replies) do not depend on a spontaneous kickoff frame, so the lost-frame window does not break them.
- QN is notification-kickoff: its one spontaneous 0x12 falls into the gap.
- On a NATIVE connection (node-ble / noble) `char.subscribe()` enables BLE notify AND starts listening atomically and locally, so the kickoff is always caught. The proxy splits enable-notify (firmware, eager) from listen (host MQTT subscribe, lazy) across the network, opening the race. The firmware enables notify eagerly; the native path enables it lazily on the adapter's subscribe. That mismatch is the bug.

`MqttBleChar.subscribe()` is the single host-side chokepoint for every proxy notify subscription (multi-char bindings, legacy effectiveNotifyUuid, and onConnected ctx.subscribe all funnel through subscribeToChar -> char.subscribe).

## Fix: host-driven (lazy) notify enable, matching native semantics

Make the proxy enable BLE notify the same way native does: only when the host's `char.subscribe()` runs, and only AFTER the host has subscribed to the MQTT notify topic.

- HOST (src/ble/handler-mqtt-proxy/gatt.ts `MqttBleChar.subscribe()`): after `await subscribeAsync(notify topic)` and registering the message handler, publish a per-char enable-notify command to the firmware (a new topic, e.g. `${base}/subscribe/<uuid>`). Because the MQTT subscription is in place before the command is sent, the firmware-triggered kickoff frame is guaranteed to have a listener.
- FIRMWARE (firmware/main.py + ble_bridge.py): stop enabling notify eagerly in `_auto_gatt_connect` and `handle_connect`. Subscribe to the new command topic (alongside write/# and read/#). On a `subscribe/<uuid>` command, call `bridge.start_notify(uuid, forward_fn)` to enable BLE notify on that char. The firmware already remembers the discovered chars, so it can enable on demand.
- This restores the native ordering (subscribe-then-notify) over the proxy and closes the race deterministically. The autonomous path keeps its speed win: the time-critical CONNECT still happens on the ESP32; only the per-char notify-enable is now host-ordered, which happens after connect within the connection window (one round-trip per notify char).

### Backward compatibility (a real decision the plan must resolve)
Mixed firmware/host versions must not regress. The dangerous case is NEW firmware (lazy-only) + OLD host (never sends the command) -> notify never enabled -> ALL proxy scales break. Two acceptable mechanisms; the plan picks one and justifies it:

1. PREFERRED - capability negotiation via the existing `config` topic. The host already publishes a `config` payload (scale MACs + auto_connect) at startup, before any connect. Add a flag (e.g. `lazy_notify: true`) that the new host sets. The firmware enables notify lazily (command-driven) only when it has seen that flag; otherwise it falls back to today's eager enable. New host -> race-free; old host -> unchanged eager behavior; new firmware + old host -> no flag -> eager -> no regression. Clean, no timing window.
2. ALTERNATIVE - short grace fallback. New firmware waits a short grace (for example ~750 ms) for a per-char subscribe command; if none arrives it eager-enables as today. Simpler, but it delays notify-enable for old hosts and could marginally regress a currently-working non-QN scale on an old host, so the grace must be short and justified. Capability negotiation avoids this and is preferred.

Either way, OLD firmware + NEW host is safe: old firmware eager-enables and ignores the new command, so behavior is exactly as today (still racy for QN, but no worse).

## Files in scope
- HOST (TypeScript): `src/ble/handler-mqtt-proxy/gatt.ts` (MqttBleChar.subscribe sends the enable-notify command), `src/ble/handler-mqtt-proxy/topics.ts` (new topic), `src/ble/handler-mqtt-proxy/watcher.ts` and/or the config publish path (set the `lazy_notify` capability flag if option 1). Possibly `src/ble/handler-mqtt-proxy/index.ts`.
- FIRMWARE (MicroPython): `firmware/main.py` (remove eager notify loops in `_auto_gatt_connect` + `handle_connect`; subscribe to the new command topic in `on_connect`; dispatch it in the main loop; read the `lazy_notify` config flag in `on_message` config handling if option 1), `firmware/ble_bridge.py` (only if a helper is needed; `start_notify` already exists).
- DOCS: `docs/guide/esp32-proxy.md` if any user-facing protocol note is warranted (likely minimal; this is an internal protocol fix).

## Tests
- FIRMWARE (host-runnable, `python -m unittest discover -s firmware/tests`, baseline 76 after #139): a test that the autonomous/host-initiated connect no longer eager-enables notify (when in lazy mode), that a `subscribe/<uuid>` command enables notify on that char, and that the backward-compat path (no flag / old host) still eager-enables. Model the existing harness in test_auto_connect.py / test_connect_irq.py (sys.modules stubs).
- HOST (vitest, `npm test`): MqttBleChar.subscribe publishes the enable-notify command after subscribing; the autonomous and host-initiated proxy flows still resolve a reading with the new ordering; no existing mqtt-proxy test regresses. tsc + eslint + prettier clean.

## What would corroborate (not required; root cause is code-confirmed)
The host-side (Docker/app) log for the same session would show `Autonomous GATT connect from ESP32: QN Scale` followed by `GATT reading timeout for ... (autonomous)` with no notify frames processed, confirming the lost-kickoff. If instead frames arrive but parsing fails, that is a different layer; the host log disambiguates. Worth requesting from marcelorodrigo alongside shipping the fix.

## Bottom line
#231 is no longer a connect or RAM problem. It is a proxy notify-ordering race that drops the QN scale's spontaneous 0x12 handshake kickoff. The fix aligns the proxy with native semantics: enable BLE notify lazily, host-ordered, only after the host is subscribed to the MQTT notify topic. Firmware + host coordinated change with explicit backward-compat handling.
