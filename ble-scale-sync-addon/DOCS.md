# BLE Scale Sync

Read body composition data from BLE smart scales and export to Home Assistant (MQTT auto-discovery), Garmin Connect, and more.

## Quick Start

1. Install the add-on
2. In the **Configuration** tab, set your **Scale MAC address** (or leave empty for auto-discovery)
3. Fill in your **user profile** (height, birth date, gender)
4. **MQTT** is enabled by default with auto-detection from the Mosquitto add-on
5. Start the add-on

Your scale measurements will appear as Home Assistant sensors automatically.

## Finding Your Scale MAC

1. Start the add-on with debug logging enabled
2. Step on your scale to wake it up
3. Check the add-on logs for discovered devices
4. Copy the MAC address and paste it into the Scale MAC field

## MQTT Auto-Detection

When **Auto-detect MQTT broker** is enabled, the add-on automatically discovers the Mosquitto add-on broker. No manual MQTT configuration needed.

If you use an external MQTT broker, disable auto-detect and enter the broker URL, username, and password manually.

## Units

**Weight unit** and **Height unit** let you choose metric (kg/cm) or imperial (lbs/in). The selection is applied to the scale readings, the user profile height, and the weight range used for user matching. Defaults are kg and cm.

Changing units after the first reading does not reinterpret existing data. Switch units first, then record a measurement.

## Persistent last known weight

The add-on stores its runtime configuration at `/data/config.yaml` and preserves each user's `last_known_weight` across add-on restarts. This is important for multi-user matching: after the first reading the remembered weight is reused to pick the right user on subsequent scans, even after you restart Home Assistant or the add-on.

If you change the user slug (by renaming the user), the remembered weight does not carry over because the slug is the lookup key.

## Home Assistant Sensors

With MQTT and HA auto-discovery enabled, these sensors appear automatically:

- Weight
- Body fat (%)
- Water (%)
- Muscle mass
- Bone mass
- BMI
- BMR (kcal)
- Visceral fat
- Metabolic age
- Impedance (diagnostic)

Weight, muscle mass, and bone mass use the weight unit you selected (kg or lbs).

## Garmin Connect

To upload measurements to Garmin Connect:

1. Enable **Garmin Connect** in the configuration
2. Enter your Garmin email and password
3. Start the add-on

On first start the add-on authenticates with Garmin and stores the OAuth tokens under `/data/garmin-tokens` inside the container. Subsequent runs reuse those tokens, so your password is only used once.

### If your Garmin account uses MFA

Home Assistant add-ons run without an interactive terminal, so the add-on cannot prompt for a 2FA code. If your account has MFA enabled:

1. On a laptop or desktop, clone the repo and run:
   ```bash
   python3 garmin-scripts/setup_garmin.py
   ```
   Enter your email, password, and MFA code when prompted. This writes `garmin_tokens.json` to `~/.garmin_tokens/`.
2. Copy that file into `/share/ble-scale-sync/garmin-tokens/` on the Home Assistant host (use the Samba or File editor add-on).
3. Restart the BLE Scale Sync add-on. On startup it detects the pre-generated token and imports it into `/data/garmin-tokens/`.

If Garmin also blocks cloud or residential proxy IPs, the same workflow applies: authenticate from a trusted network, then import the token.

If you disable Garmin in the add-on UI, cached tokens are left in place so you can turn it back on without re-authenticating.

### Upgrading from add-on v1.7.x or v1.8.0

Add-on v1.8.1 bumps `garminconnect` to 0.3.x, which uses a new native auth engine and a new token format. Tokens from earlier versions (`oauth1_token.json`, `oauth2_token.json`) are incompatible and are removed automatically on first start. The add-on re-runs `setup_garmin.py` with the email and password you entered in the UI, so for non-MFA accounts no action is needed beyond restarting the add-on. MFA users follow the workaround above with the new single-file token.

## Advanced: Custom Config

For advanced setups (multi-user, additional exporters like InfluxDB/Webhook/Ntfy/Strava/File), enable **Use custom config.yaml** and place your configuration at:

```
/share/ble-scale-sync/config.yaml
```

See [config.yaml.example](https://github.com/KristianP26/ble-scale-sync/blob/main/config.yaml.example) for the full reference.

When custom config is enabled, all other options in the Configuration tab are ignored.

## Supported Scales

23 BLE smart scale brands are supported, including Xiaomi, Renpho, Eufy, Yunmai, Beurer, Sanitas, Medisana, and more.

See the [full list](https://blescalesync.dev/guide/supported-scales).

## Troubleshooting

### Bluetooth adapter reset

The add-on power-cycles the Bluetooth adapter on startup to ensure a clean state. This is enabled by default (**Reset Bluetooth adapter on startup**). If you have other HA Bluetooth integrations that lose connectivity when this add-on restarts, disable the option.

### No scale found

- Make sure your scale is awake (step on it)
- Check that the Bluetooth adapter is working: enable debug logging and look for "Discovery started" in the logs
- If you have multiple Bluetooth adapters, try setting a specific adapter (e.g., `hci1`)

### MQTT not connecting

- Check that the Mosquitto add-on is running
- If using an external broker, verify the URL and credentials
- Enable debug logging for detailed MQTT connection info

### Garmin upload failing

- Check that your email and password are correct
- Garmin may require re-authentication after a while; check the logs for auth errors

## Links

- [Documentation](https://blescalesync.dev)
- [GitHub](https://github.com/KristianP26/ble-scale-sync)
- [Supported scales](https://blescalesync.dev/guide/supported-scales)
- [Issue tracker](https://github.com/KristianP26/ble-scale-sync/issues)
