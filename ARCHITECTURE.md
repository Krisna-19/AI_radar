# AI RADAR — Architecture

This document describes the current architecture of AI RADAR and the target
architecture we are evolving toward (approved roadmap, Stage 1..10). It is a
living document: update it whenever a stage lands.

## 1. Current architecture (as of Stage 3)

### Stack
- 100% static web app (no framework, no build step) served by GitHub Pages
  from the `main` branch root.
- Frontend scripts: `js/config.js`, `js/shared.js`, `js/aggregator.js`, `js/app.js`.
- Backend: GitHub Actions (`.github/workflows/news.yml`) runs a Node snapshot
  builder (`scripts/build-news.js`) on top of the unified pipeline and commits
  the result.
- No database, no API server on the deployed site (a local-only `server.js`
  provides a static file server + `/api/fetch` RSS proxy for development).

### Data flow (as deployed)
```
13 source definitions — sources/sources.json (canonical, served to the browser too)
   ├─ CI (every 3h or on code path push)
   │    build-news.js
   │      └─ pipeline: sources/index.js -> ingest.js (fetch+parse)
   │            -> normalizeItem (canonical Story, schemaVersion 1.0)
   │            -> validateStory -> dedupe
   │            -> data/news.json {generatedAt, stats, sources, items}
   │      -> npm test gate -> git commit -> GitHub Pages
   │
   └─ browser (fallback only when the snapshot is missing)
        fetch proxy chain (local /api -> rss2json -> allorigins -> codetabs)
        -> parse -> normalizeItem -> dedupe -> render
Frontend reads data/news.json (it ignores stats/sources fields), renders Today /
Yesterday / This week, search, category + source filters, Top Stories. Source
chips come from sources/sources.json.
```

### Identity model (Stage 1)
- Every story gets a **stable, deterministic identity**:
  - `fingerprint` = `canonicalKey(title, link)` — normalised title `|`
    canonical URL (host + first two path segments, `www`-stripped, lowercased).
  - `id` = `"s" + djb2-hash(fingerprint)` (8 hex chars).
  - Unchanged across runs, sources and days -> the foundation for idempotent
    pipeline upserts and cross-run deduplication.
- `dedupe()` collapses items with an identical `canonicalKey` (first occurrence
  wins). Stories reported by multiple outlets under (slightly) different URLs
  are **not** merged yet — that is Stage 4 (similarity clustering +
  "Reported by N sources").

### Empty/zero-state handling (Stage 1)
- "Today" with no published stories (e.g. early in the day) no longer shows a
  confusing zero page: a notice explains it and the most recent 48h of stories
  are shown instead.
- The empty state now explains *why* it is empty (search miss / category /
  sources / range) instead of a generic message.
- Live aggregation is bounded by a 45s timeout so the UI can always fall back
  instead of spinning on "Scanning sources…" forever.

### Source configuration (Stage 2)
- **`sources/sources.json` is the single source of truth** for every feed:
  `id`, `name`, `url`, `category` (`company|research|media`), `enabled`,
  `priority`, `fetchIntervalHours`, `parser` (`rss|atom|auto`), `reliability`
  (0–10), `weight` (1–5), `color`.
- Loaded + validated by `sources/index.js` (Node) through the **shared** schema
  in `js/shared.js` (`validateSourceConfig`/`applySourceDefaults`). Invalid or
  duplicate entries make `configValid === false`, which aborts `build-news.js`.
- The **browser fetches the same file** (`js/config.js` -> `SOURCES_PATH`) for the
  source chips, so adding a source is a one-line JSON edit — no code changes.
- Pipeline metadata per source (ok/failed, item count, error type, response ms)
  lands in the snapshot under `stats` + `sources`.

