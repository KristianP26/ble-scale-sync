# Docs Review: Counts, Logo Easter Egg, Changelog Menu Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the docs site and README internally consistent and user-friendly by fixing stale scale/exporter counts, updating the logo easter egg, trimming scale headlines to popular brands, and consolidating the changelog into a single menu surface.

**Architecture:** Pure documentation/markup edits across `docs/` and `README.md`. No source-code or test changes. Two count conventions: marketing/prose uses rounded `25+ scales` / `11 exporters` / `10 metrics`; reference surfaces (supported-scales, faq full-list, alternatives table, logo easter egg) state exact `26` adapters and `11` exporters.

**Tech Stack:** VitePress (Markdown + `docs/.vitepress/config.ts`), SVG logo, GitHub-flavored Markdown.

## Global Constraints

- No em dash and no double dash in any output (commits, docs, code). Rewrite the sentence instead.
- Use EUR / `€` not `$` for currency.
- Docs-only change: do NOT edit `package.json` version, `CHANGELOG.md`, `ble-scale-sync-addon/config.yaml`, or any `src/` file.
- Canonical numbers (verified 2026-06-19 against `src/scales/index.ts` and `src/exporters/`):
  - **26** protocol adapters (27 array entries minus the generic `StandardGattScaleAdapter` catch-all).
  - **11** exporters: Garmin, Strava, Intervals.icu, Runalyze, Wger, MQTT, InfluxDB, Webhook, Ntfy, Telegram, File.
  - **10** body metrics.
- Count convention:
  - Marketing/prose surfaces (README intro + features, index hero + feature cards): rounded `25+`.
  - Reference surfaces (supported-scales, faq full-list count, alternatives table, logo easter egg): exact `26`.
- Popular-brand headline list (for trimmed scale lists): Xiaomi, Renpho, Eufy, Yunmai, Beurer, Sanitas, Medisana, and more. Always followed by a link to the full supported-scales page.
- Commit style: Conventional Commits, `docs:` type. Branch `dev`.

---

## Task 1: Logo easter egg `25.9` to `26.11`

**Files:**
- Modify: `docs/public/logo.svg:6`

**Interfaces:**
- Produces: logo display text `26.11` (adapters.exporters) used by index hero `image.src` and favicon-adjacent branding. No downstream code depends on the value.

- [ ] **Step 1: Edit the SVG display text**

In `docs/public/logo.svg` line 6, change the `<text>` content from `25.9` to `26.11`:

```html
  <text x="64" y="54" text-anchor="middle" font-family="monospace" font-size="18" font-weight="700" fill="#38bdf8">26.11</text>
```

- [ ] **Step 2: Verify**

Run: `grep -n "26.11" docs/public/logo.svg`
Expected: line 6 prints with `26.11`. Confirm no remaining `25.9` via `grep -n "25.9" docs/public/logo.svg` (expected: no output).

- [ ] **Step 3: Commit**

```bash
git add docs/public/logo.svg
git commit -m "docs: update logo easter egg to 26.11 adapters.exporters"
```

---

## Task 2: Fix stale counts on the website home (`index.md`)

**Files:**
- Modify: `docs/index.md:11` (hero tagline), `docs/index.md:25` (feature title), `docs/index.md:30-31` (exporter feature title + details)

**Interfaces:**
- Consumes: canonical numbers from Global Constraints (rounded `25+`, exporter list of 11).
- Produces: home page consistent with README marketing copy.

- [ ] **Step 1: Hero tagline scale count**

`docs/index.md:11` change `20+ BLE smart scales` to `25+ BLE smart scales`:

```yaml
  tagline: Cross-platform CLI for Linux, macOS & Windows. Read weight & impedance from 25+ BLE smart scales and export to Garmin Connect, Strava, Home Assistant, InfluxDB, Webhooks, Ntfy & local files. No phone app needed.
```

- [ ] **Step 2: Scale feature card title**

`docs/index.md:25` change `20+ Smart Scales` to `25+ Smart Scales`.

- [ ] **Step 3: Exporter feature card title + details (add Runalyze, Wger)**

`docs/index.md:30` change title `9 Export Targets` to `11 Export Targets`.
`docs/index.md:31` update details to list all 11 in canonical order:

```yaml
    details: Garmin Connect &bull; Strava &bull; Intervals.icu &bull; Runalyze &bull; Wger &bull; MQTT (Home Assistant) &bull; InfluxDB &bull; Webhook &bull; Ntfy &bull; Telegram &bull; File (CSV/JSONL)
```

- [ ] **Step 4: Verify**

Run: `grep -nE "20\+|9 Export" docs/index.md`
Expected: no output (all stale tokens gone).
Run: `grep -nE "25\+|11 Export" docs/index.md`
Expected: hero tagline, feature title, and exporter title all present.

- [ ] **Step 5: Commit**

```bash
git add docs/index.md
git commit -m "docs: refresh home page scale and exporter counts"
```

---

## Task 3: Trim scale headline to popular brands (`index.md` + `README.md`)

**Files:**
- Modify: `docs/index.md:26` (scale feature card details)
- Modify: `README.md:82` (features scale line)

**Interfaces:**
- Consumes: popular-brand headline list from Global Constraints.
- Produces: shorter, scannable brand list on both surfaces, each linking to the full supported-scales page.

- [ ] **Step 1: index.md scale card details**

`docs/index.md:26` is already short. Confirm it reads popular brands plus "and more" and keeps `link: /guide/supported-scales`. Set the details to:

```yaml
    details: Xiaomi, Renpho, Eufy, Yunmai, Beurer, Sanitas, Medisana, and more. Auto-detection out of the box.
```

