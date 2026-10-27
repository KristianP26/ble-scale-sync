---
title: QN Scales
description: Setup, the ble.qn_* options and their order, and fixes for QN-protocol scales from Renpho, Arboleaf, FITINDEX, GE and their rebadges.
---

# QN Scales

The QN protocol runs on many Renpho, Arboleaf, FITINDEX, GE and Sencor scales and their rebadges. Most work without any option; the `ble.qn_*` options adjust the handshake for firmware that expects it differently.

## Supported Models

- Renpho ES-CS20M, ES-32MD, Elis 1, and FITINDEX and Sencor rebadges.
- Arboleaf scales with eight electrodes (19-byte dialect).
- GE CS 10 G ("Fit Plus") and rebadges (20-byte extended dialect).

Some ES-CS20M and Elis 1 units never accept a connection. ble-scale-sync then reads the weight from their broadcast, and body composition is estimated from BMI, because the broadcast carries no impedance. `ble-scale-sync diagnose <MAC>` (`npm run diagnose -- <MAC>` from a clone) shows whether a unit is connectable. Newer ES-CS20M revisions on service 0x1A10 use Renpho's own protocol instead, see [Renpho Scales](./renpho).

The firmware variants differ by the length of the scale-info frame the scale sends after connecting. With `runtime.debug: true` the log names it:

```text
QN: scale info (19B, dialect=es26m), factor=100, proto=0xff
```

This page names the dialects by that length: `18B` and `19B` are the 18- and 19-byte dialects, `20B` and longer the extended dialect, anything else the classic dialect. The `dialect=` value is an internal name.

If the scale-info frame gets lost, which can happen on a proxy transport, the log shows this line instead:

```text
QN: fallback: no 0x12 received, running handshake with proto=0xff
```

Its `proto` value is the byte ble-scale-sync used (`qn_protocol_byte`, or 255), not one the scale sent.

## Setup

1. Set `ble.scale_mac` to the scale's address (`scan` lists it).
2. Make the first user in `config.yaml` the first user in the vendor app, with the same `birth_date`, `height`, `gender` and `is_athlete`. Several options below send that user's profile to the scale.
3. Set that user's `last_known_weight`, or a `weight_range` narrow enough that its middle is close to their weight. The scale is sent that number as a weight anchor before the weigh-in.
4. Weigh in and stay on the scale until its display shows the results.

A weigh-in that worked logs `Measurement:` with the weight and impedance.

## Options

Try these in order when the scale connects and completes the handshake, but no weight arrives. Change one thing per weigh-in and keep each option that helped. An unset option changes nothing.

1. **`qn_protocol_byte`**: the protocol byte the handshake echoes back, 0 to 255. Try `0`, then `255`, then the `proto` value from the `QN: scale info` line if your log has one. A wrong byte gives no error, only silence.
2. **`qn_user_key`**: every dialect but the classic one, Experimental on the extended dialect. Set `1000`, the key the Feelfit, Arboleaf and GE apps use, when the debug log shows `QN: the scale did not accept the profile for user slot 1 (#331)` and the display shows only the weight. The profile frame then carries this key and the first user's profile. If the vendor app registered you in a slot other than 1, see [User Slot](#user-slot).
3. **`qn_weight_ack: true`**: sends the weight anchor right after the start command and acknowledges each live weight frame with its own weight, as the vendor apps do. On the 19-byte dialect it also sends the first user's age, height and sex. On by default on the extended dialect; `false` turns it off there.
4. **`qn_time_sync_long: true`**, keeping `qn_weight_ack` on: sends the 9-byte clock frame with the host's UTC offset. In Docker set `TZ`, or the offset sent is UTC.
5. **`qn_config_long: true`**, keeping both above: sends the 10-byte config frame the vendor app sends.
6. **`qn_a4_prelude: true`**, last: sends two extra frames the vendor app sends. They overwrite data the scale keeps for its first user, and a session that sends them never uses the scale's own body composition.

```yaml
ble:
  scale_mac: 'AA:BB:CC:DD:EE:FF'
  qn_weight_ack: true
  qn_time_sync_long: true
```

