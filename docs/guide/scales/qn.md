---
title: QN scales
description: Setup, the ble.qn_* options and their order, and fixes for QN-protocol scales from Renpho, Arboleaf, FITINDEX, GE and their rebadges.
---

# QN scales

The QN protocol runs on many Renpho, Arboleaf, FITINDEX, GE and Sencor scales and their rebadges. Most work without any option. The `ble.qn_*` options adjust the handshake for firmware that expects it differently.

## Supported models

- Renpho ES-CS20M, ES-32MD, Elis 1, and FITINDEX and Sencor rebadges.
- Arboleaf scales with eight electrodes (19-byte dialect).
- Arboleaf CS10K with eight electrodes (Experimental). It sends a 20-byte scale-info frame and weighs in like the 19-byte dialect.
- GE CS 10 G ("Fit Plus") and rebadges (20-byte extended dialect).
- Arboleaf CS10E and CS10G with eight electrodes (20-byte extended dialect).

Some ES-CS20M and Elis 1 units never accept a connection. ble-scale-sync then reads the weight from the broadcast and estimates body composition from BMI, because the broadcast carries no impedance. To see whether a unit is connectable, run `ble-scale-sync diagnose <MAC>` (`npm run diagnose -- <MAC>` from a clone).

Newer ES-CS20M revisions on service 0x1A10 use Renpho's own protocol. See [Renpho scales](./renpho).

Firmware variants differ by the length of the scale-info frame the scale sends after connecting. With `runtime.debug: true` the log shows it:

```text
QN: scale info (19B, dialect=es26m), factor=100, proto=0xff
```

This page names dialects by that length: `18B` and `19B` are the 18- and 19-byte dialects, `20B` and longer the extended dialect, anything else the classic dialect. The `dialect=` value is an internal name.

