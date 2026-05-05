# Contributing to BLE Scale Sync

Thank you for your interest in contributing! This guide covers everything you need to get started.

## Prerequisites

- [Node.js](https://nodejs.org/) v20 or later
- [Python](https://python.org/) 3.9 or later (only needed for Garmin upload)
- A Bluetooth Low Energy (BLE) capable adapter (for testing with real hardware)

## Development Setup

```bash
# Clone and install
git clone https://github.com/KristianP26/ble-scale-sync.git
cd ble-scale-sync
npm install

# Python venv (only for Garmin exporter)
python3 -m venv venv
source venv/bin/activate        # On Windows: venv\Scripts\activate
pip install -r requirements.txt
```

## Branches

| Branch | Purpose                                                      |
| ------ | ------------------------------------------------------------ |
| `main` | Stable release branch                                        |
| `dev`  | Active development — PRs and new features target this branch |

CI runs on both `main` and `dev` (push + pull request).

## Running Tests

```bash
npm test                    # Run all tests (Vitest)
npx vitest run tests/exporters/mqtt.test.ts  # Single file
```

### Test Coverage

Unit tests use [Vitest](https://vitest.dev/) and cover:

- **Body composition math** — `body-comp-helpers.ts`
- **Config schemas** — Zod validation, defaults, error formatting, slug generation
- **Config loading** — YAML parsing, env reference resolution, config source detection, BLE config loader, env overrides
- **Config resolution** — user profile resolution, runtime config extraction, exporter merging, single-user convenience
- **Config writing** — atomic file write, write lock serialization, YAML comment preservation, debounced weight updates
- **User matching** — 4-tier weight matching, all strategies (nearest/log/ignore), overlapping ranges, drift detection
- **Environment validation** — `validate-env.ts` (all validation rules and edge cases)
- **Scale adapters** — `parseNotification()`, `matches()`, `isComplete()`, `computeMetrics()`, and `onConnected()` for all 24 adapters
- **Exporters** — config parsing, MQTT publish/HA discovery, MQTT multi-user topic routing + per-user HA discovery, Garmin subprocess, Webhook/InfluxDB/Ntfy delivery, ExportContext, ntfy drift warning
- **Multi-user flow** — matching → profile resolution → exporter resolution → ExportContext construction, strategy fallback, tiebreak with last_known_weight
- **Orchestrator** — healthcheck runner, export dispatch, parallel execution, partial/total failure handling
- **BLE shared logic** — `waitForRawReading()` and `waitForReading()` in legacy, onConnected, and multi-char modes; weight normalization; disconnect handling
- **BLE utilities** — `formatMac()`, `normalizeUuid()`, `sleep()`, `withTimeout()`, abort signal handling
- **Logger** — `createLogger()`, `setLogLevel()`
- **Utilities** — shared retry logic (`withRetry`), error conversion (`errMsg`)
- **Setup wizard** — runner (step ordering, back navigation, edit mode), user profile prompts (validation, lbs→kg conversion, slug generation), exporter schema-driven field rendering, non-interactive mode (validation + slug enrichment), platform detection (OS, Docker, Python)

## Linting & Formatting

```bash
npm run lint                # ESLint check
npm run lint:fix            # ESLint auto-fix
npm run format              # Prettier auto-format
npm run format:check        # Prettier check (CI)
```

## Code Style

- **ES Modules** — `"type": "module"` in `package.json`; imports use `.js` extension (TypeScript with Node16 module resolution)
- **TypeScript strict mode** — target ES2022, module Node16
- **Prettier** — semicolons, single quotes, trailing commas, 100 char width
- **ESLint** — typescript-eslint recommended; unused vars prefixed with `_` are allowed

Both ESLint and Prettier are enforced in CI.

## Project Structure

```
ble-scale-sync/
├── .github/
│   └── workflows/
│       ├── ci.yml                   # CI: lint, format, typecheck, tests (Node 20/22/24), python-check
│       ├── docker.yml               # Docker: multi-arch build + GHCR push on release
│       ├── docker-cleanup.yml       # Prune old GHCR image tags
│       ├── docs.yml                 # VitePress docs deploy to Cloudflare Pages
│       └── worker.yml               # Deploy stats Cloudflare Worker
├── src/
│   ├── index.ts                     # Entry point (single/multi-user flow, SIGHUP reload, heartbeat)
│   ├── orchestrator.ts              # Export dispatch, healthchecks, partial/total failure handling
│   ├── diagnose.ts                  # npm run diagnose (BLE troubleshooting tool)
│   ├── scan.ts                      # BLE device scanner utility (npm run scan)
│   ├── logger.ts                    # createLogger, setLogLevel (structured logging)
│   ├── update-check.ts              # Optional anonymous version check + stats ping
│   ├── validate-env.ts              # .env validation & typed config loader (legacy path)
│   ├── config/
│   │   ├── schema.ts                # Zod schemas (AppConfig, UserConfig) + WeightUnit
│   │   ├── load.ts                  # Unified config loader (YAML + .env fallback)
│   │   ├── resolve.ts               # Config → runtime types (UserProfile, exporters)
│   │   ├── validate-cli.ts          # CLI entry for npm run validate
│   │   ├── slugify.ts               # Slug generation + uniqueness validation
│   │   ├── user-matching.ts         # Weight-based multi-user matching (4-tier)
│   │   └── write.ts                 # Atomic YAML write + debounced weight updates
│   ├── ble/
│   │   ├── index.ts                 # OS detection + handler barrel (scanAndRead, scanAndReadRaw)
│   │   ├── types.ts                 # ScanOptions, ScanResult, constants, utilities
│   │   ├── shared.ts                # BleChar/BleDevice abstractions, waitForReading()
│   │   ├── async-queue.ts           # Async notification queue for GATT handlers
│   │   ├── loopback.ts              # In-process loopback handler (tests)
│   │   ├── handler-node-ble.ts      # Linux native: node-ble (BlueZ D-Bus)
│   │   ├── handler-noble.ts         # macOS native: @stoprocent/noble
│   │   ├── handler-noble-legacy.ts  # Windows native: @abandonware/noble
│   │   ├── handler-mqtt-proxy.ts    # ESP32 proxy over MQTT
│   │   ├── handler-esphome-proxy.ts # ESPHome BT proxy over Native API (phase 1, broadcast)
│   │   ├── embedded-broker.ts       # Embedded aedes MQTT broker for ESP32 proxy
│   │   └── mqtt-proxy-bootstrap.ts  # First-run scan + adapter pin for ESP32 proxy
│   ├── exporters/
│   │   ├── index.ts                 # Exporter factory: createExporters()
│   │   ├── registry.ts              # Self-describing exporter registry (schemas + factories)
│   │   ├── config.ts                # Exporter env validation + config parsing
│   │   ├── garmin.ts                # Garmin Connect (Python subprocess)
│   │   ├── strava.ts                # Strava OAuth2 (per-user only)
│   │   ├── strava-setup.ts          # One-time Strava OAuth (npm run setup-strava)
│   │   ├── mqtt.ts                  # MQTT + Home Assistant auto-discovery
│   │   ├── webhook.ts               # Generic HTTP webhook
│   │   ├── influxdb.ts              # InfluxDB v2 (line protocol)
│   │   ├── ntfy.ts                  # Ntfy push notifications
│   │   └── file.ts                  # Local file exporter (CSV / JSONL)
│   ├── wizard/
│   │   ├── index.ts                 # Entry for npm run setup
│   │   ├── types.ts                 # WizardStep, WizardContext, PromptProvider
│   │   ├── runner.ts                # Step sequencer (sequential + edit mode)
│   │   ├── non-interactive.ts       # Non-interactive validation + slug enrichment
│   │   ├── platform.ts              # OS/Docker/Python detection
│   │   ├── prompt-provider.ts       # Real + mock prompt providers (DI)
│   │   ├── ui.ts                    # Banner, icons, section boxes, chalk helpers
│   │   └── steps/
│   │       ├── index.ts             # Step registry (WIZARD_STEPS)
│   │       ├── welcome.ts           # Banner + edit mode detection
│   │       ├── ble.ts               # BLE scale discovery / manual MAC entry
│   │       ├── users.ts             # User profile setup
│   │       ├── exporters.ts         # Schema-driven exporter selection
│   │       ├── garmin-auth.ts       # Garmin Connect authentication
│   │       ├── runtime.ts           # Runtime settings (continuous, cooldown)
│   │       ├── validate.ts          # Exporter connectivity tests
│   │       └── summary.ts           # Config review + YAML save
│   ├── utils/
│   │   ├── retry.ts                 # Shared retry utility (withRetry)
│   │   └── error.ts                 # errMsg (unknown → string)
│   ├── interfaces/
│   │   ├── scale-adapter.ts         # ScaleAdapter interface & shared types
│   │   ├── exporter.ts              # Exporter interface & ExportResult
│   │   └── exporter-schema.ts       # ExporterSchema for self-describing exporters
│   └── scales/
│       ├── index.ts                 # Adapter registry (order matters: generic last)
│       ├── body-comp-helpers.ts     # Shared body-comp utilities
│       ├── qn-scale.ts              # QN / Renpho (incl. ES-26M, ES-30M) / Senssun / Sencor
│       ├── renpho.ts                # Renpho ES-WBE28
│       ├── renpho-es26bb.ts         # Renpho ES-26BB-B
│       ├── mi-scale-2.ts            # Xiaomi Mi Scale 2
│       ├── yunmai.ts                # Yunmai Signal / Mini / SE
│       ├── eufy-p2.ts               # Eufy P2 / P2 Pro (T9148/T9149, AES-128 handshake)
│       ├── beurer-sanitas.ts        # Beurer BF700/710/800, Sanitas SBF70/75
│       ├── sanitas-sbf72.ts         # Sanitas SBF72/73, Beurer BF915
│       ├── soehnle.ts               # Soehnle Shape / Style
│       ├── medisana-bs44x.ts        # Medisana BS430/440/444
│       ├── trisa.ts                 # Trisa Body Analyze
│       ├── es-cs20m.ts              # ES-CS20M
│       ├── exingtech-y1.ts          # Exingtech Y1 (vscale)
│       ├── excelvan-cf369.ts        # Excelvan CF369
│       ├── hesley.ts                # Hesley (YunChen)
│       ├── inlife.ts                # Inlife (fatscale)
│       ├── digoo.ts                 # Digoo DG-SO38H (Mengii)
│       ├── senssun.ts               # Senssun Fat
│       ├── one-byone.ts             # 1byone / Eufy C1 / Eufy P1
│       ├── active-era.ts            # Active Era BF-06
│       ├── mgb.ts                   # MGB (Swan / Icomon / YG)
│       ├── hoffen.ts                # Hoffen BS-8107
│       └── standard-gatt.ts         # Generic BCS/WSS catch-all
├── tests/
│   ├── body-comp-helpers.test.ts    # Body-comp math
│   ├── validate-env.test.ts         # .env validation
│   ├── orchestrator.test.ts         # Healthchecks + export dispatch
│   ├── multi-user-flow.test.ts      # Multi-user integration
│   ├── logger.test.ts               # Logger utility
│   ├── update-check.test.ts         # Update check + stats ping
│   ├── helpers/
│   │   └── scale-test-utils.ts      # Mock peripheral + shared helpers
│   ├── wizard/                      # Runner, users, exporters, non-interactive, platform
│   ├── config/                      # Schema, slugify, load, resolve, write, matching
│   ├── ble/                         # Shared logic, utilities, handlers, abort signal
│   ├── utils/                       # Retry, error
│   ├── scales/                      # One file per adapter (23 files)
│   └── exporters/                   # config, garmin, mqtt (+multi-user), webhook, influxdb,
│                                    # ntfy, strava, file, context, healthcheck, registry, index
├── ble-scale-sync-addon/            # Home Assistant Supervisor Add-on
│   ├── Dockerfile                   # Thin layer on GHCR image + jq/curl/run.sh
│   ├── build.yaml                   # Multi-arch build config
│   ├── config.yaml                  # Add-on manifest (options schema, HA services, perms)
│   ├── run.sh                       # /data/options.json → config.yaml → app start
│   ├── merge_last_weights.py        # Persist last_known_weight across restarts
│   ├── DOCS.md                      # Add-on user docs (shown in HA UI)
│   ├── CHANGELOG.md                 # Add-on version history
│   ├── icon.png, logo.png
│   └── translations/
├── firmware/                        # ESP32 BLE proxy firmware (MicroPython)
│   ├── main.py, boot.py, ble_bridge.py
│   ├── board_*.py                   # Per-board pin/display setup (Atom Echo, S3, Guition)
│   ├── ui.py, beep.py, panel_init_*.py
│   ├── flash.sh                     # Board flashing helper
│   ├── requirements.txt, config.json.example
│   └── tools/
├── worker/                          # Cloudflare Worker for stats.blescalesync.dev
│   ├── src/, wrangler.toml, package.json, tsconfig.json
├── garmin-scripts/
│   ├── garmin_upload.py             # Garmin uploader (JSON stdin → JSON stdout)
│   └── setup_garmin.py              # One-time Garmin auth setup
├── docs/                            # VitePress site → blescalesync.dev
│   ├── index.md, exporters.md, multi-user.md, body-composition.md
│   ├── troubleshooting.md, changelog.md, alternatives.md, faq.md
│   ├── guide/
│   │   ├── getting-started.md, configuration.md, supported-scales.md
│   │   ├── home-assistant-addon.md, esp32-proxy.md, esphome-proxy.md
│   │   └── auto-update.md
│   └── public/, images/
├── drivers/                         # Bundled vendor BLE drivers / helper binaries
├── repository.yaml                  # HA add-on repository manifest (one-click install)
├── config.yaml.example              # Annotated config template
├── docker-compose.example.yml       # Example Compose (native BLE)
├── docker-compose.mqtt-proxy.yml    # Example Compose (ESP32 MQTT proxy)
├── Dockerfile                       # Multi-arch image (node:20-slim + BlueZ + Python)
├── docker-entrypoint.sh             # Docker entrypoint (start/setup/scan/validate/help)
├── CONTRIBUTING.md                  # This file
├── CHANGELOG.md                     # Version history (Keep a Changelog format)
├── CODE_OF_CONDUCT.md
├── SECURITY.md
├── PORTING.md                       # Notes for porting adapters from openScale
├── .env.example                     # Legacy .env template (config.yaml preferred)
├── .prettierrc, eslint.config.js
├── tsconfig.json, tsconfig.eslint.json
├── .nvmrc, .gitattributes, .dockerignore, .gitignore
├── package.json, package-lock.json, requirements.txt
├── LICENSE
└── README.md
```

## Adding a New Scale Adapter

To support a new scale brand, create a class that implements `ScaleAdapter` in `src/scales/`:

1. Create `src/scales/your-brand.ts` implementing the interface from `src/interfaces/scale-adapter.ts`
2. Define `matches()` to recognize the device by its BLE advertisement name
3. Implement `parseNotification()` for the brand's data protocol
4. Register the adapter in `src/scales/index.ts` — **position matters** (specific adapters must come before generic catch-all)
5. If your adapter detects the weight unit from BLE data and converts to kg internally, set `normalizesWeight = true`
6. Add tests in `tests/scales/` using mock utilities from `tests/helpers/scale-test-utils.ts`

## Adding a New Exporter

To add a new export target:

1. Create `src/exporters/your-exporter.ts` implementing the `Exporter` interface from `src/interfaces/exporter.ts`
   - Export an `ExporterSchema` describing fields, display info, and `supportsGlobal`/`supportsPerUser`
   - Accept optional `ExportContext` in `export(data, context?)` for multi-user support
2. Add the name to the `ExporterName` type and `KNOWN_EXPORTERS` set in `src/exporters/config.ts`
3. Add env var parsing in `src/exporters/config.ts` (for `.env` fallback path)
4. Add a case to the switch in `createExporters()` in `src/exporters/index.ts`
5. Add a registry entry in `src/exporters/registry.ts` with `{ schema, factory }`
6. Add tests in `tests/exporters/` (including `ExportContext` behavior)
7. Document config fields in `README.md` and `.env.example`

## Pull Request Guidelines

- Branch from `dev` (not `main`)
- All tests must pass: `npm test`
- ESLint and Prettier must be clean: `npm run lint && npm run format:check`
- TypeScript must compile: `npx tsc --noEmit`
- Keep commits focused, one logical change per commit
- **PRs are squash-merged.** The repo allows squash only; merge-commit and rebase-merge are disabled. On merge, GitHub squashes the branch into a single commit on the target branch and uses the **PR title** as the commit subject. That makes the PR title the thing release-please parses, so it MUST be in Conventional Commits format (see below). The PR body becomes the commit body.
- **Write commit messages, and your PR title, in [Conventional Commits](https://www.conventionalcommits.org/) style.** The project uses release-please to generate the changelog and version bumps, so the prefix you pick decides both whether the release notes mention the change and how the version bumps:
  - `feat:` or `feat(scope):` new user-visible capability, bumps the minor version
  - `fix:` or `fix(scope):` bug fix, bumps the patch version
  - `perf:` performance improvement, bumps the patch version
  - `refactor:`, `docs:`, `chore:`, `ci:`, `test:`, `build:` no version bump, appears in an "Other" / "Miscellaneous" section of the release notes
  - Append `!` (for example `feat(ble)!:`) or include a `BREAKING CHANGE:` footer to bump the major version
  - Scopes commonly used in this repo: `ble`, `scales`, `exporters`, `wizard`, `config`, `docker`, `ci`, `docs`, plus individual adapter names

  > [!IMPORTANT]
  > Non-conforming commit messages are silently ignored by release-please and will not appear in the generated changelog. When in doubt, look at `git log --oneline` for recent examples.

## Releases

Releases are fully automated via [release-please](https://github.com/googleapis/release-please-action). You do **not** create tags, edit `CHANGELOG.md`, or bump the version in `package.json` by hand.

### Flow

1. Merge feature / fix PRs into `dev` with a Conventional Commit message.
2. When `dev` is ready to ship, open a PR `dev` → `main` and merge it.
3. The `release-please` workflow (`.github/workflows/release-please.yml`) runs on every push to `main` and opens (or updates) a release PR titled `chore(main): release vX.Y.Z`.
4. That PR shows the proposed version bump plus the generated `CHANGELOG.md` diff. Review, optionally edit the PR body or the CHANGELOG entry in the PR to add prose (for example a `### Thanks` section, the one thing release-please does not generate by itself), then merge it with `--admin` like any other release PR.
5. On merge, release-please tags the release (`vX.Y.Z`), creates a GitHub Release, and emits the `release: published` event that `docker.yml` listens for. The multi-arch image is published to GHCR automatically. VitePress rebuilds `docs/changelog.md` from `CHANGELOG.md` via an `@include` directive, so the public changelog updates too.

### Files managed by release-please

- `package.json` (version field)
- `package-lock.json` (version field)
- `ble-scale-sync-addon/config.yaml` (version field, via the generic YAML updater + JSONPath `$.version`)
- `CHANGELOG.md` (generated from conventional commits since the previous tag)
- `.release-please-manifest.json` (internal state, tracks the last released version)

Do not edit these files in a feature PR. If you need to correct the version or changelog, do it in the release PR before merging.

### Files still maintained by hand

- `ble-scale-sync-addon/CHANGELOG.md` is the user-facing changelog shown inside the Home Assistant add-on UI. It benefits from a shorter, curated log, so release-please does not touch it. Update it in the release PR when user-facing add-on changes ship.
- `docs/changelog.md` is a one-line VitePress include (`<!--@include: ../CHANGELOG.md-->`), so it updates automatically as soon as `CHANGELOG.md` does. Do not replace that include with hand-written content.

### Optional: `RELEASE_PLEASE_TOKEN` secret

By default the workflow authenticates with `GITHUB_TOKEN`. GitHub intentionally suppresses downstream workflow triggers for events raised by that token, which means the release PR does not trigger `ci.yml` and the resulting GitHub release does not trigger `docker.yml`.

To get those to chain automatically, create a classic Personal Access Token with `repo` + `workflow` scopes and save it as a repository secret named `RELEASE_PLEASE_TOKEN`. The workflow already prefers it over `GITHUB_TOKEN`.

Until the PAT is configured, the fallback is:

- Re-run `ci.yml` on the release PR by clicking "Close pull request" then "Reopen pull request" (or pushing an empty commit to the release branch).
- Trigger `docker.yml` manually from the Actions tab (`workflow_dispatch`, input the new tag).

## Reporting Issues

Found a bug or have a feature request? Open an issue at [github.com/KristianP26/ble-scale-sync/issues](https://github.com/KristianP26/ble-scale-sync/issues).
