# Wger Exporter (#205) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `wger` exporter that pushes a body-weight entry and (optionally) body-composition custom measurements to a self-hosted or hosted Wger instance via its REST API v2.

**Architecture:** Mirror the existing single-file exporter pattern (`runalyze.ts` / `intervals.ts`): one `WgerExporter implements Exporter` plus a `wgerSchema`, wired through `config.ts` (env path), `registry.ts` (config.yaml path), `index.ts` (factory) and `env-load.ts`. Weight goes to `POST /api/v2/weightentry/`. Body composition goes to `POST /api/v2/measurement/`, which needs an integer `category` FK; categories are auto-discovered (`GET /api/v2/measurement-category/`) and auto-created (`POST /api/v2/measurement-category/`) on first export and cached on the instance. Weight is the primary result (its failure fails the export); measurements are best-effort (a measurement failure is logged, not fatal). `supportsBackdate = true`.

**Tech Stack:** TypeScript (strict, ESM, `.js` import suffix), `fetch` + `AbortSignal.timeout`, `withRetry`/`httpError` from `src/utils/retry.js`, Vitest with a `fetch` mock.

**API facts (verified against wger-project/wger master + docs):**
- Auth header: `Authorization: Token <key>` (static API key from `<baseUrl>/en/user/api-key`).
- Base path always `<baseUrl>/api/v2/...`, trailing slash REQUIRED on every endpoint (DRF router).
- `POST /api/v2/weightentry/` body `{ "date": "YYYY-MM-DD", "weight": <kg decimal 30..600, 2dp> }`. `user` is server-set (omit). No unique constraint and no upsert: a repeat POST for the same date creates a duplicate row (acceptable; one reading per weigh-in).
- `GET/POST /api/v2/measurement-category/` fields `{ id, name, unit }` (`user` server-set). List is DRF-paginated (`{ count, next, results }`).
- `POST /api/v2/measurement/` body `{ "category": <int id>, "date": "YYYY-MM-DD", "value": <decimal 0..5000, 2dp>, "notes"?: string }`.
- Healthcheck: `GET /api/v2/userprofile/` returns 200 with a valid token, 401 without.

---

## File Structure

- Create: `src/exporters/wger.ts` — `wgerSchema` + `WgerExporter`.
- Create: `tests/exporters/wger.test.ts` — unit tests with a URL-routing `fetch` mock.
- Modify: `src/exporters/config.ts` — `ExporterName`, `KNOWN_EXPORTERS`, `WgerConfig`, `ExporterConfig`, env loading, return object.
- Modify: `src/exporters/index.ts` — import + `createExporters` case.
- Modify: `src/exporters/registry.ts` — import + `EXPORTER_REGISTRY` entry.
- Modify: `src/config/env-load.ts` — `wger` entry mapping.
- Modify: `tests/exporters/registry.test.ts` — bump `toHaveLength(10)` → `11` (x2) + add wger assertions.
- Modify: `tests/exporters/config.test.ts` — add wger env tests.
- Modify: `tests/exporters/index.test.ts` — add wger factory test.
- Modify: `docs/exporters.md`, `.env.example`, `config.yaml.example`, `README.md` — docs + examples + count 10 → 11.

