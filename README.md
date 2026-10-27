# BLE Scale Sync

![CI](https://github.com/KristianP26/ble-scale-sync/actions/workflows/ci.yml/badge.svg)
![GitHub Release](https://img.shields.io/github/v/release/KristianP26/ble-scale-sync)
![License: GPL-3.0](https://img.shields.io/github/license/KristianP26/ble-scale-sync?v=2)
![TypeScript](https://img.shields.io/badge/typescript-%3E%3D5-blue?logo=typescript&logoColor=white)
![Node.js](https://img.shields.io/badge/node-%3E%3D22-brightgreen?logo=node.js&logoColor=white)
![Docker](https://img.shields.io/badge/docker-ghcr.io-blue?logo=docker&logoColor=white)

BLE Scale Sync reads weight and body composition from Bluetooth Low Energy smart scales and sends every reading to Garmin Connect, Home Assistant, InfluxDB and other services. It runs on a Raspberry Pi, a Linux server, macOS, Windows or as a Home Assistant add-on, so you do not need the scale's phone app.

[Documentation](https://blescalesync.dev) | [Getting Started](https://blescalesync.dev/guide/getting-started) | [Supported Scales](https://blescalesync.dev/guide/supported-scales) | [Exporters](https://blescalesync.dev/exporters) | [Troubleshooting](https://blescalesync.dev/troubleshooting) | [FAQ](https://blescalesync.dev/faq)

## Install

### Docker (Linux)

Run the setup wizard in the container to write `config.yaml`, then start the container with host networking and the D-Bus socket mounted. Docker needs a Linux host with BlueZ, such as a Raspberry Pi. The commands and a Compose file are in [Getting Started: Docker](https://blescalesync.dev/guide/getting-started#docker).

### Home Assistant Add-on

[![Add BLE Scale Sync repository to your Home Assistant](https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg)](https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2FKristianP26%2Fble-scale-sync)

The add-on needs Home Assistant OS or Supervised. On HA Container or Core, use Docker; the sensors still appear through MQTT discovery. The [add-on guide](https://blescalesync.dev/guide/home-assistant-addon) covers options, Garmin sign-in and MFA.

### Node.js (Linux, macOS, Windows)

```bash
npx ble-scale-sync setup                 # wizard, writes ./config.yaml
CONTINUOUS_MODE=true npx ble-scale-sync  # always on
```

Requires Node.js 22.23.4+, 24.22.1+ or 26.12.1+ and a BLE adapter. [Getting Started: Standalone](https://blescalesync.dev/guide/getting-started#standalone) has the prerequisites, a systemd service and the install from a clone.

## Features

- Reads scales from Xiaomi, Renpho, Eufy, Yunmai, Beurer, Sanitas, Medisana and other brands, over a GATT connection or from their advertisements ([Supported Scales](https://blescalesync.dev/guide/supported-scales)).
- Sends each reading to [13 export targets](https://blescalesync.dev/exporters), among them Garmin Connect, Strava, MQTT with Home Assistant discovery, InfluxDB, webhooks and CSV or JSONL files.
- Computes [body composition](https://blescalesync.dev/body-composition) from weight and impedance, with a BMI-based estimate for scales that report no impedance.
- Tells household members apart by weight and gives each person their own exporters ([Multi-User](https://blescalesync.dev/multi-user)).
- Imports measurements stored in the scale's memory with their original time, for exporters that can record a past measurement ([historical readings](https://blescalesync.dev/exporters#historical-readings)).
- Uses the computer's own Bluetooth adapter, an [ESP32 BLE proxy](https://blescalesync.dev/guide/esp32-proxy), an [ESPHome Bluetooth proxy](https://blescalesync.dev/guide/esphome-proxy) or [Home Assistant Bluetooth](https://blescalesync.dev/guide/ha-bluetooth) as the radio ([Bluetooth Transports](https://blescalesync.dev/guide/transports)).
- Sets up through an interactive [setup wizard](https://blescalesync.dev/guide/configuration#setup-wizard-recommended), with `scan`, `validate` and `diagnose` commands for checking the result.
- Recovers BlueZ on Linux when discovery stops after hours of uptime ([BlueZ stuck state](https://blescalesync.dev/troubleshooting#ble-discovery-stops-working-after-hours-bluez-stuck-state)).
- Logs a notice when a new version is out; [Auto Updates](https://blescalesync.dev/guide/auto-update) has recipes for Watchtower, a systemd timer and the add-on.

## Privacy

No scale vendor app or account is involved. Readings go only to the exporters you configure. The one other request is a version check, at most once a day, that sends the app version, OS and CPU architecture; those also feed the public [usage stats](https://stats.blescalesync.dev). Set `update_check: false` to turn it off ([what the update check sends](https://blescalesync.dev/faq#what-does-the-update-check-send)).

## Help

If your scale is not found or its values look wrong, follow [Troubleshooting](https://blescalesync.dev/troubleshooting). For a scale that is not listed, collect a log with [debug mode](https://blescalesync.dev/troubleshooting#debug-mode) and open an [issue](https://github.com/KristianP26/ble-scale-sync/issues) with the log and the scale model.

## Credits

- Scale protocols: many adapters are ported from [openScale](https://github.com/oliexdev/openScale) by oliexdev and contributors.
- Eufy P2, P2 Pro, C20 and P3: [bdr99/eufylife-ble-client](https://github.com/bdr99/eufylife-ble-client).
- Etekcity Fit 8S: [etekcity_esf551_ble](https://github.com/ronnnnnnnnnnnnn/etekcity_esf551_ble), support contributed by Flautz.
- OKOK and Chipsea broadcast: public captures, checked against openScale and [ble_monitor](https://github.com/custom-components/ble_monitor).
- PICOOC Mini Lite: openScale (dnsfdv) and the advertisement log in oliexdev/openScale#1512.
- A&D UC-352BLE: the capture in oliexdev/openScale#1505 (mrblowntobits) and the GATT dump in [HEADS-project/ThingML-BLE](https://github.com/HEADS-project/ThingML-BLE).
- Huawei CH100 and AH100: openScale (danieldorigatti, martinriedel), the captures in oliexdev/openScale#547 (dmitriytim) and testing on a CH100 by Otautahi.
- QN-Scale, FITINDEX and a few others: reverse-engineered in this project.
- Garmin upload: [garminconnect](https://github.com/cyberjunky/python-garminconnect) by cyberjunky.
- BLE: [node-ble](https://github.com/chrvadala/node-ble) (Linux), [@abandonware/noble](https://github.com/abandonware/noble) (Windows), [@stoprocent/noble](https://github.com/stoprocent/noble) (macOS).
- ESP32 proxy: [mqtt_as](https://github.com/peterhinch/micropython-mqtt) by peterhinch, [aioble](https://github.com/micropython/micropython-lib/tree/master/micropython/bluetooth/aioble).

## Contributors

<!-- contributors:start - generated from git history by src/tools/sync-contributors.ts, do not edit by hand -->
<table><tr>
<td align="center"><a href="https://github.com/KristianP26"><img src="https://avatars.githubusercontent.com/u/28766334?v=4" width="60" height="60" alt="KristianP26"><br><sub>KristianP26</sub></a><br><sub>1,282 commits</sub></td>
<td align="center"><a href="https://github.com/APIUM"><img src="https://avatars.githubusercontent.com/u/9067013?v=4" width="60" height="60" alt="APIUM"><br><sub>APIUM</sub></a><br><sub>34 commits</sub></td>
<td align="center"><a href="https://github.com/alasano"><img src="https://avatars.githubusercontent.com/u/14372930?v=4" width="60" height="60" alt="alasano"><br><sub>alasano</sub></a><br><sub>8 commits</sub></td>
<td align="center"><a href="https://github.com/marcelorodrigo"><img src="https://avatars.githubusercontent.com/u/443962?v=4" width="60" height="60" alt="marcelorodrigo"><br><sub>marcelorodrigo</sub></a><br><sub>7 commits</sub></td>
<td align="center"><a href="https://github.com/alexw23"><img src="https://avatars.githubusercontent.com/u/1505496?v=4" width="60" height="60" alt="alexw23"><br><sub>alexw23</sub></a><br><sub>3 commits</sub></td>
<td align="center"><a href="https://github.com/bondesen"><img src="https://avatars.githubusercontent.com/u/4944294?v=4" width="60" height="60" alt="bondesen"><br><sub>bondesen</sub></a><br><sub>3 commits</sub></td>
<td align="center"><a href="https://github.com/albert-canfield"><img src="https://avatars.githubusercontent.com/u/153834574?v=4" width="60" height="60" alt="albert-canfield"><br><sub>albert-canfield</sub></a><br><sub>3 commits</sub></td>
<td align="center"><a href="https://github.com/ibrokemypie"><img src="https://avatars.githubusercontent.com/u/7827846?v=4" width="60" height="60" alt="ibrokemypie"><br><sub>ibrokemypie</sub></a><br><sub>3 commits</sub></td>
</tr><tr>
<td align="center"><a href="https://github.com/fromport"><img src="https://avatars.githubusercontent.com/u/5751308?v=4" width="60" height="60" alt="fromport"><br><sub>fromport</sub></a><br><sub>2 commits</sub></td>
<td align="center"><a href="https://github.com/O-Palda"><img src="https://avatars.githubusercontent.com/u/68783617?v=4" width="60" height="60" alt="O-Palda"><br><sub>O-Palda</sub></a><br><sub>2 commits</sub></td>
<td align="center"><a href="https://github.com/chrisauer"><img src="https://avatars.githubusercontent.com/u/884764?v=4" width="60" height="60" alt="chrisauer"><br><sub>chrisauer</sub></a><br><sub>2 commits</sub></td>
<td align="center"><a href="https://github.com/gvarph"><img src="https://avatars.githubusercontent.com/u/17300137?v=4" width="60" height="60" alt="gvarph"><br><sub>gvarph</sub></a><br><sub>2 commits</sub></td>
<td align="center"><a href="https://github.com/vargamihaly"><img src="https://avatars.githubusercontent.com/u/20193710?v=4" width="60" height="60" alt="vargamihaly"><br><sub>vargamihaly</sub></a><br><sub>2 commits</sub></td>
<td align="center"><a href="https://github.com/FridoE"><img src="https://avatars.githubusercontent.com/u/75177010?v=4" width="60" height="60" alt="FridoE"><br><sub>FridoE</sub></a><br><sub>2 commits</sub></td>
<td align="center"><a href="https://github.com/boildead"><img src="https://avatars.githubusercontent.com/u/17303016?v=4" width="60" height="60" alt="boildead"><br><sub>boildead</sub></a><br><sub>1 commit</sub></td>
<td align="center"><a href="https://github.com/junaidk"><img src="https://avatars.githubusercontent.com/u/1422281?v=4" width="60" height="60" alt="junaidk"><br><sub>junaidk</sub></a><br><sub>1 commit</sub></td>
</tr><tr>
<td align="center"><a href="https://github.com/hedoric"><img src="https://avatars.githubusercontent.com/u/135505862?v=4" width="60" height="60" alt="hedoric"><br><sub>hedoric</sub></a><br><sub>1 commit</sub></td>
<td align="center"><a href="https://github.com/Bretos"><img src="https://avatars.githubusercontent.com/u/4947212?v=4" width="60" height="60" alt="Bretos"><br><sub>Bretos</sub></a><br><sub>1 commit</sub></td>
<td align="center"><a href="https://github.com/JamieSBenson"><img src="https://avatars.githubusercontent.com/u/21150960?v=4" width="60" height="60" alt="JamieSBenson"><br><sub>JamieSBenson</sub></a><br><sub>1 commit</sub></td>
<td align="center"><a href="https://github.com/totalitarian"><img src="https://avatars.githubusercontent.com/u/2385696?v=4" width="60" height="60" alt="totalitarian"><br><sub>totalitarian</sub></a><br><sub>1 commit</sub></td>
<td align="center"><a href="https://github.com/ocurero"><img src="https://avatars.githubusercontent.com/u/2606647?v=4" width="60" height="60" alt="ocurero"><br><sub>ocurero</sub></a><br><sub>1 commit</sub></td>
<td align="center"><a href="https://github.com/rolandgeider"><img src="https://avatars.githubusercontent.com/u/2280729?v=4" width="60" height="60" alt="rolandgeider"><br><sub>rolandgeider</sub></a><br><sub>1 commit</sub></td>
<td align="center"><a href="https://github.com/sanglt"><img src="https://avatars.githubusercontent.com/u/128535?v=4" width="60" height="60" alt="sanglt"><br><sub>sanglt</sub></a><br><sub>1 commit</sub></td>
<td align="center"><a href="https://github.com/rjekelmans"><img src="https://avatars.githubusercontent.com/u/13397247?v=4" width="60" height="60" alt="rjekelmans"><br><sub>rjekelmans</sub></a><br><sub>1 commit</sub></td>
</tr><tr>
<td align="center"><a href="https://github.com/intrak"><img src="https://avatars.githubusercontent.com/u/36244720?v=4" width="60" height="60" alt="intrak"><br><sub>intrak</sub></a><br><sub>1 commit</sub></td>
</tr></table>
<!-- contributors:end -->

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the development setup, tests and how to add a scale adapter or an exporter.

## License

GPL-3.0. See [LICENSE](LICENSE).

## Star History

<a href="https://www.star-history.com/?repos=kristianp26%2Fble-scale-sync&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=kristianp26/ble-scale-sync&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=kristianp26/ble-scale-sync&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=kristianp26/ble-scale-sync&type=date&legend=top-left" />
 </picture>
</a>
