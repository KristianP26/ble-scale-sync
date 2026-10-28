---
title: Renpho Scales
description: Setup, the rmsc04_profile_byte option and fixes for Renpho scales on Renpho's own protocols, the R-MSC04 MorphoScan Nova and the ES-CS20M on service 0x1A10.
---

# Renpho Scales

The Renpho R-MSC04 (MorphoScan Nova) and newer ES-CS20M revisions on service 0x1A10 speak Renpho's own protocol, and most other Renpho models use the QN protocol and are on [QN Scales](./qn). The ES-WBE28 and ES-26BB-B need no setup, and the A-R003 needs `ble.scale_mac` on the default Linux transport and on macOS because it advertises no name.

## Supported Models

| Model | Adapter in the log | Body composition |
| --- | --- | --- |
| R-MSC04 (MorphoScan Nova) | `Renpho R-MSC04` | BMI estimate; the scale's own with `ble.rmsc04_profile_byte` |
| ES-CS20M on service 0x1A10 | `ES-CS20M` | From the measured resistance |
| ES-WBE28 | `Renpho ES-WBE28` | BMI estimate |
| A-R003 (Experimental) | `Renpho ES-WBE28` | BMI estimate |
| ES-26BB-B | `Renpho ES-26BB` | From the measured impedance |

## Setup

1. Set `ble.scale_mac` to the scale's address (`scan` lists it).
2. Set the first user's `height` and `last_known_weight`, or a `weight_range` whose middle is close to their weight. The R-MSC04 and the ES-CS20M are sent a guest profile built from the first user.
3. Weigh in and stay on the scale until its display shows the results.

A weigh-in that worked logs `Measurement:` with the weight.

## Guest Profile

Right after connecting, ble-scale-sync sets the scale's clock to the host's time and time zone and writes a guest profile, as the Renpho app does. The profile holds the first user's height (the ES-CS20M also gets sex and birth date) and a weight: `last_known_weight`, otherwise the middle of `weight_range` when that range lies between 20 and 250 kg and spans no more than 100 kg, otherwise 70 kg.

The guest profile goes to the scale on every weigh-in, also in a household with several users, whoever steps on. It uses the guest slot, so profiles the Renpho app saved on the scale stay as they are. ble-scale-sync never logs the profile.

Time zones west of UTC are sent to the R-MSC04 as UTC, so the scale's own clock shows UTC there. Exported times come from the host and are not affected.

## R-MSC04 (MorphoScan Nova)

The scale sends its results about 15 seconds after the weight settles, so the connection stays open for up to 30 seconds after that. If ble-scale-sync connects after the weight has settled, it takes the weight from the results frame. That fails while the scale still holds undelivered weigh-ins: open the Renpho app once to sync them.

The scale computes body fat, skeletal muscle and visceral fat for the guest profile. Those figures are only logged unless you set [`rmsc04_profile_byte`](#own-body-fat); the weigh-in gets the [BMI estimate](/body-composition#body-fat-fallback-deurenberg). `estimate_body_composition: false` for the user exports none instead.

The scale's ten segment impedances (trunk, both arms and both legs at 20 and 100 kHz) are exported as diagnostic values with every weigh-in that has a body fat value. In Home Assistant they are [diagnostic sensors](/exporters#mqtt) that start disabled.

### Use the scale's own body fat (`rmsc04_profile_byte`) {#own-body-fat}

Experimental. The Renpho app writes your own profile to the scale on every connection, and one byte of it makes the scale compute for you.

1. Turn on [Android's Bluetooth HCI snoop log](https://source.android.com/docs/core/connect/bluetooth/verifying_debugging) and weigh in with the Renpho app.
2. Find a write to characteristic `0x2A11` that starts with `55 aa b2 00 09`.
3. Take its 12th byte:

   ```text
   55 aa b2 00 09 <seq> <slot> <height> <height> <weight> <weight> <BYTE> <xx> <xx> <checksum>
   ```

4. Set it as two hex digits in quotes:

   ```yaml
   ble:
     rmsc04_profile_byte: '5a' # replace with your byte, in quotes
   ```

5. Make the first user in `config.yaml` the person you captured, with the same `height`, `gender` and `birth_date` as in the Renpho app.

The scale's body fat, skeletal muscle and visceral fat are then exported for a weigh-in when all of these hold:

- the scale reported body fat and BMI;
- the profile with your byte was written in the same connection, and the scale acknowledged it before it reported the measurement complete;
- the weigh-in was matched to a user with the first user's height, sex and birth date;
- the scale's BMI fits the height that was sent.

The normal log then says:

```text
Renpho R-MSC04: using the scale's body fat, skeletal muscle and visceral fat, computed for the profile sent with ble.rmsc04_profile_byte (#434)
```

Otherwise it gives the reason and the estimate goes out. Water, bone and muscle mass are derived from the scale's body fat; BMI, BMR, metabolic age and physique rating are calculated by ble-scale-sync. The skeletal muscle percentage is exported as the scale reports it, between 10 and 90 % only.

Limits:

- The byte can change with your age and your Renpho profile. Capture it again after your birthday or after you change your profile in the Renpho app.
- `is_athlete` does not change the scale's figures; the athlete setting is not sent.
- The byte is personal: do not paste it into an issue. The setup wizard hides it when it lists changes.

Report results on [#434](https://github.com/KristianP26/ble-scale-sync/issues/434).

## ES-CS20M on Service 0x1A10

Units that also have the characteristics AE01 and AE02 get the clock, the guest profile and a command to keep their display unit every time the scale switches on during a connection. Units without them are sent the command to show kg.

After a weigh-in the scale sends the weight, the resistance it measured (0 in socks) and a BMI and body fat it computed for the guest profile. ble-scale-sync uses the weight and the resistance and computes body composition for the user the weigh-in is matched to; the scale's own BMI and body fat are not used. The connection stays up until the scale switches off, at most 30 seconds after the result.

With `runtime.debug: true` every frame the scale sends is logged raw, including its reply to the profile.

## Troubleshooting

### The R-MSC04 gets weight but no body composition from the scale

Without `rmsc04_profile_byte` that is expected; see [Use the scale's own body fat](#own-body-fat). With it, the normal log line `Renpho R-MSC04: the scale's body fat, skeletal muscle and visceral fat are not used for this weigh-in` names the reason.

### The R-MSC04 drops the connection a few seconds in

Some weigh-ins lose the connection about 5 seconds after it opened. The settled weight is still read, but that weigh-in gets no body composition from the scale. On Linux, [debug mode shows why the connection ended](/troubleshooting#connection-ended). Report the lines on [#434](https://github.com/KristianP26/ble-scale-sync/issues/434).

### An ES-CS20M connects but sends no weight

Check that the log says `Matched adapter: ES-CS20M`. A broadcast-only ES-CS20M or one on the QN protocol is on [QN Scales](./qn). Otherwise open an issue with the debug log of one weigh-in.