Branch: `dev`. Single conventional commit `feat(exporter): add Wger exporter (#205)` at the end (mirrors the #204 Runalyze commit so release-please emits one changelog line).

---

### Task 1: Config plumbing in `config.ts`

**Files:**
- Modify: `src/exporters/config.ts`
- Test: `tests/exporters/config.test.ts`

- [ ] **Step 1: Add the env-path tests (write first)**

Append inside the `describe` block that holds the runalyze env tests in `tests/exporters/config.test.ts` (right after the `does not parse runalyze config...` test at ~line 468):

```typescript
    it('requires WGER_BASE_URL when wger is enabled', () => {
      vi.stubEnv('EXPORTERS', 'wger');
      vi.stubEnv('WGER_TOKEN', 'tok-1');
      expect(() => loadExporterConfig()).toThrow(/WGER_BASE_URL is required/);
    });

    it('requires WGER_TOKEN when wger is enabled', () => {
      vi.stubEnv('EXPORTERS', 'wger');
      vi.stubEnv('WGER_BASE_URL', 'https://wger.example');
      expect(() => loadExporterConfig()).toThrow(/WGER_TOKEN is required/);
    });

    it('parses wger env vars (sync_measurements defaults true)', () => {
      vi.stubEnv('EXPORTERS', 'wger');
      vi.stubEnv('WGER_BASE_URL', 'https://wger.example');
      vi.stubEnv('WGER_TOKEN', 'tok-1');
      const cfg = loadExporterConfig();
      expect(cfg.wger).toEqual({
        baseUrl: 'https://wger.example',
        token: 'tok-1',
        syncMeasurements: true,
      });
    });

    it('parses WGER_SYNC_MEASUREMENTS=false', () => {
      vi.stubEnv('EXPORTERS', 'wger');
      vi.stubEnv('WGER_BASE_URL', 'https://wger.example');
      vi.stubEnv('WGER_TOKEN', 'tok-1');
      vi.stubEnv('WGER_SYNC_MEASUREMENTS', 'false');
      expect(loadExporterConfig().wger?.syncMeasurements).toBe(false);
    });

    it('does not parse wger config when wger is not enabled', () => {
      vi.stubEnv('EXPORTERS', 'garmin');
      vi.stubEnv('WGER_TOKEN', 'tok-1');
      expect(loadExporterConfig().wger).toBeUndefined();
    });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/exporters/config.test.ts`
Expected: FAIL — `wger` is not a known exporter (throws "Unknown exporter 'wger'") and `cfg.wger` is undefined.

- [ ] **Step 3: Wire `wger` into `config.ts`**

In `src/exporters/config.ts`:

(a) Add to the `ExporterName` union (after `'runalyze'`):
```typescript
  | 'runalyze'
  | 'wger';
```

(b) Add to `KNOWN_EXPORTERS` set (after `'runalyze',`):
```typescript
  'runalyze',
  'wger',
]);
```

(c) Add the config interface after `RunalyzeConfig`:
```typescript
export interface WgerConfig {
  baseUrl: string;
  token: string;
  /** Also push body-composition metrics as Wger custom measurements (not just weight). */
  syncMeasurements: boolean;
}
```

(d) Add to `ExporterConfig` (after `runalyze?: RunalyzeConfig;`):
```typescript
  runalyze?: RunalyzeConfig;
  wger?: WgerConfig;
}
```

(e) Add the env-loading block after the `runalyze` block (before the final `return {`):
```typescript
  let wger: WgerConfig | undefined;
  if (exporters.includes('wger')) {
    const baseUrl = process.env.WGER_BASE_URL?.trim();
    if (!baseUrl) {
      fail('WGER_BASE_URL is required when wger exporter is enabled.');
    }
    const token = process.env.WGER_TOKEN?.trim();
    if (!token) {
      fail('WGER_TOKEN is required when wger exporter is enabled.');
    }
    wger = {
      baseUrl,
      token,
      syncMeasurements: parseBoolean(
        'WGER_SYNC_MEASUREMENTS',
        process.env.WGER_SYNC_MEASUREMENTS?.trim(),
        true,
      ),
    };
  }
```

(f) Add `wger` to the returned object (after `runalyze,`):
```typescript
    runalyze,
    wger,
  };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/exporters/config.test.ts`
Expected: PASS.

---

### Task 2: The `WgerExporter` and its tests

**Files:**
- Create: `src/exporters/wger.ts`
- Test: `tests/exporters/wger.test.ts`

- [ ] **Step 1: Write `tests/exporters/wger.test.ts` (write first)**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WgerExporter } from '../../src/exporters/wger.js';
import type { WgerConfig } from '../../src/exporters/config.js';
import type { BodyComposition } from '../../src/interfaces/scale-adapter.js';
import type { ExportContext } from '../../src/interfaces/exporter.js';

