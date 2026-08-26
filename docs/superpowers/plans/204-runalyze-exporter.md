# Plan: #204 Runalyze exporter

## Summary

Add a Runalyze exporter that pushes body-composition readings as health metrics.
Runalyze is an endurance-analytics platform (same audience as Garmin/Strava).

## Corrected design vs the issue body

The issue body says OAuth2 + token refresh + an OAuth wizard flow modelled on
`strava-setup.ts`. That is WRONG. The Runalyze **Personal API** uses a simple
**personal token header**, no OAuth. Verified against the official Go client
`lildude/runalyze` (`client.go`, `bodycomposition.go`):

- Base URL: `https://runalyze.com/api/v1/`
- Auth header: `token: <personalToken>` (literal header name `token`)
- Endpoint: `POST metrics/bodyComposition`
- Body (all but weight optional):
  `{ date_time, weight, fat_percentage?, water_percentage?, muscle_percentage?, bone_percentage? }`
- Token is created at `runalyze.com/settings/personal-api` and requires an expiry date.

So this is a token exporter almost identical to `src/exporters/intervals.ts`, NOT
an OAuth exporter. No wizard file is needed (the wizard is schema-driven). The
issue body will be corrected in the closing comment.

## Template

`src/exporters/intervals.ts` is the near-exact model: token field, dated POST,
`supportsBackdate=true`, `healthcheck()`, schema `supportsGlobal:false /
supportsPerUser:true`, `withRetry` + `httpError` from `../utils/retry.js`.
Runalyze differs only in: header (`token` not Basic), endpoint, JSON body shape,
and an ISO `date_time` (Runalyze stores an exact timestamp, better than
intervals.icu's date-only key).

## Field mapping (decision: option b)

Our `BodyComposition` vs Runalyze body. Runalyze wants muscle/bone as PERCENT;
our model stores them as KG, so convert mass to a fraction of weight.

| Runalyze field | Source | Transform |
|---|---|---|
| `weight` | `weight` | `toFixed(2)` |
| `fat_percentage` | `bodyFatPercent` | `toFixed(1)` |
| `water_percentage` | `waterPercent` | `toFixed(1)` |
| `muscle_percentage` | `muscleMass` | `muscleMass / weight * 100`, `toFixed(1)` |
| `bone_percentage` | `boneMass` | `boneMass / weight * 100`, `toFixed(1)` |

Only include an OPTIONAL field when its source value is finite and `> 0` (mirrors
the Go client's `omitempty`; avoids pushing bogus `0` when an adapter could not
measure that metric). `weight` is always sent. Conversion guards on `weight > 0`.

## API details to send

- `date_time`: `(context.timestamp ?? new Date()).toISOString()` (ISO 8601).
- Headers: `token`, `Content-Type: application/json`, `Accept: application/json`.
- 10s timeout via `AbortSignal.timeout` (match intervals).

## Bad-token behaviour (important gotcha)

The official Runalyze bash example checks the RESPONSE BODY for the string
`No valid token` rather than the HTTP status, which means a bad/expired token can
return `HTTP 200` with an error body, not a `401`. The Go client, by contrast,
keys auth errors off `401/403` status. To be robust against both, every request
must inspect the body for a `no valid token` marker AND the status:

- In `export()`: if `!response.ok` -> `httpError(status)` (retryable for 5xx via
  `isRetryableStatus`, non-retryable for 4xx). If the response is ok but the body
  text matches `/no valid token/i` -> throw `NonRetryableError` (a wrong token
  will not fix itself on retry). Import `NonRetryableError` + `httpError` from
  `../utils/retry.js`.

## Healthcheck

Runalyze read endpoints may be premium-gated (a valid token can still get `403`),
and there is no confirmed GET on the metrics path. Best-effort credential probe:

- `GET https://runalyze.com/api/v1/metrics/bodyComposition` with the `token` header,
  5s timeout.
- Fail if the body text matches `/no valid token/i` -> `invalid token`.
- Fail on `status === 401` -> `HTTP 401`.
- Success if `response.ok` OR `status === 403` (token recognised, read gated).
- Otherwise fail `HTTP <status>`; network error -> `errMsg(err)`.

This is a read (no POST, no bogus metric created). The exact read-endpoint
behaviour is unconfirmed without a live token, so flag it in the issue comment
for first-user validation.

## Changes (touchpoints, mirroring how `intervals` is wired)

### 1. New `src/exporters/runalyze.ts`
- `runalyzeSchema: ExporterSchema` with one field `token` (type `password`,
  required, description pointing to `runalyze.com/settings/personal-api`),
  `supportsGlobal:false`, `supportsPerUser:true`.
- `class RunalyzeExporter implements Exporter`: `name='runalyze'`,
  `supportsBackdate=true`, constructor takes `RunalyzeConfig`, `export()` (POST
  with `withRetry`/`httpError`), `healthcheck()` as above.
- Helper to build the body with the conditional optional fields.

### 2. `src/exporters/config.ts`
- Add `'runalyze'` to the `ExporterName` union and `KNOWN_EXPORTERS` set.
- `export interface RunalyzeConfig { token: string; }`.
- Add `runalyze?: RunalyzeConfig` to `ExporterConfig`.
- In `loadExporterConfig`, add an env block:
  ```ts
  let runalyze: RunalyzeConfig | undefined;
  if (exporters.includes('runalyze')) {
    const token = process.env.RUNALYZE_TOKEN?.trim();
    if (!token) fail('RUNALYZE_TOKEN is required when runalyze exporter is enabled.');
    runalyze = { token };
  }
  ```
- Add `runalyze` to the returned object.

### 3. `src/exporters/registry.ts`
- Import `RunalyzeConfig`, `runalyzeSchema`, `RunalyzeExporter`.
- Add a registry entry with a factory:
  `token: requireField(config, 'runalyze', 'token')` -> `new RunalyzeExporter(...)`.

### 4. `src/exporters/index.ts`
- Import `RunalyzeExporter`; add `case 'runalyze': exporters.push(new RunalyzeExporter(config.runalyze!)); break;`.

### 5. `src/config/env-load.ts`
- Add the entry mapping block:
  ```ts
  if (name === 'runalyze' && exporterConfig.runalyze) {
    Object.assign(entry, { token: exporterConfig.runalyze.token });
  }
  ```

### 6. `.env.example`
- Add `runalyze` to the "Available:" exporter list.
- Add a `RUNALYZE CONFIGURATION` block with `# RUNALYZE_TOKEN=`.

### 7a. `README.md`
- Line ~10 prose list and line ~83 `9 export targets`: add Runalyze and bump the
  count to `10 export targets`. (This is a real user-facing change, so it
  satisfies the every-commit README rule legitimately.)

### 7. `docs/exporters.md`
- Add a `## Runalyze {#runalyze}` section (config field table, YAML example,
  notes: personal token from Settings -> Personal API, token expiry, backdate,
  metric mapping incl. the muscle/bone percent conversion).
- Add the summary-table row near the Intervals.icu row.
- Add the healthcheck-table row (`Runalyze | GET metrics/bodyComposition`).
- Extend the frontmatter `description` + keywords with Runalyze.

### 8. `tests/exporters/registry.test.ts` (update counts)
- Bump the three hard-coded counts 9 -> 10: `EXPORTER_REGISTRY` length,
  `EXPORTER_SCHEMAS` length, `KNOWN_EXPORTER_NAMES.size`.
- Add `expect(KNOWN_EXPORTER_NAMES.has('runalyze')).toBe(true)`.
- Add a per-exporter required-fields block for runalyze (1 required field: `token`).

### 9. `tests/exporters/index.test.ts` + `tests/exporters/config.test.ts`
- `index.test.ts`: add a case asserting `createExporters({exporters:['runalyze'],
  runalyze:{token:'x'}})` yields one `RunalyzeExporter`.
- `config.test.ts`: add a case for the env path (`RUNALYZE_TOKEN` set -> config;
  missing -> `fail`). Mirror the intervals case.

### 10. `tests/exporters/runalyze.test.ts` (new)
Model on `tests/exporters/intervals.test.ts`:
- name is `runalyze`; `supportsBackdate` true.
- POSTs to `https://runalyze.com/api/v1/metrics/bodyComposition` with the `token`
  header; live reading uses `new Date()`, historical uses `context.timestamp`
  (assert `date_time` in the body equals the ISO of the timestamp).
- body contains weight + fat/water/muscle/bone percentages; muscle/bone are the
  converted values (e.g. muscleMass 62.4 / weight 80 * 100 = 78.0).
- optional fields omitted when the source is 0 (build a payload with
  `boneMass: 0` and assert `bone_percentage` is absent).
- non-2xx returns failure `HTTP <status>`; 4xx not retried; network error retried
  3x; succeeds on retry.
- healthcheck: 200 -> success; 403 -> success (premium-gated read); 401 ->
  failure `HTTP 401`; network error -> failure.

## Verification

1. `taskkill //F //IM node.exe` then `npx tsc --noEmit`.
2. `npm run lint` + `npx prettier --check` on changed files.
3. `npx vitest run tests/exporters/runalyze.test.ts tests/exporters/intervals.test.ts`
   and any exporter-registry / config-load tests that enumerate exporters.
4. Full `npm test` (watch for tests that assert the exporter count / list).
5. Grep for a stray `intervals` left over in copied code.

## Out of scope

- No OAuth, no wizard file (schema-driven), no token-refresh.
- The extra MorphoScan-style 50+ metrics are irrelevant here; Runalyze's
  bodyComposition covers exactly weight + fat/water/muscle/bone.
