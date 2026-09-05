---
title: ESPHome Bluetooth Proxy
description: Reuse an existing ESPHome BT proxy instead of deploying a dedicated ESP32 with custom firmware.
head:
  - - meta
    - name: keywords
      content: esphome bluetooth proxy, home assistant ble proxy, esphome ble mesh, reuse esphome, ble-scale-sync esphome, scale via esphome proxy, native api bluetooth
---

# ESPHome Bluetooth Proxy

An [ESPHome Bluetooth proxy](https://esphome.io/components/bluetooth_proxy.html) can act as BLE Scale Sync's BLE radio. No dedicated ESP32 with custom firmware, no MQTT broker plumbing: the server connects to the ESPHome Native API on port 6053 and subscribes to BLE advertisements directly.

::: danger The proxy node must not be adopted by Home Assistant
A proxy node serves its BLE advertisement subscription to **one API client at a time**. If Home Assistant has already adopted the node, it holds that subscription, and BLE Scale Sync connects successfully but never receives a single advertisement, so the scale is never seen. The ESPHome device log shows:

```
Only one API subscription is allowed at a time
```

Use a **dedicated ESPHome bluetooth-proxy node that you flash but do not add to Home Assistant**, and point BLE Scale Sync at that node. Your existing Home Assistant proxy mesh keeps working untouched. See [#232](https://github.com/KristianP26/ble-scale-sync/issues/232), [#248](https://github.com/KristianP26/ble-scale-sync/issues/248) and [#252](https://github.com/KristianP26/ble-scale-sync/issues/252).
:::

::: tip Broadcast and GATT supported
The ESPHome proxy transport handles both broadcast scales (parsed straight from advertisements) and GATT scales (connected on demand through the proxy, then read and disconnected). Multiple proxies can be configured for a mesh: a GATT connect is routed to the proxy that most recently saw the scale, with the others as fallbacks. Implemented in [issue #116](https://github.com/KristianP26/ble-scale-sync/issues/116).
:::

## How it works

```
┌───────┐  BLE   ┌─────────────┐  Native API  ┌────────────────┐
│ Scale │ ─────► │ ESPHome BT  │ ──(6053)──► │ BLE Scale Sync │
└───────┘ advert │   proxy     │              │  Docker/Node   │
                 └─────────────┘              └────────────────┘
```

The ESPHome proxy sees the scale's BLE advertisement, wraps it in a Native API `BluetoothLEAdvertisementResponse`, and forwards it to BLE Scale Sync. The server matches scale adapters against the advertisement (manufacturer data, service UUIDs, local name), parses the broadcast frame, and dispatches the reading to exporters. No local Bluetooth adapter is required on the machine running BLE Scale Sync.

## Requirements

- A running ESPHome device with `bluetooth_proxy:` enabled, on ESPHome **2023.5 or newer** (older firmware used a different BLE event layout that is not handled by this transport)
- The proxy node **must not be adopted by Home Assistant** (see the warning above); dedicate one node to BLE Scale Sync
- The proxy node should have **no `remote_receiver:` / RF or IR receiver** configured (see the IR/RF note below)
- Network reachability between BLE Scale Sync and the ESPHome device on TCP port 6053
- Either the ESPHome API encryption key (recommended) or the legacy API password, matching the device's `api:` config

::: tip When to pick this vs the ESP32 MQTT proxy
Both transports support broadcast and GATT scales. Pick this one if you are comfortable flashing a spare ESP32 with stock ESPHome and want no custom firmware. The [ESP32 MQTT proxy](/guide/esp32-proxy) additionally offers a display/beep feedback UI. Either way the node is dedicated to BLE Scale Sync.
:::

## Configuring BLE Scale Sync

Add the `ble` section to your `config.yaml`:

```yaml
ble:
  handler: esphome-proxy
  esphome_proxy:
    host: ble-proxy.local # IP or mDNS name of the ESPHome device
    port: 6053 # default, matches ESPHome `api.port`
    encryption_key: '${ESPHOME_API_KEY}' # 32-byte base64 PSK from your api: config
    # password: '${ESPHOME_API_PASSWORD}' # legacy plaintext auth, use encryption_key instead
    client_info: ble-scale-sync # visible in ESPHome logs / Home Assistant
    advertisement_timeout: 0 # seconds of BLE silence before the client is rebuilt; 0 = off
```

Restart BLE Scale Sync. In continuous mode the server keeps the Native API connection open, subscribes once, and processes advertisements as they arrive.

### Recovering a transport that dies silently

The Native API client can die without saying so. A single `read ECONNRESET` has been observed to leave the transport dead for over four hours while the ESP32 itself stayed healthy and reachable, the container stayed running, and the log produced nothing at all. Weigh-ins in that window are simply lost, and only a restart brings it back ([#303](https://github.com/KristianP26/ble-scale-sync/issues/303)).

Two things help.

The client lifecycle is now logged at info level: `connected`, `disconnected`, `initialized` (which is the positive confirmation that the BLE advertisement subscription actually came back, not just that a socket exists) and any scheduled reconnect. If the transport dies you will see it stop rather than having to infer it from silence.

`advertisement_timeout` arms a watchdog. A proxy in a normal home sees some BLE traffic constantly, so if no advertisement at all arrives from a given proxy for this many seconds, its client is torn down and rebuilt with backoff. It is **off by default** (`0`), because a rebuild is a real teardown and there is one setup where it fires without helping: a proxy already adopted by Home Assistant serves only a single advertisement subscription, so the rebuild succeeds and advertisements still never arrive. The watchdog gives up on a proxy after three rebuilds that produce nothing, and never tears down a proxy while a GATT session is open on it.

If you have seen the silence in your own log, `180` to `600` is a sensible value.

### Getting the encryption key

In your ESPHome device YAML:

```yaml
api:
  encryption:
    key: 'Lw1vKZ...YOUR_BASE64_KEY...cG=='
```

Use the exact same key in `esphome_proxy.encryption_key`. If you use `secrets.yaml`, read the key from the rendered device config in Home Assistant or ESPHome Dashboard.

::: tip Wizard
`npm run setup` includes an interactive ESPHome proxy step that prompts for the host, port and authentication choice.
:::

::: warning Security
The Native API without encryption (plaintext password) transmits scale weight and body composition data in the clear. Always prefer `encryption_key` unless you're isolated on a trusted LAN.
:::

## Docker deployment

The ESPHome proxy transport, like the ESP32 MQTT proxy, removes the need for local Bluetooth on the host. The container can run without BlueZ, D-Bus mounts, or `NET_ADMIN`:

```yaml
# docker-compose.esphome-proxy.yml
services:
  ble-scale-sync:
    image: ghcr.io/kristianp26/ble-scale-sync:latest
    container_name: ble-scale-sync
    volumes:
      - ./config.yaml:/app/config.yaml
      - garmin-tokens:/app/garmin-tokens
    environment:
      - CONTINUOUS_MODE=true
    restart: unless-stopped

volumes:
  garmin-tokens:
```

## Troubleshooting

### Connects fine but never sees the scale ("Only one API subscription is allowed at a time")

The proxy is already adopted by Home Assistant, which holds the node's single BLE
advertisement subscription. BLE Scale Sync connects to the Native API and logs
`ESPHome proxy connected` plus `ReadingWatcher started`, but no advertisement ever
arrives, so no scale is matched.

Flash a spare ESP32 as a bluetooth proxy and **do not add it to Home Assistant**,
then point `esphome_proxy.host` at it. Board or RAM is not the cause: this happens
on an Atom Echo and on an ESP32-S3 alike.

### Proxy connection drops every few minutes (IR or RF receiver on the node)

If the node also has a `remote_receiver:` (IR/RF) component, every received IR or RF
signal, including stray ambient IR, makes ESPHome emit an API message that the
Native API client library does not recognise. Older builds of BLE Scale Sync tore the
proxy connection down on each one, and any weigh-in during the reconnect window was
lost. You would see repeating pairs of:

```
ESPHome proxy <host>:6053 error: Failed find or parsed message type for Id: 137
ESPHome proxy <host>:6053 error: Cannot set properties of undefined (setting 'length')
```

Unknown message ids are now ignored and the connection is kept alive, so this is
handled. Even so, keep the IR/RF receiver on a different node than the one serving
BLE Scale Sync: a dedicated bluetooth-proxy node should run `bluetooth_proxy:` and
little else. Reported in [#252](https://github.com/KristianP26/ble-scale-sync/issues/252).

### Timed out connecting to ESPHome proxy

- Check the host and port are reachable: `nc -zv <host> 6053`
- If you use `encryption_key`, make sure it matches the device's `api.encryption.key` exactly (base64, 44 characters ending in `=`)
- If you use `password`, note that newer ESPHome builds remove plaintext auth, switch to `encryption_key`

### GATT scale not read over the proxy

Both broadcast and GATT scales work over the ESPHome proxy. On connect the
handler logs a one-time capability summary naming each configured adapter and
whether it is serviced by broadcast or by an on-demand GATT connection. A GATT
scale is connected only when it advertises (it wakes when you step on it), read
via the proxy, then disconnected so no proxy connection slot is held between
weigh-ins.

If a GATT scale still does not produce readings:

- **Connection slots:** an ESP32 proxy has a limited number of active GATT
  connections (configured in your `bluetooth_proxy` / `esp32_ble_tracker`
  YAML). When all proxies are full the read is retried on the next
  advertisement and a one-time warning is logged; free a slot or add another
  proxy via `additional_proxies`.
- **Out of range:** the connect is routed to the proxy that last saw the scale.
  If no proxy is close enough, move a proxy nearer or add one to the mesh.
- Single-shot (`npm start`) returns a descriptive error; continuous mode
  (`CONTINUOUS_MODE=true`) keeps running and retries.
- **ESPHome logs "Missing address type in connect request":** resolved. The
  handler now sends the BLE address type (public or random, taken from the
  scale's advertisement) with every GATT connect, and falls back to the other
  type if the first attempt is refused. Update to the latest version if you
  still see this on older builds.
- **The scale connects and is written to, then stays silent:** resolved. The
  proxy's notify registration only routes notifications the ESP32 receives; the
  0x2902 descriptor still has to be written for the scale to send any, and that
  write was missing, so strict firmware (QN, Renpho) never streamed a byte
  ([#252](https://github.com/KristianP26/ble-scale-sync/issues/252)). A related
  bug decoded every GATT payload as empty
  ([#291](https://github.com/KristianP26/ble-scale-sync/issues/291)). Both are
  fixed; with `debug: true` you now get a `cccd=` line per characteristic and an
  explicit `ESPHome CCCD write ...` line.
- **The scale needs a bonded or encrypted link:** the ESPHome proxy does not
  bond, so a scale that demands encryption for its notifications (the Beurer
  BF7xx consent family, for example) cannot be read over this transport. With
  debug on it shows as `ESPHome GATT error: handle 0x.. status=5` (or `15`)
  right after the CCCD write. Those scales need the native Linux BlueZ path.

### Multiple ESPHome proxies (mesh)

Add more proxies under `additional_proxies`; each keeps its own host, port and
auth. Advertisements from every proxy are aggregated, and a GATT connect is
routed to the proxy that saw the scale most recently (RSSI breaks ties), with
the rest as fallbacks.

```yaml
ble:
  handler: esphome-proxy
  esphome_proxy:
    host: proxy1.home
    port: 6053
    encryption_key: '<base64 Noise key>'
    additional_proxies:
      - host: proxy2.home
        encryption_key: '<base64 Noise key>'
      - host: proxy3.home
        password: '<legacy password>'
```

### ESPHome logs show "clientInfo: ble-scale-sync"

That's expected. The `client_info` field is how ESPHome identifies who's connected. Change it per-instance in `esphome_proxy.client_info` if you run multiple BLE Scale Sync copies.

### Scale is only read on the second weigh-in

Some scales (notably Xiaomi Mi Scale 2) broadcast their final measurement frame in a very brief window: the moment weight and impedance are both stable. The default ESPHome scan parameters listen only ~9% of the time (`window: 30ms / interval: 320ms`), which can miss this window on the first stand.

Fix: increase the scan duty cycle in your ESPHome device YAML:

```yaml
bluetooth_proxy:
  active: true

esp32_ble_tracker:
  scan_parameters:
    interval: 320ms
    window: 300ms # listen ~94% of the time
    active: true
```

Flash the updated firmware to the proxy and restart BLE Scale Sync. This affects all passive-broadcast scales on that proxy: higher duty cycle means more reliable first-try readings.

### "No recognized scales found" in `npm run scan` over ESPHome

- Step on the scale (or press its button) while the scan runs so it begins advertising
- Move closer to the ESPHome proxy. Scale advertisements are low-power and ESPHome proxies have their own range limits
- Confirm Home Assistant sees the scale's advertisements via the same proxy; if HA also misses them, the proxy itself is out of range