- [ ] **Step 2: README.md features scale line**

`README.md:82` trim the long brand list (drop niche GE / Robi / FITINDEX detail from the headline) to popular brands, keep the full-list link:

```markdown
- **[25+ scale brands](https://blescalesync.dev/guide/supported-scales).** Xiaomi (Mi Scale 2 passive broadcast), Renpho (Elis 1, ES-CS20M, QN-Scale), Eufy, Yunmai, Beurer (incl. BF720), Sanitas (incl. SBF70 body composition), Medisana, and more.
```

- [ ] **Step 3: Verify**

Run: `grep -n "and more" docs/index.md README.md`
Expected: both files show the trimmed list ending in "and more".

- [ ] **Step 4: Commit**

```bash
git add docs/index.md README.md
git commit -m "docs: trim scale headline lists to popular brands"
```

---

## Task 4: Align reference-surface counts (`configuration.md`, `faq.md`, `alternatives.md`)

**Files:**
- Modify: `docs/guide/configuration.md:142`
- Modify: `docs/faq.md:65`
- Modify: `docs/alternatives.md:28`

**Interfaces:**
- Consumes: canonical exact `26` adapters, `11` exporters.
- Produces: reference pages agree with `supported-scales.md` (26) and `exporters.md` (11).

- [ ] **Step 1: configuration.md exporter count**

`docs/guide/configuration.md:142` change `all 9 targets` to `all 11 targets`.

- [ ] **Step 2: faq.md adapter count**

`docs/faq.md:65` change `full list of 25 adapters` to `full list of 26 adapters`.

- [ ] **Step 3: alternatives.md table adapter count**

`docs/alternatives.md:28` change `25 protocol adapters` to `26 protocol adapters`.

- [ ] **Step 4: Verify**

Run: `grep -rnE "9 targets|25 adapters|25 protocol adapters" docs/`
Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add docs/guide/configuration.md docs/faq.md docs/alternatives.md
git commit -m "docs: align reference pages to 26 adapters and 11 exporters"
```

---

## Task 5: Consolidate changelog into one menu surface (`config.ts`)

**Files:**
- Modify: `docs/.vitepress/config.ts:48-57` (nav), `docs/.vitepress/config.ts:85-93` (sidebar Help)

**Interfaces:**
- Consumes: existing `/changelog` page (unchanged).
- Produces: a single canonical changelog destination (`/changelog`), reachable from the top-nav "Changelog" link and the version chip; the duplicate sidebar Help entry is removed.

- [ ] **Step 1: Repoint version chip to the in-site changelog**

In `docs/.vitepress/config.ts` nav array, change the version entry `link` from the GitHub release tag to `/changelog`:

```ts
      {
        text: `v${pkg.version}`,
        link: '/changelog',
      },
```

- [ ] **Step 2: Remove the duplicate sidebar Help changelog entry**

In the `Help` sidebar group, delete the `{ text: 'Changelog', link: '/changelog' }` item so Help contains only FAQ, Troubleshooting, Alternatives:

```ts
      {
        text: 'Help',
        items: [
          { text: 'FAQ', link: '/faq' },
          { text: 'Troubleshooting', link: '/troubleshooting' },
          { text: 'Alternatives', link: '/alternatives' },
        ],
      },
```

- [ ] **Step 3: Verify**

Run: `grep -nE "Changelog|/changelog|releases/tag" docs/.vitepress/config.ts`
Expected: top-nav `Changelog` link plus the version chip, both pointing to `/changelog`; NO sidebar Changelog item; NO `releases/tag` reference remaining.

- [ ] **Step 4: Commit**

```bash
git add docs/.vitepress/config.ts
git commit -m "docs: consolidate changelog into a single menu surface"
```

---

## Task 6: User-friendliness sweep (links + residual stale text)

**Files:**
- Read-only scan across `docs/**/*.md` and `README.md`; modify only files with confirmed issues.

**Interfaces:**
- Consumes: all prior task results.
- Produces: confirmation that no stale count tokens, broken internal links, or stray `20+`/`9 export`/`25 adapters` remain.

- [ ] **Step 1: Global stale-count scan**

Run: `grep -rnE "20\+|9 Export Targets|9 targets|25 adapters|25 protocol" docs/ README.md`
Expected: no output. If any hit appears, fix it to the canonical value per Global Constraints and stage it.

- [ ] **Step 2: Logo value scan**

Run: `grep -rn "25.9" docs/`
Expected: no output.

- [ ] **Step 3: Internal link sanity (sampled)**

Confirm key internal links still resolve to existing pages: `/changelog`, `/exporters`, `/guide/supported-scales`, `/body-composition`, `/multi-user`. Cross-check against the file list in `docs/`.

Run: `ls docs/changelog.md docs/exporters.md docs/guide/supported-scales.md docs/body-composition.md docs/multi-user.md`
Expected: all five exist.

- [ ] **Step 4: Commit any residual fixes (only if Step 1 found issues)**

```bash
git add -- <explicit files>
git commit -m "docs: clean up residual stale counts from review sweep"
```

---

## Self-Review Checklist (run after implementation, before final push)

- [ ] Spec coverage: logo (T1), home counts (T2), trimmed headlines (T3), reference counts (T4), changelog menu (T5), sweep (T6) all done.
- [ ] No `20+`, `9 Export`, `9 targets`, `25 adapters`, `25.9` tokens remain anywhere in `docs/` or `README.md`.
- [ ] No em dash / double dash introduced.
- [ ] `git status` shows only docs surfaces touched (no `src/`, no version files, no untracked `docs/superpowers/plans/*` staged via `git add -A` — use explicit paths only).
- [ ] Push branch `dev`.
