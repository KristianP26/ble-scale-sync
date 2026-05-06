---
title: FAQ
description: Frequently asked questions about BLE Scale Sync. Supported scales, privacy, body composition accuracy, Garmin 2FA, deployment options, and updates.
outline: deep
head:
  - - meta
    - name: keywords
      content: ble scale sync faq, smart scale garmin questions, bluetooth scale raspberry pi faq, body composition accuracy, garmin 2fa scale, home assistant smart scale faq, multi user scale, ble scale privacy
  - - script
    - type: application/ld+json
    - |-
      {"@context":"https://schema.org","@type":"FAQPage","mainEntity":[{"@type":"Question","name":"Do I need a smartphone?","acceptedAnswer":{"@type":"Answer","text":"No. BLE Scale Sync is designed to replace the vendor phone app. Reads happen entirely on your server (Raspberry Pi, NAS, PC, Home Assistant host, or Docker host). Once the service runs, stepping on the scale is the only user action."}},{"@type":"Question","name":"Do I need Home Assistant?","acceptedAnswer":{"@type":"Answer","text":"No. The Home Assistant Add-on is one deployment target out of several. You can run the app on plain Docker, bare Node.js, or as the HA add-on. All three speak MQTT auto-discovery so the data can still appear in HA either way."}},{"@type":"Question","name":"Does it work offline without WiFi?","acceptedAnswer":{"@type":"Answer","text":"BLE read and body composition calculation are fully offline. Local exporters (File CSV/JSONL, a local MQTT broker, a local InfluxDB) work without internet. Cloud exporters (Garmin Connect, Strava, public Ntfy) need internet at the moment of export. There is no retry queue, so a reading taken while cloud is unreachable is lost for that specific exporter."}},{"@type":"Question","name":"Is my scale supported?","acceptedAnswer":{"@type":"Answer","text":"There are 24 scale adapters covering Xiaomi, Renpho, QN Scale, Eufy, Yunmai, Beurer, Sanitas, Medisana, Soehnle, and many unbranded Asian scales that reuse Renpho or QN protocols. Check the supported scales page for the full list. Auto-detect covers most cases."}},{"@type":"Question","name":"What does the update check send?","acceptedAnswer":{"@type":"Answer","text":"One GET request per 24 hours to api.blescalesync.dev/version after a successful measurement. Only the app version, OS, and CPU architecture are sent via the User-Agent header. No readings, no MAC address, no user data. The check is disabled automatically when CI=true, and can be turned off with update_check: false in config.yaml."}},{"@type":"Question","name":"Why are my body fat numbers different from the manufacturer app?","acceptedAnswer":{"@type":"Answer","text":"Scale vendors keep their BIA formulas closed and tune them for their own hardware. This project uses openScale-derived formulas, plus the Deurenberg fallback when impedance is not available. Absolute numbers will differ by a few percent from the vendor app, which is normal for any consumer BIA device. Use the trend, not the absolute value, for tracking."}},{"@type":"Question","name":"Does Garmin Connect 2FA / MFA work?","acceptedAnswer":{"@type":"Answer","text":"Yes. The setup wizard prompts for the 2FA code during the first login. Tokens are cached and reused for roughly twelve months, so the code is only needed once per cycle. Headless servers authenticate interactively during setup-garmin."}},{"@type":"Question","name":"Can I use multiple scales at once?","acceptedAnswer":{"@type":"Answer","text":"Not yet in a single instance. A workaround is to run two independent services with separate config files. Full multi-scale aggregation is tracked in GitHub issue 124."}}]}
---

# Frequently Asked Questions

Short answers to the questions that come up most often. For step-by-step setup, start with the [Getting Started](/guide/getting-started) guide. For scale-specific or connection issues, see [Troubleshooting](/troubleshooting).

> [!TIP]
> Every question on this page is listed in the **On this page** sidebar on the right. Press `/` to search across all docs at once. Most answers link to the longer reference page if you need more detail.

## Getting started

### Do I need a smartphone?

No. The whole point of BLE Scale Sync is going phone-free. Measurements happen entirely on your server (Raspberry Pi, NAS, PC, Home Assistant host, or Docker host). Once the service is running, stepping on the scale is the only user action involved.

### Do I need Home Assistant?

