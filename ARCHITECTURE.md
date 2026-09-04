# AI RADAR — Architecture

This document describes the current architecture of AI RADAR and the target
architecture we are evolving toward (approved roadmap, Stage 1..10). It is a
living document: update it whenever a stage lands.

## 1. Current architecture (as of Stage 6)

### Stack
- 100% static web app (no framework, no build step) served by GitHub Pages
  from the `main` branch root.
- The snapshot builder is offline and deterministic: no runtime calls, no
  randomness, no wall-clock dependence (besides `generatedAt`).
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
   │            -> validateStory -> dedupe (exact match)
   │            -> clusterStories (Stage 4 similarity)
   │            -> store.upsertStories -> store.prune (Stage 5, data/db/, 90-day)
   │            -> data/news.json (live snapshot)
   │      -> npm test gate -> git commit -> GitHub Pages
   │
   └─ browser (fallback only when the snapshot is missing)
        fetch proxy chain (local /api -> rss2json -> allorigins -> codetabs)
        -> parse -> normalizeItem -> dedupe -> render
Frontend reads data/news.json (it ignores stats/sources fields), renders Today /
Yesterday / This week, search, category + source filters, Top Stories. Source
chips come from sources/sources.json. data/db/ is written by the Node pipeline
(history + cross-day archive for later stages) and served as static files.
```

### Identity model (Stage 1)
- Every story gets a **stable, deterministic identity**:
  - `fingerprint` = `canonicalKey(title, link)` — normalised title `|`
    canonical URL (host + first two path segments, `www`-stripped, lowercased).
  - `id` = `"s" + djb2-hash(fingerprint)` (8 hex chars).
  - Unchanged across runs, sources and days -> the foundation for idempotent
    pipeline upserts and cross-run deduplication.
- `dedupe()` collapses items with an identical `canonicalKey` (first occurrence
  wins). **`clusterStories()` (Stage 4)** additionally merges *near-identical*
  stories reporting the same event into one canonical Story with `sources` and
  `reportedBy` populated — see Stage 4 section below.

### Similarity clustering / "Reported by N sources" (Stage 4)
- `scripts/pipeline/dedupe.js` (Node-only, zero dependencies) runs right after
  the exact-match `dedupe()` in `build-news.js`. It is **fully deterministic**:
  identical input always yields identical output, so Stage 1 ids remain stable.
- **Multi-signal similarity** (all must pass to merge):
  1. **Token overlap**: a high *symmetric* Jaccard (≥ 0.70) between **core
     content tokens**.
  2. **Time proximity**: if *both* members carry a `publishedAt`, they must be
     within 72h of each other; otherwise the same headline on different days is
     treated as two events.
  3. Same-host bonus (0.08) — an outlet re-reporting its own headline — nudges
     the score but can never cross the bar on its own.
- **Low-information vocabulary**: announcement/reporting verbs + filler
  adjectives ("releases", "announces", "launches", "unveils", "new", "latest",
  "unlocks", "breakthrough", …) are dropped before overlap is measured, because
  these are exactly the words outlets vary when covering the *same* event.
  Content nouns, model versions and numbers are **never** dropped.
- **False-positive protection** (the priority): a high symmetric bar means two
  different stories about the same company — "OpenAI launches GPT-6" vs "OpenAI
  raises $10B" — or the same model in different contexts ("releases GPT-6" vs
  "GPT-6 wins a benchmark") keep their distinguishing content token and stay
  separate. The implementation **prefers false negatives**: when a merge is
  ambiguous, stories are left separate.
- **Efficiency (no blind O(n²))**: stories are bucketed by shared meaningful
  title token (a deterministic `Map`), and similarity is only checked *within*
  each bucket, with a union-find used to form clusters. This keeps the ~4M
  pairwise comparisons of a naive build off the table for ~2.8k-item snapshots.
- **Canonical selection** is deterministic: within a merged cluster the ranking
  is `reliability` desc, then earliest `publishedAt`, then longest title, then a
  stable id tiebreak. The winner keeps its identity (`fingerprint`/`id`/
  `canonicalUrl`) and the other members are preserved:
  - `sources` = deduped list of every reporting outlet `{id, name}`
  - `relatedStoryIds` = ids of every merged member (canonical id first)
  - `reportedBy` = number of distinct reporting sources
- `stats` expose verification numbers: `afterExactDedupe`,
  `similarityMergedInto`, `multiSourceStories`, `maxClusterSize`.

### Persistence / "GitHub repo == database" (Stage 5)
- `scripts/pipeline/store.js` (Node-only, zero dependencies, only built-ins)
  archives every staged run into **`data/db/`**:
  ```
  data/db/
    runs/<runId>.json         one per pipeline run (metadata/run log)
    index.json                format, updatedAt, day -> ids, id -> {day, source}
    days/<yyyy-mm-dd>.ndjson  one canonical Story (JSON) per line
  ```
- **Idempotent upsert**: each story is keyed by its stable Stage-1 `id`. Re-running
  the same (or older) data is a no-op — an incoming record with `updatedAt <=`
  the stored one is left as-is, so a day bucket never grows and content never
  churns across identical runs. `createdAt`/`updatedAt` remain wall-clock
  metadata and are deliberately excluded from the idempotency key.
- **Day bucketing**: a story files under the UTC day of `publishedAt`, falling
  back to `discoveredAt` when `publishedAt` is null (already normalized; dates
  are never invented).
- **Retention**: `prune()` enforces a **90-day window** (configurable via
  `retentionDays`), removing expired `days/*.ndjson` and their `index.json`
  entries. The pipeline run log is kept separately under `runs/`.
- **Deterministic & lossless**: identical input ⇒ identical stored content
  (day rows sorted by id); the complete canonical Story is persisted verbatim.
  A malformed NDJSON line is skipped and reported, never fatal.
- **APIs for later stages** (tested now): `readDay(dbDir, day)`,
  `readById(dbDir, id)`, `recent(dbDir, { limit })`, `stats(dbDir)`, plus
  `upsertStories`, `prune`, `runLog`. This is the **swap boundary**: moving to
  Supabase/D1 later requires rewriting only `store.js`.
- `data/news.json` is still the live snapshot the current frontend reads —
  Stage 5 is additive. The Stage 8 dashboard will read `data/db/*` instead.

### Classification + entities (Stage 6)
- `scripts/pipeline/classify.js` (Node-only, zero dependencies) enriches every
  staged story **after** Stage 4 clustering and **before** Stage 5 persistence:
  - **12-category taxonomy** stored in `story.subcategory`:
    `research, model, product, tools, funding, business, policy, safety,
    opensource, partnership, industry, other`. Ordered, first-match rule
    precedence; word-boundary matching (so `api` never matches the `api` in
    `rapid`); low-signal input falls through to `other` (prefers false negatives).
  - Backward-compatible **top-5 chip**: the legacy `story.category` (each
    Stage-1..5 story keeps its value) is unchanged; `story.chip` holds the
    mapping the current frontend filters on
    (`model|product|tools->product`, `funding|business->funding`,
    `policy|safety->policy`, `research->research`,
    `opensource|partnership|industry|other->news`).
  - **Entity extraction** into `companies / models / people / technologies /
    countries` from conservative lexicons, matched as whole tokens with
    prefix-subsumption (a bare `gpt` does not re-fire when `gpt-5` matched),
    and **tags** = matched entities + topical keywords (capped at 6).
- **Radar Score** (`scripts/pipeline/score.js`, zero dependencies) is a
  transparent, explainable 0-100 score:
  ```
  radar = 30% impact + 25% novelty + 20% credibility
        + 15% relevance + 10% sourceConfidence
  ```
  - Every component is **stored** on `story.scores.{impact, novelty,
    credibility, relevance, sourceConfidence}` (each 0-100) so the score is
    explainable, plus `story.radarScore` (0-100) and the legacy `story.score`
    (radarScore/20, keeping the current 0-5 sort range).
  - `impact` = category base + multi-source (Stage 4 cluster) bonus;
    `novelty` = freshness vs `discoveredAt` (deterministic, no wall clock);
    `credibility` = source `reliability` + body-robustness bonus;
    `relevance` = AI-topic signal density + entity presence;
    `sourceConfidence` = source `weight` + multi-source confirmation.
  - Deterministic: identical input ⇒ identical Radar Score.
- The existing sort in `build-news.js` (which uses the legacy `story.score`)
  now ranks by Radar Score descending (it already folds in recency via
  `novelty`), so the top of the feed surfaces the most important fresh stories.
  The current frontend is unchanged and still reads the legacy `score` field.

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

### Testing (Stage 1 + Stage 2 + Stage 3 + Stage 4 + Stage 5 + Stage 6)
- Node built-in test runner, zero extra dependencies: `npm test`
  (`node --test tests/*.test.js`), **98 tests** (Stage 1 identity/empty-state +
  Stage 2 config/parser/pipeline + Stage 3 canonical schema incl. RSS/Atom/RDF,
  URL tracking, timestamps, stable ids, validation, multi-source + Stage 4
  similarity clustering / false-positive guards / source aggregation /
  determinism / ordering independence / bounds + Stage 5 persistent store /
  idempotency / day bucketing / read APIs / retention / run logs / determinism /
  malformed-data handling / empty-input + Stage 6 classification / 12-category
  taxonomy / legacy chip mapping / entity extraction / false-positive +
  prefix-subsumption guards / tags / determinism + Radar Score component
  monotonicity / weight blend / multi-source bonus / legacy 0-5 score).
- Run in CI before the snapshot is regenerated, and on every relevant code push.
- Browser-level smoke checks are run locally (jsdom harness) before pushing.
- Snapshot verification runs at build time: every generated story is validated
  against the schema and the counts are reported.

## 2. Current limitations (drivers for the roadmap)
- Similarity clustering is intentionally **conservative** (prefers false
  negatives). Deep paraphrases that share few core content tokens are left
  separate even when a human would call them the same event; a broader
  classifier/LLM could recover them in a later stage.
- History is stored in `data/db` with a **90-day retention** and grows with each
  run, but the current live frontend still reads only `data/news.json` — the
  dashboard changes to read history come in Stage 8, and cross-day search in
  Stage 9.
- Categories/entities and the Radar Score are deterministic keyword/lexicon
  heuristics (Stage 6) — not learned classifiers. They prefer false negatives
  and could be refined with an LLM later.
- No summaries, no AI interpretation layer (`ai.*` null — Stage 7).
- The browser live fallback still parses feeds with DOMParser instead of the
  Node `feed.js` path — same source config + same canonical normalizer, two XML
  parsers. It also only runs the Stage 1 exact dedupe (no similarity clustering
  in the browser — that is a Node-pipeline concern).
- High-volume feeds (OpenAI, Hugging Face) emit > 1,000 items each, so the
  snapshot can grow large between refreshes.

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
4. ~~`dedupe.js` similarity clustering -> "Reported by N sources"~~ **done** (implemented in `scripts/pipeline/dedupe.js`)
5. ~~`store.js` persistence -> per-day NDJSON + index, idempotent upserts, CI writes~~ **done** (implemented in `scripts/pipeline/store.js`, `data/db/`, 90-day retention)
6. ~~`classify.js` (12 categories) + entities + transparent `score.js` Radar Score~~ **done** (implemented in `scripts/pipeline/classify.js` + `scripts/pipeline/score.js`; 12-class subcategory, lexicons, 0-100 explainable Radar Score with stored components)
7. `summarize.js` extractive + optional LLM path
8. Dashboard rebuild (Top Stories w/ score, stats, trends, detail modal)
9. Search across history + filters (date / category / source / company / importance)
10. Company/Model/Research/Global radars + automation logging + full docs + SEO

## 4. Development & testing
- Run locally: `npm start` (serves at http://localhost:8080, plus `/api/fetch`
  proxy for live fallback debugging).
- Regenerate the snapshot: `npm run build:news`.
- Check feeds without writing files: `node scripts/pipeline/ingest.js`.
- Tests: `npm test` (98 tests).
- Push triggers the CI pipeline (tests + fresh snapshot + Pages deploy).
- Full local setup + troubleshooting: [SETUP.md](SETUP.md);
  source catalog/how-to-add: [SOURCES.md](SOURCES.md);
  canonical data model: [SCHEMA.md](SCHEMA.md).