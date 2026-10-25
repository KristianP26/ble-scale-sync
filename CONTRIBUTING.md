# Contributing to BLE Scale Sync

Bugs and feature requests go to [GitHub Issues](https://github.com/KristianP26/ble-scale-sync/issues), security reports to the address in [SECURITY.md](SECURITY.md).

## Prerequisites

- [Node.js](https://nodejs.org/) 22.23.4+, 24.22.1+ or 26.12.1+
- [Python](https://python.org/) 3.12 or later, only for the Garmin exporter and the Python tests
- A Bluetooth Low Energy adapter, for testing with a real scale

## Development Setup

```bash
git clone https://github.com/KristianP26/ble-scale-sync.git
cd ble-scale-sync
npm install

# Only for the Garmin exporter and the Python tests
python3 -m venv venv
source venv/bin/activate        # Windows: venv\Scripts\activate
pip install -r requirements.txt
```

`npm run setup` starts the setup wizard and `npm start` runs the app from the source. Work on a branch from `dev`: pull requests target `dev`, and `main` holds released code.

## Checks

CI runs these on pushes and pull requests to `dev` and `main`, on Node 22, 24 and 26:

```bash
npm run lint                # ESLint (npm run lint:fix to fix)
npm run format:check        # Prettier (npm run format to fix)
npx tsc --noEmit            # type check
npm test                    # Vitest
npx vitest run tests/exporters/mqtt.test.ts   # one file
```

CI also runs the Python tests. Run them locally when you change Python code:

```bash
python -m unittest discover -s garmin-scripts/tests -v
python -m unittest discover -s firmware/tests -v
```

For a change to the website in `docs/`, `npm run docs:dev` serves it locally and `npm run docs:build` fails on a dead link. `npm run check:counts` checks the adapter and exporter counts on the public pages.

## Code Style

- ES Modules (`"type": "module"`): imports use the `.js` extension.
- TypeScript strict mode, target ES2022, module resolution Node16.
- Prettier: semicolons, single quotes, trailing commas, 100 characters per line.
- ESLint with typescript-eslint recommended; prefix an unused variable with `_`.

## Project Structure

```text
src/                   TypeScript source of the app and its CLI
src/ble/               BLE transports: BlueZ, noble, ESP32 proxy, ESPHome proxy, HA Bluetooth
src/scales/            one adapter per scale family, plus the registry in index.ts
src/exporters/         one exporter per target, plus the registry in registry.ts
src/config/            config.yaml schema, loading and user matching
src/wizard/            the interactive setup wizard
tests/                 Vitest tests; tests/fixtures/ holds recorded scale sessions
garmin-scripts/        Python helper that uploads to Garmin Connect
firmware/              MicroPython firmware for the ESP32 BLE proxy (boards: PORTING.md)
ble-scale-sync-addon/  Home Assistant add-on, a thin layer over the Docker image
worker/                Cloudflare Worker behind the update check and the usage stats
docs/                  VitePress source of blescalesync.dev
drivers/               bundled vendor BLE drivers and helper binaries
.github/workflows/     CI, Docker image, docs deploy, release-please
```

## Adding a Scale Adapter

1. Create `src/scales/your-brand.ts` with a class that implements `ScaleAdapter` from `src/interfaces/scale-adapter.ts`.
2. Set `match` (its `priority` and the names, services or characteristics the adapter claims) and implement `matches()` to recognize the scale from its advertisement.
3. Implement the parser for the scale's frames (`parseNotification()`, or the broadcast hooks for a scale that only advertises). Return the weight in kg: nothing after the adapter converts units.
4. Register the adapter in `src/scales/index.ts`, before the generic `StandardGattScaleAdapter`, which stays last. Precedence comes from `match.priority`, highest first (`src/scales/resolve.ts`); array position only breaks a tie. The generic adapter has priority `0`, and so does an adapter without one, so give yours a priority above it.
5. Add tests in `tests/scales/` with the helpers from `tests/helpers/scale-test-utils.ts`, and a representative advertisement for your adapter in `tests/scales/registry-collision.test.ts`.
6. Run `npm run check:counts:write` to update the adapter count on the public pages, and add the scale to `docs/guide/supported-scales.md`.

Test frames must come from the real scale, copied byte for byte from a capture (btsnoop, PacketLogger) or from a `DEBUG=true` log of ble-scale-sync, which prints the frames it receives. A frame built from your own reading of the format only tests that reading. Edge cases such as a bad checksum can start from a real frame with a few bytes changed; say in the test which ones. A recorded session can also go in `tests/fixtures/<family>/`, where the contract tests in `tests/scales/contracts/` replay it. Include the capture or log in the pull request, or link the issue it comes from.

The collision test keeps one representative advertisement for the generic adapter and for all 41 adapters with their own protocol, and fails when a new or widened `matches()` takes over another adapter's scale.

A capture can contain your weight, profile and the device address. Use a made-up user (age, height, sex) in your config for the capture session. If you do not want to post it publicly, email it to security@blescalesync.dev and mention the pull request.

## Adding an Exporter

1. Create `src/exporters/your-exporter.ts` that implements `Exporter` from `src/interfaces/exporter.ts`. Export an `ExporterSchema` with the fields, display info, `supportsGlobal` and `supportsPerUser`, and accept the optional `ExportContext` in `export(data, context?)` for multi-user setups. Set `supportsBackdate` when the target can record a past measurement at its own time.
2. Add the name to `EXPORTER_NAMES` in `src/exporters/config.ts`, together with the parsing of its `.env` variables.
3. Map the parsed values to the config fields in `loadEnvConfig()` in `src/config/env-load.ts`, and add the minimal variables to the test `builds every known exporter from its minimal .env variables` in `tests/config/load.test.ts`.
4. Add a `{ schema, factory }` entry in `src/exporters/registry.ts`, the only place that constructs exporters.
5. Add tests in `tests/exporters/`, including the `ExportContext` behavior, and raise the expected count in `tests/exporters/registry.test.ts`.
6. Document the fields in a section of `docs/exporters.md` (and in its historical readings table when `supportsBackdate` is set), the variables in `.env.example`, and a commented example in `config.yaml.example`: under `users[].exporters` when `supportsGlobal` is `false`, under `global_exporters` otherwise.
7. Run `npm run check:counts:write` to update the exporter count on the public pages. The list of exporters lives on `docs/exporters.md` only, so no other page needs the name.

## Pull Requests

- The PR title must follow [Conventional Commits](https://www.conventionalcommits.org/). Pull requests are squash-merged: the title becomes the commit subject and the description becomes the commit body. release-please reads that subject to build the changelog and the version, and leaves out a commit whose subject does not follow the format.
- Pick the type by what the change does for a user:
  - `feat:` new capability, minor version bump, listed under "Added"
  - `fix:` bug fix, patch bump, listed under "Fixed"
  - `perf:` performance improvement, patch bump, listed under "Changed"
  - `docs:` listed under "Docs", no version bump
  - `refactor:`, `chore:`, `ci:`, `test:`, `build:`, `style:` no version bump, not listed
  - `!` after the type (`feat(ble)!:`) or a `BREAKING CHANGE:` footer bumps the major version
- Common scopes: `ble`, `scales`, `exporters`, `wizard`, `config`, `docker`, `ci`, `docs`, or an adapter name.
- Keep one logical change per pull request, and make lint, format, type check and tests pass.
- Do not edit generated files: `CHANGELOG.md`, the `version` in `package.json` and `ble-scale-sync-addon/config.yaml`, the image tags in `ble-scale-sync-addon/build.yaml`, `ble-scale-sync-addon/CHANGELOG.md`, and the README Contributors grid between the `contributors:start` and `contributors:end` markers. The release process regenerates them.
- You appear in the README Contributors grid from the next release on, if the email of your commits is linked to your GitHub account or is your `ID+username@users.noreply.github.com` address. To credit someone else, end the PR description with `Co-authored-by: Name <ID+username@users.noreply.github.com>`, below any `Closes #N` line. The squash merge takes the commit body from the description, not from your branch commits.
