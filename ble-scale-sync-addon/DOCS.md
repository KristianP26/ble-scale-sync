# BLE Scale Sync

Reads BLE smart scales and sends each weigh-in to Home Assistant over MQTT auto-discovery, to Garmin Connect and to [other exporters](https://blescalesync.dev/exporters). The full guide is at [blescalesync.dev/guide/home-assistant-addon](https://blescalesync.dev/guide/home-assistant-addon).

## Getting started

1. If you have no MQTT broker yet, install and start the **Mosquitto broker** app.
2. On the **Configuration** tab, fill in the user profile (name, height, birth date, gender), and leave **Enable MQTT** and **Auto-detect MQTT broker** on.
3. Leave **Scale MAC address** empty for the first weigh-in.
4. If this host's Bluetooth adapter is out of range of the scale, or the host has none, pick another **Bluetooth transport** (below).
5. Start the app on the **Info** tab and step on the scale.
6. Copy the scale's address from the `Auto-discovered:` or `Matched:` line of the log into **Scale MAC address** and restart the app, so it never reads a neighbor's scale.

The sensors appear under **Settings** > **Devices & services** > **MQTT** after the first reading. Masses always reach Home Assistant in kg; to see pounds, change the unit in the sensor's settings.

With the `ha-bluetooth` transport, **Settings** > **Devices & services** > **Bluetooth** > **Advertisement monitor** also shows the scale's address while you stand on it. Check the [supported scales](https://blescalesync.dev/guide/supported-scales) for your model.

## Bluetooth transports

| Your setup                                                                                                          | Transport         |
| ------------------------------------------------------------------------------------------------------------------- | ----------------- |
| This host's Bluetooth adapter is in range of the scale                                                              | `local` (default) |
| The scale sends its weight in its advertisement, and Home Assistant already hears it (any adapter or proxy it uses) | `ha-bluetooth`    |
| The scale needs a connection, and an ESPHome Bluetooth proxy that Home Assistant has not adopted is near it         | `esphome-proxy`   |
| The scale needs a connection, and an ESP32 with the BLE Scale Sync proxy firmware is near it                        | `mqtt-proxy`      |

[Which scales work](https://blescalesync.dev/guide/ha-bluetooth#which-scales-work) lists the scales that send their weight in the advertisement; every other scale needs a connection. Setting up the node: [ESPHome proxy](https://blescalesync.dev/guide/esphome-proxy), [ESP32 proxy](https://blescalesync.dev/guide/esp32-proxy).

- `ha-bluetooth` needs no other option and no access token. An ESPHome node used this way is adopted in Home Assistant.
- `esphome-proxy` needs **ESPHome proxy host** and, for a device with API encryption, **ESPHome API encryption key**. The node must not be adopted in Home Assistant.
- `mqtt-proxy` uses the broker of the MQTT options (`shared`) or one inside this app (`embedded`, with its own port, username and password). Give the ESP32 the same broker address, device ID and topic prefix in its `config.json`.

With any transport but `local`, the options that steer this host's adapter and the scan delays are not used, and the adapter reset at startup is skipped.

## Garmin Connect

Turn on **Enable Garmin Connect**, enter your Garmin email and password and start the app. It signs in once and keeps the token in `/data/garmin-tokens`.

### If your Garmin account uses MFA

This app has no terminal to type an MFA code into. The same steps work when Garmin blocks this host's IP address:

1. On another computer, run `setup-garmin` from BLE Scale Sync as described under [Garmin authentication](https://blescalesync.dev/exporters#garmin-authentication), and enter the MFA code when asked.
2. Copy the `garmin_tokens.json` it wrote into `/share/ble-scale-sync/garmin-tokens/` on this host, with the Samba share or File editor app.
3. Restart the app. The log shows `IMPORTING a Garmin token`.

The token is imported only while `/data/garmin-tokens` holds none. To switch to another account, reinstall the app (this also clears the remembered weights and the retry queue) and import again.

## Custom config

For several users, other exporters or transport settings the tab does not have, turn on **Use custom config.yaml** and put your file at `/share/ble-scale-sync/config.yaml`. The other options are then ignored, except **Proxy silence before restart**, and **Bluetooth adapter** with **Reset Bluetooth adapter on startup**, which still control the adapter reset at startup. Restart the app after editing the file. Details: [custom config mode](https://blescalesync.dev/guide/home-assistant-addon#custom-config-mode).

## BLE Scale Sync restarts on its own

When BLE Scale Sync cannot recover inside the running process, for example after repeated Bluetooth failures or when a Bluetooth proxy stays silent, it exits and the app starts it again, without the Supervisor's Watchdog switch. The log shows `BLE Scale Sync exited with code N after Ns; restart #M in Ns.` The wait starts at 5 seconds and doubles while BLE Scale Sync keeps exiting shortly after starting, up to 5 minutes; a run of 10 minutes resets it. The reason is in the lines above each restart.

## Errors at startup

A transport that cannot run stops the app with `ERROR:` and the reason, followed by `Not falling back to the built-in Bluetooth adapter`. Fix the option it names, or set **Bluetooth transport** back to `local`:

- `esphome_proxy_host is empty`, or `takes a host name or IP address, not a URL`: enter only the address, such as `192.168.1.50`.
- `esphome_proxy_encryption_key is not a valid ESPHome API key`: copy the whole key from `api: encryption: key:` in the device's YAML, 44 characters ending in `=`.
- `no MQTT broker is available`: start the Mosquitto broker app with **Auto-detect MQTT broker** on, set **MQTT broker URL**, or set **ESP32 proxy broker** to `embedded`.
- `needs an mqtt_broker_url that starts with mqtt:// or mqtts://`: the ESP32 proxy cannot share a `ws://` broker; enter the `mqtt://` address or use `embedded`.
- `needs mqtt_proxy_username and mqtt_proxy_password`: fill in both.
- `cannot contain + or #`: use the same plain device ID and topic prefix as the ESP32's `config.json`.
- `the Supervisor gave this add-on no SUPERVISOR_TOKEN`: open an issue with the log.

Other startup errors:

- `custom_config is enabled but /share/ble-scale-sync/config.yaml does not exist`: create the file or turn off **Use custom config.yaml**.
- `DBusError` with `AccessDenied` and `An AppArmor policy prevents this sender`: uninstall and reinstall the app so the Supervisor applies its manifest.

## More help

- [Home Assistant add-on guide](https://blescalesync.dev/guide/home-assistant-addon)
- [Supported scales](https://blescalesync.dev/guide/supported-scales)
- [Exporters](https://blescalesync.dev/exporters)
- [Troubleshooting](https://blescalesync.dev/troubleshooting)
- [Issue tracker](https://github.com/KristianP26/ble-scale-sync/issues): attach the app log with **Debug logging** on, the scale model and the transport.
