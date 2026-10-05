---
title: Exporters
description: Configure Garmin Connect, Strava, Intervals.icu, Runalyze, Wger, HealthLog, MQTT, Webhook, InfluxDB, Ntfy, Telegram, and File export targets.
head:
  - - meta
    - name: keywords
      content: garmin connect scale sync, strava weight sync, intervals.icu wellness weight, runalyze body composition, wger weight sync, healthlog body composition, mqtt home assistant scale, influxdb body weight, smart scale webhook, ntfy notifications, telegram scale notifications, scale data export csv, garmin body composition upload
---

# Exporters

BLE Scale Sync exports body composition data to 12 targets. The [setup wizard](/guide/configuration#setup-wizard-recommended) walks you through exporter selection, configuration, and connectivity testing.

Exporters are configured in `global_exporters` (shared by all users). For multi-user setups with separate accounts, see [Per-User Exporters](/multi-user#per-user-exporters). All enabled exporters run in parallel; the process reports an error only if **every** exporter fails.

A weigh-in a scale stored in its memory and sends later keeps its original time. It goes only to exporters that can record a past measurement (Garmin, InfluxDB, file, Intervals, Runalyze, wger, HealthLog), never to MQTT, webhooks or notifications, and it does not end the live weigh-in.

| Target                          | Description                                            |
| ------------------------------- | ------------------------------------------------------ |
| [**Garmin Connect**](#garmin)   | Automatic body composition upload, no phone app needed |
| [**MQTT**](#mqtt)               | Home Assistant auto-discovery with 11 sensors, LWT     |
| [**InfluxDB**](#influxdb)       | Time-series database (v2 and v3)                       |
| [**Webhook**](#webhook)         | Any HTTP endpoint (n8n, Make, Zapier, custom APIs)     |
| [**Ntfy**](#ntfy)               | Push notifications to phone/desktop                    |
| [**Telegram**](#telegram)       | Send measurement notifications to a Telegram chat      |
| [**File (CSV/JSONL)**](#file)   | Append readings to a local file                        |
| [**Strava**](#strava)           | Update weight in your Strava athlete profile           |
| [**Intervals.icu**](#intervals) | Push weight + body fat to Intervals.icu wellness       |
| [**Runalyze**](#runalyze)       | Push weight + body composition to Runalyze metrics     |
| [**Wger**](#wger)               | Push weight + body composition to a Wger instance      |
| [**HealthLog**](#healthlog)     | Push weight + body composition to a HealthLog instance |

## Garmin Connect {#garmin}

Automatic body composition upload to Garmin Connect, no phone app needed. Uses a Python subprocess with cached authentication tokens.

| Field                | Required | Default            | Description                                                                                                                                     |
| -------------------- | -------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `email`              | Yes      | (none)             | Garmin account email                                                                                                                            |
| `password`           | Yes      | (none)             | Garmin account password                                                                                                                         |
| `token_dir`          | No       | `~/.garmin_tokens` | Directory for cached auth tokens. A relative path is relative to the directory `config.yaml` is in; the setup wizard fills in `./garmin-tokens` |
| `weight_only`        | No       | `false`            | Upload the weight alone, leaving every derived metric unset                                                                                     |
| `skip_metabolic_age` | No       | `false`            | Upload every metric except metabolic age                                                                                                        |
| `upload_timeout_sec` | No       | `180`              | Seconds one upload attempt may take before it is killed (10-900). Up to three attempts are made, 1 s and 2 s apart                              |

```yaml
global_exporters:
  - type: garmin
    email: '${GARMIN_EMAIL}'
    password: '${GARMIN_PASSWORD}'
```

::: tip Slow Garmin days
Each upload attempt is killed after `upload_timeout_sec` seconds, and up to three attempts are made. The default of 180 s covers a Garmin Connect that is merely slow; if you see `Python uploader timed out` three times for a measurement that uploads fine by hand afterwards, raise it (the maximum is 900).

The cost of a higher value is only paid when Garmin is actually failing: the three attempts are only 1 s and 2 s apart, so a dead Garmin takes about three times the timeout to give up, and in continuous mode the next scan cycle and the ntfy/Telegram summary wait that long too.

```yaml
global_exporters:
  - type: garmin
    email: '${GARMIN_EMAIL}'
    password: '${GARMIN_PASSWORD}'
    upload_timeout_sec: 300
```

:::

::: tip Weight only
Set `weight_only: true` to record just the weight and leave BMI, body fat, water, bone mass, muscle mass, visceral fat, physique rating, metabolic age and BMR unset in Garmin Connect. Useful when you trust the scale's weight but not its bioimpedance estimates. In continuous mode the config watcher picks it up on the next scan cycle, so no restart is needed (unless you have set `runtime.watch_config: false`). It does not affect any other exporter.

Note that Garmin Connect derives its own BMI from the weight and the height in your Garmin profile, so a BMI figure may still appear on the entry - it just will not be the scale's.

```yaml
global_exporters:
  - type: garmin
    email: '${GARMIN_EMAIL}'
    password: '${GARMIN_PASSWORD}'
    weight_only: true
```

:::

::: tip Skip metabolic age
Set `skip_metabolic_age: true` to upload everything except metabolic age. The estimate compares your BMR with a reference BMR for the same weight and height. Unless `is_athlete` is set, weight and height cancel and the result depends on age alone. Either way it carries no body composition. Garmin Connect then shows no metabolic age on the entry. Garmin's own Fitness Age is calculated separately and is not affected.

```yaml
global_exporters:
  - type: garmin
    email: '${GARMIN_EMAIL}'
    password: '${GARMIN_PASSWORD}'
    skip_metabolic_age: true
```

:::

::: tip Authentication
The setup wizard handles Garmin authentication automatically. You only need to authenticate once; tokens are cached and reused. To re-authenticate manually:

**Standalone (Node.js):**

```bash
ble-scale-sync setup-garmin   # from a clone: npm run setup-garmin
```

**Docker (single user with env vars):**

```bash
docker run --rm -it \
  -v ./config.yaml:/app/config.yaml \
  -v ./garmin-tokens:/app/garmin-tokens \
  -e GARMIN_EMAIL \
  -e GARMIN_PASSWORD \
  ghcr.io/kristianp26/ble-scale-sync:latest setup-garmin
```

**Docker (specific user from config.yaml):**

```bash
docker run --rm -it \
  -v ./config.yaml:/app/config.yaml \
  -v ./garmin-tokens-alice:/app/garmin-tokens-alice \
  -e GARMIN_EMAIL -e GARMIN_PASSWORD \
  ghcr.io/kristianp26/ble-scale-sync:latest setup-garmin --user Alice
```

**Docker (all users from config.yaml):**

```bash
docker run --rm -it \
  -v ./config.yaml:/app/config.yaml \
  -v ./garmin-tokens-alice:/app/garmin-tokens-alice \
  -v ./garmin-tokens-bob:/app/garmin-tokens-bob \
  -e GARMIN_EMAIL -e GARMIN_PASSWORD \
  ghcr.io/kristianp26/ble-scale-sync:latest setup-garmin --all-users
```

:::

::: warning IP blocking
Garmin may block requests from cloud/VPN IPs. If authentication fails, try from a different network, then copy the token directory to your target machine.
:::

::: warning Upgrading from v1.8.0 or earlier
v1.8.1 bumps `garminconnect` to 0.3.x, which replaced the old garth-based OAuth files (`oauth1_token.json`, `oauth2_token.json`) with a single `garmin_tokens.json`. Existing tokens are incompatible. Re-run `ble-scale-sync setup-garmin` (`npm run setup-garmin` from a clone); the script auto-removes the legacy files before writing the new format.
:::

## MQTT {#mqtt}

Publishes body composition as JSON to an MQTT broker. **Home Assistant auto-discovery** is enabled by default; all 11 metrics (weight, impedance and the nine body composition values) appear as sensors grouped under a single device, with availability tracking (LWT) and display precision per metric.

::: tip Home Assistant users
If you run Home Assistant OS or Supervised, the [Home Assistant Add-on](./guide/home-assistant-addon) auto-detects the Mosquitto broker through the Supervisor API, so you do not need to wire MQTT manually.
:::

| Field            | Required | Default                  | Description                                                              |
| ---------------- | -------- | ------------------------ | ------------------------------------------------------------------------ |
| `broker_url`     | Yes      | (none)                   | `mqtt://host:1883` or `mqtts://` for TLS                                 |
| `topic`          | No       | `scale/body-composition` | Base topic; readings go to `<topic>/<user slug>`, with a single user too |
| `qos`            | No       | `1`                      | QoS level (0, 1, or 2)                                                   |
| `retain`         | No       | `true`                   | Retain last message                                                      |
| `username`       | No       | (none)                   | Broker auth username                                                     |
| `password`       | No       | (none)                   | Broker auth password                                                     |
| `client_id`      | No       | `ble-scale-sync`         | MQTT client identifier                                                   |
| `ha_discovery`   | No       | `true`                   | Home Assistant auto-discovery                                            |
| `ha_device_name` | No       | `BLE Scale`              | Device name in Home Assistant                                            |

```yaml
global_exporters:
  - type: mqtt
    broker_url: 'mqtts://broker.example.com:8883'
    username: myuser
    password: '${MQTT_PASSWORD}'
```

Availability uses an MQTT last will: when the app loses the broker without a clean shutdown (a crash, a network drop), the broker publishes `offline` for it, so Home Assistant shows the sensors as unavailable until the app reconnects.

## Webhook {#webhook}

Sends body composition as JSON to any HTTP endpoint. Works with n8n, Make, Zapier, or custom APIs.

| Field     | Required | Default | Description                                                                  |
| --------- | -------- | ------- | ---------------------------------------------------------------------------- |
| `url`     | Yes      | (none)  | Target URL                                                                   |
| `method`  | No       | `POST`  | HTTP method                                                                  |
| `headers` | No       | (none)  | Custom headers, as a YAML object or a `Name: value` list separated by commas |
| `timeout` | No       | `10000` | Request timeout in ms                                                        |

```yaml
global_exporters:
  - type: webhook
    url: 'https://example.com/hook'
    headers:
      X-Api-Key: '${WEBHOOK_API_KEY}'
```

## InfluxDB {#influxdb}

Writes metrics using line protocol. Float fields use 2 decimal places, integer fields use `i` suffix.

Works with **InfluxDB v2 and v3**. v3 keeps a v2-compatible `/api/v2/write` endpoint that accepts the same line protocol, the same `Token` authorization scheme and the same 204 response, so one exporter covers both.

| Field         | Required | Default            | Description                                   |
| ------------- | -------- | ------------------ | --------------------------------------------- |
| `url`         | Yes      | (none)             | InfluxDB server URL                           |
| `token`       | Yes      | (none)             | API token with write access                   |
| `org`         | v2 only  | (none)             | Organization name. Omit on v3, which has none |
| `bucket`      | Yes      | (none)             | Bucket name on v2, database name on v3        |
| `measurement` | No       | `body_composition` | Measurement name                              |

**InfluxDB v2:**

```yaml
global_exporters:
  - type: influxdb
    url: 'http://localhost:8086'
    token: '${INFLUXDB_TOKEN}'
    org: my-org
    bucket: my-bucket
```

**InfluxDB v3** (Core, Enterprise, Cloud), where `org` is left out and `bucket` names the database:

```yaml
global_exporters:
  - type: influxdb
    url: 'http://localhost:8181'
    token: '${INFLUXDB_TOKEN}'
    bucket: my-database
```

Setting `org` on v3 is harmless, since the server ignores the parameter, but leaving it out keeps the config honest about what the target actually has.

## Ntfy {#ntfy}

Push notifications to phone/desktop via [ntfy](https://ntfy.sh). Works with ntfy.sh or self-hosted instances.

| Field            | Required | Default             | Description                         |
| ---------------- | -------- | ------------------- | ----------------------------------- |
| `url`            | No       | `https://ntfy.sh`   | Ntfy server URL                     |
| `topic`          | Yes      | (none)              | Topic name                          |
| `title`          | No       | `Scale Measurement` | Notification title                  |
| `priority`       | No       | `3`                 | Priority (1 to 5)                   |
| `token`          | No       | (none)              | Bearer token auth                   |
| `username`       | No       | (none)              | Basic auth username                 |
| `password`       | No       | (none)              | Basic auth password                 |
| `report_exports` | No       | `false`             | Append the other exporters' results |

```yaml
global_exporters:
  - type: ntfy
    topic: '<long-random-topic-name>' # your own; <> is not valid in a topic name
    priority: 4
```

::: warning The topic is the password
ntfy has no sign-up, so the topic name is essentially a password: anyone who knows it can subscribe and read its recent messages, and each notification carries your name, weight and body composition. Use a long random topic name of your own, or a self-hosted server or an access token.
:::

Weight, muscle and bone follow `scale.weight_unit`.

With `report_exports: true` the notification is sent after the other exporters finish and ends with one line per non-reporting exporter, `✅ garmin` or `❌ garmin: <error>`, so a failed sync is visible on the phone. Two notifiers with the flag set do not report on each other. The notification arrives once the slowest exporter (and its retries) is done; with Garmin that can be more than nine minutes at the default `upload_timeout_sec` of 180 s, when every attempt times out. Error text is forwarded as-is (truncated to 120 characters), so a public ntfy topic will carry it.

## Telegram {#telegram}

Send a measurement notification to a Telegram chat via a bot. Create a bot with [@BotFather](https://t.me/BotFather) to get a bot token, then start a chat with your bot (or add it to a group/channel) so it can message you.

| Field            | Required | Default             | Description                                    |
| ---------------- | -------- | ------------------- | ---------------------------------------------- |
| `bot_token`      | Yes      | (none)              | Bot token from @BotFather                      |
| `chat_id`        | Yes      | (none)              | Target chat ID (numeric) or `@channelusername` |
| `title`          | No       | `Scale Measurement` | First line of the message                      |
| `silent`         | No       | `false`             | Deliver without a notification sound           |
| `report_exports` | No       | `false`             | Append the other exporters' results            |

```yaml
global_exporters:
  - type: telegram
    bot_token: '${TELEGRAM_BOT_TOKEN}'
    chat_id: '987654321'
    title: Scale Measurement
    silent: false
```

The message is sent as plain text. Weight, muscle and bone follow `scale.weight_unit`. `report_exports` works as for [Ntfy](#ntfy). The user's `name` is prepended as `[Name]`, with a single user as well. Historical readings replayed from a scale's offline cache are skipped (a notification for an old measurement is not meaningful).

::: tip Finding your chat ID
Message your bot once, then open `https://api.telegram.org/bot<token>/getUpdates` in a browser - the `chat.id` field holds your chat ID. For groups, add the bot to the group first.
:::

## File (CSV/JSONL) {#file}

Append each reading to a local CSV or JSONL file. Useful for simple logging without external services.

| Field       | Required | Default | Description             |
| ----------- | -------- | ------- | ----------------------- |
| `file_path` | Yes      |         | Path to the output file |
| `format`    | No       | `csv`   | `csv` or `jsonl`        |

```yaml
global_exporters:
  - type: file
    file_path: './measurements.csv'
    format: csv
```

CSV files get an automatic header row on first write. JSONL files append one JSON object per line.

::: tip Docker
Mount a volume so the file persists across container restarts:

```yaml
volumes:
  - scale-data:/app/data
# config.yaml: file_path: './data/measurements.csv'
```

:::

## Strava {#strava}

Update your weight in the Strava athlete profile. Requires a Strava API application.

| Field           | Required | Default           | Description                                                                      |
| --------------- | -------- | ----------------- | -------------------------------------------------------------------------------- |
| `client_id`     | Yes      |                   | Strava API application client ID                                                 |
| `client_secret` | Yes      |                   | Strava API application client secret                                             |
| `token_dir`     | No       | `./strava-tokens` | Directory for cached OAuth tokens, relative to the directory `config.yaml` is in |

```yaml
users:
  - name: Alice
    exporters:
      - type: strava
        client_id: '${STRAVA_CLIENT_ID}'
        client_secret: '${STRAVA_CLIENT_SECRET}'
```

### Creating a Strava API Application

1. Go to [strava.com/settings/api](https://www.strava.com/settings/api)
2. Upload an **Application Icon** (required before you can save the form)
3. Fill in the application details:
   - **Application Name**: anything you like (e.g. `BLE Scale Sync`)
   - **Category**: choose any
   - **Website**: can be anything (e.g. `https://github.com/KristianP26/ble-scale-sync`)
   - **Authorization Callback Domain**: set to `localhost` (the OAuth flow redirects here, but the page does not need to load)
4. Save and copy the **Client ID** and **Client Secret**

::: warning Callback Domain
The **Authorization Callback Domain** must be set to `localhost`. During the OAuth flow, Strava redirects to `http://localhost?code=XXXX`. The page will not load (nothing is listening), but you only need to copy the `code` parameter from the URL bar.
:::

::: tip Authentication
The setup wizard offers Strava authorization after you add the exporter there (in edit mode, pick the **Strava Authorization** section). To authorize later, or for an exporter added by hand, run the setup script:

**Standalone (Node.js):**

```bash
ble-scale-sync setup-strava   # from a clone: npm run setup-strava
```

**Docker:**

```bash
mkdir -p strava-tokens
docker run --rm -it \
  -v ./config.yaml:/app/config.yaml \
  -v ./strava-tokens:/app/strava-tokens \
  ghcr.io/kristianp26/ble-scale-sync:latest setup-strava
```

The run commands in [Getting Started](/guide/getting-started) and the compose examples mount only `garmin-tokens`. Add the Strava directory to the container that runs the app, or the exporter will not find the tokens: `-v ./strava-tokens:/app/strava-tokens` in the `docker run` command, or a `- ./strava-tokens:/app/strava-tokens` line under `volumes:` in the compose file. The [setup wizard](/guide/configuration#setup-wizard-recommended) command already mounts it.

The script prints a browser URL for Strava authorization. After authorizing, copy the `code` parameter from the redirect URL and paste it back. Tokens are cached and automatically refreshed.

With several users that each have a Strava exporter, name the one to authorize: `ble-scale-sync setup-strava --user alice` (name or slug). Each of them needs its own `token_dir`.
:::

## Intervals.icu {#intervals}

Push weight and body fat to your [Intervals.icu](https://intervals.icu) wellness data. Intervals.icu is a free training-analytics platform - a natural fit alongside the Garmin and Strava exporters.

| Field        | Required | Default | Description                                     |
| ------------ | -------- | ------- | ----------------------------------------------- |
| `athlete_id` | Yes      | (none)  | Intervals.icu athlete ID (e.g. `i123456`)       |
| `api_key`    | Yes      | (none)  | API key from Intervals.icu Settings → Developer |

```yaml
users:
  - name: Alice
    exporters:
      - type: intervals
        athlete_id: i123456
        api_key: '${INTERVALS_API_KEY}'
```

Authentication uses HTTP Basic with the API key - no OAuth flow. Find both values on the Intervals.icu **Settings → Developer** page. The reading updates the wellness record for its day (`weight` + `bodyFat`); historical readings replayed from a scale's offline cache land on their original date. The day is taken in your Intervals.icu timezone, not the host's, so a Docker container running on UTC files a late-evening weigh-in on the right day.

## Runalyze {#runalyze}

Push weight and body composition to [Runalyze](https://runalyze.com), an endurance-training analytics platform, as health metrics.

| Field   | Required | Default | Description                                                  |
| ------- | -------- | ------- | ------------------------------------------------------------ |
| `token` | Yes      | (none)  | Personal API token from Runalyze **Settings → Personal API** |

```yaml
users:
  - name: Alice
    exporters:
      - type: runalyze
        token: '${RUNALYZE_TOKEN}'
```

Authentication uses the Runalyze Personal API token (sent in the `token` header), no OAuth flow. Generate it at [runalyze.com/settings/personal-api](https://runalyze.com/settings/personal-api); note that Runalyze tokens require an expiry date, so the token has to be regenerated when it lapses.

The reading is sent to the `bodyComposition` metric with an exact timestamp, so historical readings replayed from a scale's offline cache land on their original date and time. Weight, body fat and body water map directly; muscle and bone are converted from mass to a percentage of body weight (Runalyze stores those as percentages). Metrics that an adapter could not measure are omitted.

## Wger {#wger}

Push weight and body composition to [Wger](https://wger.de), the open-source self-hosted workout and weight manager. A natural fit for the self-hosting audience, and it matches what `openScale-sync` already supports.

| Field               | Required | Default | Description                                                        |
| ------------------- | -------- | ------- | ------------------------------------------------------------------ |
| `base_url`          | Yes      | (none)  | Wger instance URL, e.g. `https://wger.de` or your self-hosted host |
| `token`             | Yes      | (none)  | Permanent API key from `<base_url>/en/user/api-key`                |
| `sync_measurements` | No       | `true`  | Also push body fat, water, muscle, bone as custom measurements     |

```yaml
users:
  - name: Alice
    exporters:
      - type: wger
        base_url: https://wger.de
        token: '${WGER_TOKEN}'
        sync_measurements: true
```

Authentication uses a permanent API key (sent as `Authorization: Token <key>`), no OAuth flow. Generate it on the Wger account settings **API** page. Weight is written to a weight entry on the reading's calendar day, so historical readings replayed from a scale's offline cache land on their original date. With `sync_measurements` enabled, body fat and water (percent) and muscle and bone (kg) are written as Wger custom measurements; the matching categories are created automatically on first use and reused afterwards. Measurement failures are logged but do not block the weight sync.

Wger stores the weight in the unit set in your Wger profile, so the exporter reads `/api/v2/userprofile/` before each export and sends pounds to a profile set to pounds; the API key must be allowed to read the profile. The calendar day comes from the host's clock, so in Docker set `TZ` to your time zone (the compose examples do), or a late-evening weigh-in lands on the next day.

## HealthLog {#healthlog}

Push weight and body composition to [HealthLog](https://github.com/MBombeck/HealthLog), a self-hosted personal health record.

| Field               | Required | Default | Description                                                   |
| ------------------- | -------- | ------- | ------------------------------------------------------------- |
| `base_url`          | Yes      | (none)  | HealthLog instance URL, e.g. `https://healthlog.example`      |
| `token`             | Yes      | (none)  | Measurement ingest token from **Settings -> API & Tokens**    |
| `sync_measurements` | No       | `true`  | Also push body fat, body water, muscle, bone and visceral fat |

```yaml
users:
  - name: Alice
    exporters:
      - type: healthlog
        base_url: https://healthlog.example
        token: '${HEALTHLOG_TOKEN}'
        sync_measurements: true
```

Authentication uses HealthLog's **Measurement ingest token**, sent as `Authorization: Bearer <token>`, no OAuth flow. Mint it in HealthLog under **Settings -> API & Tokens -> Measurement ingest token**. It is shown only once, it can only add readings to your own record (it cannot read anything back), and it **expires after a year**, so mint a new one and update `token` when it lapses. HealthLog marks the readings it receives this way as coming from an external device.

Each value is a separate `POST /api/measurements` carrying the reading's exact time, so historical readings replayed from a scale's offline cache land on their original date and time. HealthLog takes the unit from the measurement type, so every value is sent already in that unit:

| HealthLog type     | Sent as                                                                   | HealthLog accepts |
| ------------------ | ------------------------------------------------------------------------- | ----------------- |
| `WEIGHT`           | kg                                                                        | 1-500             |
| `BODY_FAT`         | percent                                                                   | 1-80              |
| `TOTAL_BODY_WATER` | kg, computed as weight x body water percent (HealthLog stores it as mass) | 5-100             |
| `MUSCLE_MASS`      | kg                                                                        | 5-200             |
| `BONE_MASS`        | kg                                                                        | 0.5-8             |
| `VISCERAL_FAT`     | rating                                                                    | 0-30              |

Everything after the weight is sent only with `sync_measurements` enabled. Those are the same values every other exporter receives, so on a scale without impedance they are the BMI-based estimates described in [Body Composition](/body-composition). A body composition value outside the range HealthLog accepts is not sent, since HealthLog would refuse it. In practice that is a visceral fat rating above 30: ours runs up to 59. A failed body composition value is logged but does not fail the export; a failed weight does.

HealthLog refuses a second reading with the same type and time with `409`. The exporter counts that as already recorded rather than as a failure, so when a retry repeats a value that did reach HealthLog (the response was lost on the way back), the export does not report an error.

The startup healthcheck calls HealthLog's public `/api/version` endpoint, which needs no token. It confirms the instance is reachable, not that the token is valid: a wrong or expired token shows up on the first export.

## Secrets

Use `${ENV_VAR}` references in YAML for passwords and tokens. The variable must be defined in the environment or in a `.env` file:

```yaml
global_exporters:
  - type: garmin
    email: '${GARMIN_EMAIL}'
    password: '${GARMIN_PASSWORD}'
```

See [Configuration: Environment Variables](/guide/configuration#environment-variables) for details.

::: warning A boolean field must spell a boolean
An `${ENV_VAR}` reference is resolved to a **string** before the exporter reads it, so a true/false field only accepts a value that reads as one: `true`, `yes`, `1`, `on`, or `false`, `no`, `0`, `off`, or empty. Anything else stops that exporter from being built, with an error naming the field, rather than being guessed at in one direction or the other.

This applies to `weight_only` and `skip_metabolic_age` (garmin), `retain` and `ha_discovery` (mqtt), `silent` (telegram), `report_exports` (ntfy and telegram) and `sync_measurements` (wger and healthlog). So `MQTT_RETAIN=maybe` is an error, not a default.
:::

## Historical readings

Some scales keep measurements taken while nothing was listening and replay them on the next connection. Two adapters currently pass that recorded time on: **Beurer BF720** (and the BF105, BF500, BF788 and BF950 it serves) and **Renpho ES-26BB**. A reading carrying a time is treated differently from a live one.

Several other scales replay a cache without a usable time. Salter is the explicit case: its stored records are delivered as ordinary readings on purpose, because a dated reading it could not date correctly would be buffered rather than exported.

A reading with a timestamp is sent **only to exporters that can record it at that time**:

| Exporter    | Accepts a backdated reading |
| ----------- | --------------------------- |
| `file`      | Yes                         |
| `garmin`    | Yes                         |
| `influxdb`  | Yes                         |
| `intervals` | Yes                         |
| `runalyze`  | Yes                         |
| `wger`      | Yes                         |
| `healthlog` | Yes                         |
| `mqtt`      | No                          |
| `webhook`   | No                          |
| `ntfy`      | No                          |
| `strava`    | No                          |
| `telegram`  | No                          |

The five that say No have no way to express "this happened on Tuesday": an MQTT sensor state and a push notification are both about now, so replaying a three-day-old weigh-in through them would put a stale number in front of you as if it had just been measured.

So a scale that replays its cache fills in your Garmin and InfluxDB history while Home Assistant shows only the live weigh-ins. The log says so each time it happens:

```
Historical reading (2026-09-07T06:12:44.000Z): skipping non-back-date exporters [mqtt, ntfy]
```

Every reading taken while the app is running is a live reading and goes to every configured exporter.

## Healthchecks

At startup, exporters are tested for connectivity. Failures are logged as warnings but don't block the scan.

| Exporter      | Method                         |
| ------------- | ------------------------------ |
| MQTT          | Connect + disconnect           |
| Webhook       | HEAD request                   |
| InfluxDB      | `/health` endpoint, with token |
| Ntfy          | `/v1/health` endpoint          |
| Telegram      | `getChat` endpoint             |
| Intervals.icu | `GET` wellness record          |
| Runalyze      | `GET` bodyComposition metric   |
| Wger          | `GET` userprofile record       |
| HealthLog     | `GET` public `/api/version`    |
| Garmin        | None (Python subprocess)       |
| File          | Directory writable check       |
| Strava        | None (avoid API rate limits)   |
