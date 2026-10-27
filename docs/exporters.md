---
title: Exporters
description: Options and behavior of every export target, from Garmin Connect and MQTT to InfluxDB, webhooks, notifications, files and self-hosted fitness apps.
---

# Exporters

Every reading goes to all enabled exporters in parallel. Exporters under `global_exporters` are shared by all users, and a user can have their own ([Per-User Exporters](/multi-user#per-user-exporters)); the [setup wizard](/guide/configuration#setup-wizard-recommended) adds and tests them.

A run reports an error only when every exporter fails. A failed export to a target that can record a past measurement is retried later ([`runtime.retry_failed_exports`](/guide/configuration#runtime)). A weigh-in the scale replays from its memory goes only to those targets too, see [Historical readings](#historical-readings).

| Target                          | What it does                                           |
| ------------------------------- | ------------------------------------------------------ |
| [Garmin Connect](#garmin)       | Uploads weight and body composition, no phone app      |
| [MQTT](#mqtt)                   | Home Assistant auto-discovery sensors, LWT             |
| [InfluxDB](#influxdb)           | Time-series database (v2 and v3)                       |
| [Webhook](#webhook)             | Any HTTP endpoint (n8n, Make, Zapier, custom APIs)     |
| [Ntfy](#ntfy)                   | Push notification to phone or desktop                  |
| [Telegram](#telegram)           | Message to a Telegram chat                             |
| [File (CSV/JSONL)](#file)       | Appends readings to a local file                       |
| [Strava](#strava)               | Updates the weight in your Strava athlete profile      |
| [Intervals.icu](#intervals)     | Weight and body fat to Intervals.icu wellness          |
| [Runalyze](#runalyze)           | Weight and body composition to Runalyze metrics        |
| [Wger](#wger)                   | Weight and body composition to a Wger instance         |
| [HealthLog](#healthlog)         | Weight and body composition to a HealthLog instance    |
| [Dreeve](#dreeve)               | Weight to a self-hosted Dreeve instance                |

The [Renpho R-MSC04 extras](/guide/scales/renpho#r-msc04-morphoscan-nova), skeletal muscle percentage and segment impedances, reach MQTT, Webhook, File JSONL and InfluxDB with the weigh-ins that carry them. Ntfy and Telegram show only the skeletal muscle percentage; CSV and the other targets get the same fields for every scale.

## Garmin Connect {#garmin}

Uploads weight and body composition to Garmin Connect through a Python helper that reuses cached login tokens. A standalone install needs Python 3.12 or newer; the Docker image and the Home Assistant add-on include it.

| Field                | Required | Default            | Description                                                                                                                |
| -------------------- | -------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `email`              | Yes      | (none)             | Garmin account email                                                                                                       |
| `password`           | Yes      | (none)             | Garmin account password                                                                                                    |
| `token_dir`          | No       | `~/.garmin_tokens` | Directory for cached login tokens. A relative path is relative to the directory of `config.yaml`; the wizard writes `./garmin-tokens` |
| `weight_only`        | No       | `false`            | Upload the weight alone, leaving every derived metric unset                                                                |
| `skip_metabolic_age` | No       | `false`            | Upload every metric except metabolic age                                                                                   |
| `upload_timeout_sec` | No       | `180`              | Seconds one upload attempt may take before it is killed (10-900). Three attempts are made, 1 s and 2 s apart               |

```yaml
global_exporters:
  - type: garmin
    email: '${GARMIN_EMAIL}'
    password: '${GARMIN_PASSWORD}'
```

### Authentication {#garmin-authentication}

You authenticate once; the tokens are cached and reused. The setup wizard does it for you. To do it by hand:

```bash
ble-scale-sync setup-garmin --all-users   # every Garmin user in config.yaml
ble-scale-sync setup-garmin --user Alice  # one user, by name or slug
# from a clone: npm run setup-garmin -- --all-users
```

Both read the email, password and `token_dir` from `config.yaml`. Without arguments, `setup-garmin` reads `GARMIN_EMAIL` and `GARMIN_PASSWORD` from the environment or `.env` and writes to `TOKEN_DIR`, otherwise to `~/.garmin_tokens`. If the account uses MFA, the script asks for the code.

In Docker, mount `config.yaml` and the token directories that `config.yaml` names. `-e` passes `GARMIN_EMAIL` and `GARMIN_PASSWORD` from your shell, for a `config.yaml` that references them:

```bash
mkdir -p garmin-tokens
docker run --rm -it \
  -v ./config.yaml:/app/config.yaml \
  -v ./garmin-tokens:/app/garmin-tokens \
  -e GARMIN_EMAIL -e GARMIN_PASSWORD \
  ghcr.io/kristianp26/ble-scale-sync:latest setup-garmin --all-users
```

On the Home Assistant add-on the add-on signs in on its first start; for an account with MFA see [Sign in to Garmin with MFA](/guide/home-assistant-addon#mfa-workaround).

### Weight Only

`weight_only: true` records only the weight and leaves BMI, body fat, water, bone mass, muscle mass, visceral fat, physique rating, metabolic age and BMR unset in Garmin Connect, for when you trust the scale's weight but not its impedance estimates. Garmin Connect still shows a BMI it computes from your Garmin profile height. Other exporters are not affected.

### Skip Metabolic Age

`skip_metabolic_age: true` uploads everything except metabolic age, for when you do not want the app's metabolic age in Garmin. The body age a [QN scale](/guide/scales/qn) with a 19-byte scale-info frame sends is skipped too. Garmin's own Fitness Age is not affected.

### Upload Timeout

If the log shows `Python uploader timed out` three times for a measurement that uploads fine by hand later, Garmin Connect was slow: raise `upload_timeout_sec`, up to 900. A Garmin that is down then takes about three times the timeout to give up, and in continuous mode the next scan cycle and the ntfy or Telegram summary wait as long.

### Troubleshooting

Garmin can block logins from cloud and VPN IP addresses. If authentication fails there, authenticate on another network and copy the token directory to the machine that runs the app.

## MQTT {#mqtt}

Publishes each weigh-in as JSON to an MQTT broker, with Home Assistant auto-discovery on by default. On Home Assistant OS or Supervised, the [Home Assistant add-on](/guide/home-assistant-addon) finds the Mosquitto broker by itself.

| Field            | Required | Default                  | Description                                                              |
| ---------------- | -------- | ------------------------ | ------------------------------------------------------------------------ |
| `broker_url`     | Yes      | (none)                   | `mqtt://host:1883`, or `mqtts://` for TLS                                |
| `topic`          | No       | `scale/body-composition` | Base topic; readings go to `<topic>/<user slug>`, with a single user too |
| `qos`            | No       | `1`                      | QoS level (0, 1 or 2)                                                    |
| `retain`         | No       | `true`                   | Retain the last message                                                  |
| `username`       | No       | (none)                   | Broker username                                                          |
| `password`       | No       | (none)                   | Broker password                                                          |
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

### Message

Each weigh-in is one message on `<topic>/<user slug>`. Masses are in kg whatever `scale.weight_unit` is:

```json
{
  "timestamp": "2026-10-20T21:30:00.000Z",
  "weight": 80,
  "impedance": 500,
  "bmi": 23.9,
  "bodyFatPercent": 18.5,
  "waterPercent": 55.2,
  "boneMass": 3.1,
  "muscleMass": 62.4,
  "visceralFat": 8,
  "physiqueRating": 5,
  "bmr": 1750,
  "metabolicAge": 30
}
```

`timestamp` is when the weigh-in was measured, in ISO 8601 UTC: the scale's own time when it sends one, otherwise the time the reading reached the app. Weigh-ins a scale sends from its memory do not go to MQTT, so it is always the last live weigh-in.

The R-MSC04 extras are `skeletalMusclePercent` and ten segment impedances in ohm: `impedanceTrunk20kHz`, `impedanceTrunk100kHz`, and the same pairs for `LeftArm`, `RightArm`, `LeftLeg` and `RightLeg`. A key is in the message only when that weigh-in carries it.

### Home Assistant Sensors

Discovery creates one device per user, with a sensor for weight, impedance, BMI, body fat, water, bone mass, muscle mass, visceral fat, physique rating, BMR, metabolic age and the time of the last weigh-in (**Last Weigh-in**). Each sensor has its own display precision.

The R-MSC04 extras get sensors the first time a message carries them: **Skeletal Muscle**, and one per segment impedance (**Impedance Left Arm 20 kHz** and so on), which are diagnostic and disabled until you enable them on the device page. A later message without one of these keys shows its sensor as unknown. With `retain: false` such a sensor can miss the value of the weigh-in that created it, because Home Assistant subscribes to its topic only once the sensor exists.

Availability uses an MQTT last will: when the app loses the broker without a clean shutdown, the broker publishes `offline` and Home Assistant shows the sensors as unavailable until the app reconnects.

### Detect a New Weigh-In

Use the **Last Weigh-in** value, not a sensor's `last_changed`. Because the message is retained, every `last_changed` becomes the time of a Home Assistant restart, and a weigh-in with the same weight as the last one does not change the weight sensor. The timestamp changes with every weigh-in and keeps its value across a restart. A state trigger on it needs `not_from`, because after a restart or a broker reconnect the sensor comes back from `unknown` or `unavailable` with the old time:

```yaml
triggers:
  - trigger: state
    entity_id: sensor.ble_scale_alice_last_weigh_in # your Last Weigh-in sensor
    not_from:
      - unknown
      - unavailable
```

Such a trigger skips a weigh-in made while Home Assistant was down. With `ha_discovery: false`, define the sensor yourself:

```yaml
mqtt:
  sensor:
    - name: 'Last Weigh-in'
      state_topic: 'scale/body-composition/alice' # <topic>/<user slug>
      value_template: '{{ value_json.timestamp }}'
      device_class: timestamp
```

## Webhook {#webhook}

Sends each weigh-in as JSON to any HTTP endpoint, such as n8n, Make, Zapier or your own API. The body is the [MQTT message](#message) without `timestamp`, plus `user_name` and `user_slug`.

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

Writes each weigh-in in line protocol, with floats at 2 decimal places and integers with the `i` suffix. One exporter covers InfluxDB v2 and v3, through the `/api/v2/write` endpoint both have.

| Field         | Required | Default            | Description                                   |
| ------------- | -------- | ------------------ | --------------------------------------------- |
| `url`         | Yes      | (none)             | InfluxDB server URL                           |
| `token`       | Yes      | (none)             | API token with write access                   |
| `org`         | v2 only  | (none)             | Organization name. Leave it out on v3         |
| `bucket`      | Yes      | (none)             | Bucket name on v2, database name on v3        |
| `measurement` | No       | `body_composition` | Measurement name                              |

InfluxDB v2:

```yaml
global_exporters:
  - type: influxdb
    url: 'http://localhost:8086'
    token: '${INFLUXDB_TOKEN}'
    org: my-org
    bucket: my-bucket
```

InfluxDB v3 (Core, Enterprise, Cloud), where `bucket` names the database:

```yaml
global_exporters:
  - type: influxdb
    url: 'http://localhost:8181'
    token: '${INFLUXDB_TOKEN}'
    bucket: my-database
```

## Ntfy {#ntfy}

Sends a push notification through [ntfy](https://ntfy.sh), on ntfy.sh or a self-hosted server.

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
    topic: YOUR_LONG_RANDOM_TOPIC
    priority: 4
```

::: warning The topic is the password
Anyone who knows an ntfy.sh topic can subscribe to it and read its recent messages, and each notification carries your name, weight and body composition. Use a long random topic name, a self-hosted server or an access token.
:::

Weight, muscle and bone follow `scale.weight_unit`. Each notification starts with the user's name as `[Name]`, with a single user too.

With `report_exports: true` the notification waits for the other exporters and ends with one line per exporter: a check mark and its name, or a cross, its name and the error. Two notifiers with the flag do not report on each other. The notification then arrives after the slowest exporter and its retries: with Garmin at the default `upload_timeout_sec`, about nine minutes when every attempt times out. Error text is forwarded as it is, cut to 120 characters, so a public topic carries it too.

## Telegram {#telegram}

Sends a message to a Telegram chat through a bot.

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
```

1. Create a bot with [@BotFather](https://t.me/BotFather) and copy its token.
2. Send the bot a message, or add it to the group or channel it should post to.
3. Open `https://api.telegram.org/bot<token>/getUpdates` in a browser and copy the `chat.id` value.

The message is plain text. Weight, muscle and bone follow `scale.weight_unit`, the user's name comes first as `[Name]`, and `report_exports` works as for [Ntfy](#ntfy).

## File (CSV/JSONL) {#file}

Appends each reading to a local CSV or JSONL file.

| Field       | Required | Default | Description             |
| ----------- | -------- | ------- | ----------------------- |
| `file_path` | Yes      | (none)  | Path to the output file |
| `format`    | No       | `csv`   | `csv` or `jsonl`        |

```yaml
global_exporters:
  - type: file
    file_path: './measurements.csv'
    format: csv
```

A CSV file gets a header row on the first write; JSONL gets one JSON object per line. In Docker, a relative `file_path` is relative to `/app`. Put the file in a mounted host directory, or it is lost when the container is re-created: create it first with UID 1000 as owner (`mkdir data && sudo chown 1000:1000 data`), mount it with `-v ./data:/app/data` and set `file_path: './data/measurements.csv'`.

## Strava {#strava}

Updates the weight in your Strava athlete profile. Requires a Strava API application, which works only while the account that owns it has a Strava subscription; without one, the healthcheck and every update fail with HTTP 403.

| Field           | Required | Default           | Description                                                                      |
| --------------- | -------- | ----------------- | -------------------------------------------------------------------------------- |
| `client_id`     | Yes      | (none)            | Strava API application client ID                                                 |
| `client_secret` | Yes      | (none)            | Strava API application client secret                                             |
| `token_dir`     | No       | `./strava-tokens` | Directory for cached OAuth tokens, relative to the directory of `config.yaml`    |

```yaml
users:
  - name: Alice
    exporters:
      - type: strava
        client_id: '${STRAVA_CLIENT_ID}'
        client_secret: '${STRAVA_CLIENT_SECRET}'
```

### Create a Strava API Application {#creating-a-strava-api-application}

1. Open [strava.com/settings/api](https://www.strava.com/settings/api).
2. Upload an **Application Icon**; the form does not save without one.
3. Fill in any **Application Name**, **Category** and **Website**.
4. Set **Authorization Callback Domain** to `localhost`.
5. Save, then copy the **Client ID** and **Client Secret**.

### Authentication {#strava-authentication}

The setup wizard offers Strava authorization after you add the exporter (in edit mode, the **Strava Authorization** section). For an exporter added by hand, run:

```bash
ble-scale-sync setup-strava   # from a clone: npm run setup-strava
```

In Docker:

```bash
mkdir -p strava-tokens
docker run --rm -it \
  -v ./config.yaml:/app/config.yaml \
  -v ./strava-tokens:/app/strava-tokens \
  ghcr.io/kristianp26/ble-scale-sync:latest setup-strava
```

The script prints a URL to open in a browser. After you authorize, Strava redirects to `http://localhost?code=...`, a page that does not load; copy the `code` value from the address bar and paste it into the script. Tokens are refreshed automatically after that.

With several users that each have a Strava exporter, name the one to authorize: `ble-scale-sync setup-strava --user alice` (name or slug). Each needs its own `token_dir`.

The container that runs the app needs the same `strava-tokens` mount, as in the [Docker commands](/guide/getting-started#docker), or the exporter does not find the tokens.

## Intervals.icu {#intervals}

Writes weight and body fat to the [Intervals.icu](https://intervals.icu) wellness record of the day.

| Field        | Required | Default | Description                                      |
| ------------ | -------- | ------- | ------------------------------------------------ |
| `athlete_id` | Yes      | (none)  | Intervals.icu athlete ID, for example `i123456`  |
| `api_key`    | Yes      | (none)  | API key from **Settings** > **Developer**           |

```yaml
users:
  - name: Alice
    exporters:
      - type: intervals
        athlete_id: i123456
        api_key: '${INTERVALS_API_KEY}'
```

The key is sent with HTTP Basic auth. The day is taken in your Intervals.icu time zone, not the host's, so a container on UTC files a late-evening weigh-in on the right day. A [stored weigh-in](#historical-readings) lands on its own date.

## Runalyze {#runalyze}

Writes weight and body composition to the `bodyComposition` health metric of [Runalyze](https://runalyze.com).

| Field   | Required | Default | Description                                                  |
| ------- | -------- | ------- | ------------------------------------------------------------ |
| `token` | Yes      | (none)  | Personal API token from **Settings** > **Personal API**         |

```yaml
users:
  - name: Alice
    exporters:
      - type: runalyze
        token: '${RUNALYZE_TOKEN}'
```

Generate the token at [runalyze.com/settings/personal-api](https://runalyze.com/settings/personal-api). Runalyze tokens have an expiry date, so generate a new one when it lapses.

Each reading carries its exact time, so a [stored weigh-in](#historical-readings) lands at its own date and time. Weight, body fat and body water map directly; muscle and bone are sent as a percentage of body weight, as Runalyze stores them. Metrics the scale did not provide are left out.

## Wger {#wger}

Writes weight and body composition to [Wger](https://wger.de), on wger.de or your own instance.

| Field               | Required | Default | Description                                                         |
| ------------------- | -------- | ------- | ------------------------------------------------------------------- |
| `base_url`          | Yes      | (none)  | Wger instance URL, for example `https://wger.de`                    |
| `token`             | Yes      | (none)  | Permanent API key from `<base_url>/en/user/api-key`                 |
| `sync_measurements` | No       | `true`  | Also send body fat, water, muscle and bone as custom measurements   |

```yaml
users:
  - name: Alice
    exporters:
      - type: wger
        base_url: https://wger.de
        token: '${WGER_TOKEN}'
```

The weight is a weight entry on the reading's calendar day, so a [stored weigh-in](#historical-readings) lands on its own date. With `sync_measurements`, body fat and water (percent) and muscle and bone (kg) become custom measurements; the categories are created on first use. A failed measurement is logged and does not block the weight.

Wger stores the weight in the unit of your Wger profile, so the exporter reads `/api/v2/userprofile/` before each export and sends pounds to a profile set to pounds; the API key must be allowed to read the profile. The calendar day comes from the host clock, so in Docker set `TZ` to your time zone, or a late-evening weigh-in lands on the next day.

## HealthLog {#healthlog}

Writes weight and body composition to [HealthLog](https://github.com/MBombeck/HealthLog), a self-hosted personal health record.

| Field               | Required | Default | Description                                                   |
| ------------------- | -------- | ------- | ------------------------------------------------------------- |
| `base_url`          | Yes      | (none)  | HealthLog instance URL, for example `https://healthlog.example` |
| `token`             | Yes      | (none)  | Measurement ingest token from **Settings** > **API & Tokens**    |
| `sync_measurements` | No       | `true`  | Also send body fat, body water, muscle, bone and visceral fat |

```yaml
users:
  - name: Alice
    exporters:
      - type: healthlog
        base_url: https://healthlog.example
        token: '${HEALTHLOG_TOKEN}'
```

Create the token in HealthLog under **Settings** > **API & Tokens** > **Measurement ingest token**. It is shown only once, can only add readings to your own record, and expires after a year: then create a new one and update `token`.

Each value is a separate measurement with the reading's exact time, so a [stored weigh-in](#historical-readings) lands at its own date and time. Values are sent in the unit HealthLog expects for the type:

| HealthLog type     | Sent as                                   | HealthLog accepts |
| ------------------ | ----------------------------------------- | ----------------- |
| `WEIGHT`           | kg                                        | 1-500             |
| `BODY_FAT`         | percent                                   | 1-80              |
| `TOTAL_BODY_WATER` | kg, weight x body water percent           | 5-100             |
| `MUSCLE_MASS`      | kg                                        | 5-200             |
| `BONE_MASS`        | kg                                        | 0.5-8             |
| `VISCERAL_FAT`     | rating                                    | 0-30              |

Everything after the weight needs `sync_measurements`. On a scale without impedance these are the BMI-based estimates from [Body Composition](/body-composition). A value outside the accepted range, such as a visceral fat rating above 30, is not sent. A failed body composition value is logged and does not fail the export; a failed weight does. HealthLog answers a repeated value with `409`, which the exporter counts as already recorded.

The startup healthcheck calls the public `/api/version` endpoint, so it confirms the instance is reachable but not that the token is valid; a wrong or expired token shows up on the first export.

## Dreeve {#dreeve}

Writes the weight to [Dreeve](https://github.com/dreeveapp/dreeve), a self-hosted sports dashboard. Requires Dreeve 5.3.3 or newer. Dreeve has no place for body composition, so only the weight is sent.

| Field         | Required | Default | Description                                                                   |
| ------------- | -------- | ------- | ----------------------------------------------------------------------------- |
| `base_url`    | Yes      | (none)  | Your Dreeve `APP_URL`, for example `https://dreeve.example`                   |
| `token`       | Yes      | (none)  | API key (`drv_...`) from **Settings** > **Security** > **API access**               |
| `unit_system` | Yes      | (none)  | `metric` or `imperial`, the same as **Settings** > **Appearance** > **Unit system** |

```yaml
users:
  - name: Alice
    exporters:
      - type: dreeve
        base_url: https://dreeve.example
        token: '${DREEVE_TOKEN}'
        unit_system: metric
```

1. In the Dreeve admin panel, generate a key under **Settings** > **Security** > **API access**.
2. Put it in Dreeve's `.env` as `DREEVE_API_KEY`.
3. Recreate the Dreeve containers; a restart does not reread `.env`.
4. Use the same key as `token`.

One Dreeve instance holds one athlete, so Dreeve is a per-user exporter. With more than one user, do not put it under `global_exporters`: everyone's weigh-ins would land on the same athlete. A `base_url` with a user name or password in it is refused.

Dreeve keeps one weight per calendar day and the last one sent wins, so a retry never creates a duplicate, but an older reading of the same day sent later (a retry or a replay from the scale's memory) replaces a newer one. The day comes from the host clock, so in Docker set `TZ` to your time zone. With `imperial` the weight is sent in pounds; Dreeve does not convert stored entries when its unit system changes, so change `unit_system` with it.

The startup healthcheck calls `/api/v1/status` with the key. A `401` means a wrong key, or a Dreeve whose `DREEVE_API_KEY` is missing or not `drv_` followed by 64 hex characters. A 404 on export means a Dreeve older than 5.3.3.

## Weigh-Ins Without Body Composition

With [`estimate_body_composition: false`](/guide/configuration#users), a weigh-in the scale measured no body composition for has no body fat, water, bone mass, muscle mass, visceral fat or physique rating. Weight, impedance, BMI, BMR and metabolic age are there as usual. Each exporter leaves the missing values out its own way:

| Exporter                  | Missing values                                                                                  |
| ------------------------- | ----------------------------------------------------------------------------------------------- |
| Garmin Connect            | Not set; Garmin records the weight, BMI, BMR and metabolic age                                  |
| MQTT                      | `null` in the message; the Home Assistant sensors show unknown until the next measured weigh-in |
| Webhook, File JSONL       | `null`                                                                                          |
| File CSV                  | Empty cells                                                                                     |
| InfluxDB                  | No field                                                                                        |
| Ntfy, Telegram            | Left out of the message                                                                         |
| Intervals.icu, Runalyze, Wger, HealthLog | Only the weight is sent                                                          |
| Strava, Dreeve            | No change: they only receive the weight                                                         |

## Secrets

Put passwords and tokens in `${ENV_VAR}` references, as in the examples above; see [Secret references](/guide/configuration#secret-references).

## Historical Readings

Some scales store weigh-ins made while nothing was listening and send them, with the time they were measured, on the next connection. A reading whose recorded time is more than 5 minutes old is a past measurement. It goes only to the exporters that can file it under its own time:

- Can record a past measurement: Garmin Connect, InfluxDB, File, Intervals.icu, Runalyze, Wger, HealthLog, Dreeve.
- Skipped: MQTT, Webhook, Ntfy, Telegram, Strava.

A notification is about now, and the MQTT topic holds one retained state, the latest weigh-in, which an older record would overwrite. So a scale that replays its memory fills in your Garmin and InfluxDB history while Home Assistant shows only live weigh-ins. The log says so each time:

```text
Historical reading (2026-09-07T06:12:44.000Z): skipping non-back-date exporters [mqtt, ntfy]
```

The adapters that pass the recorded time on include the Beurer BF720 family, the Renpho ES-26BB and [QN scales](/guide/scales/qn) with a 19-byte scale-info frame, or an 18-byte one with `ble.qn_user_key` set. On an 18-byte QN scale, a weigh-in marked as stored is a past measurement even if its time is recent. Salter scales send stored records as ordinary live readings. With [`runtime.no_reading_rescan_delay`](/guide/configuration#runtime) set, a weigh-in made during the wait can arrive more than 5 minutes late and is then a past measurement too.

### Replay Check

A scale often hands over a stored copy of the weigh-in the app already exported live. A past measurement within 0.1 kg of the user's last live weigh-in, or of their `last_known_weight`, is skipped with `Skipping replay` in the log, unless it was measured more than 5 minutes after that live weigh-in. When the live weigh-in carried the scale's own time, that time is compared, so a scale clock ahead of the host does not make the replay look new.

The weight and time of each user's last live weigh-in are kept per user `slug` in `.last-live-weigh-ins.json` next to `config.yaml`, readable by its owner only, so the check holds across restarts and single-shot runs. Without that file (a `.env`-only setup, a deleted file, or a saved weight 0.5 kg or more away from `last_known_weight` at startup) the comparison uses `last_known_weight` alone, whenever the record was measured. With the single-file `config.yaml` mount of [Docker](/guide/getting-started#docker) it is lost when the container is re-created; on the Home Assistant add-on it is in `/data`. Deleting it while the app is stopped is safe.

## Healthchecks

At startup each exporter is tested for connectivity. A failure is logged as a warning and does not stop the scan.

| Exporter      | Method                             |
| ------------- | ---------------------------------- |
| MQTT          | Connect + disconnect               |
| Webhook       | HEAD request                       |
| InfluxDB      | `/health` endpoint, with token     |
| Ntfy          | `/v1/health` endpoint              |
| Telegram      | `getChat` endpoint                 |
| Intervals.icu | `GET` wellness record              |
| Runalyze      | `GET` bodyComposition metric       |
| Wger          | `GET` userprofile record           |
| HealthLog     | `GET` public `/api/version`        |
| Dreeve        | `GET` `/api/v1/status`, with token |
| Garmin        | None (Python subprocess)           |
| File          | Directory writable check           |
| Strava        | None (avoids API rate limits)      |
