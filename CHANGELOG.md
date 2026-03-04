# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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
