---
title: FAQ
description: Short answers to common BLE Scale Sync questions, each linking to the page with the details.
outline: deep
---

# Frequently Asked Questions

For a specific error, see [Troubleshooting](/troubleshooting).

## Getting Started

### Do I need a smartphone?

No. The app reads the scale over Bluetooth on your server (a Raspberry Pi, NAS, PC or Home Assistant host), so stepping on the scale is all you do once it runs. See [Getting Started](/guide/getting-started).

### Do I need Home Assistant?

No. The app runs on Docker, as a Node.js process or as a Home Assistant add-on, and each of them can publish to Home Assistant over MQTT if you want the sensors there. See [Getting Started](/guide/getting-started) and [MQTT](/exporters#mqtt).

### Does it work offline, without Wi-Fi? {#does-it-work-offline-without-wifi}

Reading the scale and calculating body composition work offline, and so do local targets such as a file or a local MQTT broker. Cloud targets such as Garmin Connect need internet at the moment of export. A failed export to a target that can record a past measurement is retried later; see [historical readings](/exporters#historical-readings).

### What hardware do I need?

A host with Bluetooth that runs Docker or a supported Node.js version, or a Bluetooth proxy near the scale. A Raspberry Pi Zero 2 W is enough; the first Pi Zero W is [not supported](/troubleshooting#install-fails-on-raspberry-pi-zero-w-first-gen). See [recommended hardware](/guide/getting-started#recommended-hardware).

## Privacy and Data

### Where does my data go?

Only to the exporters you configure. There is no vendor cloud and no account; the one other request the app makes is the optional update check below. See [Exporters](/exporters).

### What does the update check send?

At most one `GET https://api.blescalesync.dev/version` per UTC day, after a measurement. It carries only the app version, the OS and the CPU architecture in the `User-Agent` header: no readings, no MAC address, no user data. The date of the last check is kept locally in `.update-check-state.json` and never sent; aggregated stats are public at [stats.blescalesync.dev](https://stats.blescalesync.dev). See [Update check](/guide/configuration#update-check).

### Can I disable the update check?

Yes. Set `update_check: false` in `config.yaml` (in the add-on, turn off the `update_check` option), or run with `CI=true`. See [Update check](/guide/configuration#update-check).

## Scales and BLE

### Is my scale supported?

Check the [supported scales](/guide/supported-scales) page for the full list of 43 adapters. Most scales are detected automatically, without a MAC address; set `ble.scale_mac` afterwards so the app reads only yours.

### My scale is not listed. Can I add it?

Yes. Open a [GitHub issue](https://github.com/KristianP26/ble-scale-sync/issues/new/choose) with the scan output, a `ble-scale-sync diagnose` dump and, if you can, a [raw capture](/troubleshooting#capturing-every-frame-for-a-scale-that-is-not-decoded-correctly). [Report an issue](/troubleshooting#report-an-issue) lists what else to attach.

### Can I use several scales with one user? {#can-i-use-multiple-scales-with-one-user}

One instance reads one scale at a time; with `ble.scale_mac` unset it reads whichever supported scale it finds first. To use two scales side by side, run one instance per scale, each with its own config file and `ble.scale_mac`. See [Configuration](/guide/configuration#ble).

### How do I find my scale's MAC address?

Run `ble-scale-sync scan` (`npm run scan` from a clone, or the Docker `scan` command) and step on the scale while it runs. See [Getting Started](/guide/getting-started#docker).

### I set an option from the documentation and it does nothing. Why?

If the log says `Unknown config key '...'`, your build is older than the option: update the app. Otherwise the option was read, and the `Version` line at the top of the log names the exact build to put in an issue. In the add-on, installing the repository with `#dev` changes the options UI but not the app, see [testing a development build](/guide/home-assistant-addon#testing-a-development-build).

### My scale is discovered but the connection fails. What do I try first? {#my-scale-is-discovered-but-connection-fails-what-do-i-try-first}

On Linux, run `sudo systemctl restart bluetooth` and step on the scale again. Then follow [Connection Fails or Ends](/troubleshooting#connection-fails-or-ends).

### My Raspberry Pi stops finding the scale after a few hours. How do I fix it? {#my-raspberry-pi-works-for-a-few-hours-then-stops-finding-the-scale-until-i-reboot-how-do-i-fix-this}

That is the BlueZ stuck state of the on-board Broadcom chip. The app restarts discovery and resets the adapter on its own; if it keeps coming back, a Bluetooth proxy avoids it. See [BlueZ stuck state](/troubleshooting#ble-discovery-stops-working-after-hours-bluez-stuck-state).

## Body Composition

### Why are my body fat numbers different from the manufacturer's app?

Vendors keep their formulas closed and tune them for their own hardware, while this app uses published BIA formulas (and, for Xiaomi and Yunmai scales, formulas ported from openScale), or a BMI-based estimate when the scale reports no impedance. Expect a difference of a few percent and follow the trend. See [Body Composition](/body-composition).

### Is BIA accurate?

Consumer BIA, from any scale or app, is an estimate that fits a trend over weeks better than a single reading. For a clinical measurement you need a method such as DEXA. See [Body Composition](/body-composition).

### What does athlete mode change?

It lowers the body fat estimate for users with high muscle mass, for whom standard BIA formulas read too high. Set `is_athlete: true` for that user. See [athlete mode](/body-composition#athlete-mode).

## Exporters

### Does Garmin Connect work with 2FA or MFA? {#does-garmin-connect-2fa-or-mfa-work}

Yes. `ble-scale-sync setup-garmin` asks for the MFA code at the first login and saves tokens that later uploads reuse. The Home Assistant add-on cannot ask for a code; see [the MFA workaround](/guide/home-assistant-addon#mfa-workaround) and [Garmin Connect](/exporters#garmin).

### Can each household member sync to a different Garmin account?

Yes. Exporters set under a user apply to that user together with `global_exporters`, and a user's own exporter replaces a global one of the same type, Garmin included. See [per-user exporters](/multi-user#per-user-exporters).

### Does it work with Apple Health, Google Fit or Fitbit?

Not directly. The [webhook exporter](/exporters#webhook) can post each reading to a bridge you run, such as a script that writes it to that service's API.

### How do I run custom logic on each reading?

Use the [webhook exporter](/exporters#webhook): it posts every reading as JSON to any HTTP endpoint, such as n8n, Node-RED or your own script. In Home Assistant you can also automate on the MQTT sensors.

## Deployment

### Which Raspberry Pi should I use?

A Pi Zero 2 W, or a Pi 3, 4 or 5. The first Pi Zero W (ARMv6) does not work. See [recommended hardware](/guide/getting-started#recommended-hardware).

### Can I run this in Kubernetes?

Yes. Either pin a pod to a node with a Bluetooth radio, with `NET_ADMIN` and `NET_RAW` and the host D-Bus socket mounted, or run a plain Deployment with an [ESP32 proxy](/guide/esp32-proxy) or [ESPHome proxy](/guide/esphome-proxy), so the cluster needs no radio. The proxy is the simpler one to run.

### Docker on macOS or Windows?

Docker Desktop runs containers in a VM with no access to the host's Bluetooth. Use the [standalone install](/guide/getting-started#standalone) there, or a Bluetooth proxy with Docker on another machine. See [choose a transport](/guide/transports#choose-a-transport).

### HA add-on or Docker? {#ha-add-on-vs-docker}

On Home Assistant OS or Supervised, use the [add-on](/guide/home-assistant-addon). On Home Assistant Container, Core or a host without Home Assistant, use [Docker](/guide/getting-started#docker).

## Updates and Maintenance

### How do I update?

[Auto Updates](/guide/auto-update) covers each kind of install: the add-on, Docker Compose, npm and a clone.

### What happens to my config and tokens on update?

They stay as long as they live in mounted volumes (Docker) or in `/data` (add-on). An update does not rewrite them; only `last_known_weight` in `config.yaml` changes, after each measurement. See [what a re-created container loses](/guide/getting-started#_2-run).

### How do I back up?

Copy the directory that holds `config.yaml` and `.env`. With the wizard's default `token_dir` it also holds the `garmin-tokens` and `strava-tokens` directories; copy any other `token_dir` too. On Home Assistant, a full backup includes the add-on's `/data`. See [Auto Updates](/guide/auto-update#safety-checklist-before-enabling-unattended-updates).

### Where are the logs?

- Home Assistant add-on: the add-on's **Log** tab.
- Docker: `docker logs ble-scale-sync` or `docker compose logs -f ble-scale-sync`.
- systemd: `journalctl -u ble-scale.service -f`.

For an issue, turn on [debug mode](/troubleshooting#debug-mode) first.
