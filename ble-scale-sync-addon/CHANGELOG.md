# Changelog

## 1.10.2

- Fix Renpho ES-26M weight readings being rejected by the QN-Scale handshake (the 18-byte scale-info frame was misread, leaving the scale at `proto=0xFF`). Stable readings without impedance (e.g. when wearing socks) are no longer skipped on the ES-26M variant.
- ESPHome proxy: on connect, the add-on now logs which configured scale brands are broadcast-capable and which need a GATT connection (Phase 2). Makes it obvious from the logs whether your scale is supported by the ESPHome proxy transport instead of having to reproduce the failure twice.

## 1.10.1

- Fix `debug: true` in custom `config.yaml` not switching the log level. The add-on UI's **Debug logging** option already worked, but custom-config users had to set the `DEBUG` env var to get verbose BLE logs. Now both paths produce the same logs.
- ESPHome proxy: GATT-only scales (e.g. Renpho Elis 1) now log a one-time warning instead of silently dropping every advertisement.

## 1.10.0

- Add **embedded MQTT broker for the ESP32 BLE proxy**: zero-config, no Mosquitto add-on required. When using the ESP32 proxy through custom config, leave `broker_url` empty and the add-on starts its own broker on port 1883.
- Add **ESPHome Bluetooth proxy** as a third BLE transport option (experimental, broadcast-only in phase 1). If you already run an ESPHome BT proxy mesh for Home Assistant, you can reuse it as the BLE radio without flashing a dedicated ESP32 or running an MQTT broker. Configurable via custom config (`ble.handler: esphome-proxy`).
- Setup wizard (custom-config users): adds an **embedded broker** option for the mqtt-proxy handler and an **ESPHome Bluetooth proxy** option in the BLE handler picker.

## 1.9.0

- Add **Eufy Smart Scale P2 (T9148)** and **P2 Pro (T9149)** support. Previous versions misidentified these as QN-Scales and failed with "Operation is not supported" on FFF1. The new adapter does the AES-128 handshake required by these models and reads weight + impedance over GATT FFF2.
- Fix add-on with no exporters configured exiting with code 1 immediately after a successful weigh-in. The runtime now warns once that no exporters are configured and continues.

## 1.8.2

- Fix **Sanitas SBF70 / Beurer BF710** family showing a stuck `12.80 kg` reading regardless of the real weight. The BF710 variant uses a compact 5-byte frame at a different byte offset than its BF700 / BF800 siblings; the adapter now branches on the variant and applies a 3-reading stability window so the scale's metadata frame no longer triggers early completion.

## 1.8.1

- Fix Garmin upload failing with `'Garmin' object has no attribute 'garth'` after `garminconnect` 0.3.0 dropped the garth dependency. Migrated to the new native auth API and single `garmin_tokens.json` token format.
- Legacy `oauth1_token.json` / `oauth2_token.json` files are automatically removed on first start; the add-on re-authenticates from the credentials you entered in the UI. MFA users regenerate the token file per the MFA workaround in DOCS.md.
- Docker: added `libcurl4-openssl-dev` so `curl_cffi` (new transitive dep) builds from source on armv7.

## 1.7.0

- Initial Home Assistant Add-on release
- MQTT auto-detection from Mosquitto add-on
- HA auto-discovery for 10 body composition sensors
- Garmin Connect export support
- BLE adapter selection for multi-adapter setups
- Custom config.yaml support for advanced users
- 23 supported BLE scale brands
