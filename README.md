# Renpho Scale → Garmin Connect Sync

A cross-platform CLI tool that reads body composition data from a **Renpho BLE smart scale** and uploads it to **Garmin Connect**.

Works on **Linux** (including Raspberry Pi), **macOS**, and **Windows**.

## How It Works

```
┌──────────────┐   BLE    ┌──────────────┐  stdin/JSON  ┌──────────────┐
│  Renpho Scale │ ──────> │   Node.js    │ ──────────> │    Python    │
│  (Bluetooth)  │         │  BLE + Math  │             │ Garmin Upload│
└──────────────┘         └──────────────┘             └──────────────┘
```

**Node.js** handles Bluetooth communication and calculates 9 body composition metrics (body fat %, muscle mass, BMI, BMR, etc.). It then passes the results to a **Python** script that uploads everything to Garmin Connect.

## Prerequisites

### All Platforms

- [Node.js](https://nodejs.org/) v18 or later
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
git clone https://github.com/your-username/renpho-scale-garmin-sync.git
cd renpho-scale-garmin-sync

# Install Node.js dependencies
npm install

# Install Python dependencies
pip install -r requirements.txt
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
USER_AGE=26
USER_GENDER=male
USER_IS_ATHLETE=true

SCALE_MAC=FF:03:00:13:A1:04
```

### 2. Find your scale's MAC address

Turn on your Renpho scale (step on it briefly) and run:

```bash
npm run scan
```

This scans for nearby BLE devices for 15 seconds. Look for your scale in the output (it usually appears as `QN-Scale` or similar). Copy the MAC address into your `.env` file.

> **Tip:** On macOS, noble uses UUIDs instead of MAC addresses. The scan output will show the correct identifier to use.

### 3. Authenticate with Garmin Connect

```bash
npm run setup-garmin
```

This logs into Garmin using the credentials in your `.env` and stores authentication tokens locally (default: `~/.garmin_renpho_tokens/`). You only need to do this once — tokens are reused for subsequent syncs.

> **If authentication fails:** Garmin may block requests from certain IPs (especially cloud/VPN IPs). Try running the setup from a different network, then copy the `~/.garmin_renpho_tokens/` directory to your target machine.

## Usage

### Sync your scale

```bash
npm start
```

1. The app will start scanning for your scale via Bluetooth.
2. **Step on the scale** and wait for the measurement to stabilize.
3. Once weight and impedance data are received, body composition is calculated and uploaded to Garmin Connect.

### What gets uploaded

| Metric | Unit | Description |
|---|---|---|
| Weight | kg | Raw scale reading |
| Body Fat | % | Bioelectrical impedance analysis |
| Water | % | Hydration level |
| Bone Mass | kg | Estimated bone mineral content |
| Muscle Mass | kg | Skeletal muscle mass |
| BMI | - | Body Mass Index |
| BMR | kcal | Basal Metabolic Rate (Mifflin-St Jeor) |
| Visceral Fat | 1-59 | Visceral fat rating |
| Physique Rating | 1-9 | Body type classification |
| Metabolic Age | years | Estimated metabolic age |

## Project Structure

```
renpho-scale-garmin-sync/
├── src/
│   ├── index.js          # Main orchestrator
│   ├── ble.js            # BLE communication (noble)
│   ├── calculator.js     # Body composition math (ported from Python)
│   └── scan.js           # BLE device scanner utility
├── scripts/
│   ├── garmin_upload.py   # Garmin Connect uploader (reads JSON from stdin)
│   └── setup_garmin.py    # One-time Garmin authentication setup
├── .env.example           # Configuration template
├── .gitignore
├── package.json
├── requirements.txt
├── LICENSE
└── README.md
```

## Athlete Mode

Setting `USER_IS_ATHLETE=true` in `.env` adjusts the calculation constants for people who exercise regularly. This affects:

- **Lean Body Mass** coefficients (higher lean mass estimation)
- **Water percentage** (athletes have higher hydration: 74% vs 73% of LBM)
- **Skeletal Muscle Mass** factor (60% vs 54% of LBM)
- **BMR** (+5% boost)
- **Metabolic Age** (capped at actual age minus 5 for athletes)

## Token Storage

By default, Garmin tokens are stored in `~/.garmin_renpho_tokens/`. You can change this by setting `TOKEN_DIR` in your `.env`:

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
- Verify the MAC address matches (`npm run scan`).
- On Linux, ensure the Bluetooth service is running: `sudo systemctl start bluetooth`.

### Garmin upload fails
- Re-run `npm run setup-garmin` to refresh tokens.
- Check that your Garmin credentials in `.env` are correct.
- If you're behind a VPN or on a restricted network, try authenticating from a different connection.

### Windows BLE issues
- Make sure your Bluetooth adapter uses the WinUSB driver (use [Zadig](https://zadig.akeo.ie/) to switch drivers if needed).
- Run your terminal as Administrator if you encounter permission errors.

## License

MIT License — see [LICENSE](LICENSE) for details.
