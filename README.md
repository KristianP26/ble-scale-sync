# Renpho Scale → Garmin Connect Sync

A cross-platform CLI tool that reads body composition data from a **BLE smart scale** and uploads it to **Garmin Connect**. Built with an adapter pattern supporting **20+ scale brands** out of the box.

Works on **Linux** (including Raspberry Pi), **macOS**, and **Windows**.

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
| **Active Era BF-06**                                 | Custom (FFB0)          |
| **MGB** (Swan / Icomon / YG)                         | Custom (FFB0)          |
| **Hoffen BS-8107**                                   | Custom (FFB0)          |
| Any **standard BT SIG BCS/WSS** scale                | Standard (181B / 181D) |

## How It Works

```
┌────────────────┐        ┌────────────────┐        ┌────────────────┐
│   BLE Scale    │  BLE   │   TypeScript   │  JSON  │     Python     │
│  (Bluetooth)   │ ─────> │ BLE + Adapter  │ ─────> │ Garmin Upload  │
└────────────────┘        └────────────────┘        └────────────────┘
```

**TypeScript** (run via `tsx`) scans for a BLE scale, auto-detects the brand via the adapter pattern, and calculates up to 10 body composition metrics. It passes the results as JSON to a **Python** script that uploads to Garmin Connect and returns a structured JSON response.

## Prerequisites

### All Platforms

