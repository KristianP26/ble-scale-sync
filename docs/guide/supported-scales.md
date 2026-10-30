---
title: Supported Scales
description: Every BLE smart scale brand and model BLE Scale Sync reads, how to find your scale, and the quirks of each model.
---

# Supported Scales

BLE Scale Sync has **43 protocol adapters**, plus a catch-all for any scale that follows the Bluetooth weight-scale specification. Most adapters cover several rebrands.

## Scale List

_Weight only_ means the weight is read and body composition is estimated from BMI. [Known Limitations](#known-limitations) says why for most of them.

| Brand / Models                                                         | Body composition | Notes |
| ---------------------------------------------------------------------- | ---------------- | ----- |
| Xiaomi Mi Scale 2 (MIBCS / MIBFS / XMTZC05HM)                          | Yes              | No pairing needed; works on every transport |
| Xiaomi Mi Smart Scale 2 (XMTZC04HM / MI SCALE2)                        | Weight only      | No pairing needed |
| Silvergear Smart Scale 108, INSMART (`AAA006`), Foryond FG263LB (`AAA002`) | Weight only  | Broadcast only; the display unit does not matter |
| Grifema GA2001 / Senssun IF_B7                                         | Weight only      | Broadcast only; kg or lb display |
| OKOK (Chipsea broadcast): nameless, Yoda0 / Yoda1, `ADV`               | Weight only      | Broadcast only; kg display only; a nameless unit needs `ble.scale_mac` on the default Linux transport |
| Etekcity Fit 8S                                                        | Weight only      | Broadcast only; nameless, so it needs `ble.scale_mac` on the default Linux transport |
| PICOOC Mini Lite (`PICOOC-L`)                                          | Weight only      | Broadcast only; matched by its name |
| Xiaomi Mijia Body Composition Scale S800 (ms116)                       | Weight only      | Needs a per-device `ble.bind_key` from the Mi cloud |
| Xiaomi Body Composition Scale S400 (MJTZC01YM)                         | Yes              | Needs `ble.bind_key` and `ble.scale_mac`; weigh barefoot for impedance |
| Renpho ES-CS20M / ES-32MD / Elis 1 / FITINDEX / Sencor (QN-Scale)      | Yes              | The most common protocol; see [QN Scales](./scales/qn) |
| Arboleaf (QN-Scale, 19-byte dialect)                                   | Yes              | Uses the body composition the scale computes; see [QN Scales](./scales/qn) |
| Renpho ES-CS20M on service 0x1A10                                      | Yes              | See [Renpho Scales](./scales/renpho) |
| Renpho ES-WBE28                                                        | Weight only      | Standard GATT variant |
| Renpho A-R003                                                          | Weight only      | Experimental; advertises no name, so it needs `ble.scale_mac` on the default Linux transport and on macOS |
| Renpho ES-26BB-B                                                       | Yes              |       |
| Renpho R-MSC04 (MorphoScan Nova)                                       | Weight only      | The scale's own body fat with `ble.rmsc04_profile_byte`; see [Renpho Scales](./scales/renpho) |
| 1byone / Eufy C1 / P1                                                  | Yes              |       |
| Eufy Smart Scale P2 (T9148) / P2 Pro (T9149)                           | Yes              | Body composition over a connection; the broadcast gives weight only |
| Eufy Smart Scale C20 (T9130) / P3 (T9150)                              | Weight only      | Broadcast only; matched by its name or by its own address |
| Yunmai Signal / Mini / Mini 2                                          | Yes              | Impedance and, on newer firmware, the scale's own body fat |
| Yunmai SE                                                              | Weight only      | Reports no impedance |
| Beurer BF700 / BF710 / BF800                                           | Yes              | BF710: register it in the Beurer app first; see [Beurer and Sanitas](./scales/beurer) |
| Salter SA00656 / SA00432 (Salter Health)                               | Weight only      | Powers off after weighing; suits continuous mode |
| Sanitas SBF70 / SBF75                                                  | Yes              | See [Beurer and Sanitas](./scales/beurer) |
| Sanitas SBF72 / SBF73                                                  | Yes              | Needs user slot 1 in the vendor app |
| Beurer BF720 / BF105 / BF500 / BF788 / BF915 / BF950                   | Yes              | Needs `users[].beurer_pin` and a bonded link; see [Beurer and Sanitas](./scales/beurer) |
| A&D UC-352BLE                                                          | Weight only      | Experimental; Linux (BlueZ) only, needs `ble.scale_mac` and a one-time pairing |
| Huawei CH100 / AH100                                                   | Yes              | Experimental; not on macOS; see [Known Limitations](#huawei-ch100-ah100) |
| Soehnle Shape200 / Shape100 / Shape50 / Style100                       | Yes              | Needs user slot 1 in the vendor app |
| Medisana BS430 / BS440 / BS444                                         | Yes              |       |
| Active Era BS-06 and other `AC 27` scales                              | Yes              | Detected by manufacturer id `0x27AC`; wake it before stepping on |
| Senssun Fat                                                            | Yes              | Model A only |
| MGB (Swan / Icomon / YG)                                               | Yes              |       |
| Hutbit 218008 / WL292                                                  | Yes              | Also sold under stock `SWAN` branding |
| Robi S9                                                                | Weight only      |       |
| Speediance Smart Scale FG2211WBF                                       | Yes              | Lefu/Icomon sibling of the Robi S9 |
| Digoo DG-SO38H (Mengii)                                                | Yes              |       |
| Excelvan CF369                                                         | Yes              |       |
| Trisa Body Analyze / ADE BA 1600 (fitvigo)                             | Weight only      | The resistance it reports is not on an ohm scale |
| Hoffen BS-8107                                                         | Yes              |       |
| Etekcity ESF-551 Smart Fitness Scale                                   | Yes              | Matched by its advertised name |
| Hesley (YunChen)                                                       | Yes              |       |
| Inlife (FatScale)                                                      | Yes              |       |
| Koogeek S1                                                             | Yes              | Connecting can be unreliable |
| Exingtech Y1 (vscale)                                                  | Yes              |       |
| Any standard BT SIG scale (BCS/WSS)                                    | Yes              | Catch-all; select user 1 on the scale |

## Finding Your Scale

The [setup wizard](/guide/configuration#setup-wizard-recommended) scans for nearby BLE devices, identifies supported scales and writes the config. To scan without the wizard:

```bash
# Docker
docker run --rm --network host --cap-add NET_ADMIN --cap-add NET_RAW \
  --group-add "$(getent group bluetooth | cut -d: -f3)" -v /var/run/dbus:/var/run/dbus:ro \
  ghcr.io/kristianp26/ble-scale-sync:latest scan

# Standalone (npm install or npx)
npx ble-scale-sync scan

# Standalone (from a clone)
npm run scan
```

Put the address `scan` lists into `ble.scale_mac`, so the app never connects to a neighbor's scale. The wizard does it for you. Broadcast-only scales advertise only while someone stands on them, so step on the scale while the scan runs.

## Known Limitations

### Senssun Model B

Not supported. Only Model A, with service 0xFFF0, is.

### Koogeek S1

Connecting and service discovery are unreliable on BlueZ and on the ESP32 proxy, and succeed only occasionally on macOS. Retry, or use whichever transport works for your unit.

### Renpho R-MSC04 (MorphoScan Nova) {#renpho-r-msc04-morphoscan-nova}

The scale's own body fat needs `ble.rmsc04_profile_byte`, see [Renpho Scales](./scales/renpho).

### Arboleaf (QN-Scale, 19-byte dialect) {#arboleaf-qn-scale-19-byte-dialect}

Needs two `ble.qn_*` options, see [QN Scales](./scales/qn#arboleaf-scales-19-byte-dialect).

### Renpho ES-CS20M / Elis 1 (some hardware variants)

Some units only broadcast, so body composition is estimated from BMI, see [QN Scales](./scales/qn#supported-models).

### Renpho ES-CS20M on service 0x1A10 {#renpho-es-cs20m-on-service-0x1a10-with-ae01-ae02}

Newer revisions use Renpho's own protocol, see [Renpho Scales](./scales/renpho#es-cs20m-on-service-0x1a10).

### Eufy Smart Scale P2 / P2 Pro

Over a connection body fat is computed from the impedance with the generic BIA formula, which can read a few points apart from the Eufy app. A weigh-in in socks, or one read from the broadcast, gets the BMI estimate.

### Eufy Smart Scale C20 / P3

Read from the broadcast, without a connection, as kg; if your display shows lb or st, compare the first export with the display and report it on [#408](https://github.com/KristianP26/ble-scale-sync/issues/408). On macOS the scale is found only when its name arrives in a scan response. Over [Home Assistant Bluetooth](/guide/ha-bluetooth) a P3 needs a scanner that forwards raw advertisements.

### Yunmai

A Mini 2 (M1690) that advertises no name needs `ble.scale_mac` on the default Linux transport. The body fat the scale sends is computed for the profile the vendor app stored, so with several users it can belong to the profile the scale picked rather than to the matched person.

### Xiaomi Mi Smart Scale 2 (XMTZC04HM)

Its advertisement carries no impedance, so body composition is estimated from BMI.

### Xiaomi Body Composition Scale S400 (MJTZC01YM)

1. Pair the scale in Mi Home and register a user profile there.
2. Extract `ble.bind_key` with the community Xiaomi-cloud-tokens-extractor.
3. Stand on the scale while `scan` runs, since it advertises only while someone stands on it, and set `ble.scale_mac` to its address.
4. Keep Mi Home closed while you weigh in, and weigh barefoot.

### Silvergear Smart Scale 108

The reading goes out about two seconds after the display settles, and no later than 12 seconds after it settles. Shifting your weight on the scale does not end the weigh-in.

### Grifema GA2001 / Senssun IF_B7

The weight is read in kg whether the display shows kg or lb; other display units are ignored with a warning in the log.

### OKOK app scales (Chipsea broadcast)

Sold under many names with the OKOK app. Keep the scale on kg. Nameless units need `ble.scale_mac` on Linux, and on macOS only units named `Yoda0`, `Yoda1` or `ADV` work. Scales advertising as `Chipsea-BLE` are not supported; report them on [#408](https://github.com/KristianP26/ble-scale-sync/issues/408).

### Etekcity Fit 8S

Nameless: set `ble.scale_mac` on the default Linux transport; on macOS it is recognized by its service 0xFFD0. Stay on the scale until it finishes, about two seconds after the weight settles.

### PICOOC Mini Lite

Silent between weigh-ins, so step on it while `scan` runs. A broadcast in another PICOOC format is ignored with a warning; report it on [#408](https://github.com/KristianP26/ble-scale-sync/issues/408). Other PICOOC scales, such as the PICOOC Mini (`PICOOC-CQ`, `PICOOC-CC`), are not supported.

### A&D UC-352BLE

Experimental. Linux built-in Bluetooth only, with `ble.scale_mac` set. The scale keeps one pairing, so pairing it with ble-scale-sync removes the pairing with the A&D app; that is why ble-scale-sync connects to it only when `ble.scale_mac` names it. To pair:

1. Start ble-scale-sync.
2. Switch the scale off and hold **SET** until it shows `Pr`.
3. After the first connection, weigh in again.

If it does not pair, pair it by hand while the scale shows `Pr`: run `bluetoothctl`, then `agent on`, `default-agent`, `scan on`, `pair <MAC>` and `trust <MAC>`.

In Docker set `TZ`: the scale's clock is set to the host's local time. Report results with a `runtime.debug: true` log on [#408](https://github.com/KristianP26/ble-scale-sync/issues/408).

### Huawei CH100 / AH100

Experimental. The scale encrypts every frame with its Bluetooth address, which macOS does not reveal, so read it from Linux, Windows, an [ESPHome proxy](/guide/esphome-proxy) or the [ESP32 proxy](/guide/esp32-proxy). If the log says `the scale refused this host`, bind the scale once with openScale as its first user, then weigh in again. Each connection sends the first user's profile to the scale. Its body fat is used for a user with that sex, age and height, and estimated for everyone else. Report results with a debug log on [#503](https://github.com/KristianP26/ble-scale-sync/issues/503).

### Active Era BS-06 and other `AC 27` scales

Sold with the FitDays, Starfit or Femmto apps. Switch the scale on and wait for the Bluetooth icon before you step on, or the weigh-in is stored on the scale and not imported. A unit that does not advertise `0x27AC` needs `ble.force_scale_adapter: 'Active Era BS-06'` and `ble.scale_mac`; report its `Advert:` line from a debug log.

## Scale Not Listed {#don-t-see-your-scale}

The Standard BT SIG adapter reads any scale that follows the Bluetooth specification. Run the [setup wizard](/guide/configuration#setup-wizard-recommended) or `scan` to check.

To add support for a new scale, see [Contributing](https://github.com/KristianP26/ble-scale-sync/blob/main/CONTRIBUTING.md#adding-a-new-scale-adapter).
