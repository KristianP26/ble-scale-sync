---
title: Supported Scales
description: Every BLE smart scale brand and model supported by BLE Scale Sync.
head:
  - - meta
    - name: keywords
      content: koogeek scale, xiaomi mi scale, renpho scale bluetooth, eufy smart scale, yunmai scale, beurer bf scale, sanitas scale, medisana bs scale, silvercrest scale, 1byone scale, etekcity scale, inevifit scale, arboleaf scale, lepulse scale, fitdays scale, senssun scale, grifema scale, okok scale, chipsea scale, etekcity fit 8s, eufy c20, eufy p3, picooc scale, picooc mini lite, a&d scale, uc-352ble, runstar scale, starfit scale, supported ble scales
---

# Supported Scales

**41 protocol adapters**, plus a Standard BT SIG catch-all for any spec-compliant scale. Most adapters cover several rebrands, so real coverage is wider than the count.

## Scale List

_Weight only_ means weight is reported normally but body composition is estimated from BMI. [Known Limitations](#known-limitations) says why, per scale. Most popular brands first.

| Brand / Models                                                                 | Body composition | Notes                                                                                                                                         |
| ------------------------------------------------------------------------------ | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| **Xiaomi** Mi Scale 2 (MIBCS / MIBFS / XMTZC05HM)                              | Yes              | No pairing needed; works on every transport                                                                                                   |
| **Xiaomi** Mi Smart Scale 2 (XMTZC04HM / MI SCALE2)                            | Weight only      | No pairing needed                                                                                                                             |
| **Silvergear** Smart Scale 108, INSMART (`AAA006`), Foryond FG263LB (`AAA002`) | Weight only      | Broadcast only; the display unit does not matter                                                                                              |
| **Grifema** GA2001 / **Senssun** IF_B7                                         | Weight only      | Broadcast only; kg or lb display                                                                                                              |
| **OKOK** (Chipsea broadcast): nameless, Yoda0 / Yoda1, `ADV`                   | Weight only      | Broadcast only; kg display only; a nameless unit needs `ble.scale_mac` on the default Linux transport                                         |
| **Etekcity** Fit 8S                                                            | Weight only      | Broadcast only; nameless, so it needs `ble.scale_mac` on the default Linux transport                                                          |
| **PICOOC** Mini Lite (`PICOOC-L`)                                              | Weight only      | Broadcast only; matched by its name                                                                                                           |
| **Xiaomi** Mijia Body Composition Scale S800 (ms116)                           | Weight only      | Needs a per-device `ble.bind_key` from the Mi cloud                                                                                           |
| **Xiaomi** Body Composition Scale S400 (MJTZC01YM)                             | Yes              | Needs a per-device `ble.bind_key` from the Mi cloud plus `ble.scale_mac`; weigh barefoot for impedance                                        |
| **Renpho** ES-CS20M / ES-32MD / Elis 1 / FITINDEX / Sencor (QN-Scale)          | Yes              | The most common protocol; many rebrands                                                                                                       |
| **Arboleaf** (QN-Scale, 19-byte dialect)                                       | Yes              | The scale's own values; needs `ble.qn_weight_ack` and `ble.qn_time_sync_long`, see below                                                      |
| **Renpho** ES-WBE28                                                            | Yes              | Standard GATT variant                                                                                                                         |
| **Renpho** ES-26BB-B                                                           | Yes              |                                                                                                                                               |
| **Renpho** R-MSC04 (MorphoScan Nova)                                           | Weight only      |                                                                                                                                               |
| **1byone** / **Eufy** C1 / P1                                                  | Yes              |                                                                                                                                               |
| **Eufy** Smart Scale P2 (T9148) / P2 Pro (T9149)                               | Yes              | Body composition over a connection; the broadcast gives weight only                                                                           |
| **Eufy** Smart Scale C20 (T9130) / P3 (T9150)                                  | Weight only      | Broadcast only; matched by its name or by its own address                                                                                     |
| **Yunmai** Signal / Mini / Mini 2                                              | Yes              | Impedance and, on newer firmware, the scale's own body fat; confirmed on hardware on a Mini 2, not yet on a Signal or Mini                    |
| **Yunmai** SE                                                                  | Weight only      | Reports no impedance                                                                                                                          |
| **Beurer** BF700 / BF710 / BF800                                               | Yes              | BF710: register it in the Beurer app first                                                                                                    |
| **Salter** SA00656 / SA00432 (Salter Health)                                   | Weight only      | Powers off after weighing; suits continuous mode                                                                                              |
| **Sanitas** SBF70 / SBF75                                                      | Yes              |                                                                                                                                               |
| **Sanitas** SBF72 / SBF73                                                      | Yes              | Needs user slot 1 in the vendor app                                                                                                           |
| **Beurer** BF720 / BF105 / BF500 / BF788 / BF915 / BF950                       | Yes              | Needs `users[].beurer_pin` and a bonded link                                                                                                  |
| **A&D** UC-352BLE                                                              | Weight only      | Not confirmed on hardware yet; Linux (BlueZ) only, needs `ble.scale_mac` and a one-time pairing, see below                                    |
| **Soehnle** Shape200 / Shape100 / Shape50 / Style100                           | Yes              | Needs user slot 1 in the vendor app                                                                                                           |
| **Medisana** BS430 / BS440 / BS444                                             | Yes              |                                                                                                                                               |
| **Active Era** BS-06 and other `AC 27` scales                                  | Yes              | Picked automatically when the scale advertises manufacturer id `0x27AC`; wake it before stepping on, see below. Confirmed on Runstar FG2431WB |
| **Senssun** Fat                                                                | Yes              | Model A only                                                                                                                                  |
| **MGB** (Swan / Icomon / YG)                                                   | Yes              |                                                                                                                                               |
| **Hutbit** 218008 / WL292                                                      | Yes              | Also sold under stock `SWAN` branding                                                                                                         |
| **Robi** S9                                                                    | Weight only      |                                                                                                                                               |
| **Speediance** Smart Scale FG2211WBF                                           | Yes              | Lefu/Icomon sibling of the Robi S9                                                                                                            |
| **Digoo** DG-SO38H (Mengii)                                                    | Yes              |                                                                                                                                               |
| **Excelvan** CF369                                                             | Yes              |                                                                                                                                               |
| **Trisa** Body Analyze / **ADE** BA 1600 (fitvigo)                             | Weight only      | The resistance it reports is not on an ohm scale, so body fat is estimated ([#386](https://github.com/KristianP26/ble-scale-sync/issues/386)) |
| **Hoffen** BS-8107                                                             | Yes              |                                                                                                                                               |
| **Etekcity** ESF-551 Smart Fitness Scale                                       | Yes              | Matched by its advertised name                                                                                                                |
| **Hesley** (YunChen)                                                           | Yes              |                                                                                                                                               |
| **Inlife** (FatScale)                                                          | Yes              |                                                                                                                                               |
| **Koogeek** S1                                                                 | Yes              | Connecting can be unreliable, see below                                                                                                       |
| **Exingtech** Y1 (vscale)                                                      | Yes              |                                                                                                                                               |
| Any **standard BT SIG** scale (BCS/WSS)                                        | Yes              | Catch-all; select user 1 on the scale                                                                                                         |

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

Weight is read and verified. Right after connecting, ble-scale-sync sets the scale's clock to the host's time and time zone and writes a guest profile, the same two writes an ESPHome client written for this scale sends. Before this change the scale was seen to drop every connection about 5.5 seconds after it was made, so a weigh-in that took longer to settle was lost and body composition never arrived ([#434](https://github.com/KristianP26/ble-scale-sync/issues/434)). The start command earlier versions sent is no longer sent. Time zones west of Greenwich are sent as UTC, because it is not known how the scale encodes them.

The guest profile holds the **first configured user's** height and last known weight: `last_known_weight`, otherwise the middle of `weight_range` when that range lies between 20 and 250 kg and spans no more than 100 kg, otherwise 70 kg. It is written on every weigh-in, also in multi-user setups, whoever steps on. It uses the profile slot that ESPHome client uses, not the slot of a user registered in the Renpho app. ble-scale-sync never writes this profile to its log. With the [ESP32 proxy](/guide/esp32-proxy), the frame passes through your MQTT broker unencrypted like every other frame.

The scale measures body composition after the weight settles and sends it about 15 seconds later, so the connection stays open for up to 30 seconds after the weight settles: stay on the scale until its display shows the results. If the connection is only made after the weight has settled, the scale does not send the settled weight again. The weigh-in is then taken from those results, with the weight they carry, as long as the scale was not holding weigh-ins it had not delivered yet; if it was, open the Renpho app once to sync them. Without the results such a weigh-in is not recorded. The scale's body fat and visceral fat are logged but not used yet. They are most likely computed for the guest profile, and one byte of it, probably sex and age, is not decoded, so they may not fit you. Body composition is estimated from BMI (Deurenberg formula) instead. The scale's own display may show results for the guest profile. The ten segment impedances are logged in debug mode only, and no whole-body impedance is derived from them. An owner's log shows the connection now staying up through the measurement and the results arriving. A weigh-in taken from those results, with or without the settled weight, is not confirmed on hardware yet ([#434](https://github.com/KristianP26/ble-scale-sync/issues/434)).

### **Arboleaf** (QN-Scale, 19-byte dialect)

These units log `QN: scale info (19B, dialect=es26m)` in debug mode. Two of them have streamed their weight with `ble.qn_weight_ack: true` and `ble.qn_time_sync_long: true`; whether they need both is not known yet, so set both (see [Configuration](/guide/configuration#ble)). After the weight settles the scale measures body composition for about 14 seconds more and then sends its results, so the connection stays open until the scale's last result frame: stay on the scale until its display shows the results. If that frame never comes, the weight is sent on its own 40 seconds after it settled.

The scale computes body fat, water, muscle, bone and visceral fat itself, for the profile ble-scale-sync sends it before the weigh-in: the first user's age, height and sex. Those values are exported when the weigh-in is matched to a user with exactly that profile and the scale measured after it accepted the profile; a weight that had already settled then counts when the scale finishes measuring at least 3 seconds later. Otherwise body composition is estimated from BMI (Deurenberg formula), and the log says why. This assumes the first user in your config is also the first user in the vendor app, with the same age, height and sex there, because the scale keeps data of its own for that user. The scale shows muscle and bone as a percentage of body weight; they are exported in kg, the way the vendor's published SDK converts them. A weigh-in where the scale measures no body composition (its display then shows only the weight; one reporter saw this with dry feet) gets the estimate, so the source of the numbers can change from one weigh-in to the next. The scale has no athlete mode, so an athlete gets the scale's values as they are. The segment impedances it also sends are logged in debug mode only.

Weigh-ins the scale kept while nothing was connected are read on the next connection and exported with the time they were taken, to the exporters that can record a past measurement (see [Exporters](/exporters)); MQTT and Home Assistant show only live weigh-ins. One taken in the last five minutes counts as a current weigh-in: if the same connection also brings a live weigh-in, that one is exported in its place, and the log names the stored one with its weight and time. Only their weight is used: which profile the scale computed their body composition with is not in the record. A stored weigh-in the scale did not assign to a user is logged and not exported.

Keep `ble.qn_a4_prelude` off. Per the vendor's published SDK, those frames overwrite data the scale keeps for its first user with values from someone else's capture, and in a session that sends them the scale's own values are not used.

Only a scale set to display kg has been logged so far. Confirmed on two units: the body fat, water and visceral fat exported match the scale's display ([#331](https://github.com/KristianP26/ble-scale-sync/issues/331)).

### **Eufy** Smart Scale P2 / P2 Pro

Over a connection, the scale's impedance is read and body fat is computed from it with the generic BIA formula. That formula is not Eufy's: on the weigh-in it was checked against, it gave about 3 points more body fat than the Eufy app ([#289](https://github.com/KristianP26/ble-scale-sync/issues/289)). A weigh-in without impedance (socks or shoes on) gets the BMI estimate (Deurenberg formula).

A scale read from its broadcast, without a connection, gives weight only: the broadcast carries no impedance.

### **Eufy** Smart Scale C20 / P3

Weight only. The C20 (T9130) and P3 (T9150) broadcast their weigh-in; ble-scale-sync reads it from the broadcast and does not connect.

- **Name or address.** The scale sends its name only in the scan response, which a scan does not always get. Without the name it is recognised by its own Bluetooth address, which it repeats inside the broadcast, so on macOS, which does not expose addresses, it is found only when the name arrives.
- **When it is sent.** The weight is sent as soon as the scale locks it. The scale's clock dates the weigh-in when it agrees with this host within two minutes; otherwise the time it was received is used.
- **Read as kg.** The weight is read as kg, as in every weigh-in seen so far; none is known to have been taken with the display on lb or st. If yours shows lb or st, compare the first export with the display and report it on [#408](https://github.com/KristianP26/ble-scale-sync/issues/408).
- **No impedance.** The broadcast also carries a field that looks like impedance and a heart rate, but neither has been compared with the Eufy app for the same weigh-in, so body composition is estimated from BMI (Deurenberg formula) and both are logged in debug mode.
- **Home Assistant Bluetooth.** A P3 changes its manufacturer id while weighing, so over [Home Assistant Bluetooth](/guide/ha-bluetooth) it needs a scanner that forwards raw advertisements.

### **Yunmai**

Most Yunmai scales are found by their name. A Mini 2 (M1690) that advertises no name, only Xiaomi service data, is found by the Xiaomi product id in that data, so it does not need `ble.force_scale_adapter`. Without a name it is not picked up on its own on the default Linux transport, so set `ble.scale_mac` there (`scan` lists it with its address).

The body fat the scale sends is computed by the scale for a profile the vendor app stored in it, normally the person it recognised. ble-scale-sync does not write a profile to the scale, so in a household with several users the value can belong to the profile the scale picked rather than to the person matched by weight. The Yunmai SE reports no impedance, so its body composition is estimated from BMI.

### **Xiaomi** Mi Smart Scale 2 (XMTZC04HM)

Weight only. The 0x181D advertisement carries no impedance, so body composition is estimated from BMI (Deurenberg formula).

### **Xiaomi** Body Composition Scale S400 (MJTZC01YM)

The scale broadcasts its measurement as an encrypted MiBeacon frame, so it needs the per-device `ble.bind_key` from the Mi cloud (extract it with the community Xiaomi-cloud-tokens-extractor after pairing the scale in the Mi Home app) and `ble.scale_mac`: the measurement frames omit the MAC the decryption nonce needs, and the MAC is otherwise only learned from the idle beacon. Register a user profile in Mi Home (the scale tags each reading with a profile slot) and keep the Mi Home app closed while weighing, or the phone takes the session and nothing is broadcast. Weigh barefoot: with socks the scale sends weight only and body composition is estimated from BMI (Deurenberg formula). The scale measures impedance at 50 kHz and 250 kHz and a heart rate; the 50 kHz value feeds the Xiaomi body-composition formulas shared with the Mi Scale 2 (the app's own dual-frequency model is proprietary, so expect small offsets, see [Body Composition](/body-composition)), the other two are logged only. It is a "sleepy" device that advertises only while someone stands on it, so run `scan` while you are on the scale.

### **Silvergear** Smart Scale 108

Also the INSMART body composition scale, which advertises as `AAA006` ([#467](https://github.com/KristianP26/ble-scale-sync/pull/467)), and the Foryond FG263LB, which advertises as `AAA002` ([#408](https://github.com/KristianP26/ble-scale-sync/issues/408)). Both use the same broadcast format.

Weight only. The advertisement carries a second frame after each weigh-in whose field looks like a whole-body impedance (529 ohm for a 108.5 kg adult, 0 for an object), but one sample is not a decode, so body composition is estimated from BMI (Deurenberg formula). The frame is logged in debug mode; a body-fat figure from the vendor app for the same weigh-in would settle it ([#297](https://github.com/KristianP26/ble-scale-sync/issues/297)).

The reading waits for that frame before it is sent, so it arrives about two seconds after the display settles rather than at once. If the frame does not come, the weight is sent on its own at most 12 seconds later, even when a scan times out in the meantime: the scan keeps listening until that wait is over rather than dropping the weigh-in. If someone steps off within about eight seconds of the display settling and before the frame arrives, their weight is sent at once, so a second weigh-in right after cannot replace it; a later step-off leaves the weight to the 12 second wait. Shifting your weight while standing on the scale is not a step-off ([#357](https://github.com/KristianP26/ble-scale-sync/issues/357)).

### **Grifema** GA2001 / **Senssun** IF_B7

Weight only. The scale advertises as `IF_B7` and broadcasts its weigh-in without accepting a connection. It sends the weight in kilograms whether its display is set to kg or lb (the lb case rests on a single weigh-in so far); any other display unit is ignored with a warning in the log. Its final frame carries a field that looks like impedance, but one weigh-in with a body-fat figure from the vendor app is not enough to decode it, so body composition is estimated from BMI (Deurenberg formula) and the field is logged in debug mode. More weigh-ins paired with the app's body-fat reading would settle it ([#423](https://github.com/KristianP26/ble-scale-sync/issues/423)).

### **OKOK** app scales (Chipsea broadcast)

Weight only. These Chipsea-based scales, sold under many names with the OKOK app (for example NIX Home, Xiaogui TZC4, MaxxMee QJ-J and BL-26L01), broadcast their weigh-in without accepting a connection, in one of two formats: one advertised as `ADV`, and one without a name, or named `Yoda0` / `Yoda1`.

- **Nameless units** are recognised because they repeat their own Bluetooth address inside the broadcast, so the transport must report addresses. On the default Linux transport set `ble.scale_mac` (`scan` and the setup wizard list nameless scales with their address). macOS does not expose addresses, so there only units named `Yoda0`, `Yoda1` or `ADV` work.
- **Keep the scale on kg.** Other display units and precisions are not decoded: a reading the scale marks that way is ignored with a warning in the log.
- **No impedance.** The broadcast carries a field other tools show as impedance, but it holds the same value on every unit captured so far, so body composition is estimated from BMI (Deurenberg formula) and the field is logged in debug mode.
- Scales advertising as `Chipsea-BLE` use other formats that are not supported yet ([#408](https://github.com/KristianP26/ble-scale-sync/issues/408)).

### **Etekcity** Fit 8S

Weight only. The Fit 8S broadcasts its weigh-in without a name and without accepting a connection.

- **No name.** It is recognised by its own Bluetooth address, which it repeats inside the broadcast. On the default Linux transport set `ble.scale_mac` (`scan` and the setup wizard list nameless scales with their address). macOS does not expose addresses, so there it is recognised by the service 0xFFD0 it advertises and the shape of its broadcast.
- **Any display unit.** The weight is read the same whether the scale shows kg, lb or st, as its owners report; no lb or st weigh-in has been captured yet.
- **Stay on the scale.** The result is sent when the scale has finished measuring, about two seconds after the weight settles.
- **No impedance.** The broadcast carries a field that looks like impedance, but it has not been compared with the body fat the VeSync app shows for the same weigh-in, so body composition is estimated from BMI (Deurenberg formula) and the field is logged in debug mode ([#408](https://github.com/KristianP26/ble-scale-sync/issues/408)).

### **PICOOC** Mini Lite

Weight only. The Mini Lite advertises as `PICOOC-L` and broadcasts each finished weigh-in for about seven seconds without accepting a connection; ble-scale-sync reads it from the broadcast.

- **Matched by its name**, which is in every broadcast, so it needs no `ble.scale_mac` and works on macOS too. It is silent between weigh-ins, so to find it with `scan` or the setup wizard, step on the scale while the scan runs.
- **Only the format seen so far.** The PICOOC app knows other broadcast formats under the same name. A frame in one of them is ignored with a warning in the log rather than read wrongly; please report it on [#408](https://github.com/KristianP26/ble-scale-sync/issues/408).
- **Read as kg**, after checking it against the pound value the scale sends alongside. Every weigh-in seen so far was taken with the display on kg; if yours shows lb or jin, compare the first export with the display, or if nothing is exported, look for the warning in the log, and report it on #408.
- **The same result twice.** The broadcast has no counter, so a result with the same weight (to 50 g) heard again within a minute of the last time it was heard counts as the same weigh-in.
- **No impedance.** The broadcast carries a field that looks like impedance, but the PICOOC app computes body fat from it with a calibration it learns per person, and nobody has compared our formula with it, so body composition is estimated from BMI (Deurenberg formula) and the field is logged in debug mode.

Other PICOOC scales, including the older PICOOC Mini, connect over Bluetooth (names such as `PICOOC-CQ` or `PICOOC-CC`) and are not supported yet ([#408](https://github.com/KristianP26/ble-scale-sync/issues/408)).

### **A&D** UC-352BLE

Weight only: the scale measures no impedance, so body composition is estimated from BMI (Deurenberg formula). It is a standard Bluetooth weight scale that sends its weigh-ins only to the device it is paired with. The A&D app sets the scale's clock before it asks for the weigh-in, and ble-scale-sync does the same.

- **Linux only, with `ble.scale_mac`.** Pairing works on the default Linux transport (BlueZ). The scale keeps a single pairing, so pairing it with ble-scale-sync unpairs the A&D app. That is why the default Linux transport never picks it on its own: set `ble.scale_mac` to its address (`npm run scan` lists it) to use it. [Home Assistant Bluetooth](/guide/ha-bluetooth), the [ESPHome proxy](/guide/esphome-proxy) and the [ESP32 proxy](/guide/esp32-proxy) are not supported for it.
- **Pairing, once.** With ble-scale-sync running, switch the scale off, then hold SET until its display shows `Pr`. The first connection pairs it and probably ends without a reading; weigh in again after that. If it does not pair, pair it by hand: `bluetoothctl`, then `agent on`, `default-agent`, `scan on`, `pair <MAC>`, `trust <MAC>`, with the scale showing `Pr`.
- **Clock.** ble-scale-sync sets the scale's clock on every connection, as the A&D app does, to the host's local time. In Docker set `TZ`, or the scale's clock shows UTC.
- **Stored weigh-ins.** Per its manual the scale keeps up to 90 weigh-ins while nothing is connected and sends them on the next connection. ble-scale-sync takes the time each one is stamped with: a weigh-in stamped more than five minutes ago goes only to the exporters that can record a past measurement (see [Exporters](/exporters)). Which time the scale stamps a stored weigh-in with has not been seen in a capture yet.

None of this is confirmed on hardware yet ([#408](https://github.com/KristianP26/ble-scale-sync/issues/408)): it rests on a public capture of the A&D app. If you own one, a log with `debug: true` of the pairing and of the first two weigh-ins would confirm it.

### **Active Era** BS-06 and other `AC 27` scales

Several brands sold with the FitDays, Starfit or Femmto apps use the protocol of the Active Era BS-06: service 0xFFB0 and 20-byte frames starting with `AC 27`. All of them are read by the adapter named `Active Era BS-06`.

- **Detection.** A scale that advertises manufacturer id `0x27AC` is picked automatically, ahead of the MGB adapter. A unit that does not is still taken by the MGB adapter, which cannot read it; the log then says so. Set `ble.force_scale_adapter: 'Active Era BS-06'` and `ble.scale_mac` for it, and please report its `Advert:` line from a log with `debug: true`.
- **Profile on the scale.** Right after connecting, ble-scale-sync writes the current time and the **first configured user's** height, age and sex to the scale, the way the vendor app does, plus the unit from `scale.display_unit`. Without that profile some of these scales never lock their weight and send no impedance. It goes to the scale's main user, so the scale's own display shows its results for that user, also in multi-user setups, whoever steps on.
- **Wake the scale first.** Switch it on, wait for the Bluetooth icon on its display, then step on. A weigh-in that locks before the connection is up is kept by the scale as a stored record. Stored records are not imported and not acknowledged, so the vendor app still receives them.
- **When the reading is sent.** After the scale locks the weight, the connection stays open for the impedance; some units first measure your balance and send it up to about 18 seconds later. A unit that never locks its weight is read once the weight has held still for a second, and the weight is sent 8 seconds later if no impedance follows.
- **Body composition.** Units that name the vendor's algorithm 7 or 0x24 in their result get the vendor's own formula, ported from openScale; on the two units it was checked against it matches the display or the app (body fat, water, bone). Other units, and weigh-ins without impedance, get the BMI estimate (Deurenberg formula). Heart rate and the balance measurement are logged only.

The handshake and the automatic detection rest on vendor-app captures of one model (shared in openScale PR #1534) and on frames posted in [#458](https://github.com/KristianP26/ble-scale-sync/issues/458), [#462](https://github.com/KristianP26/ble-scale-sync/issues/462) and [#466](https://github.com/KristianP26/ble-scale-sync/issues/466). Confirmed with ble-scale-sync 1.33.0 on a Runstar FG2431WB (Starfit app) in [#466](https://github.com/KristianP26/ble-scale-sync/issues/466): the scale locks its weight once the profile is written, sends the impedance and the reading is exported. The other models are not confirmed yet.

### **Renpho ES-CS20M / Elis 1** (some hardware variants)

Some units use broadcast-only firmware that does not allow GATT connections. The same model name can ship with different internal hardware. If your ES-CS20M or Elis 1 is broadcast-only, ble-scale-sync reads weight directly from BLE advertisements. Body composition is estimated from BMI (Deurenberg formula) instead of impedance, since impedance is not available in broadcast mode. Run `ble-scale-sync diagnose` (`npm run diagnose` from a clone) to check whether your unit is connectable or broadcast-only.

### **Renpho ES-CS20M** on service 0x1A10 with AE01/AE02

Newer ES-CS20M revisions (for example HVIN `ESCS20MB2`) use Renpho's own protocol on service 0x1A10 instead of QN. Some of them also expose the characteristics AE01 and AE02. One such unit sent no weight to ble-scale-sync, while the Renpho app, which sends the commands below, received weights from it ([#436](https://github.com/KristianP26/ble-scale-sync/issues/436)). On such a unit, every time the scale switches on during a connection, ble-scale-sync sets the scale's clock to the host's time and time zone, writes a guest profile, and tells the scale to keep the display unit it already shows.

The guest profile holds the **first configured user's** sex, birth date, height and last known weight. That weight is `last_known_weight`; when that is not set, the middle of `weight_range`, as long as the range lies between 20 and 250 kg and spans no more than 100 kg; otherwise 70 kg. It is written on every weigh-in, also in multi-user setups, whoever steps on. The scale uses it for that weigh-in only: it goes to the guest slot, which the scale does not keep as a user, so profiles saved by the Renpho app are left alone. ble-scale-sync never writes the profile it sends to its log, but with debug logging on it logs every frame the scale sends back raw, including the reply to the profile and the weigh-in itself. With the [ESP32 proxy](/guide/esp32-proxy), that frame passes through your MQTT broker unencrypted like every other frame (TLS, when enabled, protects only the links to the broker), so anyone who can read the proxy's topics can read it.

After a weigh-in such a unit sends its own result: the weight, the resistance it measured (0 in socks), and a BMI and body fat it computed from the guest profile. ble-scale-sync takes the weight and the resistance from it, keeps the connection until the scale switches off as the Renpho app does (at most 30 seconds after the result), and computes body composition from the resistance and the profile of the user the weigh-in is matched to. The scale's own BMI and body fat are not used: they come from the first user's profile, whoever stepped on.

Units without AE01/AE02 get only the kg display command, as before. The AE01/AE02 sequence is confirmed on one unit ([#436](https://github.com/KristianP26/ble-scale-sync/issues/436)).

## Don't See Your Scale?

If your scale uses BLE but isn't listed, it might still work. The **Standard BT SIG** adapter catches any scale that follows the official Bluetooth specification. Run the [setup wizard](/guide/configuration#setup-wizard-recommended) or `ble-scale-sync scan` to check.

Want to add support for a new scale? See [Contributing](https://github.com/KristianP26/ble-scale-sync/blob/main/CONTRIBUTING.md#adding-a-new-scale-adapter).
