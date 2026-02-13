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

### Running Tests

```bash
npm test                    # Run all tests (Vitest)
npx vitest run tests/exporters/mqtt.test.ts  # Single file
```

### Linting & Formatting

```bash
npm run lint                # ESLint check
npm run lint:fix            # ESLint auto-fix
npm run format              # Prettier auto-format
npm run format:check        # Prettier check (CI)
```

### Validating Config

```bash
npm run validate            # Validate config.yaml against the Zod schema
```

## Code Style

- **ES Modules** — `"type": "module"` in `package.json`; imports use `.js` extension (TypeScript with Node16 module resolution)
- **TypeScript strict mode** — target ES2022, module Node16
- **Prettier** — semicolons, single quotes, trailing commas, 100 char width
- **ESLint** — typescript-eslint recommended; unused vars prefixed with `_` are allowed

Both ESLint and Prettier are enforced in CI.

## Adding a New Scale Adapter

1. Create `src/scales/your-scale.ts` implementing the `ScaleAdapter` interface from `src/interfaces/scale-adapter.ts`
2. Define `matches()` to recognize the device by its BLE advertisement name
3. Implement `parseNotification()` for the brand's binary data protocol
4. Register the adapter in `src/scales/index.ts` — **position matters** (specific adapters must come before generic catch-all)
5. Add tests in `tests/scales/` using mock utilities from `tests/helpers/scale-test-utils.ts`

## Adding a New Exporter

1. Create `src/exporters/your-exporter.ts` implementing the `Exporter` interface from `src/interfaces/exporter.ts`
   - Export an `ExporterSchema` object describing fields, display info, and `supportsGlobal`/`supportsPerUser`
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