### Unified ingestion pipeline (Stage 2)
- `scripts/pipeline/ingest.js` replaces the browser-only/builder-only split with
  one Node path: `sources/index.js` -> `http.js` (classified `timeout` / `http` /
  `network` / `empty` errors via `FeedError`) -> `feed.js` (RSS 2.0, Atom, and
  RSS 1.0/RDF parsing with fast-xml-parser; lenient parser, but a feed with no
  items **and** no channel metadata is rejected as truncated) -> shared
  `Core.enrichItem` -> dedupe.
- Identical normalize step to the browser (same `enrichItem`), so Node and
  browser produce identical stories and **stable Stage-1 ids**.
- One failing feed never aborts ingestion: results are reported per source as
  `[OK]` / `[WARN]` / `[ERROR]` and summarized.
- CLI dry-run (no writes): `node scripts/pipeline/ingest.js`.
- `http.js` sends a browser-like UA (override via `HTTP_USER_AGENT`); `env.js`
  is a tiny zero-dep `.env` loader (`FETCH_TIMEOUT_MS`, `INGEST_CONCURRENCY`).
- Nature's feed is RSS 1.0 (`<rdf:RDF>`), which the parser now handles — it was
  silently returning 0 items before Stage 2.

### Canonical Story schema (Stage 3)
- `normalizeItem(rawItem, source, opts)` in `js/shared.js` is the **single
  normalization function** (browser + Node). It turns raw parser output into a
  **canonical Story** (`schemaVersion: "1.0"`) with nested `source{}`,
  `scores{}`, `ai{}`, `publishedAt`/`discoveredAt`, `originalUrl`/`canonicalUrl`,
  entity arrays, `relatedStoryIds`, `sources`, etc. — see [SCHEMA.md](SCHEMA.md).
- URL normalization (`canonicalizeUrl`) strips tracking params (`utm_*`,
  `fbclid`, `gclid`, …) into `canonicalUrl` while keeping the untouched
  `originalUrl`. Timestamp normalization (`normalizeTimestamp`) emits UTC
  ISO-8601 or `null` (never invents dates).
- **Determinism**: same raw item + source ⇒ same `id`, `fingerprint`,
  `canonicalUrl` (djb2 hash, no randomness) — unchanged from Stage 1.
- `enrichItem()` is now a thin compatibility alias over `normalizeItem`, so the
  Stage 2 pipeline shape and the current frontend keep working.
- `validateStory(story)` returns `{ valid, errors }`; `build-news.js` logs and
  drops invalid stories (never silently) and records
  `stats.rejectedValidated`. Optional fields always render as `null`/`[]`.
- Backward compatibility: the canonical Story also exposes the flat legacy
  aliases (`link`, `date`, `score`, `sourceId`, `sourceName`, `sourceType`, …)
  so existing filters, search, date grouping, source display and tests remain
  intact — **no frontend redesign** in Stage 3.

### Testing (Stage 1 + Stage 2 + Stage 3)
- Node built-in test runner, zero extra dependencies: `npm test`
  (`node --test tests/*.test.js`), **48 tests** (Stage 1 identity/empty-state +
  Stage 2 config/parser/pipeline + Stage 3 canonical schema incl. RSS/Atom/RDF,
  URL tracking, timestamps, stable ids, validation, multi-source).
- Run in CI before the snapshot is regenerated, and on every relevant code push.
- Browser-level smoke checks are run locally (jsdom harness) before pushing.
- Snapshot verification runs at build time: every generated story is validated
  against the schema and the counts are reported.

## 2. Current limitations (drivers for the roadmap)
- Snapshot is **replaced, never appended** -> no history, no cross-day
  dedup, weak search ("This week"/"Yesterday" are often empty).
- Deduplication is title+URL exact-match only (no similarity clustering) —
  `relatedStoryIds`/`sources` exist in the schema but stay empty (Stage 4).
- Categories are keyword heuristics; `scores.*` components and entities stay
  `null`/`[]` (radar Score is Stage 6, entities/classify Stage 6).
