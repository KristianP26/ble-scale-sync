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

## Home Assistant Sensors

With MQTT and HA auto-discovery enabled, these sensors appear automatically:

- Weight (kg)
- Body fat (%)
- Water (%)
- Muscle mass (kg)
- Bone mass (kg)
- BMI
- BMR (kcal)
- Visceral fat
- Metabolic age
- Impedance (diagnostic)

## Garmin Connect

To upload measurements to Garmin Connect:

1. Enable **Garmin Connect** in the configuration
2. Enter your Garmin email and password
3. Start the add-on
4. If Garmin requires 2FA, check the add-on logs for the prompt

Garmin auth tokens are stored persistently in the add-on data directory.

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
