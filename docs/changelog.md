---
title: Changelog
description: Version history for BLE Scale Sync.
---

# Changelog

All notable changes to this project are documented here. Format based on [Keep a Changelog](https://keepachangelog.com/).

## v1.3.0 <Badge type="tip" text="latest" /> {#v1-3-0}

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
