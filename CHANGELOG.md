# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Changed
- **ESPHome proxy**: the handler now logs a one-time Phase 1 capability summary on connect, listing which configured scale adapters are broadcast-capable (produce readings on this transport) and which are GATT-only (will time out until Phase 2 / [#116](https://github.com/KristianP26/ble-scale-sync/issues/116) ships). Users who were only seeing the generic `Timed out waiting for any recognized scale broadcast via ESPHome proxy` line now immediately see whether their scale brand is in the broadcast-capable set, instead of having to reproduce the failure twice to catch the per-MAC warn. Surfaces the Yunmai / Beurer / Mi Scale 2 / etc. mismatch reported in [#133](https://github.com/KristianP26/ble-scale-sync/issues/133)

## [1.10.1] - 2026-04-22

### Fixed
- **ESPHome proxy**: the `ReadingWatcher` silently dropped advertisements from dual-mode scale adapters (`parseBroadcast` defined **and** `charNotifyUuid` set) when the broadcast frame was not weight-bearing. Reported by [@deadhurricane](https://github.com/deadhurricane) on an Elis 1 / ES-30M, which matches by name as a QN-Scale but only beacons its MAC in manufacturer data and carries weight over GATT. The handler now warns once per MAC that the scale needs a GATT connection (Phase 2), pointing the user at the native BLE handler or the ESP32 MQTT proxy as workarounds instead of leaving them staring at a silent log ([#116](https://github.com/KristianP26/ble-scale-sync/issues/116), [#75](https://github.com/KristianP26/ble-scale-sync/issues/75))
- **Logger**: `runtime.debug: true` in `config.yaml` did not switch the log level to DEBUG, only the `DEBUG=true` env var did. The app now honors the config value on startup, so HA Add-on users (who pass `debug` as an option, not an env var) and anyone driving the runtime from `config.yaml` get the verbose BLE logs they expect

## [1.10.0] - 2026-04-22

### Added
- **Embedded MQTT broker for the ESP32 proxy**: zero-config setup, no Mosquitto required. When `ble.mqtt_proxy.broker_url` is omitted, BLE Scale Sync now starts an embedded [aedes](https://github.com/moscajs/aedes) broker on `0.0.0.0:1883` by default; the internal client connects over loopback, and the ESP32 firmware just points at the host machine's LAN IP. Port and bind interface are configurable via `embedded_broker_port` and `embedded_broker_bind`, optional username/password are enforced when set. Existing `broker_url` setups are untouched ([#54](https://github.com/KristianP26/ble-scale-sync/issues/54))
- **ESPHome Bluetooth proxy transport (experimental, phase 1 / broadcast-only)**: third BLE handler option `ble.handler: esphome-proxy`. If you already run an [ESPHome Bluetooth proxy](https://esphome.io/components/bluetooth_proxy.html) mesh for Home Assistant, BLE Scale Sync can connect to it over Native API (port 6053, optional Noise encryption or legacy password) and reuse it as its BLE radio, so no dedicated ESP32 with custom firmware and no MQTT broker are required. Phase 1 handles broadcast scales only; GATT scales log a warning and are skipped until phase 2 lands. New `docs/guide/esphome-proxy.md` covers setup, encryption key handling and limitations ([#116](https://github.com/KristianP26/ble-scale-sync/issues/116))
- **Setup wizard**: new "Use built-in embedded broker" option for the mqtt-proxy handler, so new installs skip the external broker prompt by default. Handler selection now also includes "Via ESPHome Bluetooth proxy" with prompts for host, port and authentication mode

### Security
- **Embedded MQTT broker**: configs that bind the embedded broker to a non-loopback interface (default `0.0.0.0`) now require `username` + `password` and are rejected at schema validation time. The wizard defaults to requiring auth and falls back to `127.0.0.1` when the user declines, so misconfiguration cannot silently expose a LAN-reachable broker without credentials.
- **ESPHome proxy**: configs that set both `encryption_key` and `password` are rejected at schema validation time. Pick Noise (`encryption_key`, recommended) or legacy password, not both.

## [1.9.0] - 2026-04-21

### Added
- **Eufy Smart Scale P2 (T9148) and P2 Pro (T9149)**: new dedicated adapter with the AES-128-CBC C0/C1/C2/C3 handshake required by these models. Weight + impedance over GATT FFF2 after authentication, passive weight reading from the 19-byte advertisement without connecting. Prevents the prior false match as a QN scale that crashed with `Operation is not supported` on FFF1 ([#98](https://github.com/KristianP26/ble-scale-sync/issues/98))

### Fixed
- **Setup wizard**: picking no exporter in the export-targets checkbox silently produced a config without any `global_exporters` block, so the first run emitted `All exports failed` and exited with code 1. The wizard now asks an explicit `Continue without exporters?` confirmation when the checkbox is submitted empty and re-prompts if the user declines ([#98](https://github.com/KristianP26/ble-scale-sync/issues/98))
- **Orchestrator**: `dispatchExports([])` logged `All exports failed` because `allFailed` defaulted to `true` with zero iterations. Empty exporter lists now short-circuit with a clear warning (`No exporters configured — measurement processed but not sent anywhere`) and return `success`, so single-shot mode no longer exits with code 1 when the config has no exporters

### Thanks
- [@mart1058](https://github.com/mart1058) and [@dbrb2](https://github.com/dbrb2) for diagnose output, HCI snoop logs, and testing the Eufy P2 Pro protocol reverse-engineering ([#98](https://github.com/KristianP26/ble-scale-sync/issues/98))
- [bdr99/eufylife-ble-client](https://github.com/bdr99/eufylife-ble-client) for the reference Python implementation of the Eufy T9148/T9149 auth handshake and frame formats

## [1.8.2] - 2026-04-20

### Fixed
- **Sanitas SBF70 / Beurer BF710 family**: weight parsed as a stuck `12.80 kg` regardless of the real reading on the scale. Root cause: the BF710 variant (start byte `0xE7`) sends a compact 5-byte `0x58` frame with weight at bytes `[3-4]` BE, not the 6+ byte BF700/BF800 layout the adapter assumed. The adapter rejected every live weight frame as too short and then mis-parsed the `0x59` finalize frame. Now branches on `isBf710Type` and applies a 3-reading stability window (0.3 kg tolerance) so the scale's initial metadata frame does not trigger early completion ([#112](https://github.com/KristianP26/ble-scale-sync/issues/112))

### Thanks
- [@flow778](https://github.com/flow778) for capturing raw BLE frames that made the fix possible ([#112](https://github.com/KristianP26/ble-scale-sync/issues/112))

## [1.8.1] - 2026-04-20

### Fixed
- **Garmin**: upload failed with `'Garmin' object has no attribute 'garth'` after `garminconnect` released 0.3.0 on 2026-04-02, which dropped the `garth` dependency in favor of native authentication. The Python bridge accessed `garmin.garth.sess.headers` and `garmin.garth.dump()`, both removed in 0.3.x. Migrated to the new API: `Garmin.login(tokenstore)` auto-persists on successful credential login, and `client.dump(token_dir)` saves tokens after MFA. Custom User-Agent override is no longer needed because `garminconnect` now uses `curl_cffi` TLS impersonation and randomized browser fingerprints internally ([#114](https://github.com/KristianP26/ble-scale-sync/issues/114))
- **Docker**: added `libcurl4-openssl-dev` so `curl_cffi` (new transitive dep via `garminconnect` 0.3.x) builds from source on armv7, where PyPI has no prebuilt wheel

### Breaking
- Tokens from `garminconnect` 0.2.x (old garth OAuth1/OAuth2 files) are incompatible with 0.3.x. Existing installs must re-authenticate: `npm run setup-garmin`, or in the HA Add-on just restart the add-on so it re-runs setup from the credentials you entered. The setup script auto-removes leftover `oauth*_token.json` files before writing the new token format.

### Thanks
- [@Phipseyy](https://github.com/Phipseyy) and [@mooredav87](https://github.com/mooredav87) for reporting the Garmin upload regression ([#114](https://github.com/KristianP26/ble-scale-sync/issues/114))

## [1.8.0] - 2026-04-17

### Added
- **HA Add-on**: one-click install via a [My Home Assistant](https://www.home-assistant.io/integrations/my/) badge in the README, landing page, getting-started guide, and HA Add-on guide. Manual steps remain as a fallback for users without My Home Assistant configured
- **HA Add-on**: `weight_unit` and `height_unit` exposed as add-on options (kg/lbs, cm/in). The CLI and exporters display in the chosen unit while internal math stays in kg/cm
- **HA Add-on**: `last_known_weight` persists across restarts. The runtime config lives at `/data/config.yaml` and a small Python helper (`merge_last_weights.py`) copies preserved per-user weights from the previous run into the freshly generated config on every startup, so multi-user identification by weight stays accurate after reboots and add-on updates
- **Docs**: new [Home Assistant Add-on guide](https://blescalesync.dev/guide/home-assistant-addon) covering install, full configuration reference, MQTT auto-detection, Garmin setup (including the MFA and IP-block workarounds), custom config mode, persistence semantics, and troubleshooting. Promoted to a first-class quick-start in the README and landing page

## [1.7.5] - 2026-04-15

### Fixed
- **HA Add-on**: Garmin Connect uploads now work out of the box. The add-on previously created an empty `/data/garmin-tokens/` directory and never ran the authentication step, so the first upload always failed with `No such file or directory: '/data/garmin-tokens/oauth1_token.json'`. On first start the add-on now runs `setup_garmin.py --from-config` to generate OAuth tokens from the email and password you entered in the UI ([#111](https://github.com/KristianP26/ble-scale-sync/issues/111))
- **Docker**: armv7 image builds failed because `cffi` (transitive dep via `garminconnect`) had no pre-built wheel for armv7 + Python 3.11 and pip could not compile from source. Added `python3-dev`, `libffi-dev`, and `libssl-dev` to the image so cffi builds cleanly

### Added
- **HA Add-on**: MFA-friendly token import. If your Garmin account uses 2FA, drop pre-generated `oauth1_token.json` and `oauth2_token.json` files into `/share/ble-scale-sync/garmin-tokens/` and the add-on imports them on startup, skipping the interactive auth that has no terminal inside an add-on container
- **HA Add-on**: DOCS.md now explains the full Garmin setup flow including the MFA workaround and the IP-block workaround

### Thanks
- [@Phipseyy](https://github.com/Phipseyy) for reporting the HA Add-on Garmin failure ([#111](https://github.com/KristianP26/ble-scale-sync/issues/111))

## [1.7.4] - 2026-04-02

### Fixed
- **QN Scale**: rewrote adapter as a notification-driven state machine for newer firmware (Renpho Elis 1, ES-CS20M) that requires an AE00 service handshake before measurement data flows ([#75](https://github.com/KristianP26/ble-scale-sync/issues/75), [#84](https://github.com/KristianP26/ble-scale-sync/issues/84))
- **QN Scale**: added ES-30M weight frame format detection (different byte layout for weight and impedance)
- **QN Scale**: 0x13 config byte now sends 0x01 (kg) instead of 0x08, which was switching the scale display to lb
- **QN Scale**: 2-second fallback timer for Linux (BlueZ D-Bus) where the initial 0x12 frame may be lost due to a CCCD subscription race condition
- **QN Scale**: skip impedance-less stable frames on ES-30M so the adapter waits for the full body composition reading

### Thanks
- [@DJBenson](https://github.com/DJBenson) for extensive macOS testing, packet capture analysis, and reverse-engineering the state machine flow ([#84](https://github.com/KristianP26/ble-scale-sync/issues/84))
- [@ericandreani](https://github.com/ericandreani) for persistent Linux/Docker testing across multiple iterations ([#75](https://github.com/KristianP26/ble-scale-sync/issues/75))

## [1.7.3] - 2026-04-02

### Fixed
- **Docker**: `diagnose` command was missing from the entrypoint, causing "exec: diagnose: not found" when running `docker run ... diagnose <MAC>` ([#98](https://github.com/KristianP26/ble-scale-sync/issues/98))

### Thanks
- [@mart1058](https://github.com/mart1058) for reporting the missing Docker diagnose command ([#98](https://github.com/KristianP26/ble-scale-sync/issues/98))

## [1.7.2] - 2026-04-01

### Fixed
- **QN Scale**: UUID fallback (FFF0/FFE0) no longer matches named devices from other brands. Prevents Eufy, 1byone, and similar scales that share the FFF0 service from being incorrectly identified as QN Scale and failing with "Operation is not supported" ([#98](https://github.com/KristianP26/ble-scale-sync/issues/98))

### Thanks
- [@mart1058](https://github.com/mart1058) for reporting the Eufy P2 Pro connection failure ([#98](https://github.com/KristianP26/ble-scale-sync/issues/98))

## [1.7.1] - 2026-03-30

### Fixed
- **Update check**: replaced strict 24-hour cooldown with calendar-day (UTC) comparison. Users who weigh in slightly earlier each day (e.g. 7:00 AM, then 6:55 AM) were being skipped

## [1.7.0] - 2026-03-29

### Added
- **Update check** with anonymous usage statistics ([#87](https://github.com/KristianP26/ble-scale-sync/issues/87)). After each successful measurement (max once per 24h), the app checks `api.blescalesync.dev` for newer versions. Only the app version, OS, and architecture are sent via the User-Agent header. Disable with `update_check: false` in config.yaml. Automatically disabled in CI environments
- **Cloudflare Worker** (`worker/`) serving the `/version` endpoint and a public stats dashboard at [stats.blescalesync.dev](https://stats.blescalesync.dev) with aggregated anonymous data (version distribution, OS/architecture breakdown)
- Setup wizard shows an update notice before the first step if a newer version is available
- **CI**: GitHub Actions workflow for automatic Cloudflare Worker deployment on push to main (`worker.yml`)

## [1.6.4] - 2026-03-27

### Fixed
- **BLE**: use ATT Write Request instead of Reliable Write in node-ble handler, fixing "Operation is not supported" errors on Medisana BS430 and similar scales that do not support reliable writes ([#85](https://github.com/KristianP26/ble-scale-sync/issues/85))

### Improved
- **BLE**: GATT characteristic flags are now logged during discovery (`DEBUG=true`) for easier troubleshooting

### Thanks
- [@Ikari34](https://github.com/Ikari34) for reporting the Medisana BS430 issue ([#85](https://github.com/KristianP26/ble-scale-sync/issues/85))

## [1.6.3] - 2026-03-04

### Fixed
- **Docker**: removed cleanup workflow that was deleting multi-arch platform manifests, making all Docker images unpullable ([#74](https://github.com/KristianP26/ble-scale-sync/issues/74), [#76](https://github.com/KristianP26/ble-scale-sync/issues/76))

### Thanks
- [@marcelorodrigo](https://github.com/marcelorodrigo) for reporting the broken Docker images ([#74](https://github.com/KristianP26/ble-scale-sync/issues/74))
- [@mtcerio](https://github.com/mtcerio) for the additional report ([#76](https://github.com/KristianP26/ble-scale-sync/issues/76))

## [1.6.2] - 2026-03-02

### Changed
- **CI**: Docker `latest` tag now only applies to GitHub releases, not every push to main ([#70](https://github.com/KristianP26/ble-scale-sync/pull/70))
- **CI**: Removed push-to-main Docker build trigger ([#71](https://github.com/KristianP26/ble-scale-sync/pull/71))
- **Docs**: SEO meta keywords added to all documentation pages ([#69](https://github.com/KristianP26/ble-scale-sync/pull/69))
- **Docs**: Alternatives page updated with Strava, file export, and ESP32 proxy sections ([#68](https://github.com/KristianP26/ble-scale-sync/pull/68))
- **Docs**: ESP32 BLE proxy section added to getting started guide ([#67](https://github.com/KristianP26/ble-scale-sync/pull/67))

## [1.6.1] - 2026-03-01

### Fixed
- **BlueZ stale discovery recovery** after Docker container restart. Adds kernel-level adapter reset via `btmgmt` as Tier 4 fallback when D-Bus recovery fails, plus proactive adapter reset in Docker entrypoint ([#39](https://github.com/KristianP26/ble-scale-sync/issues/39), [#43](https://github.com/KristianP26/ble-scale-sync/pull/43))

### Changed
- **CI**: Docker cleanup workflow removes PR images and untagged versions from GHCR ([#58](https://github.com/KristianP26/ble-scale-sync/pull/58))
- **Docs**: Contributors section added to README
- **Node.js**: minimum version bumped to 20.19.0 (required by eslint 10.0.2)
- **Deps**: @stoprocent/noble 2.3.16, eslint 10.0.2, typescript-eslint 8.56.1, @types/node 25.3.3, @inquirer/prompts 8.3.0

### Thanks
- [@marcelorodrigo](https://github.com/marcelorodrigo) for reporting the stale BlueZ discovery issue ([#39](https://github.com/KristianP26/ble-scale-sync/issues/39))

## [1.6.0] - 2026-02-28

### Added
- **ESP32 BLE proxy** (experimental) for remote BLE scanning over MQTT. Use a cheap ESP32 board (~8€) as a wireless Bluetooth radio, enabling BLE Scale Sync on machines without local Bluetooth. Supports both broadcast and GATT scales
- **ESP32 display board** (Guition ESP32-S3-4848S040) with LVGL UI showing scan status, user matches, and export results
- **Beep feedback** on ESP32 boards with I2S buzzer (Atom Echo) when a known scale is detected
- **Streaming BLE scan** for ESP32-S3 boards with hardware radio coexistence
- **Docker mqtt-proxy compose** (`docker-compose.mqtt-proxy.yml`) requiring no BlueZ, D-Bus, or `NET_ADMIN`
- Setup wizard includes interactive mqtt-proxy configuration
- `BLE_HANDLER=mqtt-proxy` environment variable as alternative to config.yaml
- ESP32 proxy documentation page with architecture diagram, flashing guide, and MQTT topics reference

### Changed
- Renpho broadcast parsing consolidated into QN scale adapter
- Landing page updated with ESP32 proxy and Setup Wizard feature cards

### Thanks
- [@APIUM](https://github.com/APIUM) for the ESP32 MQTT proxy implementation ([#45](https://github.com/KristianP26/ble-scale-sync/pull/45))

## [1.5.0] - 2026-02-24

### Added
- **File exporter** (CSV/JSONL) for local measurement logging without external services. Auto-header CSV with proper escaping, JSONL format, per-user file paths, and directory writability healthcheck
- **Strava exporter** with OAuth2 token management. Updates athlete weight via PUT /api/v3/athlete. Automatic token refresh, restricted file permissions (0o600), and interactive setup script (`npm run setup-strava`)
- Strava API application setup guide in documentation with step-by-step instructions

## [1.4.0] - 2026-02-24

### Added
- **BLE diagnostic tool** (`npm run diagnose`) for detailed device analysis: advertisement data, service UUIDs, RSSI, connectable flag, and step-by-step GATT connection testing
- **Broadcast mode** for non-connectable QN-protocol scales (#34). Reads weight directly from BLE advertisement data without requiring a GATT connection
- **Garmin 2FA/MFA support** in `setup_garmin.py`. Prompts for authenticator code when Garmin requires multi-factor authentication

### Fixed
- **QN broadcast parser**: corrected byte layout (LE uint16 at bytes 17-18, stability flag at byte 15). Previous layout produced incorrect weight values
- **ES-CS20M**: service UUID 0x1A10 fallback for unnamed Yunmai-protocol devices (#34)
- **ES-CS20M**: 0x11 STOP frame support as stability signal (#34)

### Changed
- **CI**: Node.js 24 added to test matrix (required check)
- **CI**: PR-triggered Docker image builds with `pr-{id}` tags (#44)
- **Deps**: ESLint v10, typescript-eslint v8.56

### Thanks
- [@APIUM](https://github.com/APIUM) for Garmin 2FA support ([#41](https://github.com/KristianP26/ble-scale-sync/pull/41))
- [@Tosiman-Global](https://github.com/Tosiman-Global) and [@BenBaril83](https://github.com/BenBaril83) for debugging the ES-CS20M broadcast protocol (#34)
- [@marcelorodrigo](https://github.com/marcelorodrigo) for PR-triggered Docker builds ([#44](https://github.com/KristianP26/ble-scale-sync/pull/44))

## [1.3.0] - 2026-02-16

### Added
- Garmin multi-user Docker authentication — `setup-garmin --user <name>` and `--all-users` commands
- `setup_garmin.py --from-config` mode reads users and credentials from `config.yaml`
- `--token-dir` argument for `garmin_upload.py` and `setup_garmin.py` — per-user token directories
- Tilde expansion for `token_dir` in TypeScript exporter
- 4 new Garmin exporter tests (token_dir passing, tilde expansion, backward compat)
- `pyyaml` dependency for config.yaml parsing in Python scripts
- Docker multi-user volume examples in `docker-compose.example.yml` and docs

### Fixed
- Friendly error message when D-Bus socket is not accessible (missing `-v /var/run/dbus:/var/run/dbus:ro` in Docker) instead of raw `ENOENT` crash (#25)

### Changed
- Wizard passes Garmin credentials via environment variables instead of CLI arguments (security)

### Thanks
- [@marcelorodrigo](https://github.com/marcelorodrigo) for [#29](https://github.com/KristianP26/ble-scale-sync/pull/29) — the initial implementation that inspired this solution

## [1.2.2] - 2026-02-14

### Added
- Annotated `config.yaml.example` with all sections and exporters
- `CONTRIBUTING.md` — development guide, project structure, test coverage, adding adapters/exporters, PR guidelines
- `CHANGELOG.md`
- GitHub Release and TypeScript badges
- Documentation split into `docs/` — exporters, multi-user, body-composition, troubleshooting

### Changed
- Rewrite README (~220 lines, Docker-first quick start, simplified scales table)
- Move dev content (project structure, test coverage, adding adapters/exporters) into CONTRIBUTING.md
- `.env.example` now notes that `config.yaml` is the preferred configuration method

## [1.2.1] - 2026-02-13

### Added
- Docker support with multi-arch images (`linux/amd64`, `linux/arm64`, `linux/arm/v7`)
- `Dockerfile`, `docker-entrypoint.sh`, `docker-compose.example.yml`
- GitHub Actions workflow for automated GHCR builds on release
- Docker health check via heartbeat file

## [1.2.0] - 2026-02-13

### Added
- Interactive setup wizard (`npm run setup`) — BLE discovery, user profiles, exporter configuration, connectivity tests
- Edit mode — reconfigure any section without starting over
- Non-interactive mode (`--non-interactive`) for CI/automation
- Schema-driven exporter prompts — new exporters auto-appear in the wizard

## [1.1.0] - 2026-02-13

### Added
- Multi-user support — weight-based user matching (4-tier priority)
- Per-user exporters (override global for specific users)
- `config.yaml` as primary configuration format (`.env` fallback preserved)
- Automatic `last_known_weight` tracking (debounced, atomic YAML writes)
- Drift detection — warns when weight approaches range boundaries
- `unknown_user` strategy (`nearest`, `log`, `ignore`)
- SIGHUP config reload (Linux/macOS)
- Exporter registry with self-describing schemas
- Multi-user context propagation to all 5 exporters (MQTT topic routing, InfluxDB tags, Webhook fields, Ntfy prefix)

## [1.0.1] - 2026-02-13

### Changed
- Configuration is now `config.yaml`-first with `.env` as legacy fallback
- README rewritten for `config.yaml` workflow

## [1.0.0] - 2026-02-12

### Added
- Initial release
- 23 BLE scale adapters (QN-Scale, Xiaomi Mi Scale 2, Yunmai, Beurer, Sanitas, Medisana, and more)
- 5 export targets: Garmin Connect, MQTT (Home Assistant), Webhook, InfluxDB, Ntfy
- BIA body composition calculation (10 metrics)
- Cross-platform BLE support (Linux/node-ble, Windows/@abandonware/noble, macOS/@stoprocent/noble)
- Continuous mode with auto-reconnect
- Auto-discovery (no MAC address required)
- Exporter healthchecks at startup
- 894 unit tests across 49 test files

[1.7.0]: https://github.com/KristianP26/ble-scale-sync/compare/v1.6.4...v1.7.0
[1.6.4]: https://github.com/KristianP26/ble-scale-sync/compare/v1.6.3...v1.6.4
[1.6.3]: https://github.com/KristianP26/ble-scale-sync/compare/v1.6.2...v1.6.3
[1.6.2]: https://github.com/KristianP26/ble-scale-sync/compare/v1.6.1...v1.6.2
[1.6.1]: https://github.com/KristianP26/ble-scale-sync/compare/v1.6.0...v1.6.1
[1.6.0]: https://github.com/KristianP26/ble-scale-sync/compare/v1.5.0...v1.6.0
[1.5.0]: https://github.com/KristianP26/ble-scale-sync/compare/v1.4.0...v1.5.0
[1.4.0]: https://github.com/KristianP26/ble-scale-sync/compare/v1.3.1...v1.4.0
[1.3.0]: https://github.com/KristianP26/ble-scale-sync/compare/v1.2.2...v1.3.0
[1.2.2]: https://github.com/KristianP26/ble-scale-sync/compare/v1.2.1...v1.2.2
[1.2.1]: https://github.com/KristianP26/ble-scale-sync/compare/v1.2.0...v1.2.1
[1.2.0]: https://github.com/KristianP26/ble-scale-sync/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/KristianP26/ble-scale-sync/compare/v1.0.1...v1.1.0
[1.0.1]: https://github.com/KristianP26/ble-scale-sync/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/KristianP26/ble-scale-sync/releases/tag/v1.0.0
