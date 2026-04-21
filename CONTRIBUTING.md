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
│       ├── ci.yml                  # CI: lint, format, typecheck, tests (Node 20/22)
│       └── docker.yml              # Docker: multi-arch build + GHCR push on release
├── src/
│   ├── index.ts                    # Entry point (single/multi-user flow, SIGHUP reload, heartbeat)
│   ├── orchestrator.ts             # Exported orchestration logic (healthchecks, export dispatch)
│   ├── config/
│   │   ├── schema.ts               # Zod schemas (AppConfig, UserConfig, etc.) + WeightUnit
│   │   ├── load.ts                 # Unified config loader (YAML + .env fallback)
│   │   ├── resolve.ts              # Config → runtime types (UserProfile, exporters, etc.)
│   │   ├── validate-cli.ts         # CLI entry point for npm run validate
│   │   ├── slugify.ts              # Slug generation + uniqueness validation
│   │   ├── user-matching.ts        # Weight-based multi-user matching (4-tier)
│   │   └── write.ts                # Atomic YAML write + debounced weight updates
│   ├── ble/
│   │   ├── index.ts                # OS detection + dynamic import barrel (scanAndRead, scanAndReadRaw)
│   │   ├── types.ts                # ScanOptions, ScanResult, constants, utilities
│   │   ├── shared.ts               # BleChar/BleDevice abstractions, waitForRawReading(), waitForReading()
│   │   ├── handler-node-ble.ts     # Linux: node-ble (BlueZ D-Bus)
│   │   ├── handler-noble.ts        # macOS default: @stoprocent/noble
│   │   └── handler-noble-legacy.ts # Windows default: @abandonware/noble
│   ├── exporters/
│   │   ├── index.ts                # Exporter factory — createExporters()
│   │   ├── registry.ts             # Self-describing exporter registry (schemas + factories)
│   │   ├── config.ts               # Exporter env validation + config parsing
│   │   ├── garmin.ts               # Garmin Connect exporter (Python subprocess)
│   │   ├── mqtt.ts                 # MQTT exporter + Home Assistant auto-discovery
│   │   ├── webhook.ts              # Webhook exporter (generic HTTP)
│   │   ├── influxdb.ts             # InfluxDB v2 exporter (line protocol)
│   │   └── ntfy.ts                 # Ntfy push notification exporter
│   ├── wizard/
│   │   ├── index.ts                # Entry point for npm run setup
│   │   ├── types.ts                # WizardStep, WizardContext, PromptProvider, BackNavigation
│   │   ├── runner.ts               # Step sequencer (sequential + edit mode)
│   │   ├── non-interactive.ts      # Non-interactive validation + slug enrichment
│   │   ├── platform.ts             # OS/Docker/Python detection
│   │   ├── prompt-provider.ts      # Real + mock prompt providers (DI)
│   │   ├── ui.ts                   # Banner, icons, section boxes, chalk helpers
│   │   └── steps/
│   │       ├── index.ts            # Step registry (WIZARD_STEPS)
│   │       ├── welcome.ts          # Banner + edit mode detection
│   │       ├── ble.ts              # BLE scale discovery / manual MAC entry
│   │       ├── users.ts            # User profile setup (name, slug, height, etc.)
│   │       ├── exporters.ts        # Unified exporter selection (schema-driven prompts)
│   │       ├── garmin-auth.ts      # Garmin Connect authentication
│   │       ├── runtime.ts          # Runtime settings (continuous, cooldown, etc.)
│   │       ├── validate.ts         # Exporter connectivity tests
│   │       └── summary.ts          # Config review + YAML save
│   ├── utils/
│   │   ├── retry.ts                # Shared retry utility (withRetry) used by all exporters
│   │   └── error.ts                # Shared error utility (errMsg) for unknown→string conversion
│   ├── validate-env.ts             # .env validation & typed config loader (legacy)
│   ├── scan.ts                     # BLE device scanner utility
│   ├── interfaces/
│   │   ├── scale-adapter.ts        # ScaleAdapter interface & shared types
│   │   ├── exporter.ts             # Exporter interface & ExportResult type
│   │   └── exporter-schema.ts      # ExporterSchema interface for self-describing exporters
│   └── scales/
│       ├── index.ts                # Adapter registry (all adapters)
│       ├── body-comp-helpers.ts    # Shared body-comp utilities
│       ├── qn-scale.ts             # QN-Scale / Renpho / Senssun / Sencor
│       ├── renpho.ts               # Renpho ES-WBE28
│       ├── renpho-es26bb.ts        # Renpho ES-26BB-B
│       ├── mi-scale-2.ts           # Xiaomi Mi Scale 2
│       ├── yunmai.ts               # Yunmai Signal / Mini / SE
│       ├── beurer-sanitas.ts       # Beurer BF700/710/800, Sanitas SBF70/75
│       ├── sanitas-sbf72.ts        # Sanitas SBF72/73, Beurer BF915
│       ├── soehnle.ts              # Soehnle Shape / Style
│       ├── medisana-bs44x.ts       # Medisana BS430/440/444
│       ├── trisa.ts                # Trisa Body Analyze
│       ├── es-cs20m.ts             # ES-CS20M
│       ├── exingtech-y1.ts         # Exingtech Y1 (vscale)
│       ├── excelvan-cf369.ts       # Excelvan CF369
│       ├── hesley.ts               # Hesley (YunChen)
│       ├── inlife.ts               # Inlife (fatscale)
│       ├── digoo.ts                # Digoo DG-SO38H (Mengii)
│       ├── senssun.ts              # Senssun Fat
│       ├── one-byone.ts            # 1byone / Eufy C1 / Eufy P1
│       ├── active-era.ts           # Active Era BF-06
│       ├── mgb.ts                  # MGB (Swan / Icomon / YG)
│       ├── hoffen.ts               # Hoffen BS-8107
│       └── standard-gatt.ts        # Generic BCS/WSS catch-all
├── tests/
│   ├── body-comp-helpers.test.ts   # Body-comp helper unit tests
│   ├── validate-env.test.ts        # .env validation unit tests
│   ├── orchestrator.test.ts        # Healthcheck + export dispatch tests
│   ├── multi-user-flow.test.ts     # Multi-user integration tests
│   ├── logger.test.ts              # Logger utility tests
│   ├── helpers/
│   │   └── scale-test-utils.ts     # Shared test utilities (mock peripheral, etc.)
│   ├── wizard/                     # Wizard tests (runner, users, exporters, non-interactive, platform)
│   ├── config/                     # Config tests (schema, slugify, load, resolve, write, matching)
│   ├── ble/                        # BLE tests (shared logic, utilities, abort signal)
│   ├── utils/                      # Utility tests (retry, error)
│   ├── scales/                     # One test file per adapter (23 files)
│   └── exporters/                  # Exporter tests (config, garmin, mqtt, webhook, influxdb, ntfy, context)
├── garmin-scripts/
│   ├── garmin_upload.py            # Garmin uploader (JSON stdin → JSON stdout)
│   └── setup_garmin.py             # One-time Garmin auth setup
├── docs/
│   ├── exporters.md                # Exporter configuration reference
│   ├── multi-user.md               # Multi-user weight matching guide
│   ├── body-composition.md         # Body composition metrics & formulas
│   └── troubleshooting.md          # Common issues & solutions
├── config.yaml.example             # Annotated config template (copy to config.yaml)
├── CONTRIBUTING.md                 # This file
├── CHANGELOG.md                    # Version history (Keep a Changelog format)
├── .env.example                    # Legacy .env template (config.yaml preferred)
├── .prettierrc                     # Prettier config
├── eslint.config.js                # ESLint flat config
├── tsconfig.json                   # TypeScript config (src)
├── tsconfig.eslint.json            # TypeScript config (src + tests, for ESLint)
├── Dockerfile                      # Multi-arch Docker image (node:20-slim + BlueZ + Python)
├── docker-entrypoint.sh            # Docker entrypoint (start/setup/scan/validate/help)
├── docker-compose.example.yml      # Example Compose file (host network + BLE)
├── .dockerignore
├── .gitignore
├── package.json
├── requirements.txt
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
- Keep commits focused — one logical change per commit
- Write descriptive commit messages

## Reporting Issues

Found a bug or have a feature request? Open an issue at [github.com/KristianP26/ble-scale-sync/issues](https://github.com/KristianP26/ble-scale-sync/issues).
