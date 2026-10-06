---
title: Supported Scales
description: Every BLE smart scale brand and model supported by BLE Scale Sync.
head:
  - - meta
    - name: keywords
      content: koogeek scale, xiaomi mi scale, renpho scale bluetooth, eufy smart scale, yunmai scale, beurer bf scale, sanitas scale, medisana bs scale, silvercrest scale, 1byone scale, etekcity scale, inevifit scale, arboleaf scale, lepulse scale, fitdays scale, senssun scale, grifema scale, supported ble scales
---

# Supported Scales

**36 protocol adapters**, plus a Standard BT SIG catch-all for any spec-compliant scale. Most adapters cover several rebrands, so real coverage is wider than the count.

## Scale List

_Weight only_ means weight is reported normally but body composition is estimated from BMI. [Known Limitations](#known-limitations) says why, per scale. Most popular brands first.

| Brand / Models                                                        | Body composition | Notes                                                                                                                                             |
| --------------------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Xiaomi** Mi Scale 2 (MIBCS / MIBFS / XMTZC05HM)                     | Yes              | No pairing needed; works on every transport                                                                                                       |
| **Xiaomi** Mi Smart Scale 2 (XMTZC04HM / MI SCALE2)                   | Weight only      | No pairing needed                                                                                                                                 |
| **Silvergear** Smart Scale 108                                        | Weight only      | Broadcast only; the display unit does not matter                                                                                                  |
| **Grifema** GA2001 / **Senssun** IF_B7                                | Weight only      | Broadcast only; kg or lb display                                                                                                                  |
| **Xiaomi** Mijia Body Composition Scale S800 (ms116)                  | Weight only      | Needs a per-device `ble.bind_key` from the Mi cloud                                                                                               |
| **Xiaomi** Body Composition Scale S400 (MJTZC01YM)                    | Yes              | Needs a per-device `ble.bind_key` from the Mi cloud plus `ble.scale_mac`; weigh barefoot for impedance                                            |
| **Renpho** ES-CS20M / ES-32MD / Elis 1 / FITINDEX / Sencor (QN-Scale) | Yes              | The most common protocol; many rebrands                                                                                                           |
| **Arboleaf** (QN-Scale, 19-byte dialect)                              | Weight only      | Same QN protocol; needs `ble.qn_weight_ack` and `ble.qn_time_sync_long`, see below                                                                |
| **Renpho** ES-WBE28                                                   | Yes              | Standard GATT variant                                                                                                                             |
| **Renpho** ES-26BB-B                                                  | Yes              |                                                                                                                                                   |
| **Renpho** R-MSC04 (MorphoScan Nova)                                  | Weight only      |                                                                                                                                                   |
| **1byone** / **Eufy** C1 / P1                                         | Yes              |                                                                                                                                                   |
| **Eufy** Smart Scale P2 (T9148) / P2 Pro (T9149)                      | Weight only      |                                                                                                                                                   |
| **Yunmai** Signal / Mini / SE                                         | Yes              | The scale sends its own body composition                                                                                                          |
| **Beurer** BF700 / BF710 / BF800                                      | Yes              | BF710: register it in the Beurer app first                                                                                                        |
| **Salter** SA00656 / SA00432 (Salter Health)                          | Weight only      | Powers off after weighing; suits continuous mode                                                                                                  |
| **Sanitas** SBF70 / SBF75                                             | Yes              |                                                                                                                                                   |
| **Sanitas** SBF72 / SBF73                                             | Yes              | Needs user slot 1 in the vendor app                                                                                                               |
| **Beurer** BF720 / BF105 / BF500 / BF788 / BF915 / BF950              | Yes              | Needs `users[].beurer_pin` and a bonded link                                                                                                      |
| **Soehnle** Shape200 / Shape100 / Shape50 / Style100                  | Yes              | Needs user slot 1 in the vendor app                                                                                                               |
| **Medisana** BS430 / BS440 / BS444                                    | Yes              |                                                                                                                                                   |
| **Active Era** BS-06                                                  | Weight only      | Reports a resistance, but its scaling has never been checked against a capture ([#386](https://github.com/KristianP26/ble-scale-sync/issues/386)) |
| **Senssun** Fat                                                       | Yes              | Model A only                                                                                                                                      |
| **MGB** (Swan / Icomon / YG)                                          | Yes              |                                                                                                                                                   |
| **Hutbit** 218008 / WL292                                             | Yes              | Also sold under stock `SWAN` branding                                                                                                             |
| **Robi** S9                                                           | Weight only      |                                                                                                                                                   |
| **Speediance** Smart Scale FG2211WBF                                  | Yes              | Lefu/Icomon sibling of the Robi S9                                                                                                                |
| **Digoo** DG-SO38H (Mengii)                                           | Yes              |                                                                                                                                                   |
| **Excelvan** CF369                                                    | Yes              |                                                                                                                                                   |
| **Trisa** Body Analyze / **ADE** BA 1600 (fitvigo)                    | Weight only      | The resistance it reports is not on an ohm scale, so body fat is estimated ([#386](https://github.com/KristianP26/ble-scale-sync/issues/386))     |
| **Hoffen** BS-8107                                                    | Yes              |                                                                                                                                                   |
| **Etekcity** ESF-551 Smart Fitness Scale                              | Yes              | Matched by its advertised name                                                                                                                    |
| **Hesley** (YunChen)                                                  | Yes              |                                                                                                                                                   |
| **Inlife** (FatScale)                                                 | Yes              |                                                                                                                                                   |
| **Koogeek** S1                                                        | Yes              | Connecting can be unreliable, see below                                                                                                           |
| **Exingtech** Y1 (vscale)                                             | Yes              |                                                                                                                                                   |
| Any **standard BT SIG** scale (BCS/WSS)                               | Yes              | Catch-all; select user 1 on the scale                                                                                                             |

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

### **Soehnle**, **Sanitas** SBF72/73

Create user slot 1 in the manufacturer's phone app first.

### **Standard GATT**

Select user 1 on the scale before measuring.

### **Senssun** Model B

Not supported yet (only Model A with service 0xFFF0).

### **Koogeek** S1

The measurement protocol is implemented and verified, but this hardware's GATT connect and service discovery are unreliable on BlueZ and on ESP32 NimBLE, and succeed only occasionally on macOS CoreBluetooth. That is a trait of the device rather than of the adapter. Retry, or use whichever transport works best for your unit.

### **Renpho** R-MSC04 (MorphoScan Nova)

Weight is read and verified. The scale measures body composition after the weight settles and sends it about 15 seconds later, so the connection stays open for up to 30 seconds after the weight settles: stay on the scale until its display shows the results. When the scale's record arrives, its body fat and visceral fat are used, but only if the height implied by the BMI the scale reports is within 3 cm of yours (the scale most likely uses the profile last written to it by the Renpho app, which may be another household member's); otherwise, or when no record arrives in time, body composition is estimated from BMI (Deurenberg formula). The ten segment impedances the scale reports are logged in debug mode only, and no whole-body impedance is derived from them. This is not yet confirmed on hardware ([#434](https://github.com/KristianP26/ble-scale-sync/issues/434)).

### **Arboleaf** (QN-Scale, 19-byte dialect)

These units log `QN: scale info (19B, dialect=es26m)` in debug mode. One of them has streamed its weight with `ble.qn_weight_ack: true` and `ble.qn_time_sync_long: true`; whether it needs both is not known yet, so set both (see [Configuration](/guide/configuration#ble)). After the weight settles the scale measures body composition for about 14 seconds more and then sends its results, so the connection stays open until the scale's last result frame: stay on the scale until its display shows the results. If that frame never comes, the weight is sent on its own 40 seconds after it settled. The scale's own body-composition values and the result block it sends (likely segment impedances) are not decoded, so body composition is estimated from BMI (Deurenberg formula). Only a scale set to display kg has been logged so far. With lb or st the weight frame may differ; if the log then warns about the weight frame, please attach a DEBUG log to the issue. The decode rests on a single logged weigh-in and is not yet confirmed on hardware ([#331](https://github.com/KristianP26/ble-scale-sync/issues/331)).

### **Eufy** Smart Scale P2 / P2 Pro

Weight only. The bytes previously read as impedance are not a body resistance, so publishing them produced absurd body-composition figures ([#289](https://github.com/KristianP26/ble-scale-sync/issues/289)). Body composition is estimated from BMI (Deurenberg formula) instead. A raw FFF2 capture paired with the Eufy app's own body-fat figure would let the real field be decoded.

### **Xiaomi** Mi Smart Scale 2 (XMTZC04HM)

Weight only. The 0x181D advertisement carries no impedance, so body composition is estimated from BMI (Deurenberg formula).

### **Xiaomi** Body Composition Scale S400 (MJTZC01YM)

The scale broadcasts its measurement as an encrypted MiBeacon frame, so it needs the per-device `ble.bind_key` from the Mi cloud (extract it with the community Xiaomi-cloud-tokens-extractor after pairing the scale in the Mi Home app) and `ble.scale_mac`: the measurement frames omit the MAC the decryption nonce needs, and the MAC is otherwise only learned from the idle beacon. Register a user profile in Mi Home (the scale tags each reading with a profile slot) and keep the Mi Home app closed while weighing, or the phone takes the session and nothing is broadcast. Weigh barefoot: with socks the scale sends weight only and body composition is estimated from BMI (Deurenberg formula). The scale measures impedance at 50 kHz and 250 kHz and a heart rate; the 50 kHz value feeds the Xiaomi body-composition formulas shared with the Mi Scale 2 (the app's own dual-frequency model is proprietary, so expect small offsets, see [Body Composition](/body-composition)), the other two are logged only. It is a "sleepy" device that advertises only while someone stands on it, so run `scan` while you are on the scale.

### **Silvergear** Smart Scale 108

Weight only. The advertisement carries a second frame after each weigh-in whose field looks like a whole-body impedance (529 ohm for a 108.5 kg adult, 0 for an object), but one sample is not a decode, so body composition is estimated from BMI (Deurenberg formula). The frame is logged in debug mode; a body-fat figure from the vendor app for the same weigh-in would settle it ([#297](https://github.com/KristianP26/ble-scale-sync/issues/297)).

The reading waits for that frame before it is sent, so it arrives about two seconds after the display settles rather than at once. If the frame does not come, the weight is sent on its own at most 12 seconds later, even when a scan times out in the meantime: the scan keeps listening until that wait is over rather than dropping the weigh-in. If someone steps off within about eight seconds of the display settling and before the frame arrives, their weight is sent at once, so a second weigh-in right after cannot replace it; a later step-off leaves the weight to the 12 second wait. Shifting your weight while standing on the scale is not a step-off ([#357](https://github.com/KristianP26/ble-scale-sync/issues/357)).

### **Grifema** GA2001 / **Senssun** IF_B7

Weight only. The scale advertises as `IF_B7` and broadcasts its weigh-in without accepting a connection. It sends the weight in kilograms whether its display is set to kg or lb (the lb case rests on a single weigh-in so far); any other display unit is ignored with a warning in the log. Its final frame carries a field that looks like impedance, but one weigh-in with a body-fat figure from the vendor app is not enough to decode it, so body composition is estimated from BMI (Deurenberg formula) and the field is logged in debug mode. More weigh-ins paired with the app's body-fat reading would settle it ([#423](https://github.com/KristianP26/ble-scale-sync/issues/423)).

### **Renpho ES-CS20M / Elis 1** (some hardware variants)

Some units use broadcast-only firmware that does not allow GATT connections. The same model name can ship with different internal hardware. If your ES-CS20M or Elis 1 is broadcast-only, ble-scale-sync reads weight directly from BLE advertisements. Body composition is estimated from BMI (Deurenberg formula) instead of impedance, since impedance is not available in broadcast mode. Run `ble-scale-sync diagnose` (`npm run diagnose` from a clone) to check whether your unit is connectable or broadcast-only.

### **Renpho ES-CS20M** on service 0x1A10 with AE01/AE02

Newer ES-CS20M revisions (for example HVIN `ESCS20MB2`) use Renpho's own protocol on service 0x1A10 instead of QN. Some of them also expose the characteristics AE01 and AE02. One such unit sent no weight to ble-scale-sync, while the Renpho app, which sends the commands below, received weights from it ([#436](https://github.com/KristianP26/ble-scale-sync/issues/436)). On such a unit, every time the scale switches on during a connection, ble-scale-sync sets the scale's clock to the host's time and time zone, writes a guest profile, and tells the scale to keep the display unit it already shows.

The guest profile holds the **first configured user's** sex, birth date, height and last known weight. That weight is `last_known_weight`; when that is not set, the middle of `weight_range`, as long as the range lies between 20 and 250 kg and spans no more than 100 kg; otherwise 70 kg. It is written on every weigh-in, also in multi-user setups, whoever steps on. The scale uses it for that weigh-in only: it goes to the guest slot, which the scale does not keep as a user, so profiles saved by the Renpho app are left alone. ble-scale-sync never writes the profile it sends to its log, but with debug logging on it logs every frame the scale sends back raw, including the reply to the profile and the weigh-in itself. With the [ESP32 proxy](/guide/esp32-proxy), that frame passes through your MQTT broker unencrypted like every other frame (TLS, when enabled, protects only the links to the broker), so anyone who can read the proxy's topics can read it.

Units without AE01/AE02 get only the kg display command, as before. The AE01/AE02 behaviour is not yet confirmed on hardware.

## Don't See Your Scale?

If your scale uses BLE but isn't listed, it might still work. The **Standard BT SIG** adapter catches any scale that follows the official Bluetooth specification. Run the [setup wizard](/guide/configuration#setup-wizard-recommended) or `ble-scale-sync scan` to check.

Want to add support for a new scale? See [Contributing](https://github.com/KristianP26/ble-scale-sync/blob/main/CONTRIBUTING.md#adding-a-new-scale-adapter).
