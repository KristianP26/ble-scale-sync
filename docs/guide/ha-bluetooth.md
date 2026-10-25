---
title: Home Assistant Bluetooth
description: Read broadcast scales through Home Assistant's Bluetooth stack and every adapter and proxy it already uses, over the websocket API.
---

# Home Assistant Bluetooth

BLE Scale Sync can subscribe to the advertisements Home Assistant receives from every Bluetooth scanner it knows: its own adapter, ESPHome Bluetooth proxies, SMLIGHT SLZB coordinators and Shelly devices. Home Assistant keeps control of its proxies, so use this transport when the only receiver near the scale is one Home Assistant already uses. It reads broadcast scales only.

## Requirements

- Home Assistant 2026.8 or newer.
- A Bluetooth scanner in Home Assistant that hears the scale: open **Settings** > **Devices & services** > **Bluetooth** > **Advertisement monitor** and stand on the scale.
- A scale from the list under [Which scales work](#which-scales-work).
- BLE Scale Sync in continuous mode (`runtime.continuous_mode: true` or `CONTINUOUS_MODE=true`). A single run listens only for 60 seconds.
- With Docker or a standalone install (the [add-on](#home-assistant-add-on) needs neither):
  - A long-lived access token of an administrator user: your profile > **Security** > **Long-lived access tokens** > **Create token**. A token of a non-admin user is refused at startup.
  - Network access from BLE Scale Sync to Home Assistant's web port (8123 by default; `https://` and reverse proxies work).

## Which Scales Work

The transport only receives advertisements, so it reads only scales that put the weigh-in in the advertisement:

| Scale                                                | Over Home Assistant Bluetooth                                                                                                    |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Xiaomi Mi Scale 2 (MIBCS / MIBFS / XMTZC05HM)    | Weight and impedance from the `0x181B` service data, full body composition                                                       |
| Xiaomi Mi Smart Scale 2 (XMTZC04HM / MI SCALE2)  | Weight only (`0x181D` carries no impedance)                                                                                      |
| Xiaomi Mijia Body Composition Scale S800 (ms116) | Weight only; needs `ble.bind_key`                                                                                                |
| Xiaomi Body Composition Scale S400               | Weight, impedance and heart rate; needs `ble.bind_key` and `ble.scale_mac`                                                       |
| Silvergear Smart Scale 108                       | Weight only                                                                                                                      |
| Grifema GA2001 / Senssun IF_B7               | Weight only                                                                                                                      |
| OKOK app scales (Chipsea broadcast)              | Weight only. Units without a name or named `Yoda0` / `Yoda1` need a scanner that forwards raw advertisements, see below          |
| Etekcity Fit 8S                                  | Weight only                                                                                                                      |
| PICOOC Mini Lite (`PICOOC-L`)                    | Weight only                                                                                                                      |
| Eufy Smart Scale P2 (T9148) / P2 Pro (T9149)     | Weight only. The broadcast carries no impedance; the local adapter reads it over a connection                                    |
| Eufy Smart Scale C20 (T9130) / P3 (T9150)        | Weight only. A P3 needs a scanner that forwards raw advertisements, see below                                                    |
| QN-Scale, broadcast-only firmware                | Weight only. Only units that send the `AABB` broadcast (some Renpho ES-CS20M / Elis 1 variants); connectable QN scales need GATT |

Every other adapter (Renpho, Yunmai, Beurer / Sanitas, Medisana, Soehnle, Trisa, Salter, Etekcity ESF-551, the Standard GATT catch-all and more) needs a connection to read the weight. Home Assistant's Bluetooth websocket API only subscribes to advertisements, with no way for an outside client to connect to a device, so these scales are matched but their reading never arrives. At startup the line `Home Assistant Bluetooth transport ready (broadcast only)` lists the adapters that work, and a warning names the ones that do not. For those, use a local adapter or the [ESPHome proxy](/guide/esphome-proxy).

## Configure BLE Scale Sync {#configuring-ble-scale-sync}

```yaml
ble:
  handler: ha-bluetooth
  scale_mac: 'AA:BB:CC:DD:EE:FF' # recommended: the address the advertisement monitor shows
  ha_bluetooth:
    url: http://homeassistant.local:8123
    token: '${HA_TOKEN}'
    # source: 'AA:BB:CC:DD:EE:01' # only advertisements heard by this scanner
```

Put the token in `.env` next to `config.yaml` (`HA_TOKEN=...`); it grants full access to Home Assistant.

| Field | Required | Description |
| --- | --- | --- |
| `url` | Yes | Home Assistant base URL. `http://` and `https://` are turned into the websocket endpoint; a full `ws(s)://host/api/websocket` is used as is. |
| `token` | Yes | Long-lived access token of an admin user. Use `${ENV_VAR}`. |
| `source` | No | Accept only advertisements from one Home Assistant scanner, by its `source` id (shown in the advertisement monitor and in the debug log). Default: every scanner. |

Changing `url`, `token` or `source` needs a restart.

## Home Assistant Add-on

In the [add-on](/guide/home-assistant-addon), set **Bluetooth transport** (`ble_transport`) to `ha-bluetooth`. No URL, token or `config.yaml` is needed: the add-on reaches Home Assistant through the Supervisor, which is why it asks for access to the Home Assistant API.

- Leave **Scale MAC address** empty for the first weigh-in, then copy the address from the log (or the advertisement monitor) into it.
- At boot the add-on starts before Home Assistant, so the log shows a few reconnect attempts before the subscription comes up.
- In custom config mode the add-on's Supervisor access replaces the token; see [custom config mode](/guide/home-assistant-addon#custom-config-mode) for the `ha_bluetooth` section.

## Docker {#docker-deployment}

The container needs only network access to Home Assistant, no Bluetooth flags or D-Bus mount. Start from `docker-compose.mqtt-proxy.yml` in the repository and add the `.env` file that holds the token:

```yaml
services:
  ble-scale-sync:
    env_file: .env # HA_TOKEN=...
```

## Behavior {#behaviour-worth-knowing}

- Right after subscribing, Home Assistant sends the last advertisement of every device it heard recently. BLE Scale Sync skips those older than 30 seconds, so a restart does not export an old weigh-in again.
- If Home Assistant restarts or the connection drops, BLE Scale Sync reconnects with a backoff from 2 to 60 seconds and subscribes again. A rejected token or a non-admin user is not retried.
- `ble.proxy_liveness_timeout_min` applies, see [Bluetooth transports](/guide/transports#choose-a-transport).

## Troubleshooting

### Startup Stops with a Home Assistant Error {#home-assistant-rejected-the-access-token}

- `Home Assistant rejected the access token`: the token is wrong or was revoked. Create a new one and update `.env`. Deleting the user that created a token deletes the token.
- `... the token must belong to an administrator user`: create the token while logged in as an administrator.
- `Home Assistant does not know bluetooth/subscribe_advertisements`: Home Assistant is too old, or the Bluetooth integration is not loaded. Add a Bluetooth adapter or proxy so **Settings** > **Devices & services** > **Bluetooth** exists, and upgrade Home Assistant.

### Connected, but the Scale Is Never Seen

1. Open the advertisement monitor in Home Assistant and stand on the scale. If the scale is not listed, Home Assistant cannot hear it: move a proxy closer, or enable the BLE proxy on your SMLIGHT or Shelly device.
2. If Home Assistant lists it, run `ble-scale-sync scan` (`npm run scan` from a clone) with `handler: ha-bluetooth`. Every device Home Assistant forwards is listed with the adapter it matched.
3. If `source` is set, check that it is the scanner that hears the scale.
4. Check the startup warning: a scale that needs a GATT connection is named there as unsupported over this transport.

### Weigh-Ins Are Only Picked Up Sometimes

Home Assistant emits an event only when an advertisement changes, which every supported scale does per weigh-in. On a SMLIGHT SLZB, keep the coordinator's BLE scan interval at its default; a long interval with a short window can miss the few seconds a scale broadcasts.

An OKOK scale without a name or named `Yoda0` / `Yoda1`, and a Eufy P3 (T9150), change their manufacturer id between weigh-ins, and Home Assistant keeps every id it has seen in one list. Only the raw advertisement tells which entry is current, so these scales are read only through a scanner that forwards raw advertisements: Home Assistant's local adapter and ESPHome Bluetooth proxies do. With debug logging on, a line ending in `does not forward raw advertisements.` names an affected device. OKOK scales advertising as `ADV` and the Eufy C20 (T9130) are not affected.

### "Home Assistant's live advertisements keep arriving stamped ... in the past"

Home Assistant stamps each advertisement with the time it received it, and BLE Scale Sync drops those older than 30 seconds, so no weigh-in gets through while this warning holds. Either the clocks of the two hosts disagree (check NTP on both), or Home Assistant's clock was corrected after BLE Scale Sync subscribed; restarting BLE Scale Sync starts a new subscription. The add-on shares Home Assistant's clock, so only the second cause applies there.
