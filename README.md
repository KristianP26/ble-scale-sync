# BLE Scale Sync

A cross-platform CLI tool that reads body composition data from a **BLE smart scale** and exports it to multiple targets. Built with an adapter pattern supporting **23 scale brands** out of the box.

Works on **Linux** (including Raspberry Pi), **macOS**, and **Windows**.

### Export Targets

| Target             | Description                                                        | Protocol          | Auth                             |
| ------------------ | ------------------------------------------------------------------ | ----------------- | -------------------------------- |
| **Garmin Connect** | Automatic body composition upload — no phone app needed            | Python subprocess | Email + password (tokens cached) |
| **MQTT**           | Home automation integration with **Home Assistant auto-discovery** | MQTT 5.0          | Optional username/password       |
| **Webhook**        | Generic HTTP endpoint — n8n, Make, Zapier, custom APIs             | HTTP POST/PUT     | Custom headers                   |
| **InfluxDB**       | Time-series database (v2 write API, line protocol)                 | HTTP              | Token                            |
| **Ntfy**           | Push notifications to phone/desktop via [ntfy.sh](https://ntfy.sh) | HTTP              | Optional Bearer/Basic            |

All exporters run in parallel. Configure any combination in `global_exporters` (or per-user `exporters`) in `config.yaml`. Each exporter is self-describing — it declares its configuration fields, display names, and capabilities — making it easy to add new export targets.

## Why This Exists

Most BLE smart scales measure weight and body impedance over Bluetooth, but their companion apps have no way to sync data to **Garmin Connect**. The only workflow was: open the phone app, wait for it to sync, then manually type the numbers into Garmin. Every single time.

I didn't want to depend on a phone app. So I built this tool. A **Raspberry Pi Zero 2W** sits next to the scale, always on, always listening. Step on the scale, wait a few seconds, and the reading appears in Garmin Connect — **no phone needed, no app, no manual entry**. It just works.

While the project started for one scale, it now supports **23 scale adapters** covering most popular BLE smart scales, so it works regardless of brand.

### Recommended Setup

| Component                 | Recommendation                                                                                                                          |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| **Single-board computer** | [Raspberry Pi Zero 2W](https://www.raspberrypi.com/products/raspberry-pi-zero-2-w/) — cheap, tiny, built-in BLE, low power (~0.4W idle) |
| **Scale**                 | Any supported BLE scale (see list below)                                                                                                |
| **OS**                    | Raspberry Pi OS Lite (headless, no desktop needed)                                                                                      |

### Supported Scales

| Brand / Model                                        | Protocol               |
| ---------------------------------------------------- | ---------------------- |
| **QN-Scale** / Renpho / Senssun / Sencor             | Custom (FFE0 / FFF0)   |
| **Renpho ES-WBE28**                                  | Vendor BCS/WSS         |
| **Renpho ES-26BB**                                   | Custom (1A10)          |
| **Xiaomi Mi Scale 2** (MIBCS / MIBFS)                | Vendor UUID            |
| **Yunmai** Signal / Mini / SE                        | Custom (FFE0)          |
| **Beurer** BF700 / BF710 / BF800                     | Custom (FFE0)          |
| **Sanitas** SBF70 / SBF75 / SBF72 / SBF73            | Custom (FFE0) / BCS    |
| **Beurer BF915**                                     | Standard BCS           |
| **Soehnle** Shape200 / Shape100 / Shape50 / Style100 | Custom UUID            |
| **Medisana** BS430 / BS440 / BS444                   | Custom (78B2)          |
| **Trisa** Body Analyze                               | Custom (7802)          |
| **Excelvan CF369** (Electronic Scale)                | Custom (FFF0)          |
| **Hesley** (YunChen)                                 | Custom (FFF0)          |
| **Inlife** (fatscale)                                | Custom (FFF0)          |
| **Digoo DG-SO38H** (Mengii)                          | Custom (FFF0)          |
| **Senssun Fat**                                      | Custom (FFF0)          |
| **ES-CS20M**                                         | Custom (1A10)          |
| **Exingtech Y1** (vscale)                            | Custom UUID            |
| **1byone** / Eufy C1 / Eufy P1                       | Custom (FFF0 / FFB0)   |
| **Active Era BS-06**                                 | Custom (FFB0)          |
| **MGB** (Swan / Icomon / YG)                         | Custom (FFB0)          |
| **Hoffen BS-8107**                                   | Custom (FFB0)          |
| Any **standard BT SIG BCS/WSS** scale                | Standard (181B / 181D) |

## How It Works

```
┌──────────┐    ┌──────────────┐    ┌─────────────────────────────┐
│          │    │              │    │  ├─ Garmin Connect (Python) │
│   BLE    │    │  BLE + Body  │    │  ├─ MQTT                    │
│  Scale   │───>│ Composition  │───>│  ├─ Webhook (HTTP)          │
│          │    │              │    │  ├─ InfluxDB                │
│          │    │ (TypeScript) │    │  └─ Ntfy (push)             │
└──────────┘    └──────────────┘    └─────────────────────────────┘
```

**TypeScript** (run via `tsx`) scans for a BLE scale using the OS-appropriate handler (node-ble on Linux, `@abandonware/noble` on Windows, `@stoprocent/noble` on macOS), auto-detects the brand via the adapter pattern, and calculates up to 10 body composition metrics. Both noble drivers can be used on any platform via the `NOBLE_DRIVER` env var. Results are dispatched in parallel to all enabled **exporters** — Garmin Connect, MQTT, Webhook, InfluxDB, Ntfy, or any combination.

All exporters run in parallel. The process reports an error only if every exporter fails.

## Prerequisites

### All Platforms

- [Node.js](https://nodejs.org/) v20 or later
- [Python](https://python.org/) 3.9 or later (only needed for Garmin upload)
- Bluetooth Low Energy (BLE) capable adapter

### Linux (Debian/Ubuntu/Raspberry Pi OS)

```bash
sudo apt-get update
sudo apt-get install -y bluetooth bluez libbluetooth-dev libudev-dev build-essential python3-pip

# Install Node.js v20 (skip if already installed — check with: node --version)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Allow Node.js to access BLE without root
sudo setcap cap_net_raw+eip $(eval readlink -f $(which node))
```

### macOS

```bash
# Install Xcode command-line tools (required for native modules)
xcode-select --install

# Install Node.js via Homebrew (skip if already installed — check with: node --version)
brew install node@20
```

No additional Bluetooth setup needed — macOS uses its native CoreBluetooth API.

### Windows

1. Install [Node.js](https://nodejs.org/) v20 or later — download the LTS installer and check "Add to PATH" during installation.
2. Install [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) (select "Desktop development with C++").
3. Install [Python](https://python.org/) and check "Add to PATH" during installation.
4. You need a BLE-compatible Bluetooth adapter. Most built-in adapters work out of the box with the default driver (`@abandonware/noble`).

> **Note:** If you override `NOBLE_DRIVER=stoprocent` on Windows, `@stoprocent/noble` requires the Bluetooth adapter to use WinUSB. See the [noble Windows setup guide](https://github.com/nicedoc/noble#windows) for details. The default `@abandonware/noble` does not require this.

## Installation

```bash
# Clone the repository
git clone https://github.com/KristianP26/ble-scale-sync.git
cd ble-scale-sync

# Install Node.js dependencies
npm install

# Create a Python virtual environment and install dependencies
python3 -m venv venv
source venv/bin/activate        # On Windows: venv\Scripts\activate
pip install -r requirements.txt
```

> **Note:** Modern Linux distributions (Debian 12+, Ubuntu 23.04+, Raspberry Pi OS Bookworm) require a virtual environment for pip — installing globally will fail with `error: externally-managed-environment`. The commands above handle this automatically. **Remember to activate the venv** (`source venv/bin/activate`) before running `npm start` or `npm run setup-garmin`.

## Configuration

The app uses **`config.yaml`** for configuration. Create it in the project root or specify a path with `--config`.

#### CLI Flags

```bash
npm start -- --config /path/to/config.yaml   # Use a custom config file path
npm start -- --help                           # Show usage and environment overrides
npm run validate                              # Validate config.yaml and show summary
npm run validate -- --config /path/to/config.yaml  # Validate a custom config file
```

#### Environment Overrides

These environment variables always override the corresponding `config.yaml` values:

| Variable          | Overrides                 |
| ----------------- | ------------------------- |
| `CONTINUOUS_MODE` | `runtime.continuous_mode` |
| `DRY_RUN`         | `runtime.dry_run`         |
| `DEBUG`           | `runtime.debug`           |
| `SCAN_COOLDOWN`   | `runtime.scan_cooldown`   |
| `SCALE_MAC`       | `ble.scale_mac`           |
| `NOBLE_DRIVER`    | `ble.noble_driver`        |

> **Legacy:** `.env` is also supported as a fallback — see `.env.example`. If both files exist, `config.yaml` takes priority.

### 1. Create your `config.yaml`

```yaml
version: 1

ble:
  scale_mac: 'FF:03:00:13:A1:04' # Optional — omit for auto-discovery
  # noble_driver: abandonware       # Optional — "abandonware" | "stoprocent"

scale:
  weight_unit: kg # kg | lbs (display only — all calculations use kg)
  height_unit: cm # cm | in (for height input)

# Multi-user matching: when weight falls outside all ranges
# "nearest" = assign to closest range midpoint, "log" = log warning + skip, "ignore" = silently skip
unknown_user: nearest

users:
  - name: Alice
    slug: alice
    height: 168
    birth_date: '1995-03-20'
    gender: female
    is_athlete: false
    weight_range: { min: 50, max: 75 }
    last_known_weight: null # Updated automatically after each measurement
    # Per-user exporters (optional — override global_exporters for this user)
    # exporters:
    #   - type: garmin
    #     email: alice@example.com
    #     password: "${GARMIN_PASSWORD}"
    #     token_dir: ./garmin-tokens/alice

  - name: Bob
    slug: bob
    height: 183
    birth_date: '1990-06-15'
    gender: male
    is_athlete: true
    weight_range: { min: 75, max: 100 }
    last_known_weight: 85.5

global_exporters:
  - type: garmin
    email: your_email@example.com
    password: '${GARMIN_PASSWORD}' # ${ENV_VAR} references are resolved at load time
    token_dir: ~/.garmin_tokens

  - type: mqtt
    broker_url: 'mqtt://localhost:1883'
    topic: scale/body-composition
    qos: 1 # 0, 1, or 2
    retain: true
    username: myuser
    password: '${MQTT_PASSWORD}'
    client_id: ble-scale-sync
    ha_discovery: true # Home Assistant auto-discovery
    ha_device_name: BLE Scale

  # - type: webhook
  #   url: "https://example.com/hook"
  #   method: POST
  #   headers:
  #     X-Api-Key: secret123
  #   timeout: 10000

  # - type: influxdb
  #   url: "http://localhost:8086"
  #   token: "${INFLUXDB_TOKEN}"
  #   org: my-org
  #   bucket: my-bucket
  #   measurement: body_composition

  # - type: ntfy
  #   url: "https://ntfy.sh"
  #   topic: my-scale
  #   title: Scale Measurement
  #   priority: 3

runtime:
  continuous_mode: false
  scan_cooldown: 30 # Seconds between scans (5–3600)
  dry_run: false
  debug: false
```

YAML values support `${ENV_VAR}` references — useful for secrets (passwords, tokens). The referenced environment variable must be defined, otherwise config loading fails with an error.

`weight_unit` and `height_unit` default to metric (`kg` / `cm`). Set `height_unit: in` to enter `height` in inches. Set `weight_unit: lbs` to display weight in pounds — all internal calculations and Garmin uploads remain in metric.

`scale_mac` is **optional**. If omitted, the app auto-discovers any recognized scale during `npm start`. To pin to a specific device, add the MAC address from `npm run scan`.

> **Recommended:** Set `scale_mac` to your scale's address. Without it, the app connects to the first recognized scale it finds — which could be a neighbor's scale, since BLE signals easily pass through walls.

### 2. Find your scale's MAC address (optional)

By default, the app auto-discovers your scale — no MAC address needed. If you have multiple BLE scales nearby and want to pin to a specific one, run:

```bash
npm run scan
```

This scans for nearby BLE devices for 15 seconds. Recognized scales are tagged with the adapter name (e.g. `[QN Scale]`, `[Xiaomi Mi Scale 2]`, `[Yunmai]`). Copy the address into `ble.scale_mac` in your `config.yaml`.

> **Tip:** On macOS, BLE peripherals are identified by a CoreBluetooth UUID instead of a MAC address. The `npm run scan` output shows the correct identifier to use for `SCALE_MAC`.

### 3. Authenticate with Garmin Connect

```bash
npm run setup-garmin
```

This logs into Garmin using `GARMIN_EMAIL` and `GARMIN_PASSWORD` environment variables and stores authentication tokens locally (default: `~/.garmin_tokens/`). You only need to do this once — tokens are reused for subsequent syncs.

> **If authentication fails:** Garmin may block requests from certain IPs (especially cloud/VPN IPs). Try running the setup from a different network, then copy the `~/.garmin_tokens/` directory to your target machine.

### 4. Exporters

Each exporter is configured as an entry in `global_exporters` (shared by all users) or per-user `exporters` (overrides global for that user). All enabled exporters run in parallel. The process reports an error only if every exporter fails.

#### Garmin Connect

Uploads body composition to Garmin Connect via Python subprocess with saved tokens.

| Field       | Required | Default               | Description                      |
| ----------- | -------- | --------------------- | -------------------------------- |
| `email`     | No       | `GARMIN_EMAIL` env    | Garmin account email             |
| `password`  | No       | `GARMIN_PASSWORD` env | Garmin account password          |
| `token_dir` | No       | `~/.garmin_tokens`    | Directory for cached auth tokens |

#### MQTT

Publishes the full body composition payload as JSON to the configured topic. **Home Assistant auto-discovery** is enabled by default — all 11 metrics appear as sensors grouped under a single device. Includes availability tracking (LWT), display precision per metric, and diagnostic entity categories.

| Field            | Required | Default                  | Description                                           |
| ---------------- | -------- | ------------------------ | ----------------------------------------------------- |
| `broker_url`     | Yes      | —                        | Broker URL (`mqtt://host:1883` or `mqtts://` for TLS) |
| `topic`          | No       | `scale/body-composition` | Publish topic                                         |
| `qos`            | No       | `1`                      | QoS level (0, 1, or 2)                                |
| `retain`         | No       | `true`                   | Retain last message on broker                         |
| `username`       | No       | —                        | Broker auth username                                  |
| `password`       | No       | —                        | Broker auth password                                  |
| `client_id`      | No       | `ble-scale-sync`         | MQTT client identifier                                |
| `ha_discovery`   | No       | `true`                   | Home Assistant auto-discovery                         |
| `ha_device_name` | No       | `BLE Scale`              | Device name in Home Assistant                         |

#### Webhook

Sends the full body composition payload as JSON to any HTTP endpoint. Useful for automation platforms (n8n, Make, Zapier, custom APIs).

| Field     | Required | Default | Description                  |
| --------- | -------- | ------- | ---------------------------- |
| `url`     | Yes      | —       | Target URL                   |
| `method`  | No       | `POST`  | HTTP method                  |
| `headers` | No       | —       | Custom headers (YAML object) |
| `timeout` | No       | `10000` | Request timeout in ms        |

#### InfluxDB

Writes body composition metrics to InfluxDB v2 using line protocol. Float fields use 2 decimal places, integer fields use InfluxDB's `i` suffix.

| Field         | Required | Default            | Description                 |
| ------------- | -------- | ------------------ | --------------------------- |
| `url`         | Yes      | —                  | InfluxDB server URL         |
| `token`       | Yes      | —                  | API token with write access |
| `org`         | Yes      | —                  | Organization name           |
| `bucket`      | Yes      | —                  | Destination bucket          |
| `measurement` | No       | `body_composition` | Measurement name            |

#### Ntfy

Sends a human-readable push notification via [ntfy](https://ntfy.sh). Works with ntfy.sh or self-hosted.

| Field      | Required | Default             | Description         |
| ---------- | -------- | ------------------- | ------------------- |
| `url`      | No       | `https://ntfy.sh`   | Ntfy server URL     |
| `topic`    | Yes      | —                   | Topic name          |
| `title`    | No       | `Scale Measurement` | Notification title  |
| `priority` | No       | `3`                 | Priority (1–5)      |
| `token`    | No       | —                   | Bearer token auth   |
| `username` | No       | —                   | Basic auth username |
| `password` | No       | —                   | Basic auth password |

## Usage

### Sync your scale

```bash
npm start
```

### Continuous mode (always-on)

Keep the app running and automatically reconnect after each reading. Ideal for a Raspberry Pi sitting next to the scale:

```bash
# Linux / macOS
CONTINUOUS_MODE=true npm start

# Windows (PowerShell)
$env:CONTINUOUS_MODE="true"; npm start
```

Press **Ctrl+C** once for graceful shutdown, twice to force exit. Configure the delay between scans with `SCAN_COOLDOWN` (default: 30 seconds).

### Dry run (read scale, skip exports)

To test the BLE connection and verify readings without uploading anywhere:

```bash
# Linux / macOS
DRY_RUN=true npm start

# Windows (PowerShell)
$env:DRY_RUN="true"; npm start
```

Both modes can be combined: `CONTINUOUS_MODE=true DRY_RUN=true npm start`.

1. The app scans for your scale via Bluetooth. If `SCALE_MAC` is set, it connects to that specific device; otherwise it auto-discovers any recognized scale.
2. **Step on the scale** and wait for the measurement to stabilize.
3. Once weight and impedance data are received, body composition is calculated and dispatched to all enabled exporters.
4. At startup, exporters with a healthcheck (MQTT, Webhook, InfluxDB, Ntfy) are tested for connectivity — failures are logged as warnings but don't block the scan.

### What gets exported

| Metric          | Unit  | Formula                                                                 |
| --------------- | ----- | ----------------------------------------------------------------------- |
| Weight          | kg    | Raw scale reading                                                       |
| BMI             | -     | `weight / (height_m)^2`                                                 |
| Body Fat        | %     | BIA: `LBM = c1*(H^2/Z) + c2*W + c3*A + c4`, `BF% = (W - LBM) / W * 100` |
| Water           | %     | `LBM * 0.73 / W * 100` (athlete: 0.74)                                  |
| Bone Mass       | kg    | `LBM * 0.042`                                                           |
| Muscle Mass     | kg    | `LBM * 0.54` (athlete: 0.60)                                            |
| Visceral Fat    | 1-59  | `BF% * 0.55 - 4 + age * 0.08`                                           |
| Physique Rating | 1-9   | Based on BF% and muscle/weight ratio                                    |
| BMR             | kcal  | Mifflin-St Jeor: `10*W + 6.25*H - 5*A + s` (athlete: +5%)               |
| Metabolic Age   | years | `age + (idealBMR - BMR) / 15`                                           |

Where `W` = weight (kg), `H` = height (cm), `A` = age, `Z` = impedance (ohm), `s` = +5 male / -161 female.

BIA coefficients (c1, c2, c3, c4):

|                  | c1    | c2    | c3     | c4   |
| ---------------- | ----- | ----- | ------ | ---- |
| Male             | 0.503 | 0.165 | -0.158 | 17.8 |
| Male (athlete)   | 0.637 | 0.205 | -0.180 | 12.5 |
| Female           | 0.490 | 0.150 | -0.130 | 11.5 |
| Female (athlete) | 0.550 | 0.180 | -0.150 | 8.5  |

When impedance is not available, body fat is estimated using the Deurenberg formula:
`BF% = 1.2 * BMI + 0.23 * age - 10.8 * sex - 5.4` (sex: 1 = male, 0 = female; athlete: \*0.85).

Scales that provide their own body composition values (fat, water, muscle, bone) use those directly — only BMI, BMR, metabolic age, visceral fat, and physique rating are always calculated from the formulas above.

## Development

### Branches

| Branch | Purpose                                                      |
| ------ | ------------------------------------------------------------ |
| `main` | Stable release branch                                        |
| `dev`  | Active development — PRs and new features target this branch |

CI runs on both `main` and `dev` (push + pull request).

### Testing

```bash
npm test
```

### Validate Config

```bash
npm run validate                              # Validate config.yaml
npm run validate -- --config /path/to/config.yaml  # Validate a custom config file
```

Checks `config.yaml` against the Zod schema and reports the number of users, exporters, and continuous mode status. On error, prints human-readable validation messages with field paths.

Unit tests use [Vitest](https://vitest.dev/) and cover:

- **Body composition math** — `body-comp-helpers.ts`
- **Config schemas** — Zod validation, defaults, error formatting, slug generation
- **Config loading** — YAML parsing, env reference resolution, config source detection, BLE config loader, env overrides
- **Config resolution** — user profile resolution, runtime config extraction, exporter merging, single-user convenience
- **Config writing** — atomic file write, write lock serialization, YAML comment preservation, debounced weight updates
- **User matching** — 4-tier weight matching, all strategies (nearest/log/ignore), overlapping ranges, drift detection
- **Environment validation** — `validate-env.ts` (all validation rules and edge cases)
- **Scale adapters** — `parseNotification()`, `matches()`, `isComplete()`, `computeMetrics()`, and `onConnected()` for all 23 adapters
- **Exporters** — config parsing, MQTT publish/HA discovery, MQTT multi-user topic routing + per-user HA discovery, Garmin subprocess, Webhook/InfluxDB/Ntfy delivery, ExportContext, ntfy drift warning
- **Multi-user flow** — matching → profile resolution → exporter resolution → ExportContext construction, strategy fallback, tiebreak with last_known_weight
- **Orchestrator** — healthcheck runner, export dispatch, parallel execution, partial/total failure handling
- **BLE shared logic** — `waitForRawReading()` and `waitForReading()` in legacy, onConnected, and multi-char modes; weight normalization; disconnect handling
- **BLE utilities** — `formatMac()`, `normalizeUuid()`, `sleep()`, `withTimeout()`, abort signal handling
- **Logger** — `createLogger()`, `setLogLevel()`
- **Utilities** — shared retry logic (`withRetry`), error conversion (`errMsg`)

### Linting & Formatting

```bash
npm run lint          # ESLint check
npm run lint:fix      # ESLint auto-fix
npm run format        # Prettier auto-format
npm run format:check  # Prettier check (CI)
```

The project uses [ESLint](https://eslint.org/) with [typescript-eslint](https://typescript-eslint.io/) and [Prettier](https://prettier.io/). Both are enforced in CI.

## Project Structure

```
ble-scale-sync/
├── src/
│   ├── index.ts                    # Entry point (single/multi-user flow, SIGHUP reload, heartbeat)
│   ├── orchestrator.ts             # Exported orchestration logic (healthchecks, export dispatch)
│   ├── config/
│   │   ├── schema.ts               # Zod schemas (AppConfig, UserConfig, etc.) + WeightUnit
│   │   ├── load.ts                 # Unified config loader (YAML + .env fallback)
│   │   ├── resolve.ts              # Config → runtime types (UserProfile, exporters, etc.)
│   │   ├── validate-cli.ts         # CLI entry point for npm run validate
│   │   ├── slugify.ts              # Slug generation + uniqueness validation
│   │   ├── user-matching.ts       # Weight-based multi-user matching (4-tier)
│   │   └── write.ts               # Atomic YAML write + debounced weight updates
│   ├── ble/
│   │   ├── index.ts                # OS detection + dynamic import barrel (scanAndRead, scanAndReadRaw)
│   │   ├── types.ts                # ScanOptions, ScanResult, constants, utilities
│   │   ├── shared.ts               # BleChar/BleDevice abstractions, waitForRawReading(), waitForReading()
│   │   ├── handler-node-ble.ts     # Linux: node-ble (BlueZ D-Bus)
│   │   ├── handler-noble.ts        # macOS default: @stoprocent/noble
│   │   └── handler-noble-legacy.ts # Windows default: @abandonware/noble
│   ├── exporters/
│   │   ├── index.ts                # Exporter factory — createExporters()
│   │   ├── registry.ts             # Self-describing exporter registry (schemas + factories)
│   │   ├── config.ts               # Exporter env validation + config parsing
│   │   ├── garmin.ts               # Garmin Connect exporter (Python subprocess)
│   │   ├── mqtt.ts                 # MQTT exporter + Home Assistant auto-discovery
│   │   ├── webhook.ts              # Webhook exporter (generic HTTP)
│   │   ├── influxdb.ts             # InfluxDB v2 exporter (line protocol)
│   │   └── ntfy.ts                 # Ntfy push notification exporter
│   ├── utils/
│   │   ├── retry.ts                # Shared retry utility (withRetry) used by all exporters
│   │   └── error.ts                # Shared error utility (errMsg) for unknown→string conversion
│   ├── validate-env.ts             # .env validation & typed config loader (legacy)
│   ├── scan.ts                     # BLE device scanner utility
│   ├── interfaces/
│   │   ├── scale-adapter.ts        # ScaleAdapter interface & shared types
│   │   ├── exporter.ts             # Exporter interface & ExportResult type
│   │   └── exporter-schema.ts      # ExporterSchema interface for self-describing exporters
│   └── scales/
│       ├── index.ts                # Adapter registry (all adapters)
│       ├── body-comp-helpers.ts    # Shared body-comp utilities
│       ├── qn-scale.ts             # QN-Scale / Renpho / Senssun / Sencor
│       ├── renpho.ts               # Renpho ES-WBE28
│       ├── renpho-es26bb.ts        # Renpho ES-26BB-B
│       ├── mi-scale-2.ts           # Xiaomi Mi Scale 2
│       ├── yunmai.ts               # Yunmai Signal / Mini / SE
│       ├── beurer-sanitas.ts       # Beurer BF700/710/800, Sanitas SBF70/75
│       ├── sanitas-sbf72.ts        # Sanitas SBF72/73, Beurer BF915
│       ├── soehnle.ts              # Soehnle Shape / Style
│       ├── medisana-bs44x.ts       # Medisana BS430/440/444
│       ├── trisa.ts                # Trisa Body Analyze
│       ├── es-cs20m.ts             # ES-CS20M
│       ├── exingtech-y1.ts         # Exingtech Y1 (vscale)
│       ├── excelvan-cf369.ts       # Excelvan CF369
│       ├── hesley.ts               # Hesley (YunChen)
│       ├── inlife.ts               # Inlife (fatscale)
│       ├── digoo.ts                # Digoo DG-SO38H (Mengii)
│       ├── senssun.ts              # Senssun Fat
│       ├── one-byone.ts            # 1byone / Eufy C1 / Eufy P1
│       ├── active-era.ts           # Active Era BF-06
│       ├── mgb.ts                  # MGB (Swan / Icomon / YG)
│       ├── hoffen.ts               # Hoffen BS-8107
│       └── standard-gatt.ts        # Generic BCS/WSS catch-all
├── tests/
│   ├── body-comp-helpers.test.ts   # Body-comp helper unit tests
│   ├── validate-env.test.ts        # .env validation unit tests
│   ├── orchestrator.test.ts        # Healthcheck + export dispatch tests
│   ├── multi-user-flow.test.ts     # Multi-user matching → profile → exporters → context integration
│   ├── logger.test.ts              # Logger utility tests
│   ├── helpers/
│   │   └── scale-test-utils.ts     # Shared test utilities (mock peripheral, etc.)
│   ├── config/                     # Config tests (schema, slugify, load, resolve, write, matching)
│   ├── ble/                        # BLE tests (shared logic, utilities, abort signal)
│   ├── utils/                      # Utility tests (retry, error)
│   ├── scales/                     # One test file per adapter (23 files)
│   └── exporters/                  # Exporter tests (config, garmin, mqtt, mqtt-multiuser, webhook, influxdb, ntfy, context)
├── garmin-scripts/
│   ├── garmin_upload.py            # Garmin uploader (JSON stdin → JSON stdout)
│   └── setup_garmin.py             # One-time Garmin auth setup
├── .env.example
├── .prettierrc                     # Prettier config
├── eslint.config.js                # ESLint flat config
├── tsconfig.json                   # TypeScript config (src)
├── tsconfig.eslint.json            # TypeScript config (src + tests, for ESLint)
├── .gitignore
├── package.json
├── requirements.txt
├── LICENSE
└── README.md
```

## Adding a New Scale

To support a new scale brand, create a class that implements `ScaleAdapter` in `src/scales/`:

1. Create `src/scales/your-brand.ts` implementing the interface from `src/interfaces/scale-adapter.ts`
2. Define `matches()` to recognize the device by its BLE advertisement name
3. Implement `parseNotification()` for the brand's data protocol
4. Register the adapter in `src/scales/index.ts`
5. If your adapter detects the weight unit from BLE data and converts to kg internally (like the standard BCS/WSS protocol does), set `normalizesWeight = true`. This prevents double-conversion when the user sets `WEIGHT_UNIT=lbs`.

## Adding a New Exporter

To add a new export target:

1. Create `src/exporters/your-exporter.ts` implementing the `Exporter` interface from `src/interfaces/exporter.ts`
   - Export an `ExporterSchema` describing fields, display info, and `supportsGlobal`/`supportsPerUser`
   - Accept optional `ExportContext` in `export(data, context?)` for multi-user support
2. Add the name to the `ExporterName` type and `KNOWN_EXPORTERS` set in `src/exporters/config.ts`
3. Add env var parsing in `src/exporters/config.ts` (for `.env` fallback path)
4. Add a case to the switch in `createExporters()` in `src/exporters/index.ts`
5. Add a registry entry in `src/exporters/registry.ts` with `{ schema, factory }`
6. Add tests in `tests/exporters/` (including `ExportContext` behavior)
7. Document config fields in this README and `.env.example`

## Multi-User Weight Matching

When using `config.yaml` with multiple users, the app automatically identifies who stepped on the scale based on the measured weight. Each user defines a `weight_range` in their config:

```yaml
users:
  - name: Alice
    weight_range:
      min: 50
      max: 70
    last_known_weight: null
  - name: Bob
    weight_range:
      min: 75
      max: 100
    last_known_weight: 85.5
```

### Matching Priority (4 tiers)

1. **Single user** — always matches (warns if weight is outside the configured range)
2. **Exact range match** — one user's range contains the weight
3. **Overlapping ranges** — multiple users match; tiebreak by `last_known_weight` proximity, then config order
4. **No range match** — matches the user with the closest `last_known_weight`

If none of the above produce a match, the `unknown_user` strategy applies:

| Strategy            | Behavior                                                                      |
| ------------------- | ----------------------------------------------------------------------------- |
| `nearest` (default) | Picks the user whose range midpoint is closest to the weight (with a warning) |
| `log`               | Logs a warning and skips the measurement                                      |
| `ignore`            | Silently skips the measurement                                                |

### Drift Detection

After matching, the app checks if the weight falls in the outer 10% of the user's range and logs a warning. This helps you notice when a user's typical weight is drifting toward a range boundary, so you can adjust the config before mismatches occur.

### Automatic Weight Tracking

After each successful measurement, the user's `last_known_weight` is automatically updated in `config.yaml`. This improves future matching accuracy for overlapping ranges. Updates are debounced (5 seconds) and skipped if the change is less than 0.5 kg.

### Multi-User Execution Flow

When 2+ users are configured, the main loop uses a different execution path:

1. **Raw scan** — `scanAndReadRaw()` reads weight + impedance without computing body composition
2. **User matching** — `matchUserByWeight()` identifies who stepped on the scale (4-tier priority)
3. **Drift detection** — warns if weight is near the boundary of the matched user's range
4. **Body composition** — computes metrics using the matched user's profile (height, age, gender, athlete)
5. **Per-user exporters** — resolves and caches exporters for the matched user (user-level + global, deduped by type)
6. **Export with context** — dispatches to all exporters with `ExportContext` (user name, slug, config, drift warning)
7. **Weight tracking** — updates `last_known_weight` in `config.yaml` (debounced, atomic write)

**Per-exporter multi-user behavior:**

- **MQTT** — publishes to `{topic}/{slug}`, per-user HA device discovery + LWT
- **InfluxDB** — adds `user={slug}` tag to line protocol
- **Webhook** — adds `user_name` + `user_slug` fields to JSON payload
- **Ntfy** — prepends `[{name}]` to notification, appends drift warning if present
- **Garmin** — unchanged (one Garmin account per user via per-user exporter config)

### SIGHUP Config Reload

On Linux/macOS, sending `SIGHUP` to the process triggers a config reload between scan cycles:

```bash
kill -HUP $(pgrep -f "ble-scale-sync")
```

The reload acquires the write lock (to avoid conflicting with `last_known_weight` writes), re-validates the YAML via Zod, and clears the exporter cache. If validation fails, the previous config is kept.

### Heartbeat

At the start of each scan cycle, the process writes the current ISO timestamp to `/tmp/.ble-scale-sync-heartbeat`. This can be used for Docker health checks or monitoring.

## Athlete Mode

Setting `is_athlete: true` in `config.yaml` (or `USER_IS_ATHLETE=true` in `.env`) adjusts the calculation constants for people who exercise regularly. This affects:

- **Lean Body Mass** coefficients (higher lean mass estimation)
- **Water percentage** (athletes have higher hydration: 74% vs 73% of LBM)
- **Skeletal Muscle Mass** factor (60% vs 54% of LBM)
- **BMR** (+5% boost)
- **Metabolic Age** (capped at actual age minus 5 for athletes)

## Token Storage

By default, Garmin tokens are stored in `~/.garmin_tokens/`. You can change this with the `token_dir` field in the Garmin exporter config:

```yaml
global_exporters:
  - type: garmin
    token_dir: /custom/path/to/tokens
```

## Troubleshooting

### "Permission denied" on Linux

Make sure you've granted BLE capabilities to Node.js:

```bash
sudo setcap cap_net_raw+eip $(eval readlink -f $(which node))
```

### Scale not found

- Make sure the scale is powered on (step on it to wake it up).
- If using a specific `SCALE_MAC`, verify the address matches (`npm run scan`).
- If using auto-discovery, ensure only one recognized scale is powered on nearby. Auto-discovery works on all platforms (Linux, macOS, Windows) — all adapters match by device name, so `SCALE_MAC` is never required.
- On Linux, ensure the Bluetooth service is running: `sudo systemctl start bluetooth`.

### Connection errors on Raspberry Pi Zero (le-connection-abort-by-local)

The app automatically stops BLE discovery before connecting, which resolves most `le-connection-abort-by-local` errors on low-power devices like Pi Zero 2W. If you still see connection failures, try restarting Bluetooth:

```bash
sudo systemctl restart bluetooth
```

### Scale was found before but now isn't discovered (Linux / Raspberry Pi)

BlueZ (the Linux Bluetooth stack) can sometimes get into a state where it no longer reports a previously-seen device. To fix:

```bash
sudo systemctl restart bluetooth
```

Then step on the scale to wake it up and run `npm start` (or `npm run scan` to verify visibility first). If using `setcap`, you may need to re-apply it after a Node.js update:

```bash
sudo setcap cap_net_raw+eip $(eval readlink -f $(which node))
```

### Garmin upload fails

- Re-run `npm run setup-garmin` to refresh tokens.
- Check that your Garmin credentials are correct (in `config.yaml` or environment variables).
- If you're behind a VPN or on a restricted network, try authenticating from a different connection.

### Debug BLE output

Set `DEBUG=true` to see detailed BLE discovery logs (advertised services, discovered characteristics, UUID matching):

```bash
# Linux / macOS
DEBUG=true npm start

# Windows (PowerShell)
$env:DEBUG="true"; npm start
```

### Windows BLE issues

- The default BLE driver on Windows is `@abandonware/noble`, which works with the native Windows Bluetooth stack — no special driver setup needed.
- If you set `NOBLE_DRIVER=stoprocent`, you'll need the WinUSB driver (use [Zadig](https://zadig.akeo.ie/) to switch drivers).
- Run your terminal as Administrator if you encounter permission errors.

## Credits

### Scale Protocols

BLE protocols were ported from [**openScale**](https://github.com/oliexdev/openScale), an open-source Android app for Bluetooth scales by oliexdev and contributors. All 23 adapters have been cross-referenced against the openScale Java/Kotlin source to verify byte offsets, init sequences, and protocol correctness.

### Garmin Connect Upload

Garmin Connect authentication and upload is powered by [**garminconnect**](https://github.com/cyberjunky/python-garminconnect) by cyberjunky (Ron Klinkien) and contributors.

### BLE Libraries

Low-level Bluetooth communication is provided by [**node-ble**](https://github.com/chrvadala/node-ble) (Linux/BlueZ D-Bus), [**@abandonware/noble**](https://github.com/abandonware/noble) (Windows default), and [**@stoprocent/noble**](https://github.com/stoprocent/noble) (macOS default). Both noble forks can be used on any platform via `NOBLE_DRIVER`.

### Body Composition Formulas

| Formula                                    | Authors                                                                                                                                                                         | Used For                                          |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| **BIA** (Bioelectrical Impedance Analysis) | Lukaski H.C. et al. (1986) — _"Assessment of fat-free mass using bioelectrical impedance measurements of the human body"_, American Journal of Clinical Nutrition               | Body fat % from impedance — the core algorithm    |
| **Mifflin-St Jeor**                        | Mifflin M.D., St Jeor S.T. et al. (1990) — _"A new predictive equation for resting energy expenditure in healthy individuals"_, American Journal of Clinical Nutrition          | Basal Metabolic Rate (BMR)                        |
| **Deurenberg**                             | Deurenberg P., Weststrate J.A., Seidell J.C. (1991) — _"Body mass index as a measure of body fatness: age- and sex-specific prediction formulas"_, British Journal of Nutrition | Body fat % fallback when impedance is unavailable |

## License

GPL-3.0 License — see [LICENSE](LICENSE) for details.
