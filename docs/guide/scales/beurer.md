---
title: Beurer and Sanitas Scales
description: Pairing, consent codes, the bonding options and fixes for Beurer BF7xx and BF9xx and Sanitas SBF scales.
---

# Beurer and Sanitas Scales

Beurer and Sanitas scales pair over Bluetooth and keep their users in slots protected by a consent code. Pairing, the code and the slot have to match before the scale sends a weigh-in.

## Supported Models

| Models | Adapter in the log | Needs |
| --- | --- | --- |
| Beurer BF720, BF105, BF500, BF788, BF915, BF950 | `Beurer BF720/BF105` | A bonded link and `users[].beurer_pin` |
| Beurer BF700, BF710, BF800, Sanitas SBF70, SBF75 | `Beurer / Sanitas` | BF710: register it in the Beurer app first |
| Sanitas SBF72, SBF73 | `Sanitas SBF72/73` | User slot 1 created in the vendor app |

## Requirements

- For the BF720 family: Linux with the built-in Bluetooth handler (`ble.handler: auto` without `ble.noble_driver`; `ble_transport: local` in the add-on). Pairing and the bonding options work only there; the proxy transports do not pair.
- For a BF700 that shows a six-digit code to type: one pairing by hand, with `bluetoothctl` on Linux, as in [Pairing](#pairing).
- The consent code and slot are read from the first user in `config.yaml`. The Home Assistant add-on has no field for them; use [custom config mode](/guide/home-assistant-addon#custom-config-mode).

## Pairing

Three different numbers are all called "the PIN":

| Number | Digits | What it is | Where it goes |
| --- | --- | --- | --- |
| Passkey to confirm (BF915) | 6 | Shown during pairing, new every time | Nowhere. Confirm it on the scale with **SET**. |
| Passkey to type (BF700) | 6 | Shown during pairing, the computer has to type it, new every time | Nowhere. Pair once by hand, below. |
| Consent code | 4 | Tied to one user slot on the scale | `users[].beurer_pin` |

On a BF915 the consent code is the four-digit number the scale shows when you select that profile in its own menu.

To pair a scale that shows a code to confirm:

1. Start ble-scale-sync and stand at the scale.
2. When the scale shows a six-digit code, about a minute after start, press **SET**.
3. If you miss it, restart ble-scale-sync to be asked again at once. Otherwise it waits before asking again, see [The scale shows a pairing code again and again](#the-scale-shows-a-pairing-code-again-and-again).

For a scale that shows a code to type, the log on Linux says it `asked for a passkey and no users[].beurer_pin is set`. To pair it, stop ble-scale-sync, wake the scale and run:

```bash
bluetoothctl
scan on      # wait until the scale's MAC shows up
pair <MAC>   # type the six-digit code the scale shows when asked
```

Then start ble-scale-sync again. On Linux `beurer_pin` is also offered to BlueZ during pairing, so remove an existing bond (`bluetoothctl remove <MAC>`) before you change it.

### Pair with a Host Identity Key

Some Beurer scales, the BF915 among them, keep a pairing only from a device that hands over an identity key while pairing. Linux hands over that key only with LE privacy on. Without it the scale asks for **SET** and a new pairing before every weigh-in, or the connect stalls at `Connected. Discovering services...` with `GATT server acquisition timed out`.

1. Set `ble.adapter_privacy: true` (in the add-on: **Pair with a host identity key (LE privacy)**) and restart.
2. Remove the old pairing once: `bluetoothctl remove <MAC>`, or set `ble.auto_clear_stale_bond: true` (in the add-on: **Re-pair a scale that forgot its pairing**) to let ble-scale-sync do it.
3. Pair through ble-scale-sync as above. Let ble-scale-sync start the pairing rather than `bluetoothctl pair`.

The log confirms it with `uses an IRK derived from its address` and a fingerprint of the key. Later weigh-ins reuse the pairing, also after the scale slept.

Before you turn it on:

- It affects the whole adapter. Every LE connection and active scan on it uses a random address, Home Assistant's own Bluetooth integration included, and other paired LE devices may need pairing again. A second adapter set in `ble.adapter` (`ble_adapter` in the add-on) avoids that.
- It does not hide the host: the key is derived from the adapter's address, so it survives restarts, re-created containers and reboots.
- Do not combine it with `Privacy` in `/etc/bluetooth/main.conf`; the two keys replace each other.
- It needs `btmgmt` with root or `CAP_NET_ADMIN`, which the add-on and the Docker image have. Turning the option off does not turn privacy off on the adapter: run `sudo btmgmt --index 0 power off`, `sudo btmgmt --index 0 privacy off` and `sudo btmgmt --index 0 power on` with your adapter's index, or reboot.

On a native or Docker host, `Privacy = device` under `[General]` in `/etc/bluetooth/main.conf` and `sudo systemctl restart bluetooth` do the same without the option. Home Assistant OS does not let you edit that file.

## Consent Code

```yaml
users:
  - name: Alice
    beurer_pin: 1234 # the four-digit consent code
    beurer_user_index: 1 # the slot the code belongs to
```

### Restore a Scale That Lost Its Users

Removing the batteries can wipe every user slot and its code on the BF7xx models; the user-slot digit is then gone from the display. A BF915 keeps its slots across a battery change. On an empty scale:

```yaml
users:
  - name: Alice
    beurer_pin: 0 # an empty scale has no code to check
    beurer_provision: true # write this profile back into the scale
```

Provisioning fills only fields the scale reports as empty. To change a record the scale already holds, reset the scale.

### Register a New User

A user record exists only after the vendor app registered it, so a scale set up by the app can refuse every consent code from another client. On a BF915, create the profile in the scale's menu first (**SET**, `U:1` to `U:8`) and use the four-digit code it shows as `beurer_pin` and the slot number (`U:n`) as `beurer_user_index`; registering from ble-scale-sync only uses up slots.

On other models:

1. Set `beurer_pin` to the code you want and `beurer_register_new_user: true`.
2. Weigh in. The log names the slot: `Beurer BF720: registered a new user at index 4.`
3. Set `beurer_user_index` to that index and `beurer_register_new_user` back to `false`, or the next run registers another one.

If the scale refuses the registration, its slots are full; free one in the scale's menu.

A new profile needs one weigh-in assigned to it on the scale. Until then the scale shows `U -` after weighing and sends nothing, which looks like a wrong consent code.

### Factory Reset and Deleting One User (BF915)

Both use the **UNIT** button on the underside:

- 4 seconds with a user selected deletes that user (`dEL`).
- 5 seconds from powered on resets the scale (`CLr`). It then asks for the date and time.

## Configuration Options

Defaults are in the [BLE reference](/guide/configuration#ble). Each applies on the next scan without a restart, except `adapter_privacy`.

- **`auto_clear_stale_bond: true`**: when the scale works once and then every connect fails, deletes the pairing the scale forgot and pairs again. It acts only on evidence that the scale refused the key, so a weak radio link does not clear a working pairing.
- **`pairing_retry_max_min`**: the longest wait before asking again after nobody confirmed a pairing. The waits are 2 minutes three times, then double up to this value. `0` asks on every scan. Continuous mode only; a single run asks once per run.
- **`adapter_privacy: true`**: for a scale that asks for a new pairing before every weigh-in, see [Pair with a host identity key](#pair-with-a-host-identity-key).
- **`preemptive_adapter_reset: false`**: skips the adapter power-cycle after each session. It is not the cause of lost pairings; turn it back on if the adapter starts missing the scale.
- **`session_timeout_sec`**: shorter sessions free a scale that does not weigh while connected, such as the BF500.
- **`runtime.no_reading_rescan_delay`**: a pause after a session without a reading, for a scale that accepts a connection all the time, such as the BF915.

## Troubleshooting

### `Beurer BF720: consent rejected (USER_NOT_AUTHORIZED)`

`beurer_pin` or `beurer_user_index` does not match a slot on the scale. If the log also says `the scale reports no stored user profiles`, follow [Restore a scale that lost its users](#restore-a-scale-that-lost-its-users); if the vendor app owns the slots, [register a new user](#register-a-new-user).

### Every connect fails after the first session

The log shows `le-connection-abort-by-local` on every attempt. The scale has most likely dropped its half of the pairing while the host still holds the key; a weak radio link gives the same error, but then some connects still get through. Clear it and pair again:

```bash
sudo bluetoothctl
remove AA:BB:CC:DD:EE:FF
pair AA:BB:CC:DD:EE:FF
```

If it happens every session, set `ble.auto_clear_stale_bond: true`. If the pairing is rejected on the very next connect every time, see [Pair with a host identity key](#pair-with-a-host-identity-key).

### The scale shows a pairing code again and again

Nobody confirmed the pairing. The app then stops connecting for a while and logs `asked for the pairing to be confirmed on the scale and it was not`. It asks again at once when the scale wakes up after sleeping, advertises a new weigh-in or ble-scale-sync restarts. To pair now, restart ble-scale-sync and press **SET** when the code shows, about a minute later.

### BF915 shows PAIR on the display all day

The BF915 accepts a connection all the time, and shows `PAIR` while a session is open, about two minutes when nobody steps on. It keeps a weigh-in made in between and hands it over at the next connection, so a pause between sessions mostly delays the upload:

```yaml
runtime:
  no_reading_rescan_delay: 900
```

A weigh-in that arrives more than 5 minutes after it was taken is a past measurement, which only the exporters that [can record a past measurement](/exporters#historical-readings) accept. If the others matter, keep the value at about 240 or below.

### BF500 shows APP and does not weigh

The BF500 runs no standalone weigh-in while a host holds the session open. Shorten the session and stay away longer after a reading:

```yaml
ble:
  session_timeout_sec: 20
runtime:
  scan_cooldown: 60
  watchdog_max_consecutive_failures: 0
```

Shorter sessions mean more adapter resets per hour and more timed-out sessions, which the failure watchdog can count; `0` turns the watchdog off.

### Still not working

Open an issue with a log taken with `runtime.debug: true` from start through one weigh-in, the scale model and the transport.
