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

## 4. Tests

```bash
npm test           # node --test tests/*.test.js  (expect 29/29)
```

Covers Stage 1 (identity keys, empty states) and Stage 2 (source config
validation, RSS/Atom/RSS-1.0 parsing, graceful feed failure handling, line
formatting). Tests are also run in CI on every code push before the snapshot is
regenerated.

## 5. Rebuild the news snapshot

```bash
npm run build:news # node scripts/build-news.js
```

This fetches all enabled sources from `sources/sources.json`, parses each feed,
normalizes items via the shared `js/shared.js` step (stable Story IDs), dedupes,
and writes `data/news.json`. It **aborts with exit code 1** if the source config is
invalid or zero items survive.

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
- commits `data/news.json` and pushes, which auto-redeploys Pages.

Nothing else is required — the snapshot file is the database, GitHub is the host.

## 7. Common failure modes

| Symptom | Cause / fix |
|---|---|
| `config invalid` error in `build-news.js` | `sources/sources.json` has a bad entry — run `node scripts/pipeline/ingest.js` or look at `sources/index.js` validation errors, fix and re-run. |
| A feed prints `[ERROR] … HTTP 403/429` | Feed is blocking bots / rate-limited. Set `HTTP_USER_AGENT` in `.env` or reduce fetch frequency; never bypass a 403 aggressively. |
| `[WARN] … 0 items` | Legitimate empty feed (e.g. nothing published recently). Valid. |
| `node scripts/pipeline/ingest.js` exits 1 | All configured sources failed. Check network, `.env`, and `HTTP_USER_AGENT`. |
| Snapshot sites hold stale data | CI regenerates every 3 h; check the Actions run, then trigger *Refresh AI Radar news snapshot* → **Run workflow**.