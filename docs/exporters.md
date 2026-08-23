---
title: Exporters
description: Configure Garmin Connect, Strava, Intervals.icu, Runalyze, Wger, MQTT, Webhook, InfluxDB, Ntfy, Telegram, and File export targets.
head:
  - - meta
    - name: keywords
      content: garmin connect scale sync, strava weight sync, intervals.icu wellness weight, runalyze body composition, wger weight sync, mqtt home assistant scale, influxdb body weight, smart scale webhook, ntfy notifications, telegram scale notifications, scale data export csv, garmin body composition upload
---

# Exporters

BLE Scale Sync exports body composition data to 11 targets. The [setup wizard](/guide/configuration#setup-wizard-recommended) walks you through exporter selection, configuration, and connectivity testing.

Exporters are configured in `global_exporters` (shared by all users). For multi-user setups with separate accounts, see [Per-User Exporters](/multi-user#per-user-exporters). All enabled exporters run in parallel; the process reports an error only if **every** exporter fails.

| Target                          | Description                                            |
| ------------------------------- | ------------------------------------------------------ |
| [**Garmin Connect**](#garmin)   | Automatic body composition upload, no phone app needed |
| [**MQTT**](#mqtt)               | Home Assistant auto-discovery with 10 sensors, LWT     |
| [**InfluxDB**](#influxdb)       | Time-series database (v2 write API)                    |
| [**Webhook**](#webhook)         | Any HTTP endpoint (n8n, Make, Zapier, custom APIs)     |
| [**Ntfy**](#ntfy)               | Push notifications to phone/desktop                    |
| [**Telegram**](#telegram)       | Send measurement notifications to a Telegram chat      |
| [**File (CSV/JSONL)**](#file)   | Append readings to a local file                        |
| [**Strava**](#strava)           | Update weight in your Strava athlete profile           |
| [**Intervals.icu**](#intervals) | Push weight + body fat to Intervals.icu wellness       |
| [**Runalyze**](#runalyze)       | Push weight + body composition to Runalyze metrics     |
| [**Wger**](#wger)               | Push weight + body composition to a Wger instance      |

## Garmin Connect {#garmin}

Automatic body composition upload to Garmin Connect, no phone app needed. Uses a Python subprocess with cached authentication tokens.

| Field       | Required | Default            | Description                      |
| ----------- | -------- | ------------------ | -------------------------------- |
| `email`     | Yes      | (none)             | Garmin account email             |
| `password`  | Yes      | (none)             | Garmin account password          |
| `token_dir` | No       | `~/.garmin_tokens` | Directory for cached auth tokens |

```yaml
global_exporters:
  - type: garmin
    email: '${GARMIN_EMAIL}'
    password: '${GARMIN_PASSWORD}'
```

::: tip Authentication
The setup wizard handles Garmin authentication automatically. You only need to authenticate once; tokens are cached and reused. To re-authenticate manually:

**Standalone (Node.js):**

```bash
npm run setup-garmin
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
v1.8.1 bumps `garminconnect` to 0.3.x, which replaced the old garth-based OAuth files (`oauth1_token.json`, `oauth2_token.json`) with a single `garmin_tokens.json`. Existing tokens are incompatible. Re-run `npm run setup-garmin`; the script auto-removes the legacy files before writing the new format.
:::

## MQTT {#mqtt}

Publishes body composition as JSON to an MQTT broker. **Home Assistant auto-discovery** is enabled by default; all 10 metrics appear as sensors grouped under a single device, with availability tracking (LWT) and display precision per metric.

::: tip Home Assistant users
If you run Home Assistant OS or Supervised, the [Home Assistant Add-on](./guide/home-assistant-addon) auto-detects the Mosquitto broker through the Supervisor API, so you do not need to wire MQTT manually.
:::

| Field            | Required | Default                  | Description                              |
| ---------------- | -------- | ------------------------ | ---------------------------------------- |
| `broker_url`     | Yes      | (none)                   | `mqtt://host:1883` or `mqtts://` for TLS |
| `topic`          | No       | `scale/body-composition` | Publish topic                            |
| `qos`            | No       | `1`                      | QoS level (0, 1, or 2)                   |
| `retain`         | No       | `true`                   | Retain last message                      |
| `username`       | No       | (none)                   | Broker auth username                     |
| `password`       | No       | (none)                   | Broker auth password                     |
| `client_id`      | No       | `ble-scale-sync`         | MQTT client identifier                   |
| `ha_discovery`   | No       | `true`                   | Home Assistant auto-discovery            |
| `ha_device_name` | No       | `BLE Scale`              | Device name in Home Assistant            |

```yaml
global_exporters:
  - type: mqtt
    broker_url: 'mqtts://broker.example.com:8883'
    username: myuser
    password: '${MQTT_PASSWORD}'
```

## Webhook {#webhook}

Sends body composition as JSON to any HTTP endpoint. Works with n8n, Make, Zapier, or custom APIs.

| Field     | Required | Default | Description                  |
| --------- | -------- | ------- | ---------------------------- |
| `url`     | Yes      | (none)  | Target URL                   |
| `method`  | No       | `POST`  | HTTP method                  |
| `headers` | No       | (none)  | Custom headers (YAML object) |
| `timeout` | No       | `10000` | Request timeout in ms        |

```yaml
global_exporters:
  - type: webhook
    url: 'https://example.com/hook'
    headers:
      X-Api-Key: '${WEBHOOK_API_KEY}'
```

## InfluxDB {#influxdb}

Writes metrics to InfluxDB v2 using line protocol. Float fields use 2 decimal places, integer fields use `i` suffix.

| Field         | Required | Default            | Description                 |
| ------------- | -------- | ------------------ | --------------------------- |
| `url`         | Yes      | (none)             | InfluxDB server URL         |
| `token`       | Yes      | (none)             | API token with write access |
| `org`         | Yes      | (none)             | Organization name           |
| `bucket`      | Yes      | (none)             | Destination bucket          |
| `measurement` | No       | `body_composition` | Measurement name            |

```yaml
global_exporters:
  - type: influxdb
    url: 'http://localhost:8086'
    token: '${INFLUXDB_TOKEN}'
    org: my-org
    bucket: my-bucket
```

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
    topic: my-scale
    priority: 4
```

Weight, muscle and bone follow `scale.weight_unit`.

With `report_exports: true` the notification is sent after the other exporters finish and ends with one line per exporter, `✅ garmin` or `❌ garmin: <error>`, so a failed sync is visible on the phone. The notification then arrives once the slowest exporter (and its retries) is done.

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

The message is sent as plain text. Weight, muscle and bone follow `scale.weight_unit`. `report_exports` works as for [Ntfy](#ntfy). In multi-user setups the user's name is prepended as `[Name]`. Historical readings replayed from a scale's offline cache are skipped (a notification for an old measurement is not meaningful).

::: tip Finding your chat ID
Message your bot once, then open `https://api.telegram.org/bot<token>/getUpdates` in a browser — the `chat.id` field holds your chat ID. For groups, add the bot to the group first.
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

| Field           | Required | Default           | Description                          |
| --------------- | -------- | ----------------- | ------------------------------------ |
| `client_id`     | Yes      |                   | Strava API application client ID     |
| `client_secret` | Yes      |                   | Strava API application client secret |
| `token_dir`     | No       | `./strava-tokens` | Directory for cached OAuth tokens    |

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
After adding the Strava exporter to your config, run the setup script to authorize:

**Standalone (Node.js):**

```bash
npm run setup-strava
```

**Docker:**

```bash
docker run --rm -it \
  -v ./config.yaml:/app/config.yaml \
  -v strava-tokens:/app/strava-tokens \
  ghcr.io/kristianp26/ble-scale-sync:latest setup-strava
```

The script prints a browser URL for Strava authorization. After authorizing, copy the `code` parameter from the redirect URL and paste it back. Tokens are cached and automatically refreshed.
:::

## Intervals.icu {#intervals}

Push weight and body fat to your [Intervals.icu](https://intervals.icu) wellness data. Intervals.icu is a free training-analytics platform — a natural fit alongside the Garmin and Strava exporters.

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

Authentication uses HTTP Basic with the API key — no OAuth flow. Find both values on the Intervals.icu **Settings → Developer** page. The reading updates the wellness record for its day (`weight` + `bodyFat`); historical readings replayed from a scale's offline cache land on their original date.

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

## Secrets

Use `${ENV_VAR}` references in YAML for passwords and tokens. The variable must be defined in the environment or in a `.env` file:

```yaml
global_exporters:
  - type: garmin
    email: '${GARMIN_EMAIL}'
    password: '${GARMIN_PASSWORD}'
```

See [Configuration: Environment Variables](/guide/configuration#environment-variables) for details.

## Healthchecks

At startup, exporters are tested for connectivity. Failures are logged as warnings but don't block the scan.

| Exporter      | Method                       |
| ------------- | ---------------------------- |
| MQTT          | Connect + disconnect         |
| Webhook       | HEAD request                 |
| InfluxDB      | `/health` endpoint           |
| Ntfy          | `/v1/health` endpoint        |
| Telegram      | `getChat` endpoint           |
| Intervals.icu | `GET` wellness record        |
| Runalyze      | `GET` bodyComposition metric |
| Wger          | `GET` userprofile record     |
| Garmin        | None (Python subprocess)     |
| File          | Directory writable check     |
| Strava        | None (avoid API rate limits) |
