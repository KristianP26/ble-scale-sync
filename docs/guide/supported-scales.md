---
title: Supported Scales
description: Every BLE smart scale brand and model supported by BLE Scale Sync.
head:
  - - meta
    - name: keywords
      content: koogeek scale, xiaomi mi scale, renpho scale bluetooth, eufy smart scale, yunmai scale, beurer bf scale, sanitas scale, medisana bs scale, silvercrest scale, 1byone scale, etekcity scale, inevifit scale, arboleaf scale, lepulse scale, fitdays scale, senssun scale, supported ble scales
---

# Supported Scales

BLE Scale Sync ships **29 protocol adapters** out of the box, covering Xiaomi, Renpho (incl. FITINDEX, Sencor, QN-Scale), Eufy (incl. P2 Pro T9149), Yunmai, Beurer, Sanitas, Medisana, and more, plus a generic Bluetooth SIG adapter that works with any spec-compliant BCS/WSS scale. Each adapter typically supports several models or rebrands sold under different names, so the real device coverage is much wider than the adapter count. Most adapters provide weight + impedance for full [body composition](/body-composition) calculation; a few are weight-only (noted in the table), and those estimate body composition from BMI instead.

## Scale List

| Brand / Model                                                         | Notes                                                                                                                                                                                                                                             |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Xiaomi** Mi Scale 2 (MIBCS / MIBFS / XMTZC05HM)                     | Passive BLE advertisement decoding (service data 0x181B); no pairing required. Works on all BLE transports (direct, ESPHome proxy, ESP32 MQTT proxy). Uses scale's own body comp values                                                           |
| **Xiaomi** Mijia Body Composition Scale S800 (ms116)                  | Weight via encrypted MiBeacon broadcast (service data 0xFE95); requires a per-device `ble.bind_key` from the Mi cloud. Body composition estimated from weight plus profile (8-electrode segmental data needs the unsupported encrypted GATT path) |
| **Renpho** ES-CS20M / ES-32MD / Elis 1 / FITINDEX / Sencor (QN-Scale) | Most common generic BLE protocol                                                                                                                                                                                                                  |
| **Renpho** ES-WBE28                                                   | Standard GATT variant                                                                                                                                                                                                                             |
| **Renpho** ES-26BB-B                                                  |                                                                                                                                                                                                                                                   |
| **Renpho** R-MSC04 (MorphoScan Nova)                                  | Weight-only. Body composition is estimated from BMI, see Known Limitations below                                                                                                                                                                  |
| **1byone** / **Eufy** C1 / P1                                         |                                                                                                                                                                                                                                                   |
| **Eufy** Smart Scale P2 (T9148) / P2 Pro (T9149)                      | AES handshake over FFF1/FFF4, impedance via FFF2                                                                                                                                                                                                  |
| **Yunmai** Signal / Mini / SE                                         | Uses scale's own body comp values                                                                                                                                                                                                                 |
| **Beurer** BF700 / BF710 / BF800                                      | Full body composition over vendor FFE1. BF710 needs registering via the Beurer app, then stand until the bioimpedance step finishes                                                                                                               |
| **Sanitas** SBF70 / SBF75                                             | Same protocol as Beurer BF710; full body composition (impedance, fat, water, muscle, bone)                                                                                                                                                        |
| **Sanitas** SBF72 / SBF73 / **Beurer** BF915                          | Requires user slot 1 via manufacturer app                                                                                                                                                                                                         |
| **Beurer** BF720 / BF105 / BF500 / BF788 / BF950                      | SIG-standard, native body composition. Needs the consent PIN from the Beurer / openScale app (or the scale's control unit) in `users[].beurer_pin`, and a bonded link, so use the native BLE handler on Linux rather than an ESPHome proxy        |
| **Soehnle** Shape200 / Shape100 / Shape50 / Style100                  | Requires user slot 1 via manufacturer app                                                                                                                                                                                                         |
| **Medisana** BS430 / BS440 / BS444                                    |                                                                                                                                                                                                                                                   |
| **Active Era** BS-06                                                  |                                                                                                                                                                                                                                                   |
| **Senssun** Fat                                                       | Model A only (0xFFF0)                                                                                                                                                                                                                             |
| **MGB** (Swan / Icomon / YG)                                          | Lefu OEM units that advertise as `SWAN` and carry the Hutbit manufacturer signature route to the Hutbit adapter instead                                                                                                                           |
| **Hutbit** 218008 / WL292                                             | Lefu / Fitdays OEM. Also sold with stock `SWAN` branding, which is matched on the advertisement signature. Weight-only: the vendor bioimpedance is unreliable, so body composition is derived from BMI                                            |
| **Robi** S9                                                           | Lefu / Fitdays FFB0 protocol (B0/B1/B2/BD handshake, final result on FFB3 indicate). Weight is read and verified; the vendor impedance frame is not decoded, so body composition is estimated from BMI                                            |
| **Digoo** DG-SO38H (Mengii)                                           |                                                                                                                                                                                                                                                   |
| **Excelvan** CF369                                                    |                                                                                                                                                                                                                                                   |
| **Trisa** Body Analyze / **ADE** BA 1600 (fitvigo)                    | ADE variant: weight reported by scale; body composition derived locally via Deurenberg fallback                                                                                                                                                   |
| **Hoffen** BS-8107                                                    |                                                                                                                                                                                                                                                   |
| **Hesley** (YunChen)                                                  |                                                                                                                                                                                                                                                   |
| **Inlife** (FatScale)                                                 |                                                                                                                                                                                                                                                   |
| **Koogeek** S1                                                        | Vendor FFF0 protocol. Body composition is estimated from weight and impedance, because the vendor computed it in a cloud service that no longer exists. See Known Limitations                                                                     |
| **Exingtech** Y1 (vscale)                                             |                                                                                                                                                                                                                                                   |
| Any **standard BT SIG** scale (BCS/WSS)                               | Catch-all for standard-compliant scales                                                                                                                                                                                                           |

::: info Sorted by popularity
Most widely available brands are listed first. The Standard BT SIG adapter at the bottom acts as a catch-all for any scale that follows the official Bluetooth Body Composition Service or Weight Scale Service specification.
:::

## Finding Your Scale

The [setup wizard](/guide/configuration#setup-wizard-recommended) includes interactive scale discovery. It scans for nearby BLE devices, identifies supported scales, and writes the config for you. To scan without the wizard:

```bash
# Docker
docker run --rm --network host --cap-add NET_ADMIN --cap-add NET_RAW \
  ghcr.io/kristianp26/ble-scale-sync:latest scan

# Standalone (Node.js)
npm run scan
```

::: tip Set your scale's MAC address
We recommend setting `scale_mac` in `config.yaml`. It prevents the app from accidentally connecting to a neighbor's scale. The setup wizard does this automatically. If you skip it, the app falls back to auto-discovery by BLE advertisement name.
:::

## Known Limitations

| Scale                                                 | What to do                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Soehnle**, **Sanitas** SBF72/73, **Beurer** BF915   | Create user slot 1 in the manufacturer's phone app first                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **Standard GATT**                                     | Select user 1 on the scale before measuring                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **Senssun** Model B                                   | Not supported yet (only Model A with service 0xFFF0)                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **Koogeek** S1                                        | The measurement protocol is implemented and verified, but this hardware's GATT connect and service discovery are unreliable on BlueZ and on ESP32 NimBLE, and succeed only occasionally on macOS CoreBluetooth. That is a trait of the device rather than of the adapter. Retry, or use whichever transport works best for your unit                                                                                                                                              |
| **Renpho** R-MSC04 (MorphoScan Nova)                  | Weight is read and verified. The scale only computes and sends body composition after the vendor app's multi-frame init sequence, and that handshake is not decoded yet, so body composition is estimated from BMI (Deurenberg formula) rather than measured impedance. Tracked in [#117](https://github.com/KristianP26/ble-scale-sync/issues/117)                                                                                                                               |
| **Renpho ES-CS20M / Elis 1** (some hardware variants) | Some units use broadcast-only firmware that does not allow GATT connections. The same model name can ship with different internal hardware. If your ES-CS20M or Elis 1 is broadcast-only, ble-scale-sync reads weight directly from BLE advertisements. Body composition is estimated from BMI (Deurenberg formula) instead of impedance, since impedance is not available in broadcast mode. Run `npm run diagnose` to check whether your unit is connectable or broadcast-only. |

## Don't See Your Scale?

If your scale uses BLE but isn't listed, it might still work. The **Standard BT SIG** adapter catches any scale that follows the official Bluetooth specification. Run the [setup wizard](/guide/configuration#setup-wizard-recommended) or `npm run scan` to check.

Want to add support for a new scale? See [Contributing](https://github.com/KristianP26/ble-scale-sync/blob/main/CONTRIBUTING.md#adding-a-new-scale-adapter).