The Arboleaf CS10K is the exception: its `20B` frame names the extended dialect, but it weighs in like the 19-byte dialect (see [Arboleaf scales](#arboleaf-scales-19-byte-dialect)).

If the scale-info frame is lost, which can happen on a proxy transport, the log shows this line instead:

```text
QN: fallback: no 0x12 received, running handshake with proto=0xff
```

Its `proto` value is the byte ble-scale-sync used (`qn_protocol_byte`, or 255), not one from the scale.

## Setup

1. Set `ble.scale_mac` to the scale's address (`scan` lists it).
2. Make the first user in `config.yaml` the first user in the vendor app, with the same `birth_date`, `height`, `gender` and `is_athlete`. Several options below send that user's profile to the scale.
3. Set that user's `last_known_weight`, or a `weight_range` narrow enough that its middle is close to their weight. The scale is sent that number as a weight anchor before the weigh-in.
4. Weigh in and stay on the scale until its display shows the results.

A weigh-in that worked logs `Measurement:` with the weight and impedance.

## Options

Try these in order when the scale connects and completes the handshake but sends no weight. Change one thing per weigh-in and keep each option that helped. An unset option changes nothing.

1. **`qn_protocol_byte`**: the protocol byte the handshake echoes back, 0 to 255. Try `0`, then `255`, then the `proto` value from the `QN: scale info` line if your log has one. A wrong byte gives no error, only silence.
2. **`qn_user_key`**: every dialect but the classic one; Experimental on the extended dialect. Set `1000`, the key the Feelfit, Arboleaf and GE apps use, when the debug log shows `QN: the scale did not accept the profile for user slot 1 (#331)` and the display shows only the weight. The profile frame then carries this key and the first user's profile. If the vendor app registered you in another slot, see [User slot](#user-slot).
3. **`qn_weight_ack: true`**: sends the weight anchor right after the start command and acknowledges each live weight frame with its own weight, as the vendor apps do. On the 19-byte dialect it also sends the first user's age, height and sex. On by default on the extended dialect; `false` turns it off there.
4. **`qn_time_sync_long: true`**, with `qn_weight_ack` on: sends the 9-byte clock frame with the host's UTC offset. In Docker, set `TZ`; otherwise the offset is UTC.
5. **`qn_config_long: true`**, with both above on: sends the 10-byte config frame the vendor app sends.
6. **`qn_a4_prelude: true`**, last: sends two extra frames the vendor app sends. They overwrite data the scale keeps for its first user, and a session that sends them never uses the scale's own body composition.

```yaml
ble:
  scale_mac: 'AA:BB:CC:DD:EE:FF'
  qn_weight_ack: true
  qn_time_sync_long: true
```

All options apply on the next weigh-in without a restart. If one of them makes your scale report, say which on [#331](https://github.com/KristianP26/ble-scale-sync/issues/331), with the `QN: scale info` line.

### Options with side effects

- **`qn_report_byte`** sends, on every connection, a frame that deletes the user slots its bits select on the scale (`252` deletes slots 3 to 8), with any weigh-ins stored for them. Leave it unset unless a scale that reported weights stopped after you updated ble-scale-sync and nobody else uses the scale.
- **`qn_result_ack: true`** (Experimental, 19-byte dialect and Arboleaf CS10K) sends the end-of-measurement frame of the vendor's published SDK after the last result frame. Report results on [#331](https://github.com/KristianP26/ble-scale-sync/issues/331).

## User slot

The scale keeps up to eight users, each in a numbered slot with the key the vendor app registered it with. ble-scale-sync sends the first user's profile from `config.yaml` to slot 1.

If the vendor app registered you in another slot, set `qn_user_slot` (Experimental, 1 to 8) together with `qn_user_key`. The profile frame, the weight anchor and the request for stored weigh-ins then go to that slot. On the 18-, 19- and 20-byte dialects nothing goes to slot 1, and nothing goes to any slot until the scale has sent its scale-info frame. Without `qn_user_key` the option is ignored with a warning.

A wrong slot sends the first user's profile to another person's slot, and the scale accepts key 1000 there too.

To find the slot, weigh in once with `runtime.debug: true`. On the 20-byte dialect, except the Arboleaf CS10K, the result line names it:

```text
QN: extended result 0xb1 decoded 72.4kg, user slot 2 (no whole-body impedance, emitting weight-only) #235
```

On the 19-byte dialect and the Arboleaf CS10K the line `QN: result block, user slot N` names it. On the 18-byte dialect only the lines of stored weigh-ins do.

```yaml
ble:
  qn_user_key: 1000
  qn_user_slot: 2
```

## Algorithm byte {#algorithm-byte}

The profile frame tells the scale which body-fat method to compute with. The scale never reports which one it expects. The vendor app picks it from its settings for the scale model, and per the vendor's published SDK an 8-electrode scale without such a setting gets 7. ble-scale-sync sends 4, or 14 for an athlete aged 18 or older on the 18-byte dialect.

`qn_algorithm` (Experimental, 0 to 255) sends another value. It goes into the profile frame as given, with no athlete step, wherever the vendor-app profile frame goes out: with `qn_user_key` on the 18-, 19- and 20-byte dialects, and with `qn_weight_ack: true` on the 19-byte dialect. Without either, a warning says it is never sent. On the 20-byte dialect, except the Arboleaf CS10K, it also turns on the [scale's own body composition](#scale-body-composition-on-the-extended-dialect). The debug log shows it:

```text
QN: A00D profile frame with key 1000, age 30, height 1700 mm, sex female, athlete no, algorithm 7 (ble.qn_user_key, 20-byte dialect, #463)
```

The scale computes its own body composition with the method this byte names. If you try a value, report on [#331](https://github.com/KristianP26/ble-scale-sync/issues/331) whether the results changed.

## Arboleaf scales (19-byte dialect)

Set `qn_weight_ack: true` and `qn_time_sync_long: true` from the start. Keep `qn_a4_prelude` off.

The scale measures body composition for about 14 seconds after the weight settles, so the connection stays open until its last result frame. If that frame never comes, the weight goes out alone after 40 seconds at most.

The scale computes body fat, water, muscle, bone, visceral fat, BMR and body age for the profile it was sent. These are exported, with body age as metabolic age, when both hold:

- the weigh-in is matched to a user with exactly the age, height and sex of that profile;
- the scale measured after it accepted the profile.

The log then says `QN: using the scale's own body composition for this weigh-in (#331)`. Otherwise it names the reason and the weigh-in gets the [BMI estimate](/body-composition#body-fat-fallback-deurenberg). With several users, only the first user can get the scale's values. The scale has no athlete mode.

Weigh-ins stored while nothing was connected arrive on the next connection. They go, with their own time and weight only, to the exporters that [can record a past measurement](/exporters#historical-readings).

The Arboleaf CS10K (Experimental) sends a 20-byte scale-info frame but weighs in like these scales, so the measuring time, the held weight and the stored weigh-ins above apply to it. Instead of the two options at the top of this section, start with `qn_user_key: 1000` alone. The scale's own body composition needs it, and unlike on the CS10E it needs no `qn_algorithm`.

## GE CS 10 G and extended-dialect scales

The scale waits for a weight anchor close to the weight of the person on it. The anchor is the first user's `last_known_weight`, or the middle of their `weight_range` when that range lies between 20 and 250 kg and spans no more than 100 kg. Without either, the log warns `QN: no usable weight anchor in config` and a fixed value is sent. Live weight frames are not acknowledged, so the anchor matters only for the start.

With `qn_user_key` set, the start command and the anchor go out only after the scale answers the profile frame, or after one second without an answer, as in the vendor app. No anchor goes out when the scale reports ready, even with `qn_weight_ack: true`.

### Scale body composition on the extended dialect {#scale-body-composition-on-the-extended-dialect}

Experimental. Eight-electrode scales on this dialect, such as the Arboleaf CS10E, compute body fat, water, muscle, bone, skeletal muscle, visceral fat, BMR and body age for the profile they were sent. With `qn_user_key` and [`qn_algorithm`](#algorithm-byte) set, these are exported, with body age as metabolic age, under the same two conditions as on the [19-byte dialect](#arboleaf-scales-19-byte-dialect).

The Arboleaf CS10K is covered under [Arboleaf scales](#arboleaf-scales-19-byte-dialect).

The scale must send its result in one frame, as it does over an ESPHome proxy. When the result arrives split, which happens over the ESP32 proxy, only the weight goes out. With `qn_user_key` set, the session first waits up to 5 seconds for the other parts, and the debug log lists the scale's values from them; report how they compare with the vendor app on [#501](https://github.com/KristianP26/ble-scale-sync/issues/501). Without `qn_algorithm` the normal log names it as the reason and the weigh-in gets the BMI estimate.

```yaml
ble:
  qn_user_key: 1000
  qn_algorithm: 7 # what the vendor's published SDK sends an 8-electrode scale
```

These are the scale's own values and can differ from the vendor app. The skeletal muscle percentage is exported as the scale reports it, between 10 and 90 % only. Report on [#331](https://github.com/KristianP26/ble-scale-sync/issues/331) how they compare with the vendor app.

## Stored weigh-ins on the 18-byte dialect

With `qn_user_key` set and the profile accepted, the app also asks an 18-byte scale for weigh-ins it stored while nothing was connected. Those of the profile's user slot (1, or [`qn_user_slot`](#user-slot)), or of no user, go out once with their own time to the exporters that [can record a past measurement](/exporters#historical-readings). Without the option such a weigh-in is not exported; the normal log gives its weight and time so you can add it by hand.

A stored weigh-in is exported once: the newest exported one is recorded in `.scale-dedup-marks.json` next to `config.yaml`.

## Troubleshooting

### The scale connects, the handshake completes, no weight arrives

Work through [Options](#options) in order. Make sure someone stands on the scale during the connection, because a scale nobody stands on looks the same. Over an ESP32 proxy, a log line such as `QN: 0xb1 part 3 of 3 arrived without part 1` likely means the board dropped notifications: [flash the current firmware](/guide/esp32-proxy#flashing-the-firmware). If no option helps, open an issue with a `runtime.debug: true` log of one weigh-in, the scale model, the transport and the options you tried.

### The display shows only the weight

The scale refused the profile frame. Set `qn_user_key: 1000` (not on the classic dialect).

If the normal log then says `QN: the scale refused the profile frame sent with ble.qn_user_key 1000`, the vendor app set up that slot with another key or never set it up. Check that the first user in `config.yaml` is the first user in the vendor app, or set [`qn_user_slot`](#user-slot) if the scale reports your weigh-ins for another slot.

### The scale works for one person in the house only

On the extended dialect the anchor comes from the first user. Set `last_known_weight` for that user, or narrow `weight_range` so its middle is close to them, as in [GE CS 10 G and extended-dialect scales](#ge-cs-10-g-and-extended-dialect-scales).

### Body fat differs between weigh-ins on an Arboleaf

A weigh-in without measured body composition, with dry feet for example, gets the BMI estimate instead of the scale's values. With `estimate_body_composition: false` for the user, none is exported instead. See [Configuration](/guide/configuration#users).
