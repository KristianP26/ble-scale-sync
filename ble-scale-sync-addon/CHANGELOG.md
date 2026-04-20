# Changelog

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
