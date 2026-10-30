---
layout: home
description: BLE Scale Sync reads weight and body composition from Bluetooth smart scales and sends them to Garmin Connect, Home Assistant and other targets, without the vendor app.

hero:
  name: BLE Scale Sync
  text: Automatic body composition sync
  tagline: Reads weight and impedance from Bluetooth smart scales and sends them to Garmin Connect, Strava, Home Assistant and more, without the vendor's phone app. Runs on Linux, macOS and Windows.
  image:
    src: /logo.svg
    alt: BLE Scale Sync
  actions:
    - theme: brand
      text: Get Started
      link: /guide/getting-started
    - theme: alt
      text: View on GitHub
      link: https://github.com/KristianP26/ble-scale-sync

features:
  - icon: "\u2696\uFE0F"
    title: Smart Scales
    details: Xiaomi, Renpho, Eufy, Yunmai, Beurer, Sanitas, Medisana and more, detected automatically.
    link: /guide/supported-scales
    linkText: See all scales
  - icon: "\uD83D\uDCE4"
    title: 13 Export Targets
    details: Garmin Connect, Strava, MQTT for Home Assistant, InfluxDB, webhooks, notifications and files, each with its own settings per user.
    link: /exporters
    linkText: Configure exporters
  - icon: "\uD83E\uDDE0"
    title: Body Composition
    details: Body fat, muscle, water, bone and more from weight and impedance.
    link: /body-composition
    linkText: See formulas
  - icon: "\uD83D\uDC65"
    title: Multi-User
    details: Identifies who stepped on the scale by weight, with exporters per user.
    link: /multi-user
    linkText: Learn more
  - icon: "\uD83D\uDCBB"
    title: Cross-Platform
    details: Runs natively on Linux, macOS and Windows, or as a Docker image on Linux.
    link: /guide/getting-started
    linkText: Install guide
  - icon: "\uD83C\uDFE0"
    title: Home Assistant Add-on
    details: Installs on Home Assistant OS or Supervised, configured in the UI, with Mosquitto detected for MQTT discovery.
    link: /guide/home-assistant-addon
    linkText: Add-on guide
  - icon: "\uD83D\uDCE1"
    title: Bluetooth Proxies
    details: Read the scale through an ESP32, an ESPHome proxy or Home Assistant's Bluetooth, so the server needs no adapter of its own.
    link: /guide/transports
    linkText: Choose a transport
  - icon: "\uD83D\uDD12"
    title: Self-Hosted and Open Source
    details: Measurements go only to the targets you configure, with no vendor account. The daily update check sends only the app version, OS and CPU type, and can be turned off.
    link: /alternatives
    linkText: Compare alternatives
---

## Install {#quick-start}

- [Docker](/guide/getting-started#docker): Linux, including Raspberry Pi and NAS.
- [Home Assistant add-on](/guide/home-assistant-addon): Home Assistant OS or Supervised.
- [Node.js](/guide/getting-started#standalone): Linux, macOS and Windows.

The [Getting Started guide](/guide/getting-started) walks through each one, and [Supported Scales](/guide/supported-scales) shows how to find your scale.