All options apply on the next weigh-in without a restart. If one of them makes your scale report, say which one on [#331](https://github.com/KristianP26/ble-scale-sync/issues/331), with the `QN: scale info` line.

### Options with Side Effects

- **`qn_report_byte`** sends, on every connection, a frame that deletes the user slots its bits select on the scale (`252` deletes slots 3 to 8), with any weigh-ins stored for them. Leave it unset unless a scale that reported weights stopped after you updated ble-scale-sync, and nobody else uses the scale.
- **`qn_result_ack: true`** (Experimental, 19-byte dialect) sends the end-of-measurement frame of the vendor's published SDK after the last result frame. Report results on [#331](https://github.com/KristianP26/ble-scale-sync/issues/331).

## User Slot

The scale keeps up to eight users, each in a numbered slot with the key the vendor app registered it with. ble-scale-sync sends the profile of the first user in `config.yaml` to slot 1. If the vendor app registered you in another slot, set `qn_user_slot` (Experimental, 1 to 8) together with `qn_user_key`. The profile frame, the weight anchor and the request for stored weigh-ins then go to that slot, and once the scale has sent its scale-info frame nothing goes to slot 1. Without `qn_user_key` the option is ignored with a warning. A wrong slot sends the first user's profile to another person's slot, and the scale accepts key 1000 there too.

To find the slot, weigh in once with `runtime.debug: true`. On the 20-byte dialect the result line names it:

```text
QN: extended result 0xb1 decoded 72.4kg, user slot 2 (impedance sweep not yet calibrated, emitting weight-only) #235
```

On the 19-byte dialect the line `QN: result block, user slot N` names it, on the 18-byte dialect only the lines of stored weigh-ins.

```yaml
ble:
  qn_user_key: 1000
  qn_user_slot: 2
```

## Arboleaf Scales (19-Byte Dialect)

Set `qn_weight_ack: true` and `qn_time_sync_long: true` from the start and keep `qn_a4_prelude` off.

The scale measures body composition for about 14 seconds after the weight settles, so the connection stays open until its last result frame. If that frame never comes, the weight goes out alone after at most 40 seconds.

The scale computes body fat, water, muscle, bone, visceral fat, BMR and body age for the profile it was sent. These are exported, with body age as metabolic age, when both hold:

- the weigh-in is matched to a user with exactly the age, height and sex of that profile;
- the scale measured after it accepted the profile.

The log then says `QN: using the scale's own body composition for this weigh-in (#331)`. Otherwise it names the reason and the weigh-in gets the [BMI estimate](/body-composition#body-fat-fallback-deurenberg). With several users only the first user can get the scale's values. The scale has no athlete mode.

Weigh-ins the scale stored while nothing was connected arrive on the next connection and go, with their own time and weight only, to the exporters that [can record a past measurement](/exporters#historical-readings).

## GE CS 10 G and Extended-Dialect Scales

The scale waits for a weight anchor close to the weight of the person on it. The anchor is the first user's `last_known_weight`, or the middle of their `weight_range` when that range lies between 20 and 250 kg and spans no more than 100 kg. Without either, the log warns `QN: no usable weight anchor in config` and a fixed value is sent. Once the scale streams, every frame is acknowledged with its own weight, so the anchor matters only for the start.

With `qn_user_key` set, the start command and the anchor go out only after the scale answers the profile frame or after one second without an answer, as in the vendor app, and no anchor goes out when the scale reports ready, even with `qn_weight_ack: true`.

## Stored Weigh-Ins on the 18-Byte Dialect

With `qn_user_key` set and the profile accepted, the app also asks an 18-byte scale for the weigh-ins it stored while nothing was connected. Those of the profile's user slot (1, or [`qn_user_slot`](#user-slot)), or of no user, go out once with their own time to the exporters that [can record a past measurement](/exporters#historical-readings). Without the option such a weigh-in is not exported, and the normal log gives its weight and time so you can add it by hand.

A stored weigh-in is exported once: the newest exported one is recorded in `.scale-dedup-marks.json` next to `config.yaml`.

## Troubleshooting

### The scale connects, the handshake completes, no weight arrives

Work through [Options](#options) in order. Make sure someone stands on the scale during the connection, since a scale nobody stands on looks the same. If none of the options helps, open an issue with a log taken with `runtime.debug: true` during one weigh-in, the scale model, the transport and the options you tried.

### The display shows only the weight

The scale refused the profile frame. Set `qn_user_key: 1000` (not on the classic dialect). If the normal log then says `QN: the scale refused the profile frame sent with ble.qn_user_key 1000`, the vendor app set up that slot with another key or never set it up; check that the first user in `config.yaml` is the first user in the vendor app, or set [`qn_user_slot`](#user-slot) if the scale reports your weigh-ins for another slot.

### The scale works for one person in the house only

On the extended dialect the anchor comes from the first user. Set `last_known_weight` for that user, or narrow `weight_range` so its middle is close to them, as in [GE CS 10 G and extended-dialect scales](#ge-cs-10-g-and-extended-dialect-scales).

### Body fat differs between weigh-ins on an Arboleaf

A weigh-in without measured body composition, with dry feet for example, gets the BMI estimate instead of the scale's values. `estimate_body_composition: false` for the user exports none instead, see [Configuration](/guide/configuration#users).
