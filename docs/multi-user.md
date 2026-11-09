---
title: Multi-user support
description: How BLE Scale Sync decides who stepped on the scale, warns about weight drift and sends each user's readings to their own exporters.
---

# Multi-user support

With several users configured, the app picks the person on the scale and uses their profile and exporters. It goes by the scale's user slot when the scale sends one and exactly one user claims it, otherwise by the measured weight. The [setup wizard](/guide/configuration#setup-wizard-recommended) adds users and their weight ranges.

## Who is on the scale {#how-it-works}

1. Someone steps on the scale.
2. The app picks the user who claims the scale's user slot. When no single user claims it, it matches the weight to a user by the users' weight ranges.
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

The example shows only the matching fields. Every user also needs `slug`, `height`, `birth_date`, `gender` and `is_athlete`, and the file needs `version: 1`. See the [config.yaml reference](/guide/configuration#config-yaml-reference).

## Scale user slot

Experimental. The Beurer BF720, BF105, BF500, BF788, BF915 and BF950 send their user slot with each weigh-in; other scales are matched by weight. When exactly one user has that slot as `beurer_user_index`, the weigh-in goes to that user without weight matching, and the log shows `[Alice] Matched (tier: slot)`:

```yaml
users:
  - name: Alice
    beurer_user_index: 1 # slot 1 on the scale
  - name: Bob
    beurer_user_index: 2
```

The app signs in as the first user's slot. If every weigh-in goes to the first user and that slot is 1, leave out the first user's `beurer_user_index` so weight matching decides.

- Only a value set in `config.yaml` counts. The consent code uses slot 1 when the key is unset, but that does not make the user the owner of slot 1.
- The slot owner's `weight_range` still applies: with `out_of_range: skip`, a weigh-in outside it is dropped even when another user's range covers it. `unknown_user` does not apply.
- When two or more users claim the same slot, the live weigh-in is matched by its weight and the log names the users.

## Weight matching

When no user slot decides, the first rule that applies picks the user:

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

Once any user has a `last_known_weight`, a reading outside every range is still assigned to someone. To drop such readings, set `out_of_range: skip` ([Out-of-range readings](/guide/configuration#out-of-range-readings)). The setup wizard writes it when it saves a config with more than one user.

A scale that sends weigh-ins stored in its memory assigns each one by its own user slot or weight, as above, not to the person on the scale now. A stored weigh-in that matches nobody, fits several users equally, or has a slot that two or more users claim, is dropped and logged.

## Drift detection

A matched weight in the outer 10% of the user's range logs a warning, so you can widen the range before readings go to the wrong person. With Alice at 50 to 70 kg, a reading of 68.5 kg warns that she is near the upper boundary.

## Automatic weight tracking

The matched user's `last_known_weight` is written to `config.yaml` 5 seconds after the last reading, when it changed by 0.5 kg or more. That lets overlapping ranges resolve to the right person.

## Per-user exporters

All users share `global_exporters`. A user who needs their own targets, such as a separate Garmin account, gets an `exporters` list. It adds to `global_exporters`; for a type that is also global (for example `garmin`), only the user's own is used. A list can hold several exporters of one type, such as two webhooks, and each gets the reading:

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

Give every Garmin and Strava account its own `token_dir`, as above. Accounts that share a directory would send everyone's readings to the one that authenticates last, so the app refuses such a config at startup with an error naming both users. Two Garmin entries with the same `email` can share a directory, since they are one account.

Each user's own [`estimate_body_composition`](/guide/configuration#users) applies to the weigh-ins matched to that user.

### Exporter behavior in multi-user mode

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

## Live config reload

Which `config.yaml` changes apply without a restart is listed under [Live config reload](/guide/configuration#live-config-reload).
