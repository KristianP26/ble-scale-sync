---
title: Supported Scales
description: Every BLE smart scale brand and model supported by BLE Scale Sync.
head:
  - - meta
    - name: keywords
      content: koogeek scale, xiaomi mi scale, renpho scale bluetooth, eufy smart scale, yunmai scale, beurer bf scale, sanitas scale, medisana bs scale, silvercrest scale, 1byone scale, etekcity scale, inevifit scale, arboleaf scale, lepulse scale, fitdays scale, senssun scale, supported ble scales
---

# Supported Scales

**33 protocol adapters**, plus a Standard BT SIG catch-all for any spec-compliant scale. Most adapters cover several rebrands, so real coverage is wider than the count.

## Scale List

_Weight only_ means weight is reported normally but body composition is estimated from BMI. [Known Limitations](#known-limitations) says why, per scale. Most popular brands first.

| Brand / Models                                                        | Body composition | Notes                                               |
| --------------------------------------------------------------------- | ---------------- | --------------------------------------------------- |
| **Xiaomi** Mi Scale 2 (MIBCS / MIBFS / XMTZC05HM)                     | Yes              | No pairing needed; works on every transport         |
| **Xiaomi** Mi Smart Scale 2 (XMTZC04HM / MI SCALE2)                   | Weight only      | No pairing needed                                   |
| **Silvergear** Smart Scale 108                                        | Weight only      | Broadcast only; the display unit does not matter    |
| **Xiaomi** Mijia Body Composition Scale S800 (ms116)                  | Weight only      | Needs a per-device `ble.bind_key` from the Mi cloud |
| **Renpho** ES-CS20M / ES-32MD / Elis 1 / FITINDEX / Sencor (QN-Scale) | Yes              | The most common protocol; many rebrands             |
| **Renpho** ES-WBE28                                                   | Yes              | Standard GATT variant                               |
| **Renpho** ES-26BB-B                                                  | Yes              |                                                     |
| **Renpho** R-MSC04 (MorphoScan Nova)                                  | Weight only      |                                                     |
| **1byone** / **Eufy** C1 / P1                                         | Yes              |                                                     |
| **Eufy** Smart Scale P2 (T9148) / P2 Pro (T9149)                      | Weight only      |                                                     |
| **Yunmai** Signal / Mini / SE                                         | Yes              | The scale sends its own body composition            |
| **Beurer** BF700 / BF710 / BF800                                      | Yes              | BF710: register it in the Beurer app first          |
| **Salter** SA00656 / SA00432 (Salter Health)                          | Weight only      | Powers off after weighing; suits continuous mode    |
| **Sanitas** SBF70 / SBF75                                             | Yes              |                                                     |
| **Sanitas** SBF72 / SBF73 / **Beurer** BF915                          | Yes              | Needs user slot 1 in the vendor app                 |
| **Beurer** BF720 / BF105 / BF500 / BF788 / BF950                      | Yes              | Needs `users[].beurer_pin` and a bonded link        |
| **Soehnle** Shape200 / Shape100 / Shape50 / Style100                  | Yes              | Needs user slot 1 in the vendor app                 |
| **Medisana** BS430 / BS440 / BS444                                    | Yes              |                                                     |
| **Active Era** BS-06                                                  | Yes              |                                                     |
| **Senssun** Fat                                                       | Yes              | Model A only                                        |
| **MGB** (Swan / Icomon / YG)                                          | Yes              |                                                     |
| **Hutbit** 218008 / WL292                                             | Yes              | Also sold under stock `SWAN` branding               |
| **Robi** S9                                                           | Weight only      |                                                     |
| **Digoo** DG-SO38H (Mengii)                                           | Yes              |                                                     |
| **Excelvan** CF369                                                    | Yes              |                                                     |
| **Trisa** Body Analyze / **ADE** BA 1600 (fitvigo)                    | Yes              | The ADE BA 1600 variant is weight only              |
| **Hoffen** BS-8107                                                    | Yes              |                                                     |
| **Etekcity** ESF-551 Smart Fitness Scale                              | Yes              | Matched by its advertised name                      |
| **Hesley** (YunChen)                                                  | Yes              |                                                     |
| **Inlife** (FatScale)                                                 | Yes              |                                                     |
| **Koogeek** S1                                                        | Yes              | Connecting can be unreliable, see below             |
| **Exingtech** Y1 (vscale)                                             | Yes              |                                                     |
| Any **standard BT SIG** scale (BCS/WSS)                               | Yes              | Catch-all; select user 1 on the scale               |

## Finding Your Scale

The [setup wizard](/guide/configuration#setup-wizard-recommended) includes interactive scale discovery. It scans for nearby BLE devices, identifies supported scales, and writes the config for you. To scan without the wizard:

```bash
# Docker
docker run --rm --network host --cap-add NET_ADMIN --cap-add NET_RAW \
  ghcr.io/kristianp26/ble-scale-sync:latest scan

# Standalone (npm install or npx)
ble-scale-sync scan

# Standalone (from a clone)
npm run scan
```

::: tip Set your scale's MAC address
We recommend setting `scale_mac` in `config.yaml`. It prevents the app from accidentally connecting to a neighbor's scale. The setup wizard does this automatically. If you skip it, the app falls back to auto-discovery by BLE advertisement name.
:::

## Known Limitations

Everything below still works; these are the quirks worth knowing before you buy or debug.

### **Soehnle**, **Sanitas** SBF72/73, **Beurer** BF915

Create user slot 1 in the manufacturer's phone app first.

### **Standard GATT**

Select user 1 on the scale before measuring.

### **Senssun** Model B

Not supported yet (only Model A with service 0xFFF0).

### **Koogeek** S1

The measurement protocol is implemented and verified, but this hardware's GATT connect and service discovery are unreliable on BlueZ and on ESP32 NimBLE, and succeed only occasionally on macOS CoreBluetooth. That is a trait of the device rather than of the adapter. Retry, or use whichever transport works best for your unit.

### **Renpho** R-MSC04 (MorphoScan Nova)

Weight is read and verified. Body composition is estimated from BMI (Deurenberg formula) rather than measured impedance. The vendor handshake is documented but not yet implemented, and the scale also closes the link after its history sync, so a reconnect is needed before the live measurement arrives. Tracked in [#117](https://github.com/KristianP26/ble-scale-sync/issues/117).

### **Eufy** Smart Scale P2 / P2 Pro

Weight only. The bytes previously read as impedance are not a body resistance, so publishing them produced absurd body-composition figures ([#289](https://github.com/KristianP26/ble-scale-sync/issues/289)). Body composition is estimated from BMI (Deurenberg formula) instead. A raw FFF2 capture paired with the Eufy app's own body-fat figure would let the real field be decoded.

### **Xiaomi** Mi Smart Scale 2 (XMTZC04HM)

Weight only. The 0x181D advertisement carries no impedance, so body composition is estimated from BMI (Deurenberg formula).

### **Silvergear** Smart Scale 108

Weight only. The advertisement carries a second frame after each weigh-in whose field looks like a whole-body impedance (529 ohm for a 108.5 kg adult, 0 for an object), but one sample is not a decode, so body composition is estimated from BMI (Deurenberg formula). The frame is logged in debug mode; a body-fat figure from the vendor app for the same weigh-in would settle it ([#297](https://github.com/KristianP26/ble-scale-sync/issues/297)).

### **Renpho ES-CS20M / Elis 1** (some hardware variants)

Some units use broadcast-only firmware that does not allow GATT connections. The same model name can ship with different internal hardware. If your ES-CS20M or Elis 1 is broadcast-only, ble-scale-sync reads weight directly from BLE advertisements. Body composition is estimated from BMI (Deurenberg formula) instead of impedance, since impedance is not available in broadcast mode. Run `ble-scale-sync diagnose` (`npm run diagnose` from a clone) to check whether your unit is connectable or broadcast-only.

## Don't See Your Scale?

If your scale uses BLE but isn't listed, it might still work. The **Standard BT SIG** adapter catches any scale that follows the official Bluetooth specification. Run the [setup wizard](/guide/configuration#setup-wizard-recommended) or `ble-scale-sync scan` to check.

Want to add support for a new scale? See [Contributing](https://github.com/KristianP26/ble-scale-sync/blob/main/CONTRIBUTING.md#adding-a-new-scale-adapter).
