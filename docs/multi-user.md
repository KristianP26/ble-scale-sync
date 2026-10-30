---
title: Multi-User Support
description: How BLE Scale Sync decides who stepped on the scale, warns about weight drift and sends each user's readings to their own exporters.
---

# Multi-User Support

With several users configured, the app picks the person on the scale by the measured weight and uses that person's profile and exporters. The [setup wizard](/guide/configuration#setup-wizard-recommended) adds users and their weight ranges.

## How It Works

1. Someone steps on the scale.
2. The app matches the weight to a user by the users' weight ranges.
3. Body composition is calculated from that user's profile (height, age, gender, athlete mode).
4. The reading goes to that user's exporters.
5. The user's `last_known_weight` in `config.yaml` is updated, which helps the next match.

Each user has a `weight_range` in kg:

```yaml
users:
  - name: Alice
    weight_range: { min: 50, max: 70 }
    last_known_weight: null
  - name: Bob
    weight_range: { min: 75, max: 100 }
    last_known_weight: 85.5
```

Only the fields that matter for matching are shown. Every user also needs `slug`, `height`, `birth_date`, `gender` and `is_athlete`, and the file needs `version: 1`; see the [config.yaml reference](/guide/configuration#config-yaml-reference).

## Weight Matching

The first rule that applies decides:

| Order | Condition                                        | Result                                                                          |
| ----- | ------------------------------------------------ | ------------------------------------------------------------------------------- |
| 1     | Only one user is configured                      | That user, with a warning if the weight is outside the range                    |
| 2     | Exactly one range contains the weight            | That user                                                                       |
| 3     | Several ranges contain the weight                | The one whose `last_known_weight` is closest; without one, the first in config  |
| 4     | No range contains it, some user has a `last_known_weight` | The user with the closest `last_known_weight`                          |
| 5     | No range contains it, no user has a `last_known_weight`   | The `unknown_user` strategy                                            |

`unknown_user` applies only in the last case:

| Strategy            | Result                                            |
| ------------------- | ------------------------------------------------- |
| `nearest` (default) | The user with the closest range midpoint, with a warning |
| `log`               | Logs a warning and skips the reading              |
| `ignore`            | Skips the reading without a log line              |

So once any user has a `last_known_weight`, a reading outside every range is still assigned to someone. To drop such readings instead, set `out_of_range: skip` ([Out-of-range readings](/guide/configuration#out-of-range-readings)). The setup wizard writes `out_of_range: skip` when it saves a config with more than one user.

A scale that sends weigh-ins stored in its memory has each one assigned by its own weight, or by the scale's user slot when it sends one, not to the person on the scale now. A stored weigh-in that matches nobody, or that several users fit equally, is dropped and logged.

### Senssun IF_B2

Users only need to step on a Senssun IF_B2. BLE Scale Sync waits until one uniquely matched live weight remains unchanged for two seconds, updates reusable scale profile PIN `0001`, and confirms the same user from the final current record before exporting. The scale retains the most recently acknowledged user's demographics in that profile. Use non-overlapping `weight_range` values so a quiet reading identifies one user unambiguously, and set `out_of_range: skip` to discard readings outside every configured range. If an intermediate plateau selects a different user, final correlation fails the measurement rather than routing it to the wrong account.

The user must still match unambiguously when the two-second window ends. If a configuration reload removes that authorization, no profile is written. Updated demographics for the same authorized user are applied before the write.

If you remove a selected user while a completed live reading is queued, that reading is skipped rather than reassigned. This also applies when only one configured user remains. Historical records do not authorize a live session selection.

## Drift Detection

After a match, a weight in the outer 10% of the user's range logs a warning, so you can widen the range before readings go to the wrong person. With Alice at 50 to 70 kg, a reading of 68.5 kg warns that she is near the upper boundary.

## Automatic Weight Tracking

The matched user's `last_known_weight` is written to `config.yaml` 5 seconds after the last reading, when it changed by 0.5 kg or more. This makes overlapping ranges resolve to the right person.

## Per-User Exporters

All users share `global_exporters`. A user who needs their own targets, such as a separate Garmin account, gets an `exporters` list. It is added to `global_exporters`; when the user has an exporter of a type that is also global (for example `garmin`), only theirs is used for that type. A list can hold several exporters of one type, such as two webhooks, and each gets the reading:

```yaml
users:
  - name: Alice
    # ...
    exporters:
      - type: garmin
        email: 'alice@example.com'
        password: '${ALICE_GARMIN_PASSWORD}'
        token_dir: './garmin-tokens/alice'

  - name: Bob
    # ...
    exporters:
      - type: garmin
        email: 'bob@example.com'
        password: '${BOB_GARMIN_PASSWORD}'
        token_dir: './garmin-tokens/bob'

global_exporters:
  - type: influxdb
    # ... shared by Alice and Bob, since neither has an influxdb of their own
```

Give every Garmin and Strava account its own `token_dir`, as above. If two accounts share a directory, the one that authenticates last receives everyone's readings, so the app refuses such a config at startup with an error naming both users. Two Garmin entries with the same `email` can share a directory, since they are one account.

Each user's own [`estimate_body_composition`](/guide/configuration#users) applies to the weigh-ins matched to that user.

### Exporter Behavior in Multi-User Mode

| Exporter     | What changes                                                                |
| ------------ | --------------------------------------------------------------------------- |
| MQTT         | Publishes to `{topic}/{slug}`, one Home Assistant device and LWT per user   |
| InfluxDB     | Adds a `user={slug}` tag                                                    |
| Webhook      | Adds `user_name` and `user_slug` to the JSON (a single user gets them too)  |
| Ntfy         | Starts the notification with `[{name}]` (a single user gets it too)         |
| Telegram     | Starts the message with `[{name}]` (a single user gets it too)              |
| Garmin       | One account per user, each with its own `token_dir`                         |
| Strava       | One account per user, each with its own `token_dir`                         |
| Dreeve       | One instance per user; a shared one keeps only the last weigh-in of the day |

## Live Config Reload

Which `config.yaml` changes apply without a restart is listed under [Live config reload](/guide/configuration#live-config-reload).
