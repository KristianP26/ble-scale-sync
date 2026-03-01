---
title: Alternatives
description: How BLE Scale Sync compares to openScale, openScale-sync, manufacturer apps, and more.
---

# Alternatives

## Comparison

| | BLE Scale Sync | openScale | openScale-sync | Manufacturer App |
|---|---|---|---|---|
| **Platform** | Linux, macOS, Windows, Docker | Android | Android | iOS / Android |
| **Headless (always-on)** | Yes, Raspberry Pi or server | No | No | No |
| **Phone required** | No | Yes | Yes | Yes |
| **BLE connectivity** | Local adapter or [ESP32 proxy](/guide/esp32-proxy) over WiFi | Phone BLE | Phone BLE | Phone BLE |
| **Garmin Connect** | Automatic upload | No | Via Health Connect | Some (indirect) |
| **Strava** | Automatic weight sync | No | No | No |
| **MQTT / Home Assistant** | Auto-discovery, LWT, 10 sensors | No | MQTT 3.1 / 5.0 | No |
| **InfluxDB** | Built-in | No | No | No |
| **Webhook** | Built-in | No | No | No |
| **Push notifications** | Ntfy | No | No | App only |
| **Local file export** | CSV and JSONL | SQLite | No | No |
| **Multi-user** | Automatic weight matching | Manual selection | Per-user sync | Per-account |
| **Supported scales** | 23 brands | 20+ brands | Via openScale | 1 (own brand) |
| **Body composition** | 10 metrics (BIA) | Varies | 4 metrics | Varies |
| **Docker** | Multi-arch images | No | No | No |
| **Open source** | GPL-3.0 | GPL-3.0 | GPL-3.0 | No |

## BLE Scale Sync

**Best for:**
- Automatic Garmin Connect and Strava sync without a phone
- Home automation integration (MQTT, InfluxDB, webhooks)
- Headless always-on deployment (Raspberry Pi)
- Remote BLE via [ESP32 proxy](/guide/esp32-proxy) when the server has no Bluetooth
- Multi-user households with automatic identification
- Local data logging (CSV/JSONL) alongside cloud exports
- Self-hosting and privacy

## openScale

[openScale](https://github.com/oliexdev/openScale) is an excellent open-source Android app for reading BLE scales with a polished UI.

**Best for:**
- Android users who prefer a phone app
- Users who want a local-first scale tracker on their phone

::: info
BLE Scale Sync's scale protocols were ported from openScale. Both projects benefit from the same reverse-engineering work by the open-source community.
:::

## openScale-sync

[openScale-sync](https://github.com/oliexdev/openScale-sync) is a companion Android app that syncs openScale measurements to external services (Health Connect, Wger, MQTT).

**Best for:**
- openScale users who want Garmin Connect sync via Health Connect
- Android users who want MQTT export without a server

**Limitations:**
- Requires both openScale + openScale-sync installed on Android
- No InfluxDB, webhook, or ntfy support
- Syncs only 4 metrics (weight, body fat, muscle mass, water)

## Manufacturer Apps

Renpho, Yunmai, Xiaomi Mi Fit, and similar apps are the simplest option if you only use one brand.

**Trade-offs:**
- Locked to one brand's ecosystem
- No direct Garmin Connect export (some support Health Connect on Android)
- No MQTT, InfluxDB, or webhook integration
- No headless operation, requires phone for every measurement
- **Your data is stored in their cloud.** Most manufacturer apps upload your weight, body fat, and other health metrics to servers in China or the US. Their privacy policies typically allow sharing data with "partners" or using it for "business purposes", which may include selling aggregated health data to third parties
