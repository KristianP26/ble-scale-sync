---
title: Configuration
description: Complete config.yaml reference for BLE Scale Sync.
head:
  - - meta
    - name: keywords
      content: ble scale sync config, config.yaml smart scale, setup wizard, scale configuration, garmin exporter config, mqtt exporter config
---

# Configuration

::: tip Using the Home Assistant Add-on?
The add-on is configured through the HA UI, not `config.yaml`. See the [Home Assistant Add-on guide](./home-assistant-addon) for the full option reference.
:::

## Setup Wizard (recommended) {#setup-wizard-recommended}

The fastest way to configure BLE Scale Sync is with the **interactive setup wizard**. It walks you through scale discovery, user profiles, exporter selection, and connectivity tests:

```bash
# Docker (Linux)
docker run --rm -it --network host --cap-add NET_ADMIN --cap-add NET_RAW \
  --group-add "$(getent group bluetooth | cut -d: -f3)" -v /var/run/dbus:/var/run/dbus:ro \
  -v ./config.yaml:/app/config.yaml ghcr.io/kristianp26/ble-scale-sync:latest setup

# Standalone (npm install or npx)
npx ble-scale-sync setup

# Standalone (from a clone)
npm run setup
```

The wizard generates a complete `config.yaml`. If a config already exists, it offers **edit mode**: pick any section to reconfigure without starting over.

::: tip
You don't need to edit `config.yaml` manually. The wizard handles everything, including BLE scale auto-discovery, Garmin authentication, and exporter connectivity tests.
:::

### Validation

```bash
# Docker
docker run --rm -v ./config.yaml:/app/config.yaml:ro \
  ghcr.io/kristianp26/ble-scale-sync:latest validate

# Standalone (npm install or npx)
npx ble-scale-sync validate

# Standalone (from a clone)
npm run validate
```

## Where config.yaml and .env are read from {#config-location}

Outside Docker and the Home Assistant add-on, both files are looked up in **the working directory first**, and in the package install directory as a fallback. In a git checkout those are the same place, which is why the clone workflow never had to think about it.

Two consequences worth knowing:

- Under `npx ble-scale-sync`, the package lives in a cache directory that is deleted again, so the only useful location is the directory you run the command in. Run the command from where your `config.yaml` lives.
- `config.yaml` and `.env` are always taken from the **same** directory, never one from each. A stray `.env` in your working directory is the `.env` that gets used, so do not keep unrelated ones next to each other.

`--config <path>` overrides the config file location for the run path, for `validate` and for `setup`. In Docker the file is mounted to `/app/config.yaml` instead, and on the add-on it lives in `/data`.

## config.yaml Reference {#config-yaml-reference}

If you prefer manual configuration, here's the full reference. See [`config.yaml.example`](https://github.com/KristianP26/ble-scale-sync/blob/main/config.yaml.example) for an annotated template.

### BLE

```yaml
ble:
  scale_mac: 'FF:03:00:13:A1:04'
  # bind_key: '0123456789abcdef0123456789abcdef' # Xiaomi S800 / S400
  # handler: auto
  # noble_driver: abandonware
  # adapter: hci1
  # force_scale_adapter: 'Hutbit'
  # session_timeout_sec: 20
  # qn_protocol_byte: 0
  # qn_report_byte: 252
```

