# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [1.2.3] - 2026-02-14

### Changed
- Rewrite README (~220 lines, Docker-first quick start, simplified scales table)
- Split documentation into `docs/` — exporters, multi-user, body-composition, troubleshooting
- Move dev content (project structure, test coverage, adding adapters/exporters) into CONTRIBUTING.md

### Added
- GitHub Release and TypeScript badges

## [1.2.2] - 2026-02-13

### Added
- Annotated `config.yaml.example` with all sections and exporters
- `CONTRIBUTING.md` — development guide, adding adapters/exporters, PR guidelines
- This `CHANGELOG.md`
- README badges (CI, License, Node.js, Docker)

### Changed
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

[1.2.3]: https://github.com/KristianP26/ble-scale-sync/compare/v1.2.2...v1.2.3
[1.2.2]: https://github.com/KristianP26/ble-scale-sync/compare/v1.2.1...v1.2.2
[1.2.1]: https://github.com/KristianP26/ble-scale-sync/compare/v1.2.0...v1.2.1
[1.2.0]: https://github.com/KristianP26/ble-scale-sync/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/KristianP26/ble-scale-sync/compare/v1.0.1...v1.1.0
[1.0.1]: https://github.com/KristianP26/ble-scale-sync/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/KristianP26/ble-scale-sync/releases/tag/v1.0.0
