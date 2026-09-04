# AI RADAR — Setup

Everything you need to run, test and build AI RADAR locally. The deployed site is
pure static — Node is only required to regenerate the news snapshot and to run the
tests.

## Requirements

- **Node.js ≥ 18** (uses global `fetch`); tests run on Node 24.
- npm (ships with Node).

## 1. Install

```bash
npm install        # dev dependency: fast-xml-parser (snapshot builder only)
```

The frontend itself has **zero dependencies** — without `npm install` the site
still runs in a browser (live aggregation falls back to CORS proxies then embedded
sample content).

## 2. Run the site locally

```bash
npm start          # zero-dependency static server + RSS proxy at http://localhost:8080
```

Open http://localhost:8080. With the snapshot present (`data/news.json`) the page
renders it directly; otherwise the browser falls back to `server.js`'s `/api/fetch`
proxy, then public CORS proxies, then sample content.

## 3. Environment file (optional)

The Node scripts read `<repo>/.env` if present (via `scripts/pipeline/env.js` —
no dotenv dependency). Copy the example and adjust if needed:

```bash
copy .env.example .env     # Windows
```

See [`.env.example`](.env.example). Secrets are **never committed** (`.gitignore`
covers `.env`); CI uses GitHub Action secrets instead.

Stage 7 summarization is **extractive by default** (no config needed). To enable
the **optional LLM path**, set `SUMMARY_MODE=llm` plus `AI_API_KEY` (and
optionally `AI_MODEL`/`AI_BASE_URL`). It uses Node's built-in `fetch` (no extra
dependency) and falls back to extraction on any failure. In CI, provide
`AI_API_KEY` as an encrypted Action secret.

## 4. Tests

```bash
npm test           # node --test tests/*.test.js  (expect 116/116)
```

Covers Stage 1 (identity keys, empty states), Stage 2 (source config validation,
RSS/Atom/RSS-1.0 parsing, graceful feed failure handling, line formatting),
Stage 3 (canonical Story schema: RSS/Atom/RDF normalization, URL tracking params,
timestamp normalization, stable ids, schema validation, multi-source),
Stage 5 (persistent store: idempotent upsert, day bucketing, read APIs,
retention/prune, run logs, determinism, malformed-data handling, empty input),
Stage 6 (classification: 12-category taxonomy, legacy top-5 bucket mapping,
entity extraction with false-positive + prefix-subsumption guards, tags,
determinism; Radar Score: weight blend, component monotonicity, multi-source
bonus, 0-100 range, legacy 0-5 alias) and Stage 7 (summarization: extractive
determinism, title-only/short-input handling, sentence boundaries, takeaway +
length limits, idempotency, provenance label, anti-hallucination, LLM success /
malformed / failure + extractive fallback).
Tests are also run in CI on every code push before the snapshot is regenerated.

## 5. Rebuild the news snapshot

```bash
npm run build:news # node scripts/build-news.js
```

This fetches all enabled sources from `sources/sources.json`, parses each feed,
and normalizes every item into a **canonical Story** (`js/shared.js`
`normalizeItem`, see [SCHEMA.md](SCHEMA.md)) with stable IDs. It **validates each
story** and logs + drops any that fail validation (never silently), then dedupes,
similarity-clusters (Stage 4), **classifies** (Stage 6: 12-category `subcategory`,
entities, `tags`, a refined legacy top-5 `category`) and **scores** (Stage 6:
explainable 0-100 `radarScore` with stored components), **summarizes** (Stage 7:
extractive `ai.summary` + `ai.keyTakeaways`, with an optional labeled LLM path),
**persists a copy of each staged story into `data/db/`** (per-day NDJSON +
`index.json`, idempotent, with a 90-day retention prune), and writes
`data/news.json`. It **aborts with exit code 1** if the source config is invalid
or zero items survive. The final line reports normalized vs rejected counts plus
Stage 4-7 numbers (e.g. `Saved 2689 unique stories … (normalized 2694, rejected
0, exactDedupe 2694, similarityMergedInto 5, … storeDays 7, stored 2689,
prunedDays 0, classifyCats 12, radar 0-100 mean 57, summarize extract
(1234 of 2689))`).

To check feeds without writing any file (diagnostic dry run):

```bash
node scripts/pipeline/ingest.js
```

Prints one `[OK]/[WARN]/[ERROR]` line per source plus a summary
(`sources ok=.. empty=.. failed=.. items=..`).

## 6. Deployment

GitHub Pages + GitHub Actions (`.github/workflows/news.yml`):

- re-aggregates on a 3-hour cron, on manual `workflow_dispatch`, and on any code
  push touching `js/`, `scripts/`, `tests/`, `package*.json` or the workflow;
- runs `npm ci` → `npm test` → `node scripts/build-news.js`;
- commits `data/news.json` **and `data/db/`** and pushes, which auto-redeploys Pages.

Nothing else is required — the snapshot file is the database, GitHub is the host.

## 7. Common failure modes

| Symptom | Cause / fix |
|---|---|
| `config invalid` error in `build-news.js` | `sources/sources.json` has a bad entry — run `node scripts/pipeline/ingest.js` or look at `sources/index.js` validation errors, fix and re-run. |
| A feed prints `[ERROR] … HTTP 403/429` | Feed is blocking bots / rate-limited. Set `HTTP_USER_AGENT` in `.env` or reduce fetch frequency; never bypass a 403 aggressively. |
| `[WARN] … 0 items` | Legitimate empty feed (e.g. nothing published recently). Valid. |
| `data/db/` grows | Expected — Stage 5 keeps per-day history. `build-news.js` auto-prunes archives older than the 90-day retention window on every run. |
| `node scripts/pipeline/ingest.js` exits 1 | All configured sources failed. Check network, `.env`, and `HTTP_USER_AGENT`. |
| Snapshot sites hold stale data | CI regenerates every 3 h; check the Actions run, then trigger *Refresh AI Radar news snapshot* → **Run workflow**.