| Field                        | Required                    | Default        | Description                                                                                                                                                                                                                                                                                |
| ---------------------------- | --------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `scale_mac`                  | Recommended                 | Auto-discovery | MAC address, or a CoreBluetooth UUID on macOS (bare 32-hex as the wizard writes it, or the dashed form). Prevents connecting to a neighbor's scale.                                                                                                                                        |
| `bind_key`                   | Xiaomi S800 / S400          | (none)         | 32-char hex per-device MiBeacon key from the Mi cloud (extract with the community Xiaomi-cloud-tokens-extractor). Decrypts only the device's own FE95 broadcast. The S400 also needs `scale_mac`. Keep it secret; it is a credential.                                                      |
| `handler`                    | No                          | `auto`         | Transport: `auto` (local radio), `mqtt-proxy` (ESP32 over MQTT), `esphome-proxy` (ESPHome Native API). See below.                                                                                                                                                                          |
| `noble_driver`               | No                          | OS default     | `abandonware` or `stoprocent`. Overrides the default BLE driver. Only applies when `handler: auto`.                                                                                                                                                                                        |
| `adapter`                    | No                          | System default | Linux only. Select a specific Bluetooth adapter (e.g., `hci0`, `hci1`). See below.                                                                                                                                                                                                         |
| `force_scale_adapter`        | No                          | Auto-detect    | Name of the scale protocol adapter to use, bypassing auto-detection. Requires `scale_mac`. See below.                                                                                                                                                                                      |
| `session_timeout_sec`        | No                          | `120`          | Seconds of scale silence that end a GATT session (5 to 600); an inbound frame restarts the clock. Native BLE handlers only; ignored on `mqtt-proxy` and `esphome-proxy`. See below.                                                                                                        |
| `qn_protocol_byte`           | No                          | Auto           | QN-family scales only. Protocol byte the handshake echoes back to the scale (0 to 255). Set it when a QN scale runs the whole handshake and then reports nothing, or when its scale-info frame is lost in transit on a proxy transport. See below.                                         |
| `qn_report_byte`             | No                          | Per dialect    | QN-family scales only. Payload byte of the history-response frame (0 to 255). Defaults to `252` (0xFC) on the long-frame dialects (es26m and extended) and `254` (0xFE) on the classic one. Try the other value if your scale completes the handshake and then reports nothing. See below. |
| `auto_clear_stale_bond`      | No                          | `false`        | Delete a pairing key the scale has forgotten and pair again. Bonded scales only (Beurer BF7xx / BF9xx), node-ble transport only. See below.                                                                                                                                                |
| `qn_weight_ack`              | No                          | Per dialect    | QN-family scales only. Answer every live weight frame with its own weight, as the vendor app does. On by default on the 20-byte extended dialect. Try `true` if your QN scale completes the handshake and then streams nothing. See below.                                                 |
| `qn_a4_prelude`              | No                          | `false`        | QN-family scales only. Send the two undecoded `0xA4` frames an Arboleaf vendor app sends between START and the first weight frame. Off by default. Try `true` only if `qn_weight_ack` did not help and your scale still goes silent right after START. See below.                          |
| `proxy_liveness_timeout_min` | No                          | `30`           | Minutes of total advertisement silence before a proxy transport is treated as wedged and the process exits for the supervisor to restart. `0` disables. Proxy transports only. See below.                                                                                                  |
| `mqtt_proxy`                 | If `handler: mqtt-proxy`    | (none)         | MQTT proxy connection (`broker_url`, `device_id`, `topic_prefix`, `username`, `password`, `auto_connect`, `embedded_broker_*`). See [ESP32 BLE Proxy](./esp32-proxy).                                                                                                                      |
| `esphome_proxy`              | If `handler: esphome-proxy` | (none)         | ESPHome Native API connection (`host`, `port`, `encryption_key` or `password`, `client_info`). See [ESPHome Bluetooth Proxy](./esphome-proxy).                                                                                                                                             |

::: warning Forcing a scale adapter
`force_scale_adapter` is an escape hatch for when auto-detection routes your scale to the wrong protocol adapter, which happens with rebadged OEM hardware that shares a vendor service with another brand.

Use the adapter name exactly as it appears in the `Adapters:` line printed at startup:

```yaml
ble:
  scale_mac: '03:B3:EC:91:A2:12'
  force_scale_adapter: 'Hutbit'
```

Two things to know. The forced adapter claims **every** device it is shown, which is why `scale_mac` is required: the MAC is what keeps it aimed at your scale. And an unknown name fails at startup with the list of valid ones rather than being ignored.