- [Node.js](https://nodejs.org/) v20 or later
- [Python](https://python.org/) 3.9 or later
- Bluetooth Low Energy (BLE) capable adapter

### Linux (Debian/Ubuntu/Raspberry Pi OS)

```bash
sudo apt-get update
sudo apt-get install -y bluetooth bluez libbluetooth-dev libudev-dev build-essential python3-pip

# Allow Node.js to access BLE without root
sudo setcap cap_net_raw+eip $(eval readlink -f $(which node))
```

### macOS

```bash
# Install Xcode command-line tools (required for native modules)
xcode-select --install
```

No additional Bluetooth setup needed — macOS uses its native CoreBluetooth API.

### Windows

1. Install [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) (select "Desktop development with C++").
2. Install [Python](https://python.org/) and check "Add to PATH" during installation.
3. You need a BLE-compatible Bluetooth adapter. Most built-in adapters work, but you may need a [WinUSB driver setup with Zadig](https://zadig.akeo.ie/) for generic dongles.

> **Note:** On Windows, `@abandonware/noble` requires the Bluetooth adapter to use WinUSB. See the [noble Windows setup guide](https://github.com/abandonware/noble#windows) for details.

## Installation

```bash
# Clone the repository
git clone https://github.com/KristianP26/renpho-scale-garmin-sync.git
cd renpho-scale-garmin-sync

# Install Node.js dependencies
npm install

# Install Python dependencies
pip3 install -r requirements.txt    # or: pip install -r requirements.txt
```

## Configuration

### 1. Create your `.env` file

```bash
cp .env.example .env
```

Edit `.env` with your personal details:

```ini
GARMIN_EMAIL=you@example.com
GARMIN_PASSWORD=your_password

USER_HEIGHT=183
USER_BIRTH_YEAR=2000
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
| `USER_BIRTH_YEAR` | Yes      | Number, 1900–current year, age >= 5                  |
| `USER_GENDER`     | Yes      | `male` or `female` (case-insensitive)                |
| `USER_IS_ATHLETE` | Yes      | `true`/`false`/`yes`/`no`/`1`/`0`                    |
| `WEIGHT_UNIT`     | No       | `kg` or `lbs` (default: `kg`) — display + scale input |
| `HEIGHT_UNIT`     | No       | `cm` or `in` (default: `cm`) — for `USER_HEIGHT`    |
| `SCALE_MAC`       | No       | Format `XX:XX:XX:XX:XX:XX` if provided               |

### 2. Find your scale's MAC address (optional)

By default, the app auto-discovers your scale — no MAC address needed. If you have multiple BLE scales nearby and want to pin to a specific one, run:

```bash
npm run scan
```

This scans for nearby BLE devices for 15 seconds. Recognized scales are tagged with the adapter name (e.g. `[QN Scale]`, `[Xiaomi Mi Scale 2]`, `[Yunmai]`). Copy the MAC address into your `.env` file.

> **Tip:** On macOS, noble uses UUIDs instead of MAC addresses. The scan output will show the correct identifier to use.

### 3. Authenticate with Garmin Connect

```bash
npm run setup-garmin
```

This logs into Garmin using the credentials in your `.env` and stores authentication tokens locally (default: `~/.garmin_tokens/`). You only need to do this once — tokens are reused for subsequent syncs.

> **Note:** On Linux/macOS, if `python` is not available, run the script directly with `python3 scripts/setup_garmin.py`.

> **If authentication fails:** Garmin may block requests from certain IPs (especially cloud/VPN IPs). Try running the setup from a different network, then copy the `~/.garmin_tokens/` directory to your target machine.

## Usage

### Sync your scale

```bash
npm start
```

1. The app scans for your scale via Bluetooth. If `SCALE_MAC` is set, it connects to that specific device; otherwise it auto-discovers any recognized scale.
2. **Step on the scale** and wait for the measurement to stabilize.
3. Once weight and impedance data are received, body composition is calculated and uploaded to Garmin Connect.

### What gets uploaded

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

### Testing

```bash
npm test
```

Unit tests use [Vitest](https://vitest.dev/) and cover:

- **Body composition math** — `calculator.ts` and `body-comp-helpers.ts`
- **Environment validation** — `validate-env.ts` (all validation rules and edge cases)
- **Scale adapters** — `parseNotification()`, `matches()`, `isComplete()`, `computeMetrics()` for QN Scale, Standard GATT, Mi Scale 2, Yunmai, and Renpho adapters

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
renpho-scale-garmin-sync/
├── src/
│   ├── index.ts                    # Main orchestrator
│   ├── ble.ts                      # Generic BLE manager
│   ├── calculator.ts               # Body composition math (BIA formulas)
│   ├── validate-env.ts             # .env validation & typed config loader
│   ├── scan.ts                     # BLE device scanner utility
│   ├── interfaces/
│   │   └── scale-adapter.ts        # ScaleAdapter interface & shared types
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
│   ├── calculator.test.ts          # BodyCompCalculator unit tests
│   ├── body-comp-helpers.test.ts   # Body-comp helper unit tests
│   ├── validate-env.test.ts        # .env validation unit tests
│   ├── helpers/
│   │   └── scale-test-utils.ts     # Shared test utilities (mock peripheral, etc.)
│   └── scales/
│       ├── qn-scale.test.ts        # QN Scale adapter tests
│       ├── standard-gatt.test.ts   # Standard GATT adapter tests
│       ├── mi-scale-2.test.ts      # Mi Scale 2 adapter tests
│       ├── yunmai.test.ts          # Yunmai adapter tests
│       └── renpho.test.ts          # Renpho ES-WBE28 adapter tests
├── scripts/
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
- If using auto-discovery, ensure only one recognized scale is powered on nearby.
- On Linux, ensure the Bluetooth service is running: `sudo systemctl start bluetooth`.

### Garmin upload fails

- Re-run `npm run setup-garmin` to refresh tokens.
- Check that your Garmin credentials in `.env` are correct.
- If you're behind a VPN or on a restricted network, try authenticating from a different connection.

### Windows BLE issues

- Make sure your Bluetooth adapter uses the WinUSB driver (use [Zadig](https://zadig.akeo.ie/) to switch drivers if needed).
- Run your terminal as Administrator if you encounter permission errors.

## Credits

Scale BLE protocols were ported from [**openScale**](https://github.com/oliexdev/openScale), an open-source Android app for Bluetooth scales by oliexdev and contributors.

## License

GPL-3.0 License — see [LICENSE](LICENSE) for details.
