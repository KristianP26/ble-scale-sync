# BLE Scale Sync

> **⚠️ Work in Progress** — This project is under active development and is **not production-ready**. Expect breaking changes, incomplete features, and rough edges. Use at your own risk.

A cross-platform CLI tool that reads body composition data from a **BLE smart scale** and exports it to multiple targets. Built with an adapter pattern supporting **23 scale brands** out of the box.

Works on **Linux** (including Raspberry Pi), **macOS**, and **Windows**.

### Export Targets

| Target | Description | Protocol | Auth |
| --- | --- | --- | --- |
| **Garmin Connect** | Automatic body composition upload — no phone app needed | Python subprocess | Email + password (tokens cached) |
| **MQTT** | Home automation integration with **Home Assistant auto-discovery** | MQTT 5.0 | Optional username/password |
| **Webhook** | Generic HTTP endpoint — n8n, Make, Zapier, custom APIs | HTTP POST/PUT | Custom headers |
| **InfluxDB** | Time-series database (v2 write API, line protocol) | HTTP | Token |
| **Ntfy** | Push notifications to phone/desktop via [ntfy.sh](https://ntfy.sh) | HTTP | Optional Bearer/Basic |

All exporters run in parallel. Enable any combination via `EXPORTERS=garmin,mqtt,webhook,influxdb,ntfy`. Each exporter is self-describing — it declares its configuration fields, display names, and capabilities — making it easy to add new export targets.

## Why This Exists

Most BLE smart scales measure weight and body impedance over Bluetooth, but their companion apps have no way to sync data to **Garmin Connect**. The only workflow was: open the phone app, wait for it to sync, then manually type the numbers into Garmin. Every single time.

I didn't want to depend on a phone app. So I built this tool. A **Raspberry Pi Zero 2W** sits next to the scale, always on, always listening. Step on the scale, wait a few seconds, and the reading appears in Garmin Connect — **no phone needed, no app, no manual entry**. It just works.

While the project started for one scale, it now supports **23 scale adapters** covering most popular BLE smart scales, so it works regardless of brand.

### Recommended Setup

| Component | Recommendation |
| --- | --- |
| **Single-board computer** | [Raspberry Pi Zero 2W](https://www.raspberrypi.com/products/raspberry-pi-zero-2-w/) — cheap, tiny, built-in BLE, low power (~0.4W idle) |
| **Scale** | Any supported BLE scale (see list below) |
| **OS** | Raspberry Pi OS Lite (headless, no desktop needed) |

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

> **Coming soon:** A structured `config.yaml` format with multi-user support, an interactive setup wizard (`npm run setup`), and Docker deployment. The `.env` configuration below continues to work and will remain supported as a fallback.

### 1. Create your `.env` file

```bash
cp .env.example .env
```

Edit `.env` with your personal details:

```ini
GARMIN_EMAIL=you@example.com
GARMIN_PASSWORD=your_password

USER_HEIGHT=183
USER_BIRTH_DATE=2000-06-15
USER_GENDER=male
USER_IS_ATHLETE=true

# Optional — measurement units (both default to metric)
WEIGHT_UNIT=kg
HEIGHT_UNIT=cm
```

`WEIGHT_UNIT` and `HEIGHT_UNIT` are **optional** and default to metric (`kg` / `cm`). Set `HEIGHT_UNIT=in` to enter `USER_HEIGHT` in inches. Set `WEIGHT_UNIT=lbs` if your scale transmits in pounds — the app will convert to kg for calculations and display weight in lbs. All internal calculations and Garmin uploads remain in metric.

> **Note:** Some adapters (Mi Scale 2, Standard GATT BCS/WSS, Sanitas SBF72/73) auto-detect the scale's unit from BLE flags and always normalize to kg. For those scales, `WEIGHT_UNIT` only affects console display. For all other scales, `WEIGHT_UNIT=lbs` also converts the raw scale reading from lbs to kg before processing.

`SCALE_MAC` is **optional**. If omitted, the app auto-discovers any recognized scale during `npm start`. To pin to a specific device, add:

```ini
SCALE_MAC=FF:03:00:13:A1:04
```

> **Recommended:** Set `SCALE_MAC` to your scale's MAC address. Without it, the app connects to the first recognized scale it finds — which could be a neighbor's scale, since BLE signals easily pass through walls. Run `npm run scan` to find your scale's address.

All environment variables are validated at startup with clear error messages:

| Variable          | Required | Validation                                           |
| ----------------- | -------- | ---------------------------------------------------- |
| `GARMIN_EMAIL`    | Yes      | Validated on Python side                             |
| `GARMIN_PASSWORD` | Yes      | Validated on Python side                             |
| `USER_HEIGHT`     | Yes      | Number, 50–250 cm (or 20–100 if `HEIGHT_UNIT=in`)   |
| `USER_BIRTH_DATE` | Yes      | Date in YYYY-MM-DD format, age >= 5                  |
| `USER_GENDER`     | Yes      | `male` or `female` (case-insensitive)                |
| `USER_IS_ATHLETE` | Yes      | `true`/`false`/`yes`/`no`/`1`/`0`                    |
| `WEIGHT_UNIT`     | No       | `kg` or `lbs` (default: `kg`) — display + scale input |
| `HEIGHT_UNIT`     | No       | `cm` or `in` (default: `cm`) — for `USER_HEIGHT`    |
| `SCALE_MAC`       | No       | MAC (`XX:XX:XX:XX:XX:XX`) or CoreBluetooth UUID (macOS) |
| `NOBLE_DRIVER`    | No       | `abandonware` or `stoprocent` — override OS default noble driver |
| `DRY_RUN`         | No       | `true` to skip exports (read scale + compute only) |
| `CONTINUOUS_MODE` | No       | `true` to loop with auto-reconnect (default: `false`) |
| `SCAN_COOLDOWN`   | No       | Seconds between scans in continuous mode (5–3600, default: `30`) |

### 2. Find your scale's MAC address (optional)

By default, the app auto-discovers your scale — no MAC address needed. If you have multiple BLE scales nearby and want to pin to a specific one, run:

```bash
npm run scan
```

This scans for nearby BLE devices for 15 seconds. Recognized scales are tagged with the adapter name (e.g. `[QN Scale]`, `[Xiaomi Mi Scale 2]`, `[Yunmai]`). Copy the MAC address into your `.env` file.

> **Tip:** On macOS, BLE peripherals are identified by a CoreBluetooth UUID instead of a MAC address. The `npm run scan` output shows the correct identifier to use for `SCALE_MAC`.

### 3. Authenticate with Garmin Connect

```bash
npm run setup-garmin
```

This logs into Garmin using the credentials in your `.env` and stores authentication tokens locally (default: `~/.garmin_tokens/`). You only need to do this once — tokens are reused for subsequent syncs.

> **If authentication fails:** Garmin may block requests from certain IPs (especially cloud/VPN IPs). Try running the setup from a different network, then copy the `~/.garmin_tokens/` directory to your target machine.

### 4. Exporters

The app supports multiple export targets. Configure which ones to use with the `EXPORTERS` environment variable:

```ini
EXPORTERS=garmin              # default — Garmin Connect only
EXPORTERS=garmin,mqtt         # both in parallel
EXPORTERS=webhook,influxdb    # HTTP + time-series DB
EXPORTERS=garmin,ntfy         # Garmin + push notifications
EXPORTERS=garmin,mqtt,webhook,influxdb,ntfy  # all five
```

If `EXPORTERS` is not set, it defaults to `garmin`. All enabled exporters run in parallel.

#### MQTT

Publishes the full body composition payload as a JSON object to the configured topic.

**Home Assistant auto-discovery** is enabled by default — all 11 metrics appear as sensors grouped under a single device in Home Assistant. No manual YAML configuration needed. Discovery includes availability tracking (online/offline via LWT), display precision per metric, diagnostic entity categories for impedance and physique rating, and the app version in the device info.

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `MQTT_BROKER_URL` | Yes (when mqtt enabled) | — | Broker connection URL (`mqtt://host:1883`) |
| `MQTT_TOPIC` | No | `scale/body-composition` | Publish topic for measurement data |
| `MQTT_QOS` | No | `1` | MQTT QoS level (0, 1, or 2) |
| `MQTT_RETAIN` | No | `true` | Retain the last published message on the broker |
| `MQTT_USERNAME` | No | — | Broker authentication username |
| `MQTT_PASSWORD` | No | — | Broker authentication password |
| `MQTT_CLIENT_ID` | No | `ble-scale-sync` | MQTT client identifier |
| `MQTT_HA_DISCOVERY` | No | `true` | Publish Home Assistant auto-discovery configs on connect |
| `MQTT_HA_DEVICE_NAME` | No | `BLE Scale` | Device name shown in Home Assistant |

#### Webhook

Sends the full body composition payload as a JSON POST to any HTTP endpoint. Useful for integrating with automation platforms (n8n, Make, Zapier, custom APIs).

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `WEBHOOK_URL` | Yes (when webhook enabled) | — | Target URL |
| `WEBHOOK_METHOD` | No | `POST` | HTTP method (`POST`, `PUT`, etc.) |
| `WEBHOOK_HEADERS` | No | — | Custom headers as comma-separated `Key: Value` pairs |
| `WEBHOOK_TIMEOUT` | No | `10000` | Request timeout in milliseconds |

#### InfluxDB

Writes body composition metrics to an InfluxDB v2 instance using line protocol. Float fields (`weight`, `bmi`, `bodyFatPercent`, `waterPercent`, `boneMass`, `muscleMass`) are written with 2 decimal places. Integer fields (`impedance`, `visceralFat`, `physiqueRating`, `bmr`, `metabolicAge`) use InfluxDB's integer type.

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `INFLUXDB_URL` | Yes (when influxdb enabled) | — | InfluxDB server URL (`http://localhost:8086`) |
| `INFLUXDB_TOKEN` | Yes (when influxdb enabled) | — | API token with write access |
| `INFLUXDB_ORG` | Yes (when influxdb enabled) | — | Organization name |
| `INFLUXDB_BUCKET` | Yes (when influxdb enabled) | — | Destination bucket |
| `INFLUXDB_MEASUREMENT` | No | `body_composition` | Measurement name in line protocol |

#### Ntfy

Sends a human-readable push notification via [ntfy](https://ntfy.sh). Works with the public ntfy.sh server or a self-hosted instance.

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `NTFY_TOPIC` | Yes (when ntfy enabled) | — | Ntfy topic name |
| `NTFY_URL` | No | `https://ntfy.sh` | Ntfy server URL |
| `NTFY_TITLE` | No | `Scale Measurement` | Notification title |
| `NTFY_PRIORITY` | No | `3` | Priority (1=min, 3=default, 5=max) |
| `NTFY_TOKEN` | No | — | Bearer token for authentication |
| `NTFY_USERNAME` | No | — | Username for Basic auth |
| `NTFY_PASSWORD` | No | — | Password for Basic auth |

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

| Branch | Purpose |
| --- | --- |
| `main` | Stable release branch |
| `dev` | Active development — PRs and new features target this branch |

CI runs on both `main` and `dev` (push + pull request).

### Testing

```bash
npm test
```

Unit tests use [Vitest](https://vitest.dev/) and cover:

- **Body composition math** — `body-comp-helpers.ts`
- **Environment validation** — `validate-env.ts` (all validation rules and edge cases)
- **Scale adapters** — `parseNotification()`, `matches()`, `isComplete()`, `computeMetrics()`, and `onConnected()` for all 23 adapters
- **Exporters** — config parsing, MQTT publish/HA discovery, Garmin subprocess, Webhook/InfluxDB/Ntfy delivery
- **Orchestrator** — healthcheck runner, export dispatch, parallel execution, partial/total failure handling
- **BLE shared logic** — `waitForReading()` in legacy, onConnected, and multi-char modes; weight normalization; disconnect handling
- **Utilities** — shared retry logic (`withRetry`), abort-signal sleep

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
│   ├── index.ts                    # Entry point (config, signals, scan cycle, continuous mode)
│   ├── orchestrator.ts             # Exported orchestration logic (healthchecks, export dispatch)
│   ├── ble/
│   │   ├── index.ts                # OS detection + dynamic import barrel
│   │   ├── types.ts                # ScanOptions, ScanResult, constants, utilities
│   │   ├── shared.ts               # BleChar/BleDevice abstractions, waitForReading()
│   │   ├── handler-node-ble.ts     # Linux: node-ble (BlueZ D-Bus)
│   │   ├── handler-noble.ts        # macOS default: @stoprocent/noble
│   │   └── handler-noble-legacy.ts # Windows default: @abandonware/noble
│   ├── exporters/
│   │   ├── index.ts                # Exporter registry — createExporters()
│   │   ├── config.ts               # Exporter env validation + config parsing
│   │   ├── garmin.ts               # Garmin Connect exporter (Python subprocess)
│   │   ├── mqtt.ts                 # MQTT exporter + Home Assistant auto-discovery
│   │   ├── webhook.ts              # Webhook exporter (generic HTTP)
│   │   ├── influxdb.ts             # InfluxDB v2 exporter (line protocol)
│   │   └── ntfy.ts                 # Ntfy push notification exporter
│   ├── utils/
│   │   ├── retry.ts                # Shared retry utility (withRetry) used by all exporters
│   │   └── error.ts                # Shared error utility (errMsg) for unknown→string conversion
│   ├── validate-env.ts             # .env validation & typed config loader
│   ├── scan.ts                     # BLE device scanner utility
│   ├── interfaces/
│   │   ├── scale-adapter.ts        # ScaleAdapter interface & shared types
│   │   └── exporter.ts             # Exporter interface & ExportResult type
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
│   ├── helpers/
│   │   └── scale-test-utils.ts     # Shared test utilities (mock peripheral, etc.)
│   ├── utils/                      # Utility tests (retry, error)
│   ├── scales/                     # One test file per adapter (23 files)
│   └── exporters/                  # Exporter tests (config, garmin, mqtt, webhook, influxdb, ntfy)
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
2. Add the name to the `ExporterName` type and env parsing in `src/exporters/config.ts`
3. Add the factory case in `src/exporters/index.ts` → `createExporters()`
4. Add tests in `tests/exporters/`
5. Document config variables in `.env.example`

## Athlete Mode

Setting `USER_IS_ATHLETE=true` in `.env` adjusts the calculation constants for people who exercise regularly. This affects:

- **Lean Body Mass** coefficients (higher lean mass estimation)
- **Water percentage** (athletes have higher hydration: 74% vs 73% of LBM)
- **Skeletal Muscle Mass** factor (60% vs 54% of LBM)
- **BMR** (+5% boost)
- **Metabolic Age** (capped at actual age minus 5 for athletes)

## Token Storage

By default, Garmin tokens are stored in `~/.garmin_tokens/`. You can change this by setting `TOKEN_DIR` in your `.env`:

```ini
TOKEN_DIR=/custom/path/to/tokens
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
- Check that your Garmin credentials in `.env` are correct.
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

| Formula | Authors | Used For |
| --- | --- | --- |
| **BIA** (Bioelectrical Impedance Analysis) | Lukaski H.C. et al. (1986) — *"Assessment of fat-free mass using bioelectrical impedance measurements of the human body"*, American Journal of Clinical Nutrition | Body fat % from impedance — the core algorithm |
| **Mifflin-St Jeor** | Mifflin M.D., St Jeor S.T. et al. (1990) — *"A new predictive equation for resting energy expenditure in healthy individuals"*, American Journal of Clinical Nutrition | Basal Metabolic Rate (BMR) |
| **Deurenberg** | Deurenberg P., Weststrate J.A., Seidell J.C. (1991) — *"Body mass index as a measure of body fatness: age- and sex-specific prediction formulas"*, British Journal of Nutrition | Body fat % fallback when impedance is unavailable |

## License

GPL-3.0 License — see [LICENSE](LICENSE) for details.