If you need this, please [open an issue](https://github.com/KristianP26/ble-scale-sync/issues) with your scale's advertisement, so detection can be fixed for everyone and you can drop the override.
:::

::: tip QN scales that connect but never send a weight (`qn_protocol_byte`)

The QN protocol family (Renpho, Arboleaf, FITINDEX, GE and several rebadges) echoes a protocol byte back to the scale in every configuration command, and the firmware revisions disagree about which value they accept. The wrong value is not an error: the scale acknowledges the entire handshake and then simply never streams a weight, which looks exactly like nobody standing on it.

The scale-info frame length picks the default, and it is right for every unit reported so far. Some firmware wants its own byte rather than 0 or 255: an ES-CS20M that reports 21 needs 21, and the full 0 to 255 range is accepted, so try the value your scale reports before assuming it is a binary choice.

```yaml
ble:
  qn_protocol_byte: 0 # or 255; if neither works, the byte your scale reports (an ES-CS20M reporting 21 needs 21)
```

The debug log states which value is in use. When the scale-info frame arrives:

```
QN: scale info (19B, dialect=es26m), factor=10, proto=0xff
```

On a proxy transport that loses the scale-info frame, that line never prints; look for the fallback line instead, which shows the byte the handshake ran with:

```
QN: fallback: no 0x12 received, running handshake with proto=0x15
```

If a value makes your scale work, please say so in an issue with the model and that line: the default is set from the models we have evidence for, and yours may change it.

:::

::: tip QN scales that still report nothing (`qn_report_byte`)

If `qn_protocol_byte` did not help, there is one more byte worth trying, and it is a separate one.

When the scale asks for its configuration (`0x21`), the handshake answers with a history-response frame:

```
a0 0d 04 fe 00 00 00 00 00 00 00 00 <checksum>
                ^^
```

That `fe` comes from openScale, which took it from a capture of an ES-30M and labels it only as a payload byte.

On the **long-frame dialects**, es26m (19-byte) and extended (20-byte), the default is `fc`, and that one is not an inference. Two vendor-app captures on two different scales agree: one writes `a0 0d 04 fc ...` five times across three weigh-ins and never sends `fe`, with the scale echoing the byte back and 59 live weight frames following; the other is an Android capture of a successful weigh-in on a unit whose own log line reads `dialect=es26m`.

The 11-byte **classic** dialect keeps `fe`. No capture covers it, and unlike the long variants it reads today, which is what decides it: every scale reported silent after a completed handshake has been on a long frame.

What the byte actually selects is still not known. Reporters read it as choosing between a live weight stream and the stored-history path, which fits their symptoms, but openScale receives live weight frames while sending `fe`, so that reading cannot be the whole story. If your scale is on another dialect and goes quiet after the handshake, `fc` is the value to try:

```yaml
ble:
  qn_report_byte: 252 # 0xFC, the value both vendor-app captures send
```

With debug logging on, every session says which byte it used and why:

```
QN: history response byte 0xfc (dialect default)
QN: history response byte 0xfe (forced; dialect default 0xfc)
```

If `252` makes your scale produce a weight, please say so in an issue with the model, the dialect from the `QN: scale info` line and that log line. Two confirmations on different firmware would be enough to move the default.

:::

::: tip QN scales that finish the handshake and then stream nothing (`qn_weight_ack`)

There is a third silent-failure knob in this family, and it is the one with the clearest evidence behind it.

A vendor-app capture of a GE CS 10 G answers **every** live weight frame the scale sends with an acknowledgement carrying that frame's own weight:

```
scale  ... 11 1e be ...   ->  app  a2 06 01 1e be 85
scale  ... 11 1e c3 ...   ->  app  a2 06 01 1e c3 8a
```

On that firmware the scale will not finish a weigh-in without it, so the 20-byte extended dialect does this by default and needs no setting.

There is a second place the same frame appears, and it is the more interesting one for a scale that never streams anything at all. Before the weigh-in the handshake sends `a2 06 01 32 <age>`, which openScale labels a user profile. Under the reading above those payload bytes are a weight, and `0x32` plus an age decodes to something like **128.58 kg**, which is nobody. Two es26m reporters whose scales complete the whole handshake and then go silent have exactly that in their logs.

That default is not changed, because openScale's bytes are what every QN scale in the registry reads with today and two silent units are not enough to move it under the whole family. Turning this on swaps in your configured weight anchor there too, so the scale is told a plausible number before it decides whether to measure.

If your scale completes the whole handshake, is accepted on `qn_protocol_byte` and `qn_report_byte`, and then goes quiet, this is the next thing to try:

```yaml
ble:
  qn_weight_ack: true
```

That does two things: the pre-weigh-in A2 carries your `last_known_weight` (or the midpoint of your `weight_range`) instead of the placeholder, and every live weight frame is acknowledged with its own weight. `false` turns both off everywhere, including on the extended dialect, if it ever turns out to hurt a unit there.

If that still leaves the scale silent right after START, there is one more thing to try:

```yaml
ble:
  qn_a4_prelude: true
```

An HCI capture of an Arboleaf vendor app shows two `0xA4` frames sent between START and the first live weight frame, which this app does not send. The scale acknowledges each one and only then starts streaming. Turning this on replays those two frames.

Be aware of what that means. The frames are replayed byte for byte from one reporter's capture of their own scale, and their payload is not decoded. It looks like per-user calibration or a previous measurement handed back, so it may be right for everyone or right for nobody but the person who captured it. That is why it is off by default and why it is the last thing to try rather than the first. If it works for your unit, please say so on [issue #331](https://github.com/KristianP26/ble-scale-sync/issues/331): more than one confirmation is what would turn this from a replay into a decoded frame.

With debug on, the swap is named:

```
QN: ready-time A2 carries the configured weight anchor 76.40 kg instead of openScale's placeholder (#75)
```

If `true` makes your scale report a weight, please say so in an issue with the model and the dialect from the `QN: scale info` log line. Two confirmations would move the default.

:::

::: tip QN scales that only work for one person in the house (`last_known_weight`)

The 20-byte extended dialect (GE CS 10 G, "Fit Plus" and rebadges) is sent a weight anchor immediately after the start command, and the scale gates the weigh-in on it: if the number is far from what the person on the platform actually weighs, the handshake completes normally and then nothing else arrives.

Until 1.26.0 that anchor was a constant replayed from the capture it was decoded in, 77.15 kg, which is why these scales appeared to work for some households and not others. It now comes from your config: `users[].last_known_weight` when it is set, and the midpoint of `users[].weight_range` before the first reading lands. Both already exist, so there is nothing new to add.

```yaml
users:
  - name: Alex
    weight_range: { min: 70, max: 85 }
    last_known_weight: 76.4 # updated automatically after every reading
```

The debug log names the value each session runs with:

```
QN: extended-dialect measurement trigger sent, weight anchor 76.40 kg (#235, #75)
```

The anchor is taken from the **first** user in the list, because the scale is handed it before anyone steps on and there is nothing yet to match a person against.

That only covers the moment before the weigh-in. Once the scale starts streaming, every live weight frame is acknowledged with that frame's own weight, exactly as the vendor app does, so the number the scale is told matches whoever is actually standing on it regardless of whose anchor went out first. The anchor is the opening value; the acknowledgements are exact.

:::

::: tip A proxy that is connected but no longer delivering (`proxy_liveness_timeout_min`)

On `mqtt-proxy` and `esphome-proxy` the app waits for the proxy to push it a weigh-in. If that link wedges while still looking connected, the wait simply never ends, and from the app's side that is indistinguishable from a house where nobody has stepped on the scale. Both are silence.

What separates them is everything else in range. Advertisements arrive constantly from phones, watches and thermometers while the link is alive, and stop completely when it is not. So a proxy that has delivered **nothing at all** for half an hour is wedged rather than idle, and the process exits for your supervisor to restart it:

```yaml
ble:
  proxy_liveness_timeout_min: 30 # 0 disables the check
```

The window is deliberately long, and the check counts advertisements from **any** device, never from your scale alone: your scale only advertises while somebody is standing on it, so it proves nothing about the link.

Raise it or set it to `0` if your proxy sits somewhere genuinely quiet with no other Bluetooth devices in range. A false positive there would restart the add-on every half hour while nothing was actually wrong, which is worse than the problem it solves. The log always says why it fired.

Native handlers have their own watchdog and ignore this setting.

:::

::: tip Beurer scales that work once and never again (`auto_clear_stale_bond`)

A bonded scale can drop its half of the pairing on its own: a battery change does it, and on some units simply ending a session does. The host does not find out. BlueZ keeps replaying the stored key, the peripheral answers "PIN or Key Missing", and every connect from then on fails during encryption before any GATT traffic:

```
Connect error: le-connection-abort-by-local
```

Deleting a bond is destructive, so the default is to diagnose it and stop, telling you to run `bluetoothctl remove <mac>` and pair again. If that is happening to you every session, this does it for you:

```yaml
ble:
  auto_clear_stale_bond: true
```

The bond is cleared at most once per connect, and only after three consecutive authentication-class failures against a device BlueZ still lists as bonded. It stays opt-in because `le-connection-abort-by-local` also has innocent causes, notably a connect issued while another client (the Home Assistant Bluetooth integration on the same adapter, for instance) still holds a discovery session, and on these scales a bond dropped in error costs a trip to the device to confirm the passkey.

Native BlueZ only. The proxy transports do not pair at all.

:::

::: tip Beurer scales that reject every consent code (`beurer_register_new_user`)

If a Beurer or Sanitas scale bonds, subscribes and then answers the consent with `USER_NOT_AUTHORIZED` no matter which code or slot you try, the problem is usually not the code.

A user record in the Bluetooth SIG User Data Service exists only after a **Register New User** operation, and normally only the vendor app performs it. On a scale whose user was registered by the vendor app, another client has no record it is entitled to, and consent can never succeed for it.

::: warning Try the scale's own menu first
On a **BF915** the scale's menu profiles (SET, `U:1` to `U:8`) _are_ the SIG user slots, and creating one there is the whole job. @martingebert9428 measured it: factory reset, create `U:1` in the menu with no BLE operation of any kind, and Register New User then comes back with index **2**, because the menu profile has taken slot 1. Consent on index 1 is accepted and returns exactly the date of birth, gender and height entered in the menu.

So on that model the right first move is: create the profile in the menu, read the four-digit number the scale displays when you select it (that is the consent code, no guessing), and set `beurer_user_index` to the profile's number. Registering from here only burns slots you cannot free individually.

One more step that is invisible from the log: **assign one weigh-in to the new profile**. A profile with no reference weight makes the scale show `U -` after weighing and assign the measurement to nobody, and in that state it sends no notification at all, on any characteristic. It looks exactly like a wrong consent code.

Register New User is still the right tool where the vendor app owns the code, which is where it came from.
:::

This creates a record:

```yaml
users:
  - name: Your Name
    beurer_pin: 1234 # the code you want the new record to use
    beurer_register_new_user: true
```

It is opt-in and meant to be used once, because it writes a record to the scale and the slots are finite. The log then tells you which index the scale assigned:

```
Beurer BF720: registered a new user at index 4. Set 'users[].beurer_user_index: 4'
and turn 'beurer_register_new_user' back off, or the next run registers another one.
```

Put that index in `beurer_user_index`, set `beurer_register_new_user` back to `false`, and normal consent takes over from the next run.

If the scale refuses the registration, its slots are probably all occupied. Free one from the scale's own menu and try again.

:::

::: tip Shortening the session (`session_timeout_sec`)
Some scales will not run a standalone weigh-in while a host holds the GATT session open. The Beurer BF500 is the clearest example: it displays `APP` and waits, so only a measurement taken **between** sessions is picked up.

By default a session ends after 120 seconds without a notification from the scale. On a scale like this, that is 120 seconds out of every cycle in which stepping on it achieves nothing. Shortening the session, and lengthening the gap after it, frees the scale for most of the cycle:

```yaml
ble:
  session_timeout_sec: 20
runtime:
  scan_cooldown: 60
  watchdog_max_consecutive_failures: 0
```

Two costs, both real:

- **More Bluetooth adapter resets.** Every read that ends in a timeout triggers one, and shorter sessions mean more timeouts per hour. On a Raspberry Pi that is noticeable.
- **The failure watchdog trips sooner.** A session that times out counts as a failed cycle, so shorter sessions reach `watchdog_max_consecutive_failures` (default 10) in proportionally less time, and the process exits for the supervisor to restart. On a scale where waiting between weigh-ins is normal, raise that limit or set it to `0` to disable it, as above.

This option applies to the native BLE handlers only. On `mqtt-proxy` and `esphome-proxy` the watcher waits for a weigh-in indefinitely by design, and the value is ignored.
:::

::: tip BLE adapter selection (Linux only)
If your device has multiple Bluetooth adapters, you can choose which one BLE Scale Sync uses. By default, the first adapter (`hci0`) is used.

List your adapters:

```bash
hciconfig
# or
btmgmt info
```

For example, a Raspberry Pi with a built-in adapter (`hci0`) and a USB dongle (`hci1`):

```yaml
ble:
  adapter: hci1 # use the USB dongle for scale scanning
```

This lets you dedicate one adapter to BLE Scale Sync while keeping the other free for other tasks (e.g., Home Assistant Bluetooth proxy). This option is ignored on macOS and Windows, where the OS manages adapter selection.
:::

### Scale

```yaml
scale:
  weight_unit: kg
  height_unit: cm
```

| Field         | Required | Default | Description                                              |
| ------------- | -------- | ------- | -------------------------------------------------------- |
| `weight_unit` | No       | `kg`    | `kg` or `lbs`. Display only; calculations always use kg. |
| `height_unit` | No       | `cm`    | `cm` or `in`. Used for height input in user profiles.    |

### Users

At least one user is required. For multi-user setups, see [Multi-User Support](/multi-user).

```yaml
users:
  - name: Alice
    slug: alice
    height: 168
    birth_date: '1995-03-20'
    gender: female
    is_athlete: false
    weight_range: { min: 50, max: 75 }
```

| Field                      | Required | Default        | Description                                                                             |
| -------------------------- | -------- | -------------- | --------------------------------------------------------------------------------------- |
| `name`                     | Yes      | (none)         | Display name                                                                            |
| `slug`                     | No       | Auto-generated | Unique ID (lowercase, hyphens) for MQTT topics, InfluxDB tags                           |
| `height`                   | Yes      | (none)         | Height in configured unit                                                               |
| `birth_date`               | Yes      | (none)         | ISO date (`YYYY-MM-DD`)                                                                 |
| `gender`                   | Yes      | (none)         | `male` or `female`                                                                      |
| `is_athlete`               | No       | `false`        | Adjusts [body composition](/body-composition#athlete-mode) formulas                     |
| `weight_range`             | No       | (none)         | `{ min, max }` in kg. Required for [multi-user](/multi-user) deployments                |
| `last_known_weight`        | No       | `null`         | Auto-updated after each measurement. Also used as the weight anchor some scales expect  |
| `exporters`                | No       | (none)         | [Per-user exporter](/multi-user#per-user-exporters) overrides                           |
| `beurer_pin`               | Beurer   | (none)         | Consent code the Beurer BF7xx / BF9xx scale was paired with                             |
| `beurer_user_index`        | No       | `1`            | Scale user slot the consent code belongs to                                             |
| `beurer_provision`         | No       | `false`        | Write this profile into a Beurer scale that has no stored user                          |
| `beurer_register_new_user` | No       | `false`        | Create a new user record on the scale instead of consenting to one. One-shot; see below |

### Exporters

```yaml
global_exporters:
  - type: garmin
    email: '${GARMIN_EMAIL}'
    password: '${GARMIN_PASSWORD}'
```

Shared by all users unless a user defines their own `exporters` list. See [Exporters](/exporters) for all 11 targets and their configuration fields.

### Runtime

```yaml
runtime:
  continuous_mode: false
  scan_cooldown: 30
  dry_run: false
  debug: false
  watchdog_max_consecutive_failures: 10
  watch_config: true
```

| Field                               | Required | Default | Description                                                                                                                                                                                                                                                                                                            |
| ----------------------------------- | -------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `continuous_mode`                   | No       | `false` | Keep scanning in a loop (for always-on deployments)                                                                                                                                                                                                                                                                    |
| `scan_cooldown`                     | No       | `30`    | Seconds between scans (5-3600). On the native BLE handler in continuous mode, after a successful read the app sleeps at least 25 s regardless of this setting so it does not reconnect while the scale is still advertising (post-disconnect grace, [#143](https://github.com/KristianP26/ble-scale-sync/issues/143)). |
| `dry_run`                           | No       | `false` | Read scale + compute body comp, skip exports                                                                                                                                                                                                                                                                           |
| `debug`                             | No       | `false` | Verbose BLE logging                                                                                                                                                                                                                                                                                                    |
| `watchdog_max_consecutive_failures` | No       | `10`    | In continuous mode on Linux: exit after this many consecutive scan failures so Docker `restart: unless-stopped` can recover from a stuck BlueZ controller (0 = disabled). See [Troubleshooting](/troubleshooting#ble-discovery-stops-working-after-hours-bluez-stuck-state).                                           |
| `watch_config`                      | No       | `true`  | Auto-reload `config.yaml` on edit (continuous mode only). Set to `false` to disable and rely on `SIGHUP` only. See [Live Config Reload](/multi-user#live-config-reload).                                                                                                                                               |

### Update Check

```yaml
update_check: true
```

| Field          | Required | Default | Description                                                        |
| -------------- | -------- | ------- | ------------------------------------------------------------------ |
| `update_check` | No       | `true`  | Check for newer versions after each measurement (max once per 24h) |

After each successful measurement, the app sends a single GET request to `api.blescalesync.dev/version`. Only the app version, OS, and architecture are sent via the User-Agent header. No personal data is collected. Automatically disabled when `CI=true`.

The date of the last check is written to `.update-check-state.json` next to this config file, so the once-per-day limit survives a restart. On the Home Assistant add-on that is `/data`, on bare Node.js it is the directory holding `config.yaml` (or your `.env` when there is no `config.yaml`). On Docker it is `/app` inside the container, because `-v ./config.yaml:/app/config.yaml` mounts the file and not the directory: the cooldown then survives a container restart but not a re-create or an image update. `--config` cannot be passed through `docker run` on the published image: the entrypoint's `start` command runs `node dist/index.js` with no arguments, and any extra argument replaces the command instead of being forwarded. If you need the cooldown to survive an image update, run on bare Node.js or the Home Assistant add-on, where the state file sits in a directory you control. The file holds a single date and nothing else; if it is missing or unreadable the app simply checks again. Delete it any time.

Anonymous aggregated statistics are visible at [stats.blescalesync.dev](https://stats.blescalesync.dev).

## Environment Variables

### Secret references

YAML values support `${ENV_VAR}` syntax for passwords and tokens. The variable must be defined in the environment or in a `.env` file; loading fails if a reference is undefined.

```yaml
global_exporters:
  - type: garmin
    email: '${GARMIN_EMAIL}'
    password: '${GARMIN_PASSWORD}'
```

### Runtime overrides

These environment variables always override `config.yaml` values, useful for Docker `-e` flags:

| Variable                    | Overrides                                   |
| --------------------------- | ------------------------------------------- |
| `CONTINUOUS_MODE`           | `runtime.continuous_mode`                   |
| `DRY_RUN`                   | `runtime.dry_run`                           |
| `DEBUG`                     | `runtime.debug`                             |
| `SCAN_COOLDOWN`             | `runtime.scan_cooldown`                     |
| `BLE_WATCHDOG_MAX_FAILURES` | `runtime.watchdog_max_consecutive_failures` |
| `SCALE_MAC`                 | `ble.scale_mac`                             |
| `NOBLE_DRIVER`              | `ble.noble_driver`                          |
| `BLE_ADAPTER`               | `ble.adapter`                               |

::: details Legacy .env support
If `config.yaml` doesn't exist, the app falls back to `.env` configuration. See `.env.example` in the repository. When both files exist, `config.yaml` takes priority.
:::