No. The [Home Assistant Add-on](/guide/home-assistant-addon) is one deployment target out of several. You can also run on plain [Docker](/guide/getting-started#docker), as a [standalone Node.js process](/guide/getting-started#standalone), or behind an [ESP32 proxy](/guide/esp32-proxy). Any of those three speak MQTT auto-discovery, so the sensors can still appear in HA if you want them to.

### Does it work offline, without WiFi?

BLE read and body composition calculation are fully offline. Local exporters (File CSV/JSONL, a local MQTT broker, a local InfluxDB) work with no internet at all. Cloud exporters (Garmin Connect, Strava, public Ntfy) need internet only at the moment of export.

There is **no retry queue**. If a reading fires while Garmin is unreachable, that specific export fails and the reading is lost for that target. Other exporters in the same fan-out run independently, so a File or local MQTT export still succeeds.

### What hardware do I need?

Any device with a BLE radio running Node.js 20.19+ or Docker. Recommended: [Raspberry Pi Zero 2W](/guide/getting-started#recommended-hardware) for about 15 euros, with built-in Bluetooth and roughly 0.4 W idle power draw. The original Pi Zero W (first-gen, ARMv6) is [not supported](/troubleshooting#install-fails-on-raspberry-pi-zero-w-first-gen).

---

## Privacy and data

### Where does my data go?

> [!IMPORTANT]
> Only to the exporters you configure in `config.yaml`. Enable Garmin and readings go to Garmin Connect; enable only File and data stays on disk. There is no vendor cloud in the middle, no account, and no telemetry beyond the optional anonymous update check.

### What does the update check send?

One `GET api.blescalesync.dev/version` request per 24 hours after a successful reading. Only the app version, OS, and CPU architecture travel in the `User-Agent` header. No readings, no MAC, no user data. Aggregated stats are visible at [stats.blescalesync.dev](https://stats.blescalesync.dev).

### Can I disable the update check?

Yes. Set `update_check: false` in `config.yaml`, or run with `CI=true` in the environment. See the [Configuration reference](/guide/configuration#update-check).

---

## Scales and BLE

### Is my scale supported?

Check the [supported scales](/guide/supported-scales) page for the full list of 24 adapters. Coverage includes Xiaomi, Renpho (Elis 1, FITINDEX, Sencor, QN Scale), Eufy, Yunmai, Beurer, Sanitas, Medisana, Soehnle, and many unbranded Asian scales that reuse the Renpho or QN protocol. Auto-detect matches most devices without any MAC pinning.

### My scale is not listed. Can I add it?

Yes, and community adapter contributions are welcome. Open a [GitHub issue](https://github.com/KristianP26/ble-scale-sync/issues/new/choose) with the scan output, a diagnose dump, and an HCI snoop log from the vendor app (three things the issue template asks for). Most new protocols land in 50 to 150 lines once the captures are in hand.

### Can I use multiple scales with one user?

Not yet in a single instance. As a workaround, run two independent services with separate config files. First-class multi-scale aggregation (merge, priority fallback, per-user pinning) is tracked in [issue 124](https://github.com/KristianP26/ble-scale-sync/issues/124).

### How do I find my scale's MAC address?

```bash
# Docker
docker run --rm --network host --cap-add NET_ADMIN --cap-add NET_RAW \
  --group-add 112 -v /var/run/dbus:/var/run/dbus:ro \
  ghcr.io/kristianp26/ble-scale-sync:latest scan

# Node.js
npm run scan
```

Step on the scale during the scan so it starts advertising.

### My scale is discovered but connection fails. What do I try first?

On Linux, `sudo systemctl restart bluetooth` fixes roughly 80% of transient GATT issues. If failures persist, flip `ble.noble_driver` between `abandonware` and `stoprocent` in `config.yaml`. The full decision tree lives in [Troubleshooting](/troubleshooting).

### My Raspberry Pi works for a few hours then stops finding the scale until I reboot. How do I fix this?

This is the BlueZ "stuck discovery" state, a known kernel/firmware-level issue on Pi 3 / 4 / Zero 2W with the on-board Broadcom Bluetooth chip. BLE Scale Sync's recovery tiers (D-Bus stop, btmgmt power-cycle, rfkill, `systemctl restart bluetoothd`) clear it on most setups but sometimes don't on Pi Broadcom firmware. Home Assistant has the [same problem](https://github.com/home-assistant/operating-system/issues/4022) and recommends the same fix: an [ESP32](/guide/esp32-proxy) or [ESPHome](/guide/esphome-proxy) Bluetooth proxy that runs the BLE work outside the Pi. If you want to stick with the on-board chip, the built-in [watchdog](/troubleshooting#ble-discovery-stops-working-after-hours-bluez-stuck-state) auto-restarts the container after 10 consecutive scan failures so Docker can recover automatically.

---

## Body composition

### Why are my body-fat numbers different from the manufacturer's app?

Scale vendors keep their BIA formulas closed and tune them for their own electrode geometry. BLE Scale Sync uses [openScale-derived formulas](/body-composition), with the Deurenberg equation as a weight-only fallback for scales that do not report impedance. Absolute numbers will drift a few percent away from the vendor app, which is normal for any consumer BIA device. Track the trend, not the absolute value.

### Is BIA accurate?

BIA is a population-level estimator. Any consumer scale, vendor app or this tool, has roughly three to five percent absolute error on body fat. It is useful as a weekly or monthly trend signal, not as a clinical number. For clinical-grade accuracy you want DEXA or a hydrostatic weighing, not a 30-euro bathroom scale.

### What does athlete mode change?

It lowers the body fat estimate for users with high muscle mass. Trained athletes hold more water in lean tissue, and standard BIA formulas overestimate their fat percentage as a result. Toggle per user via `is_athlete: true`. Formula details at [Body Composition](/body-composition#athlete-mode).

---

## Exporters

### Does Garmin Connect 2FA or MFA work?

Yes. During the first login, `setup-garmin` prompts for the 2FA code. Tokens are cached and reused for around twelve months, so the code is only needed once per cycle. On headless servers, run the setup step interactively and copy the token directory to the target. See the [Garmin exporter guide](/exporters#garmin).

### Can each household member sync to a different Garmin account?

Yes. Define `exporters` at the user level and they override `global_exporters`. Each user can have their own Garmin, Strava, MQTT, and File exporters independently. See [Per-user exporters](/multi-user#per-user-exporters).

### Does it work with Apple Health, Google Fit, or Fitbit?

Not directly. A native exporter for these is on the roadmap. In the meantime, the [Webhook exporter](/exporters#webhook) plus a bridge (iOS Shortcuts posting into HealthKit, a small script posting to the Fitbit API, Google Fit REST API via a custom endpoint) covers most cases.

### How do I run custom logic on each reading?

Use the [Webhook exporter](/exporters#webhook) to POST a JSON body with all computed metrics to any HTTP endpoint. From there you can forward to n8n, Make, Zapier, Node-RED, or a custom script. Home Assistant users can also build automations on top of the MQTT sensors.

---

## Deployment

### Which Raspberry Pi should I use?

Pi Zero 2W is the sweet spot: ARMv7, built-in Bluetooth, roughly 15 euros, about 0.4 W idle. Pi 3, 4, and 5 all work fine as well. The original Pi Zero W is not supported because `esbuild` has no ARMv6 binaries and `npm install` fails with a `SIGILL` error.

### Can I run this in Kubernetes?

Yes, but BLE is the tricky part. Two paths work:

- A `DaemonSet` pinned to a node that has a Bluetooth radio, with `NET_ADMIN` and `NET_RAW` capabilities and the host D-Bus socket mounted in.
- Any plain `Deployment` combined with an [ESP32 proxy](/guide/esp32-proxy) or [ESPHome proxy](/guide/esphome-proxy) so the cluster needs no radio at all.

The proxy approach is simpler to operate and is the recommended route for clusters.

### Docker on macOS or Windows?

Docker Desktop on those platforms runs Linux inside a VM with no BLE bridge to the host radio. Use the [standalone Node.js install](/guide/getting-started#standalone) on macOS and Windows instead, or offload the Bluetooth work to an [ESP32 proxy](/guide/esp32-proxy) and run the app in Docker on another machine.

### HA Add-on vs Docker?

If you run Home Assistant OS or Supervised, the [add-on](/guide/home-assistant-addon) is the easiest path: UI config, MQTT auto-detection, and one-click updates. On Home Assistant Container, HA Core, or a non-HA host, use [Docker](/guide/getting-started#docker). Both routes feed HA via MQTT auto-discovery with identical sensor layout, so the choice is about ergonomics, not features.

---

## Updates and maintenance

### How do I update?

It depends on the deployment target. The [Auto Updates guide](/guide/auto-update) has full recipes for the HA Add-on Supervisor toggle, Watchtower on Docker, and a systemd timer for Raspberry Pi source deploys.

### What happens to my config and tokens on update?

`config.yaml`, Garmin tokens, Strava tokens, and the `last_known_weight` field survive container rebuilds as long as you mount them as volumes (Docker) or keep the `/data` directory intact (HA Add-on). Version bumps never rewrite these files, with one exception: `last_known_weight` is updated in-place after each measurement, with write locking and atomic replacement to avoid torn writes.

### How do I back up?

Copy these off-device:

- `config.yaml` (the source of truth for users, exporters, and settings)
- `garmin-tokens/` and `strava-tokens/` (so you do not need to re-authenticate)
- The HA Add-on `/data/` directory or Docker named volumes, depending on your setup

On Home Assistant, the Supervisor **Full Backup** covers everything in `/data` automatically. See the safety checklist in [Auto Updates](/guide/auto-update#safety-checklist-before-enabling-unattended-updates).

### Where are the logs?

- **HA Add-on**: Supervisor > Add-on > Log tab.
- **Docker**: `docker logs ble-scale-sync` or `docker compose logs -f ble-scale-sync`.
- **Systemd source deploy**: `journalctl -u ble-scale.service -f`.

Enable `runtime.debug: true` in `config.yaml` for verbose BLE diagnostics when reporting an issue.