const sample: BodyComposition = {
  weight: 80,
  impedance: 500,
  bmi: 23.9,
  bodyFatPercent: 18.5,
  waterPercent: 55.2,
  boneMass: 3.1,
  muscleMass: 62.4,
  visceralFat: 8,
  physiqueRating: 5,
  bmr: 1750,
  metabolicAge: 30,
};

const config: WgerConfig = {
  baseUrl: 'https://wger.example',
  token: 'tok-1',
  syncMeasurements: true,
};

const BASE = 'https://wger.example/api/v2';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function res(body: unknown, opts: { ok?: boolean; status?: number } = {}) {
  const status = opts.status ?? 200;
  return {
    ok: opts.ok ?? (status >= 200 && status < 300),
    status,
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

/** Default happy-path router: empty category list, category creation, then 201s. */
function routeHappy(existing: Array<{ id: number; name: string; unit: string }> = []) {
  let nextId = 100;
  mockFetch.mockImplementation((url: string, init?: { method?: string }) => {
    const method = init?.method ?? 'GET';
    if (url.endsWith('/measurement-category/') && method === 'GET') {
      return Promise.resolve(res({ count: existing.length, next: null, results: existing }));
    }
    if (url.endsWith('/measurement-category/') && method === 'POST') {
      return Promise.resolve(res({ id: nextId++, name: 'x', unit: 'x' }, { status: 201 }));
    }
    if (url.endsWith('/measurement/') && method === 'POST') {
      return Promise.resolve(res({ id: 1 }, { status: 201 }));
    }
    if (url.endsWith('/weightentry/') && method === 'POST') {
      return Promise.resolve(res({ id: 1 }, { status: 201 }));
    }
    return Promise.resolve(res({}, { status: 200 }));
  });
}

function calls(method: string, suffix: string) {
  return mockFetch.mock.calls.filter(
    ([url, init]) => (init?.method ?? 'GET') === method && (url as string).endsWith(suffix),
  );
}

describe('WgerExporter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    routeHappy();
  });

  it('has name "wger" and supports back-dating', () => {
    const e = new WgerExporter(config);
    expect(e.name).toBe('wger');
    expect(e.supportsBackdate).toBe(true);
  });

  it('POSTs a weight entry with the Token header and date+weight body', async () => {
    await new WgerExporter(config).export(sample, { timestamp: new Date(2024, 2, 14, 9, 0) });

    const weightCalls = calls('POST', '/weightentry/');
    expect(weightCalls).toHaveLength(1);
    expect(weightCalls[0][0]).toBe(`${BASE}/weightentry/`);
    expect(weightCalls[0][1].headers.Authorization).toBe('Token tok-1');
    const body = JSON.parse(weightCalls[0][1].body as string);
    expect(body.weight).toBe(80);
    expect(body.date).toBe('2024-03-14');
    expect(body).not.toHaveProperty('user');
  });

  it('uses the current local date for a live reading', async () => {
    await new WgerExporter(config).export(sample);
    const body = JSON.parse(calls('POST', '/weightentry/')[0][1].body as string);
    expect(body.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('auto-creates missing categories then posts a measurement per metric', async () => {
    await new WgerExporter(config).export(sample);

    // 4 categories created (fat, water, muscle, bone) and 4 measurements posted.
    expect(calls('POST', '/measurement-category/')).toHaveLength(4);
    const measurements = calls('POST', '/measurement/');
    expect(measurements).toHaveLength(4);
    const fat = measurements
      .map((c) => JSON.parse(c[1].body as string))
      .find((b) => b.value === 18.5);
    expect(fat).toBeDefined();
    expect(typeof fat.category).toBe('number');
    expect(fat.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('reuses an existing category id and does not recreate it', async () => {
    routeHappy([{ id: 7, name: 'Body Fat', unit: '%' }]);
    await new WgerExporter(config).export(sample);

    // Only the 3 missing categories are created (Body Fat already exists).
    expect(calls('POST', '/measurement-category/')).toHaveLength(3);
    const fat = calls('POST', '/measurement/')
      .map((c) => JSON.parse(c[1].body as string))
      .find((b) => b.value === 18.5);
    expect(fat.category).toBe(7);
  });

  it('skips a metric whose value is 0', async () => {
    await new WgerExporter(config).export({ ...sample, boneMass: 0 });
    const values = calls('POST', '/measurement/').map((c) => JSON.parse(c[1].body as string).value);
    expect(values).not.toContain(0);
    expect(values).toHaveLength(3);
  });

  it('caches categories across exports (lists only once)', async () => {
    const e = new WgerExporter(config);
    await e.export(sample);
    await e.export(sample);
    expect(calls('GET', '/measurement-category/')).toHaveLength(1);
  });

  it('does not touch measurements when syncMeasurements is false', async () => {
    await new WgerExporter({ ...config, syncMeasurements: false }).export(sample);
    expect(calls('POST', '/weightentry/')).toHaveLength(1);
    expect(calls('GET', '/measurement-category/')).toHaveLength(0);
    expect(calls('POST', '/measurement/')).toHaveLength(0);
  });

  it('normalizes a trailing slash in the base URL', async () => {
    await new WgerExporter({ ...config, baseUrl: 'https://wger.example/' }).export(sample);
    expect(calls('POST', '/weightentry/')[0][0]).toBe(`${BASE}/weightentry/`);
  });

  it('fails the export when the weight POST fails', async () => {
    mockFetch.mockImplementation((url: string) =>
      Promise.resolve(
        (url as string).endsWith('/weightentry/')
          ? res({ detail: 'err' }, { status: 500 })
          : res({ count: 0, next: null, results: [] }),
      ),
    );
    const result = await new WgerExporter({ ...config, syncMeasurements: false }).export(sample);
    expect(result.success).toBe(false);
    expect(result.error).toBe('HTTP 500');
  });

  it('does not retry a 4xx weight response', async () => {
    mockFetch.mockResolvedValue(res({ detail: 'bad' }, { status: 400 }));
    await new WgerExporter({ ...config, syncMeasurements: false }).export(sample);
    expect(calls('POST', '/weightentry/')).toHaveLength(1);
  });

  it('treats a measurement failure as non-fatal (weight still succeeds)', async () => {
    mockFetch.mockImplementation((url: string, init?: { method?: string }) => {
      const method = init?.method ?? 'GET';
      if ((url as string).endsWith('/measurement/') && method === 'POST') {
        return Promise.resolve(res({ detail: 'err' }, { status: 500 }));
      }
      if ((url as string).endsWith('/measurement-category/') && method === 'GET') {
        return Promise.resolve(res({ count: 0, next: null, results: [] }));
      }
      return Promise.resolve(res({ id: 1 }, { status: 201 }));
    });
    const result = await new WgerExporter(config).export(sample);
    expect(result.success).toBe(true);
  });

  describe('healthcheck()', () => {
    it('returns success on 200 from userprofile', async () => {
      mockFetch.mockResolvedValue(res({ id: 1 }, { status: 200 }));
      const result = await new WgerExporter(config).healthcheck();
      expect(result.success).toBe(true);
      const call = mockFetch.mock.calls.find(([url]) => (url as string).endsWith('/userprofile/'));
      expect(call).toBeDefined();
      expect(call![1].headers.Authorization).toBe('Token tok-1');
    });

    it('returns failure on 401', async () => {
      mockFetch.mockResolvedValue(res({ detail: 'no' }, { status: 401 }));
      const result = await new WgerExporter(config).healthcheck();
      expect(result.success).toBe(false);
      expect(result.error).toBe('HTTP 401');
    });

    it('returns failure on a network error', async () => {
      mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));
      const result = await new WgerExporter(config).healthcheck();
      expect(result.success).toBe(false);
      expect(result.error).toBe('ECONNREFUSED');
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/exporters/wger.test.ts`
Expected: FAIL — `src/exporters/wger.js` does not exist.

- [ ] **Step 3: Implement `src/exporters/wger.ts`**

```typescript
import { createLogger } from '../logger.js';
import type { BodyComposition } from '../interfaces/scale-adapter.js';
import type { Exporter, ExportContext, ExportResult } from '../interfaces/exporter.js';
import type { ExporterSchema } from '../interfaces/exporter-schema.js';
import type { WgerConfig } from './config.js';
import { toLocalDate } from './intervals.js';
import { withRetry, httpError } from '../utils/retry.js';
import { errMsg } from '../utils/error.js';

const log = createLogger('Wger');

export const wgerSchema: ExporterSchema = {
  name: 'wger',
  displayName: 'Wger',
  description: 'Push weight and body composition to a self-hosted or hosted Wger instance',
  fields: [
    {
      key: 'base_url',
      label: 'Base URL',
      type: 'string',
      required: true,
      description: 'Wger instance URL, e.g. https://wger.de or your self-hosted address',
    },
    {
      key: 'token',
      label: 'API Token',
      type: 'password',
      required: true,
      description: 'Permanent API key from Wger account settings (<base_url>/en/user/api-key)',
    },
    {
      key: 'sync_measurements',
      label: 'Sync body composition',
      type: 'boolean',
      required: false,
      default: true,
      description: 'Also push body-fat/water/muscle/bone as Wger custom measurements, not just weight',
    },
  ],
  supportsGlobal: false,
  supportsPerUser: true,
};

/** Body-composition metrics mapped onto Wger custom measurement categories. */
const MEASUREMENT_CATEGORIES: ReadonlyArray<{
  name: string;
  unit: string;
  value: (d: BodyComposition) => number;
}> = [
  { name: 'Body Fat', unit: '%', value: (d) => d.bodyFatPercent },
  { name: 'Body Water', unit: '%', value: (d) => d.waterPercent },
  { name: 'Muscle Mass', unit: 'kg', value: (d) => d.muscleMass },
  { name: 'Bone Mass', unit: 'kg', value: (d) => d.boneMass },
];

interface CategoryListResponse {
  next: string | null;
  results: Array<{ id: number; name: string; unit: string }>;
}

export class WgerExporter implements Exporter {
  readonly name = 'wger';
  readonly supportsBackdate = true;
  private readonly config: WgerConfig;
  private readonly apiBase: string;
  /** name -> category id, resolved lazily on first export and cached. */
  private categories: Map<string, number> | null = null;

  constructor(config: WgerConfig) {
    this.config = config;
    this.apiBase = `${config.baseUrl.replace(/\/+$/, '')}/api/v2`;
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Token ${this.config.token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
  }

  async export(data: BodyComposition, context?: ExportContext): Promise<ExportResult> {
    const date = toLocalDate(context?.timestamp ?? new Date());

    // Weight is the primary result: its failure fails the export.
    const weightResult = await withRetry(
      async () => {
        const response = await fetch(`${this.apiBase}/weightentry/`, {
          method: 'POST',
          headers: this.headers(),
          body: JSON.stringify({ date, weight: Number(data.weight.toFixed(2)) }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) {
          throw httpError(response.status);
        }
        return { success: true };
      },
      { log, label: 'Wger weight entry' },
    );

    if (!weightResult.success) {
      return weightResult;
    }
    log.info(`Wger weight entry pushed for ${date}.`);

    // Body composition is best-effort: a failure here is logged, not fatal.
    if (this.config.syncMeasurements) {
      try {
        await this.pushMeasurements(data, date);
      } catch (err) {
        log.warn(`Wger measurements skipped: ${errMsg(err)}`);
      }
    }

    return { success: true };
  }

  private async pushMeasurements(data: BodyComposition, date: string): Promise<void> {
    const categories = await this.resolveCategories();
    for (const cat of MEASUREMENT_CATEGORIES) {
      const value = cat.value(data);
      if (!Number.isFinite(value) || value <= 0) continue;
      const categoryId = categories.get(cat.name);
      if (categoryId === undefined) continue;

      const result = await withRetry(
        async () => {
          const response = await fetch(`${this.apiBase}/measurement/`, {
            method: 'POST',
            headers: this.headers(),
            body: JSON.stringify({ category: categoryId, date, value: Number(value.toFixed(2)) }),
            signal: AbortSignal.timeout(10_000),
          });
          if (!response.ok) {
            throw httpError(response.status);
          }
          return { success: true };
        },
        { log, label: `Wger ${cat.name} measurement` },
      );
      if (!result.success) {
        log.warn(`Wger ${cat.name} measurement failed: ${result.error}`);
      }
    }
  }

  /** List existing measurement categories, create any missing ones, cache name->id. */
  private async resolveCategories(): Promise<Map<string, number>> {
    if (this.categories) return this.categories;

    const map = new Map<string, number>();
    let url: string | null = `${this.apiBase}/measurement-category/`;
    let pages = 0;
    while (url && pages < 50) {
      const response = await fetch(url, {
        headers: this.headers(),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        throw httpError(response.status);
      }
      const json = (await response.json()) as CategoryListResponse;
      for (const c of json.results) {
        if (!map.has(c.name)) map.set(c.name, c.id);
      }
      url = json.next;
      pages++;
    }

    for (const cat of MEASUREMENT_CATEGORIES) {
      if (map.has(cat.name)) continue;
      const response = await fetch(`${this.apiBase}/measurement-category/`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ name: cat.name, unit: cat.unit }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        throw httpError(response.status);
      }
      const created = (await response.json()) as { id: number };
      map.set(cat.name, created.id);
    }

    this.categories = map;
    return map;
  }

  async healthcheck(): Promise<ExportResult> {
    try {
      const response = await fetch(`${this.apiBase}/userprofile/`, {
        headers: this.headers(),
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) {
        return { success: false, error: `HTTP ${response.status}` };
      }
      return { success: true };
    } catch (err) {
      return { success: false, error: errMsg(err) };
    }
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/exporters/wger.test.ts`
Expected: PASS (all).

---

### Task 3: Wire the exporter into the registry, factory, and env-load

**Files:**
- Modify: `src/exporters/index.ts`
- Modify: `src/exporters/registry.ts`
- Modify: `src/config/env-load.ts`
- Test: `tests/exporters/index.test.ts`, `tests/exporters/registry.test.ts`

- [ ] **Step 1: Update `registry.test.ts` counts and add assertions (write first)**

In `tests/exporters/registry.test.ts`:
- Change `expect(EXPORTER_REGISTRY).toHaveLength(10);` to `toHaveLength(11);`
- Change `expect(EXPORTER_SCHEMAS).toHaveLength(10);` to `toHaveLength(11);`
- Change `expect(KNOWN_EXPORTER_NAMES.size).toBe(10);` (line ~205) to `toBe(11);`
- After the `runalyze schema has token as the only required field` test (~line 196), add:

```typescript
  it('wger schema supports per-user only', () => {
    const wger = EXPORTER_SCHEMAS.find((s) => s.name === 'wger');
    expect(wger).toBeDefined();
    expect(wger!.supportsGlobal).toBe(false);
    expect(wger!.supportsPerUser).toBe(true);
  });

  it('wger schema has base_url and token as required fields', () => {
    const wger = EXPORTER_SCHEMAS.find((s) => s.name === 'wger');
    const requiredFields = wger!.fields.filter((f) => f.required);
    expect(requiredFields.map((f) => f.key).sort()).toEqual(['base_url', 'token']);
  });
```

- After the `KNOWN_EXPORTER_NAMES.has('runalyze')` assertion (~line 218) add:
```typescript
    expect(KNOWN_EXPORTER_NAMES.has('wger')).toBe(true);
```

- [ ] **Step 2: Add the index factory test (write first)**

In `tests/exporters/index.test.ts`, after the `creates RunalyzeExporter for runalyze` test (~line 147):

```typescript
  it('creates WgerExporter for wger', () => {
    const exporters = createExporters({
      exporters: ['wger'],
      wger: { baseUrl: 'https://wger.example', token: 'tok-1', syncMeasurements: true },
    });
    expect(exporters).toHaveLength(1);
    expect(exporters[0]).toBeInstanceOf(WgerExporter);
    expect(exporters[0].name).toBe('wger');
  });
```

Add the import at the top alongside the other exporter imports:
```typescript
import { WgerExporter } from '../../src/exporters/wger.js';
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run tests/exporters/registry.test.ts tests/exporters/index.test.ts`
Expected: FAIL — registry has 10 not 11, `WgerExporter` import unresolved / no `wger` case.

- [ ] **Step 4: Wire `index.ts`**

In `src/exporters/index.ts`, add the import after the runalyze import:
```typescript
import { RunalyzeExporter } from './runalyze.js';
import { WgerExporter } from './wger.js';
```

Add the case after the `runalyze` case:
```typescript
      case 'runalyze':
        exporters.push(new RunalyzeExporter(config.runalyze!));
        break;
      case 'wger':
        exporters.push(new WgerExporter(config.wger!));
        break;
```

- [ ] **Step 5: Wire `registry.ts`**

In `src/exporters/registry.ts`:

(a) Add `WgerConfig` to the type import block:
```typescript
  IntervalsConfig,
  RunalyzeConfig,
  WgerConfig,
} from './config.js';
```

(b) Add the schema/class import after runalyze:
```typescript
import { runalyzeSchema, RunalyzeExporter } from './runalyze.js';
import { wgerSchema, WgerExporter } from './wger.js';
```

(c) Add the registry entry after the runalyze entry (before the closing `];`):
```typescript
  {
    schema: wgerSchema,
    factory: (config) => {
      const wgerConfig: WgerConfig = {
        baseUrl: requireField(config, 'wger', 'base_url'),
        token: requireField(config, 'wger', 'token'),
        syncMeasurements: (config.sync_measurements as boolean) ?? true,
      };
      return new WgerExporter(wgerConfig);
    },
  },
```

- [ ] **Step 6: Wire `env-load.ts`**

In `src/config/env-load.ts`, after the `runalyze` block (~line 87):
```typescript
    if (name === 'wger' && exporterConfig.wger) {
      const w = exporterConfig.wger;
      Object.assign(entry, {
        base_url: w.baseUrl,
        token: w.token,
        sync_measurements: w.syncMeasurements,
      });
    }
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run tests/exporters/registry.test.ts tests/exporters/index.test.ts`
Expected: PASS.

---

### Task 4: Docs, examples, README, full verification, commit, push, close

**Files:**
- Modify: `docs/exporters.md`, `.env.example`, `config.yaml.example`, `README.md`

- [ ] **Step 1: `.env.example`** — after the RUNALYZE block (~line 113):

```
# ----------------------------------------------------------------------------
# WGER CONFIGURATION (only when wger exporter is enabled)
# ----------------------------------------------------------------------------
# Permanent API key from <base_url>/en/user/api-key
# WGER_BASE_URL=https://wger.de
# WGER_TOKEN=
# WGER_SYNC_MEASUREMENTS=true
```

- [ ] **Step 2: `docs/exporters.md`** —
  - Frontmatter line 3 (`description:`) and line 7 (`content:`): add `wger` to the keyword lists.
  - Line 12: change "exports body composition data to 10 targets" to "11 targets".
  - In the summary table (after the Runalyze row ~line 27) add: `| [**Wger**](#wger)               | Push weight + body composition to a Wger instance      |`
  - After the Runalyze section (~line 334) add a `## Wger {#wger}` section:

```markdown
## Wger {#wger}

Push weight and body composition to [Wger](https://wger.de), the open-source self-hosted workout and weight manager. A natural fit for the self-hosting audience, and it matches what `openScale-sync` already supports.

| Field               | Required | Default | Description                                                        |
| ------------------- | -------- | ------- | ------------------------------------------------------------------ |
| `base_url`          | Yes      | (none)  | Wger instance URL, e.g. `https://wger.de` or your self-hosted host |
| `token`             | Yes      | (none)  | Permanent API key from `<base_url>/en/user/api-key`                |
| `sync_measurements` | No       | `true`  | Also push body fat, water, muscle, bone as custom measurements     |

```yaml
exporters:
  - type: wger
    base_url: https://wger.de
    token: ${WGER_TOKEN}
    sync_measurements: true
```

Authentication uses a permanent API key (sent as `Authorization: Token <key>`), no OAuth flow. Generate it on the Wger account settings **API** page. Weight is written to a weight entry on the reading's calendar day, so historical readings replayed from a scale's offline cache land on their original date. With `sync_measurements` enabled, body fat and water (percent) and muscle and bone (kg) are written as Wger custom measurements; the matching categories are created automatically on first use and reused afterwards. Measurement failures are logged but do not block the weight sync.
```

  - In the Healthchecks table (~line 361) add: `| Wger          | `GET` userprofile record     |`

- [ ] **Step 3: `config.yaml.example`** — after the `file` exporter example block (~line 144), add:
```yaml
  # - type: wger
  #   base_url: https://wger.de
  #   token: ${WGER_TOKEN}
  #   sync_measurements: true
```

- [ ] **Step 4: `README.md`** —
  - Line 10: change the exporter sentence to include Wger and read "and **local files** (CSV/JSONL)" unchanged, inserting `**Wger**,` after `**Runalyze**,`.
  - Line 83: change "**[10 export targets]**" to "**[11 export targets]**" and add `Wger,` to the list after `Runalyze,`.

- [ ] **Step 5: Full verification**

```bash
taskkill //F //IM node.exe
npm test
npm run lint
npx tsc --noEmit
npx prettier --check "src/**/*.ts" "tests/**/*.ts" "docs/exporters.md" README.md
```
Expected: full suite green (1688 + new tests), lint clean, tsc no errors, prettier clean on the changed files. If prettier flags a changed file, run `npx prettier --write` on it and re-check.

- [ ] **Step 6: Commit (single conventional commit) and push**

```bash
git add src/exporters/wger.ts tests/exporters/wger.test.ts src/exporters/config.ts src/exporters/index.ts src/exporters/registry.ts src/config/env-load.ts tests/exporters/config.test.ts tests/exporters/index.test.ts tests/exporters/registry.test.ts docs/exporters.md .env.example config.yaml.example README.md
git commit -m "feat(exporter): add Wger exporter (#205)"
git push origin dev
```

- [ ] **Step 7: Confirm the Deploy Docs workflow re-runs on dev**

Run: `"C:\Program Files\GitHub CLI\gh.exe" run list --branch dev --limit 5`
Expected: a "Deploy Docs" run queued/in_progress for the push.

- [ ] **Step 8: Comment on and close the issue**

Post a comment summarizing the implementation (weight + auto-managed measurement categories, token auth, self-hosted base URL, backdate, healthcheck), note it ships in the next `dev` to `main` release, then close `#205` (per the user's instruction to close after commit + push).

```bash
"C:\Program Files\GitHub CLI\gh.exe" issue close 205 --repo KristianP26/ble-scale-sync
```

---

## Notes / out of scope

- **No idempotency / dedup.** Wger has no upsert and no per-date unique constraint, so a replayed reading creates duplicate rows. One reading per weigh-in is the normal flow, so blind POST is acceptable; matching the verified API behavior. Documented, not worked around.
- **Date format.** `weightentry.date` accepting a bare `YYYY-MM-DD` is verified; `measurement.date` is the same `DateTimeField` type and strongly implied to accept it but was not seen in a primary-source example. If a live test rejects it, send full ISO `YYYY-MM-DDT00:00:00`.
- **Weight unit.** `BodyComposition.weight` is always kg in this project; Wger stores the weight decimal in the kg domain (no unit field on the entry), so post kg as-is. `scale.weight_unit` is display-only and not involved.
- `toLocalDate` is imported from `intervals.js` (already exported and tested) to stay DRY rather than duplicating the calendar-day formatter.
