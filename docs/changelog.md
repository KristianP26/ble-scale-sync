---
title: Changelog
description: Version history for BLE Scale Sync.
---

# Changelog

All notable changes to this project are documented here. Format based on [Keep a Changelog](https://keepachangelog.com/).

## Unreleased {#unreleased}

### Added
- **Eufy Smart Scale P2 (T9148) and P2 Pro (T9149)**: new dedicated adapter with the AES-128-CBC C0/C1/C2/C3 handshake these models require. Weight + impedance over GATT FFF2 after auth, plus passive weight reading from the 19-byte advertisement without connecting. The scale is no longer mis-matched as a QN scale (prior crash: `Operation is not supported`) ([#98](https://github.com/KristianP26/ble-scale-sync/issues/98))

### Thanks
- [@mart1058](https://github.com/mart1058) and [@dbrb2](https://github.com/dbrb2) for diagnose output, HCI snoop logs, and testing the Eufy P2 Pro protocol reverse-engineering ([#98](https://github.com/KristianP26/ble-scale-sync/issues/98))
- [bdr99/eufylife-ble-client](https://github.com/bdr99/eufylife-ble-client) for the reference Python implementation of the Eufy T9148/T9149 auth handshake and frame formats

## v1.8.2 <Badge type="tip" text="latest" /> {#v1-8-2}

_2026-04-20_

### Fixed
- **Sanitas SBF70 / Beurer BF710 family**: weight parsed as a stuck `12.80 kg` regardless of the real reading on the scale. Root cause: the BF710 variant (start byte `0xE7`) sends a compact 5-byte `0x58` frame with weight at bytes `[3-4]` BE, not the 6+ byte BF700/BF800 layout the adapter assumed. The adapter rejected every live weight frame as too short and then mis-parsed the `0x59` finalize frame. Now branches on `isBf710Type` and applies a 3-reading stability window (0.3 kg tolerance) so the scale's initial metadata frame does not trigger early completion ([#112](https://github.com/KristianP26/ble-scale-sync/issues/112))

### Thanks
- [@flow778](https://github.com/flow778) for capturing raw BLE frames that made the fix possible ([#112](https://github.com/KristianP26/ble-scale-sync/issues/112))

## v1.8.1 {#v1-8-1}

_2026-04-20_

### Fixed
- **Garmin**: upload failed with `'Garmin' object has no attribute 'garth'` after `garminconnect` 0.3.0 (released 2026-04-02) dropped the `garth` dependency. Migrated the Python bridge to the new native auth API: `Garmin.login(tokenstore)` auto-persists on successful login, and `client.dump(token_dir)` saves tokens after MFA. The custom User-Agent override is obsolete because `garminconnect` now uses `curl_cffi` TLS impersonation internally ([#114](https://github.com/KristianP26/ble-scale-sync/issues/114))
- **Docker**: added `libcurl4-openssl-dev` so `curl_cffi` builds from source on armv7 (no prebuilt wheel on PyPI)

### Breaking
- Old tokens from `garminconnect` 0.2.x are incompatible with 0.3.x. Existing installs must re-authenticate: run `npm run setup-garmin`, or in the HA Add-on restart the add-on so it re-runs setup from your saved credentials. The setup script auto-cleans leftover `oauth*_token.json` files before writing the new format.

## v1.8.0 {#v1-8-0}

_2026-04-17_

### Added
- **HA Add-on**: one-click install via a [My Home Assistant](https://www.home-assistant.io/integrations/my/) badge. The badge opens your HA instance, confirms the repository, and lands on the Add-on Store with BLE Scale Sync ready to install. Manual steps stay as a fallback
- **HA Add-on**: `weight_unit` and `height_unit` exposed as add-on options (kg/lbs, cm/in), no longer hardcoded
- **HA Add-on**: `last_known_weight` persists across restarts. Runtime config lives at `/data/config.yaml`; a small Python helper merges preserved per-user weights into the freshly generated config on every startup
- **Docs**: new [Home Assistant Add-on guide](/guide/home-assistant-addon) with install, configuration reference, MQTT auto-detection, Garmin setup, MFA workaround, custom config mode, and troubleshooting

## v1.7.5 {#v1-7-5}

_2026-04-15_

### Fixed
- **HA Add-on**: Garmin Connect uploads now work out of the box. On first start the add-on runs `setup_garmin.py --from-config` to generate OAuth tokens from the email and password you entered in the UI ([#111](https://github.com/KristianP26/ble-scale-sync/issues/111))
- **Docker**: armv7 image builds failed because `cffi` had no pre-built wheel for armv7 + Python 3.11. Added `python3-dev`, `libffi-dev`, and `libssl-dev` to the image so cffi builds from source cleanly

### Added
- **HA Add-on**: MFA-friendly token import. Pre-generate tokens on another machine and drop them into `/share/ble-scale-sync/garmin-tokens/`; the add-on imports them on startup
- **HA Add-on**: DOCS.md now explains the full Garmin setup flow including the MFA and IP-block workarounds

### Thanks
- [@Phipseyy](https://github.com/Phipseyy) for reporting the HA Add-on Garmin failure ([#111](https://github.com/KristianP26/ble-scale-sync/issues/111))

## v1.7.4 {#v1-7-4}

_2026-04-02_

### Fixed
- **QN Scale**: rewrote adapter as a notification-driven state machine for newer firmware (Renpho Elis 1, ES-CS20M) that requires an AE00 service handshake before measurement data flows ([#75](https://github.com/KristianP26/ble-scale-sync/issues/75), [#84](https://github.com/KristianP26/ble-scale-sync/issues/84))
- **QN Scale**: added ES-30M weight frame format detection (different byte layout for weight and impedance)
- **QN Scale**: 0x13 config byte now sends 0x01 (kg) instead of 0x08, which was switching the scale display to lb
- **QN Scale**: fallback timer for Linux (BlueZ D-Bus) where the initial 0x12 frame may be lost

## v1.7.3 {#v1-7-3}

_2026-04-02_

### Fixed
- **Docker**: `diagnose` command was missing from the entrypoint, causing "exec: diagnose: not found" when running `docker run ... diagnose <MAC>` ([#98](https://github.com/KristianP26/ble-scale-sync/issues/98))

## v1.7.2 {#v1-7-2}

_2026-04-01_

### Fixed
- **QN Scale**: UUID fallback (FFF0/FFE0) no longer matches named devices from other brands. Prevents Eufy, 1byone, and similar scales that share the FFF0 service from being incorrectly identified as QN Scale ([#98](https://github.com/KristianP26/ble-scale-sync/issues/98))

## v1.7.1 {#v1-7-1}

_2026-03-30_

### Fixed
- **Update check**: replaced strict 24-hour cooldown with calendar-day (UTC) comparison. Users who weigh in slightly earlier each day (e.g. 7:00 AM, then 6:55 AM) were being skipped

## v1.7.0 {#v1-7-0}

_2026-03-29_

### Added
- **Update check** with anonymous usage statistics ([#87](https://github.com/KristianP26/ble-scale-sync/issues/87)). After each successful measurement (max once per 24h), the app checks for newer versions. Only the app version, OS, and architecture are sent via the User-Agent header. Disable with `update_check: false` in config.yaml
- Setup wizard shows an update notice before the first step if a newer version is available
- Public stats dashboard at [stats.blescalesync.dev](https://stats.blescalesync.dev) with aggregated anonymous data

## v1.6.4 {#v1-6-4}

_2026-03-27_

### Fixed
- **BLE**: use ATT Write Request instead of Reliable Write in node-ble handler, fixing "Operation is not supported" errors on Medisana BS430 and similar scales that do not support reliable writes ([#85](https://github.com/KristianP26/ble-scale-sync/issues/85))

### Improved
- **BLE**: GATT characteristic flags are now logged during discovery (`DEBUG=true`) for easier troubleshooting

### Thanks
- [@Ikari34](https://github.com/Ikari34) for reporting the Medisana BS430 issue ([#85](https://github.com/KristianP26/ble-scale-sync/issues/85))

## v1.6.3 {#v1-6-3}

_2026-03-04_

### Fixed
- **Docker**: removed cleanup workflow that was deleting multi-arch platform manifests, making all Docker images unpullable ([#74](https://github.com/KristianP26/ble-scale-sync/issues/74), [#76](https://github.com/KristianP26/ble-scale-sync/issues/76))

### Thanks
- [@marcelorodrigo](https://github.com/marcelorodrigo) for reporting the broken Docker images ([#74](https://github.com/KristianP26/ble-scale-sync/issues/74))
- [@mtcerio](https://github.com/mtcerio) for the additional report ([#76](https://github.com/KristianP26/ble-scale-sync/issues/76))

## v1.6.2 {#v1-6-2}

_2026-03-02_

### Changed
- **CI**: Docker `latest` tag now only applies to GitHub releases, not every push to main ([#70](https://github.com/KristianP26/ble-scale-sync/pull/70))
- **CI**: Removed push-to-main Docker build trigger ([#71](https://github.com/KristianP26/ble-scale-sync/pull/71))
- **Docs**: SEO meta keywords added to all documentation pages ([#69](https://github.com/KristianP26/ble-scale-sync/pull/69))
- **Docs**: Alternatives page updated with Strava, file export, and ESP32 proxy sections ([#68](https://github.com/KristianP26/ble-scale-sync/pull/68))
- **Docs**: ESP32 BLE proxy section added to getting started guide ([#67](https://github.com/KristianP26/ble-scale-sync/pull/67))

## v1.6.1 {#v1-6-1}

_2026-03-01_

### Fixed
- **BlueZ stale discovery recovery** after Docker container restart. Adds kernel-level adapter reset via `btmgmt` as Tier 4 fallback when D-Bus recovery fails, plus proactive adapter reset in Docker entrypoint ([#39](https://github.com/KristianP26/ble-scale-sync/issues/39), [#43](https://github.com/KristianP26/ble-scale-sync/pull/43))

### Changed
- **CI**: Docker cleanup workflow removes PR images and untagged versions from GHCR ([#58](https://github.com/KristianP26/ble-scale-sync/pull/58))
- **Docs**: Contributors section added to README
- **Node.js**: minimum version bumped to 20.19.0 (required by eslint 10.0.2)
- **Deps**: @stoprocent/noble 2.3.16, eslint 10.0.2, typescript-eslint 8.56.1, @types/node 25.3.3, @inquirer/prompts 8.3.0

## v1.6.0 {#v1-6-0}

_2026-02-28_

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

## v1.5.0 {#v1-5-0}

_2026-02-24_

### Added
- **File exporter** (CSV/JSONL) for local measurement logging without external services. Auto-header CSV with proper escaping, JSONL one-object-per-line, per-user file paths, and directory writability healthcheck
- **Strava exporter** with OAuth2 token management. Updates athlete weight via PUT /api/v3/athlete. Automatic token refresh, restricted file permissions (0o600), and interactive setup script (`npm run setup-strava`)
- Strava API application setup guide in documentation with step-by-step instructions

## v1.4.0 {#v1-4-0}

_2026-02-24_

### Added
- **BLE diagnostic tool** (`npm run diagnose`) for detailed device analysis: advertisement data, service UUIDs, RSSI, connectable flag, and step-by-step GATT connection testing
- **Broadcast mode** for non-connectable QN-protocol scales (#34). Reads weight directly from BLE advertisement data without requiring a GATT connection
- **Garmin 2FA/MFA support** in `setup_garmin.py` ([#41](https://github.com/KristianP26/ble-scale-sync/pull/41) by [@APIUM](https://github.com/APIUM))

### Fixed
- **QN broadcast parser**: corrected byte layout (LE uint16 at bytes 17-18, stability flag at byte 15)
- **ES-CS20M**: service UUID 0x1A10 fallback for unnamed Yunmai-protocol devices (#34)
- **ES-CS20M**: 0x11 STOP frame support as stability signal (#34)

### Changed
- **CI**: Node.js 24 added to test matrix (required check)
- **CI**: PR-triggered Docker image builds with `pr-{id}` tags (#44)
- **Deps**: ESLint v10, typescript-eslint v8.56

## v1.3.1 {#v1-3-1}

_2026-02-22_

### Fixed
- **ES-CS20M**: support 0x11 STOP frame as stability signal for Yunmai-protocol variant (#34)
- **ES-CS20M**: add service UUID 0x1A10 fallback for unnamed devices (#34)

### Added
- **Docs**: BLE handler switching guide in troubleshooting
- **Docs**: Pi Zero W (ARMv6) not supported notice (#42)
- **Docs**: `StartLimitIntervalSec=0` in systemd service example

### Changed
- **CI**: PR-triggered Docker image builds with `pr-{id}` tags (#44)
- **CI**: Node.js 24 added to test matrix
- **Deps**: ESLint v10, typescript-eslint v8.56

## v1.3.0 {#v1-3-0}

_2026-02-16_

### Added
- **Garmin multi-user Docker authentication** - `setup-garmin --user <name>` and `--all-users` commands
- `setup_garmin.py --from-config` mode reads users and credentials from `config.yaml`
- `--token-dir` argument for per-user token directories (persisted via Docker volumes)
- `pyyaml` dependency for config.yaml parsing in Python scripts
- Docker multi-user volume examples in `docker-compose.example.yml` and docs

### Fixed
- Friendly error message when D-Bus socket is not accessible in Docker instead of raw `ENOENT` crash (#25)

### Changed
- Wizard passes Garmin credentials via environment variables instead of CLI arguments (security)

## v1.2.2 {#v1-2-2}

_2026-02-14_

### Added
- Annotated `config.yaml.example` with all sections and exporters
- `CONTRIBUTING.md` with development guide, project structure, and test coverage
- `CHANGELOG.md`
- Documentation split into `docs/` — exporters, multi-user, body composition, troubleshooting

### Changed
- README rewritten (~220 lines, Docker-first quick start, simplified scales table)
- Dev content moved into `CONTRIBUTING.md`

## v1.2.1 {#v1-2-1}

_2026-02-13_

### Added
- **Docker support** with multi-arch images (`linux/amd64`, `linux/arm64`, `linux/arm/v7`)
- `Dockerfile`, `docker-entrypoint.sh`, `docker-compose.example.yml`
- GitHub Actions workflow for automated GHCR builds on release
- Docker health check via heartbeat file

## v1.2.0 {#v1-2-0}

_2026-02-13_

### Added
- **Interactive setup wizard** (`npm run setup`) — BLE discovery, user profiles, exporter configuration, connectivity tests
- Edit mode — reconfigure any section without starting over
- Non-interactive mode (`--non-interactive`) for CI/automation
- Schema-driven exporter prompts — new exporters auto-appear in the wizard

## v1.1.0 {#v1-1-0}

_2026-02-13_

### Added
- **Multi-user support** — weight-based user matching (4-tier priority)
- Per-user exporters (override global for specific users)
- `config.yaml` as primary configuration format (`.env` fallback preserved)
- Automatic `last_known_weight` tracking (debounced, atomic YAML writes)
- Drift detection — warns when weight approaches range boundaries
- `unknown_user` strategy (`nearest`, `log`, `ignore`)
- SIGHUP config reload (Linux/macOS)
- Exporter registry with self-describing schemas
- Multi-user context propagation to all 5 exporters

## v1.0.1 {#v1-0-1}

_2026-02-13_

### Changed
- Configuration is now `config.yaml`-first with `.env` as legacy fallback

## v1.0.0 {#v1-0-0}

_2026-02-12_

### Added
- **Initial release**
- 23 BLE scale adapters (QN-Scale, Xiaomi, Yunmai, Beurer, Sanitas, Medisana, and more)
- 5 export targets: Garmin Connect, MQTT (Home Assistant), Webhook, InfluxDB, Ntfy
- BIA body composition calculation (10 metrics)
- Cross-platform BLE support (Linux, Windows, macOS)
- Continuous mode with auto-reconnect
- Auto-discovery (no MAC address required)
- Exporter healthchecks at startup
- 894 unit tests across 49 test files