- No summaries, no AI interpretation layer (`ai.*` null — Stage 7).
- The browser live fallback still parses feeds with DOMParser instead of the
  Node `feed.js` path — same source config + same canonical normalizer, two XML
  parsers.
- High-volume feeds (OpenAI, Hugging Face) emit > 1,000 items each, so the
  snapshot can grow large between refreshes.
- No detailed docs for Stage 4+ (dedupe/classify/score/store land in the
  roadmap; the canonical Story schema is documented in [SCHEMA.md](SCHEMA.md)).

## 3. Target architecture (approved roadmap)

```
FRONTEND (GitHub Pages, static)
  index.html + js/app.js  ->  dashboard, Top Stories w/ Radar Score, detail
                              modal, search/filters, radars
  reads ONLY: data/db/*.json (never runtime feed fetching)

BACKEND = GitHub Actions (the "server")
  scripts/pipeline/
    1 ingest.js     sources/* config -> fetch (no aggressive scraping)
    2 normalize.js  canonical Story schema (pure)   <-- implemented in shared.js (Stage 3)
    3 dedupe.js     canonical-URL + title + n-gram similarity clustering,
                    merges duplicates into one story with sources[]
    4 classify.js   12 categories + entities (companies/models/people/
                    countries/tech lexicons; keyword + optional LLM)
    5 summarize.js  extractive summarizer by default (never fabricates),
                    optional LLM enrichment via encrypted Action secret
    6 score.js      Radar Score = 30% impact + 25% novelty + 20% credibility
                    + 15% relevance + 10% source confidence (0-100,
                    components stored -> explainable)
    7 store.js      idempotent UPSERT into data/db/ (per-day NDJSON +
                    index.json, 90-day retention) + pipeline run log
  commit + push -> GitHub Pages auto-deploys the fresh data

DATA
  "GitHub repo == database": versioned JSON in data/db/, idempotent upserts,
  real history + cross-day search. Swap boundary (store.js) allows a future
  move to Supabase/Cloudflare D1 without frontend changes.

AI LAYER
  Pluggable: heuristic/extractive default = zero credentials, zero
  fabrication risk; optional LLM via AI_API_KEY Action secret (encrypted).
  AI-generated text is always clearly labelled; original text preserved.

CONFIG / SECRETS / TESTS / DOCS
  sources/sources.json modular config (validated in Node + browser); .env.example
  for local runs (secrets never committed; CI uses encrypted Action secrets);
  automated tests gating every stage; README, ARCHITECTURE, SETUP, SOURCES docs.
```

### Stage plan (each stage tested before the next)
1. ~~Fix empty/zero states + stable identity keys~~ **done**
2. ~~`sources/` modular config + unified `ingest.js` parser + reliability stats~~ **done**
3. ~~`normalize.js` canonical Story schema~~ **done** (implemented in `js/shared.js`, see SCHEMA.md)
4. `dedupe.js` similarity clustering -> "Reported by N sources"
5. Persistence: `store.js` per-day NDJSON + index, idempotent upserts, CI writes
6. `classify.js` (12 categories) + entities + transparent `score.js` Radar Score
7. `summarize.js` extractive + optional LLM path
8. Dashboard rebuild (Top Stories w/ score, stats, trends, detail modal)
9. Search across history + filters (date / category / source / company / importance)
10. Company/Model/Research/Global radars + automation logging + full docs + SEO

## 4. Development & testing
- Run locally: `npm start` (serves at http://localhost:8080, plus `/api/fetch`
  proxy for live fallback debugging).
- Regenerate the snapshot: `npm run build:news`.
- Check feeds without writing files: `node scripts/pipeline/ingest.js`.
- Tests: `npm test` (48 tests).
- Push triggers the CI pipeline (tests + fresh snapshot + Pages deploy).
- Full local setup + troubleshooting: [SETUP.md](SETUP.md);
  source catalog/how-to-add: [SOURCES.md](SOURCES.md);
  canonical data model: [SCHEMA.md](SCHEMA.md).