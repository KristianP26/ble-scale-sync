---
title: Home Assistant Bluetooth
description: Use Home Assistant's Bluetooth stack, and every proxy it already has, as BLE Scale Sync's radio.
head:
  - - meta
    - name: keywords
      content: home assistant bluetooth proxy, ble-scale-sync home assistant, subscribe_advertisements, smlight slzb bluetooth proxy, shelly bluetooth proxy, esphome proxy home assistant, scale without bluetooth adapter
---

# Home Assistant Bluetooth

Home Assistant can act as BLE Scale Sync's BLE radio. Every Bluetooth scanner Home Assistant knows about (its own adapter, ESPHome Bluetooth proxies, SMLIGHT SLZB coordinators, Shelly devices) feeds one advertisement stream, and BLE Scale Sync subscribes to that stream over the Home Assistant websocket API. No local Bluetooth adapter, no dedicated ESP32, no MQTT broker.

::: tip Broadcast scales only
Home Assistant exposes advertisements over this API, not GATT connections. Scales whose reading is in the advertisement work (Xiaomi Mi Scale 2 and S400 / S800, Silvergear 108, broadcast-only Renpho ES-CS20M variants, ...). Scales that need a connection (QN Scale, Yunmai, Beurer, most Renpho, ...) are reported as unsupported over this transport at startup; use a local adapter or the [ESPHome proxy](/guide/esphome-proxy) for those.
:::

::: tip Coexists with Home Assistant
Unlike pointing BLE Scale Sync at an ESPHome node directly, this transport does not take anything away from Home Assistant: Home Assistant keeps owning its proxies and simply forwards what they hear. It is the right choice when your only BLE receiver near the scale is something Home Assistant already uses, for example a SMLIGHT SLZB-06/MR coordinator with its BLE proxy enabled.
:::

## How it works

```
┌───────┐  BLE  ┌──────────────┐  proxy   ┌────────────────┐  websocket  ┌────────────────┐
│ Scale │ ────► │ any HA BT    │ ───────► │ Home Assistant │ ──────────► │ BLE Scale Sync │
└───────┘ advert│ proxy/adapter│          │   bluetooth    │  (8123)     │  Docker/Node   │
                └──────────────┘          └────────────────┘             └────────────────┘
```

BLE Scale Sync authenticates with a long-lived access token and sends `bluetooth/subscribe_advertisements`. Home Assistant then pushes every advertisement it receives, already parsed into name, manufacturer data, service data and service UUIDs. The server matches its scale adapters against that, parses the broadcast frame, and dispatches the reading to exporters exactly as with a local radio.

## Requirements

- Home Assistant **2026.8 or newer** (the SMLIGHT SLZB proxy needs this; the advertisement subscription itself exists since 2025)
- A **long-lived access token of an administrator user**: Profile (bottom-left) → Security → Long-lived access tokens → Create. The subscription is admin-only; a token from a non-admin user is refused at startup.
- At least one Bluetooth scanner in Home Assistant that can hear the scale: check **Settings → Devices & services → Bluetooth → Advertisement monitor** while standing on the scale.
- Network reachability from BLE Scale Sync to Home Assistant on its web port (8123 by default; `https://` and reverse proxies work too).

## Configuring BLE Scale Sync

Add the `ble` section to your `config.yaml`:

```yaml
ble:
  handler: ha-bluetooth
  scale_mac: 'F8:83:06:4E:B6:7E' # recommended: the scale as shown in HA's advertisement monitor
  ha_bluetooth:
    url: http://homeassistant.local:8123 # http(s):// base URL, or ws(s)://.../api/websocket
    token: '${HA_TOKEN}' # long-lived access token from .env
    # source: '9c:13:9e:34:82:08'      # optional: only this HA scanner (its source id)
```

Put the token in `.env` next to the config (`HA_TOKEN=...`); it is a credential with full Home Assistant access. The `${HA_TOKEN}` reference is resolved at load time.

| Field    | Required | Description                                                                                                                                                                      |
| -------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `url`    | Yes      | Home Assistant base URL. `http://` / `https://` are turned into the websocket endpoint automatically; a full `ws(s)://host/api/websocket` is accepted as-is.                     |
| `token`  | Yes      | Long-lived access token of an **admin** user. Use `${ENV_VAR}`.                                                                                                                  |
| `source` | No       | Only accept advertisements heard by one Home Assistant scanner, identified by its `source` id (shown in the advertisement monitor and in the debug log). Default: every scanner. |

Run it in **continuous mode** (`runtime.continuous_mode: true` or `CONTINUOUS_MODE=true`): the watcher keeps the websocket open and reacts the moment Home Assistant forwards a weigh-in. A single run only listens during its own 60-second window.

### Behaviour worth knowing

- **Restart safety.** Home Assistant replays every advertisement it has cached the moment a client subscribes. BLE Scale Sync drops anything Home Assistant last saw more than 30 seconds ago, so a restart never re-exports the previous weigh-in.
- **Reconnects.** If Home Assistant restarts or the connection drops, the watcher reconnects with backoff (2 s → 60 s) and re-subscribes. A rejected token or a non-admin user is not retried; the log says which.
- **Liveness.** `proxy_liveness_timeout_min` (default 30) applies: if Home Assistant delivers no advertisement from any device for that long, the process exits for the supervisor to restart it. See [Configuration](/guide/configuration).
- **Hot reload.** Changing `url`, `token` or `source` requires a restart; the reload diff says so and never prints the token.

## Docker deployment

No Bluetooth capabilities or D-Bus socket are needed; the container only needs network access to Home Assistant:

```yaml
services:
  ble-scale-sync:
    image: ghcr.io/kristianp26/ble-scale-sync:latest
    container_name: ble-scale-sync
    volumes:
      - ./config.yaml:/app/config.yaml
      - ./data:/app/data
    env_file: .env # HA_TOKEN=...
    environment:
      - CONTINUOUS_MODE=true
    restart: unless-stopped
```

## Troubleshooting

### "Home Assistant rejected the access token"

The token is wrong, expired, or was revoked. Create a new long-lived token and update `.env`. Tokens are tied to the user that created them: deleting that user deletes the token.

### "the token must belong to an administrator user"

`bluetooth/subscribe_advertisements` is an admin-only command. Create the token while logged in as an administrator.

### "Home Assistant does not know bluetooth/subscribe_advertisements"

Home Assistant is too old, or the Bluetooth integration is not loaded. Add a Bluetooth adapter or proxy so **Settings → Devices & services → Bluetooth** exists, and upgrade to a current release.

### Connected, but the scale is never seen

1. Open **Settings → Devices & services → Bluetooth → Advertisement monitor** in Home Assistant and stand on the scale. If it does not appear there, Home Assistant cannot hear it either: move a proxy closer or enable the BLE proxy on your SMLIGHT / Shelly device.
2. If it appears in Home Assistant but not in BLE Scale Sync, run `ble-scale-sync scan` (`npm run scan` from a clone) with `handler: ha-bluetooth`: every device Home Assistant forwards is listed with the adapter it matched, or none.
3. If `source` is set, make sure it matches the scanner that actually hears the scale (the same view shows which one does).
4. Scales that need a GATT connection are listed at startup as unsupported over this transport.

### Weigh-ins are only picked up sometimes

Home Assistant only emits an event when an advertisement **changes**. That is fine for every supported broadcast scale, which sends distinct frames per weigh-in. If your Home Assistant proxy is a SMLIGHT SLZB, keep the coordinator's BLE scan interval at its default; a long interval with a short window can miss the few seconds a scale broadcasts.
