---
title: Exporters
description: Configure Garmin Connect, Strava, MQTT, Webhook, InfluxDB, Ntfy, and File export targets.
---

# Exporters

BLE Scale Sync exports body composition data to 7 targets. The [setup wizard](/guide/configuration#setup-wizard-recommended) walks you through exporter selection, configuration, and connectivity testing.

Exporters are configured in `global_exporters` (shared by all users). For multi-user setups with separate accounts, see [Per-User Exporters](/multi-user#per-user-exporters). All enabled exporters run in parallel — the process reports an error only if **every** exporter fails.

| Target | Description |
|---|---|
| [**Garmin Connect**](#garmin) | Automatic body composition upload — no phone app needed |
| [**MQTT**](#mqtt) | Home Assistant auto-discovery with 10 sensors, LWT |
| [**InfluxDB**](#influxdb) | Time-series database (v2 write API) |
| [**Webhook**](#webhook) | Any HTTP endpoint — n8n, Make, Zapier, custom APIs |
| [**Ntfy**](#ntfy) | Push notifications to phone/desktop |
| [**File (CSV/JSONL)**](#file) | Append readings to a local file |
| [**Strava**](#strava) | Update weight in your Strava athlete profile |

## Garmin Connect {#garmin}

Automatic body composition upload to Garmin Connect — no phone app needed. Uses a Python subprocess with cached authentication tokens.

| Field | Required | Default | Description |
|---|---|---|---|
| `email` | Yes | — | Garmin account email |
| `password` | Yes | — | Garmin account password |
| `token_dir` | No | `~/.garmin_tokens` | Directory for cached auth tokens |

```yaml
global_exporters:
  - type: garmin
    email: '${GARMIN_EMAIL}'
    password: '${GARMIN_PASSWORD}'
```

::: tip Authentication
The setup wizard handles Garmin authentication automatically. You only need to authenticate once — tokens are cached and reused. To re-authenticate manually:

**Native:**

```bash
npm run setup-garmin
```

**Docker (single user with env vars):**

```bash
docker run --rm -it \
  -v ./config.yaml:/app/config.yaml \
  -v garmin-tokens:/home/node/.garmin_tokens \
  -e GARMIN_EMAIL \
  -e GARMIN_PASSWORD \
  ghcr.io/kristianp26/ble-scale-sync:latest setup-garmin
```

**Docker (specific user from config.yaml):**

```bash
docker run --rm -it \
  -v ./config.yaml:/app/config.yaml \
  -v garmin-tokens-alice:/home/node/.garmin_tokens_alice \
  -e GARMIN_EMAIL -e GARMIN_PASSWORD \
  ghcr.io/kristianp26/ble-scale-sync:latest setup-garmin --user Alice
```

**Docker (all users from config.yaml):**

```bash
docker run --rm -it \
  -v ./config.yaml:/app/config.yaml \
  -v garmin-tokens-alice:/home/node/.garmin_tokens_alice \
  -v garmin-tokens-bob:/home/node/.garmin_tokens_bob \
  -e GARMIN_EMAIL -e GARMIN_PASSWORD \
  ghcr.io/kristianp26/ble-scale-sync:latest setup-garmin --all-users
```

:::

::: warning IP blocking
Garmin may block requests from cloud/VPN IPs. If authentication fails, try from a different network, then copy the token directory to your target machine.
:::

## MQTT {#mqtt}

Publishes body composition as JSON to an MQTT broker. **Home Assistant auto-discovery** is enabled by default — all 10 metrics appear as sensors grouped under a single device, with availability tracking (LWT) and display precision per metric.

| Field | Required | Default | Description |
|---|---|---|---|
| `broker_url` | Yes | — | `mqtt://host:1883` or `mqtts://` for TLS |
| `topic` | No | `scale/body-composition` | Publish topic |
| `qos` | No | `1` | QoS level (0, 1, or 2) |
| `retain` | No | `true` | Retain last message |
| `username` | No | — | Broker auth username |
| `password` | No | — | Broker auth password |
| `client_id` | No | `ble-scale-sync` | MQTT client identifier |
| `ha_discovery` | No | `true` | Home Assistant auto-discovery |
| `ha_device_name` | No | `BLE Scale` | Device name in Home Assistant |

```yaml
global_exporters:
  - type: mqtt
    broker_url: 'mqtts://broker.example.com:8883'
    username: myuser
    password: '${MQTT_PASSWORD}'
```

## Webhook {#webhook}

Sends body composition as JSON to any HTTP endpoint. Works with n8n, Make, Zapier, or custom APIs.

| Field | Required | Default | Description |
|---|---|---|---|
| `url` | Yes | — | Target URL |
| `method` | No | `POST` | HTTP method |
| `headers` | No | — | Custom headers (YAML object) |
| `timeout` | No | `10000` | Request timeout in ms |

```yaml
global_exporters:
  - type: webhook
    url: 'https://example.com/hook'
    headers:
      X-Api-Key: '${WEBHOOK_API_KEY}'
```

## InfluxDB {#influxdb}

Writes metrics to InfluxDB v2 using line protocol. Float fields use 2 decimal places, integer fields use `i` suffix.

| Field | Required | Default | Description |
|---|---|---|---|
| `url` | Yes | — | InfluxDB server URL |
| `token` | Yes | — | API token with write access |
| `org` | Yes | — | Organization name |
| `bucket` | Yes | — | Destination bucket |
| `measurement` | No | `body_composition` | Measurement name |

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

| Field | Required | Default | Description |
|---|---|---|---|
| `url` | No | `https://ntfy.sh` | Ntfy server URL |
| `topic` | Yes | — | Topic name |
| `title` | No | `Scale Measurement` | Notification title |
| `priority` | No | `3` | Priority (1–5) |
| `token` | No | — | Bearer token auth |
| `username` | No | — | Basic auth username |
| `password` | No | — | Basic auth password |

```yaml
global_exporters:
  - type: ntfy
    topic: my-scale
    priority: 4
```

## File (CSV/JSONL) {#file}

Append each reading to a local CSV or JSONL file. Useful for simple logging without external services.

| Field | Required | Default | Description |
|---|---|---|---|
| `file_path` | Yes | | Path to the output file |
| `format` | No | `csv` | `csv` or `jsonl` |

```yaml
global_exporters:
  - type: file
    file_path: './measurements.csv'
    format: csv
```

CSV files get an automatic header row on first write. JSONL files append one JSON object per line.

## Strava {#strava}

Update your weight in the Strava athlete profile. Requires a Strava API application (create one at [strava.com/settings/api](https://www.strava.com/settings/api)).

| Field | Required | Default | Description |
|---|---|---|---|
| `client_id` | Yes | | Strava API application client ID |
| `client_secret` | Yes | | Strava API application client secret |
| `token_dir` | No | `./strava-tokens` | Directory for cached OAuth tokens |

```yaml
users:
  - name: Alice
    exporters:
      - type: strava
        client_id: '${STRAVA_CLIENT_ID}'
        client_secret: '${STRAVA_CLIENT_SECRET}'
```

::: tip Authentication
After adding the Strava exporter to your config, run the setup script to authorize:

```bash
npm run setup-strava
```

The script opens a browser URL for Strava authorization. After authorizing, paste the code from the redirect URL. Tokens are cached and automatically refreshed.
:::

## Secrets

Use `${ENV_VAR}` references in YAML for passwords and tokens. The variable must be defined in the environment or in a `.env` file:

```yaml
global_exporters:
  - type: garmin
    email: '${GARMIN_EMAIL}'
    password: '${GARMIN_PASSWORD}'
```

See [Configuration — Environment Variables](/guide/configuration#environment-variables) for details.

## Healthchecks

At startup, exporters are tested for connectivity. Failures are logged as warnings but don't block the scan.

| Exporter | Method |
|---|---|
| MQTT | Connect + disconnect |
| Webhook | HEAD request |
| InfluxDB | `/health` endpoint |
| Ntfy | `/v1/health` endpoint |
| Garmin | None (Python subprocess) |
| File | Directory writable check |
| Strava | None (avoid API rate limits) |
