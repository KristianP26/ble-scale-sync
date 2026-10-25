---
title: Alternatives
description: How BLE Scale Sync compares with openScale, openScale-sync and manufacturer apps on platform, phone use, export targets, multi-user support and licensing.
---

# Alternatives

BLE Scale Sync reads the scale on an always-on host instead of a phone. The table compares it with the phone apps people use for the same job.

## Comparison

|                           | BLE Scale Sync                                               | openScale        | openScale-sync       | Manufacturer App |
| ------------------------- | ------------------------------------------------------------ | ---------------- | -------------------- | ---------------- |
| Platform                  | Linux, macOS, Windows, Docker                                | Android          | Android              | iOS / Android    |
| Headless (always-on)      | Yes, Raspberry Pi or server                                  | No               | No                   | No               |
| Phone required            | No                                                           | Yes              | Yes                  | Yes              |
| BLE connectivity          | Local adapter, ESP32 or ESPHome proxy, or Home Assistant Bluetooth ([transports](/guide/transports)) | Phone BLE        | Phone BLE            | Phone BLE        |
| Garmin Connect            | Automatic upload                                             | No               | Via Health Connect   | Some (indirect)  |
| Strava                    | Automatic weight sync                                        | No               | No                   | No               |
| MQTT / Home Assistant     | Auto-discovery, LWT                                          | No               | Yes                  | No               |
| Other targets             | InfluxDB, webhook, ntfy, [and more](/exporters)              | No               | Health Connect, Wger | No               |
| Local file export         | CSV and JSONL                                                | SQLite           | No                   | No               |
| Multi-user                | Automatic weight matching                                    | Manual selection | Per-user sync        | Per-account      |
| Supported scales          | 41 protocol adapters                                         | Many brands      | Via openScale        | Own brand only   |
| Body composition          | [BIA from impedance](/body-composition)                      | Varies           | From openScale       | Varies           |
| Docker                    | Multi-arch images                                            | No               | No                   | No               |
| Open source               | GPL-3.0                                                      | GPL-3.0          | GPL-3.0              | No               |

## BLE Scale Sync

Best for:

- Garmin Connect and Strava sync without a phone
- Home automation (MQTT, InfluxDB, webhooks)
- An always-on Raspberry Pi or server, or an [ESP32 proxy](/guide/esp32-proxy) when the server has no Bluetooth
- Households where the app tells users apart by weight
- A local CSV or JSONL log next to cloud exports

Limitations:

- Needs an always-on host in Bluetooth range of the scale, or a Bluetooth proxy near it
- The Docker image runs on Linux only

## openScale

[openScale](https://github.com/oliexdev/openScale) is an open-source Android app that reads BLE scales on the phone. Many of BLE Scale Sync's scale adapters are ported from it.

Best for:

- Android users who prefer a phone app
- A local-first scale tracker on the phone

Limitations:

- The phone must be near the scale for every measurement
- No Garmin Connect, Strava or MQTT export of its own

## openScale-sync

[openScale-sync](https://github.com/oliexdev/openScale-sync) is a companion Android app that sends openScale measurements to Health Connect, Wger and MQTT.

Best for:

- openScale users who want Garmin Connect sync through Health Connect
- Android users who want MQTT export without a server

Limitations:

- Needs both openScale and openScale-sync on an Android phone
- No InfluxDB, webhook or ntfy support

## Manufacturer Apps

Renpho, Yunmai, Xiaomi and similar apps are the shortest path if you use only one brand.

Best for:

- A household with scales of one brand that wants the vendor's own metrics

Limitations:

- Locked to one brand's scales
- No direct Garmin Connect export (some go through Health Connect on Android)
- No MQTT, InfluxDB or webhook integration
- A phone is needed for every measurement
- Most of them store measurements in the vendor's cloud account
