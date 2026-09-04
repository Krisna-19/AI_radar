# AI RADAR — Canonical Story Schema

The **Canonical Story** is the single, stable, versioned data model produced by
`normalizeItem()` in `js/shared.js` and consumed by every later pipeline stage
(dedupe → classify → summarize → score → store). It replaces the ad-hoc "raw
items" of Stage 1/2 with one well-defined shape that later stages can rely on.

> **Version:** `schemaVersion: "1.0"` · **Implemented in:** Stage 3
> **Normalizer:** `Core.normalizeItem(rawItem, sourceConfig, opts)`
> **Validator:** `Core.validateStory(story)` (returns `{ valid, errors }`)

---

## 1. Principles

- **Deterministic**: the same `rawItem` + `source` always yields the same `id`,
  `fingerprint` and `canonicalUrl` (djb2 hash, no randomness).
- **Complete**: required fields are always present; optional fields are always
  present with a consistent empty value (`null` for scalars, `[]` for arrays) —
  never a mix of `undefined`/`null`/`""` for the same semantic field.
- **Non-inventing**: a missing/invalid publication date stays `null` (downstream
  may fall back to `discoveredAt`); a missing title stays visible ("Untitled")
  so the story is never silently dropped.
- **Versioned**: every story carries `schemaVersion` so future migrations and
  readers can branch by it.
- **Backward compatible**: the canonical Story *also* exposes the flat legacy
  fields (`link`, `date`, `score`, `sourceId`, `sourceName`, `sourceType`,
  `sourceColor`, `sourceWeight`, `category`, `description`, `image`,
  `fingerprint`) the current frontend reads, so the existing UI, filters,
  search, date grouping and Stage 1/2 tests keep working with **no changes**.

---

## 2. Field reference

### 2.1 Required

| Field | Type | Notes |
|---|---|---|
| `schemaVersion` | string | `"1.0"` |
| `id` | string | `"s" + 8 hex` (djb2 of canonical key) |
| `fingerprint` | string | `canonicalKey(title, originalUrl)` |
| `title` | string | whitespace-normalized; `"Untitled"` fallback |
| `originalUrl` | string | as-published link (never modified) |
| `canonicalUrl` | string | tracking params stripped; `originalUrl` if unparseable |
| `source` | object | `{ id, name, type, reliability, priority, weight, color }` |
| `publishedAt` | string \| null | UTC ISO-8601, or `null` if no valid source date |
| `discoveredAt` | string | UTC ISO-8601 (when the pipeline saw it) |
| `category` | string | Stage-1 keyword category (`research/product/funding/policy/news`) |

### 2.2 Optional (always present with a consistent empty value)

| Field | Type | Empty value |
|---|---|---|
| `description` | string \| null | `null` |
| `author` | string \| null | `null` (not parsed yet) |
| `imageUrl` | string \| null | `null` |
| `content` | string \| null | `null` (full body, future) |
| `subcategory` | string \| null | Stage 6: one of the 12-class taxonomy (e.g. `model`, `funding`, `safety`) |
| `tags` | string[] | `[]` (Stage 6: matched entities + topical keywords, ≤6) |
| `companies` | string[] | `[]` (Stage 6: matched entities) |
| `people` | string[] | `[]` |
| `models` | string[] | `[]` |
| `technologies` | string[] | `[]` |
| `countries` | string[] | `[]` |
| `ai` | object | Stage 7 fills: `{ summary: null, whyItMatters: null, keyTakeaways: [], method: null }` — `summary` (string\|null, extractive 1-2 sentences), `whyItMatters` (string\|null, `null` unless LLM path), `keyTakeaways` (string[], ≤3), `method` (`"extractive"\|"llm"\|null`, provenance label) |
| `scores` | object | Stage 6: each of `impact, novelty, credibility, relevance, sourceConfidence` is a 0-100 number; `importance` kept as an alias of `impact`. |
| `radarScore` | number \| undefined | Stage 6: explainable 0-100 Radar Score (weighted blend of `scores.*`); `undefined` for stories before Stage 6 scoring |
| `relatedStoryIds` | string[] | `[]` (Stage 4: ids of every story merged into this one, canonical first) |
| `sources` | string[]/obj[] | `[]` (Stage 4: deduped `{id, name}` of every reporting outlet) |
| `reportedBy` | number \| undefined | `undefined` for a single-source story; = `sources.length` for a merged cluster |
| `createdAt` | string | = `discoveredAt` for now |
| `updatedAt` | string | = `discoveredAt` for now |

### 2.3 Legacy flat compatibility aliases

Present on every story for the current frontend (kept in sync with the nested
field it mirrors):

| Alias | Mirrors |
|---|---|
| `link` | `originalUrl` |
| `date` | `publishedAt` |
| `score` | Stage-6 Radar Score / 20 (0-5), preserving the legacy sort range |
| `chip` | Stage 6: legacy top-5 bucket the current frontend filters on (kept in sync with `category`) |
| `sourceId` | `source.id` |
| `sourceName` | `source.name` |
| `sourceType` | `source.type` |
| `sourceColor` | `source.color` |
| `sourceWeight` | `source.weight` |
| `category` | (already top-level) |
| `description` | (already top-level) |
| `image` | `imageUrl` |
| `fingerprint` | (already top-level) |

---

## 3. Example

```json
{
  "schemaVersion": "1.0",
  "id": "s99ed4c93",
  "fingerprint": "introducing agentic video understanding with gemini|deepmind.google/blog/introducing-agentic-video-in-gemini",
  "title": "Introducing agentic video understanding with Gemini",
  "description": null,
  "originalUrl": "https://deepmind.google/blog/introducing-agentic-video-in-gemini/",
  "canonicalUrl": "https://deepmind.google/blog/introducing-agentic-video-in-gemini/",
  "source": {
    "id": "deepmind", "name": "Google DeepMind", "type": "company",
    "reliability": 9, "priority": 20, "weight": 5, "color": "#4285f4"
  },
  "publishedAt": "2026-09-01T17:08:51.000Z",
  "discoveredAt": "2026-09-02T07:31:32.089Z",
  "author": null,
  "imageUrl": null,
  "category": "product",
  "subcategory": null,
  "tags": [], "companies": [], "people": [], "models": [],
  "technologies": [], "countries": [],
  "content": null,
  "ai": { "summary": null, "whyItMatters": null, "keyTakeaways": [], "method": null },
  "scores": {
    "importance": null, "impact": null, "novelty": null,
    "credibility": null, "relevance": null, "sourceConfidence": null
  },
  "relatedStoryIds": [], "sources": [],
  "createdAt": "2026-09-02T07:31:32.089Z",
  "updatedAt": "2026-09-02T07:31:32.089Z"
}
```

---

## 4. Normalization rules

- **Title** — collapse whitespace, trim; empty → `"Untitled"`.
- **Description / author / image / content** — collapse whitespace, trim;
  empty → `null`.
- **URLs** — `originalUrl` = untouched link; `canonicalUrl` =
  `canonicalizeUrl()`: host lowercased, tracking params removed, URL
  re-serialized deterministically. Unparseable → `null` from `canonicalizeUrl`,
  normalized story keeps `originalUrl` as-is.
- **Tracking params removed** (case-insensitive): every `utm_*` plus
  `fbclid, gclid, msclkid, yclid, dclid, gbraid, wbraid, mc_cid, mc_eid,
  igshid, vero_id, _hsenc, _hsmi, ref_src, ref_url, campaign, ocid`.
  Genuine identifying params (`?id=`, `?p=`, Google News params, …) are kept.
- **Timestamps** — anything `Date` can parse (RSS `pubDate`, Atom
  `updated`/`published`, RDF `dc:date`) → UTC ISO-8601; unusable → `null`.
  No dates are invented.
- **Arrays** — always `[]` unless provided as an actual array (`normalizeArray`).
- **Identity** — `fingerprint = canonicalKey(title, originalUrl)`,
  `id = "s" + djb2(fingerprint)`. Unchanged from Stage 1.

---

## 5. Validation rules (`validateStory`)

Returns `{ valid: boolean, errors: [{ field, message }] }`. A story is invalid
if any of the following hold:

- `schemaVersion` ≠ `"1.0"`
- `id` not `s` + 8 hex
- empty `fingerprint` or `title`
- neither `originalUrl` nor `canonicalUrl` present
- `originalUrl`/`canonicalUrl` present but not `http(s)://`
- `source` missing, or `source.id`/`source.name` missing
- `publishedAt` provided but not a valid date
- `discoveredAt` missing/invalid
- any of `tags/companies/people/models/technologies/countries/relatedStoryIds/sources`
  present but not an array
- `scores` / `ai` present but not objects

The pipeline **never silently discards** a story: `build-news.js` logs
`[WARN] rejecting story <id>…` with the field errors and records the count in
the snapshot under `stats.rejectedValidated`.

---

## 6. Schema versioning & migrations

- `SCHEMA_VERSION` (`"1.0"`) is the single constant in `js/shared.js`.
- Every story is stamped with `schemaVersion`, and writers are gated by
  `validateStory()` so a mis-versioned story can't enter the snapshot.
- **Migration policy**: bump `SCHEMA_VERSION` only for breaking shape changes.
  Non-breaking additions (e.g. Stage 4 `relatedStoryIds`/`sources`, Stage 6
  `scores`/entities, Stage 7 `ai`) are additive: readers use `schemaVersion` plus
  `documentedField in story` checks. For a breaking change, keep the old writer
  reading `"1.0"` while new runs emit the new version, and add a reader branch
  keyed on `schemaVersion`. Snapshot consumers (stage N+1) must always tolerate
  older versions until the migration window closes.
- Do **not** reuse a version number for a different shape.

---

## 7. Where the schema is enforced

- **Normalizer**: `normalizeItem()` in `js/shared.js` (browser + Node share it).
- **Compatibility wrapper**: `enrichItem()` delegates to `normalizeItem()` so
  Stage 2 code/tests and the browser aggregator keep their call shape.
- **Pipeline**: `scripts/pipeline/ingest.js` parses feeds and normalizes via
  `normalizeItem`; `scripts/build-news.js` validates every story, logs
  rejections, dedupes, **classifies (Stage 6: `classify.js` sets `subcategory`,
  entities, `tags` and refines `category` to a legacy top-5 id) and scores
  (Stage 6: `score.js` fills `scores.*` and `radarScore`)**, **summarizes
  (Stage 7: `summarize.js` fills `ai.summary`/`whyItMatters`/`keyTakeaways` +
  `ai.method`, extractive by default, optional labeled LLM path)**, then writes
  `data/news.json` and persists a copy of each staged story via
  `scripts/pipeline/store.js` into `data/db/` (per-day NDJSON + `index.json`,
  idempotent upsert by `id`, 90-day retention). The store keeps
  `createdAt`/`updatedAt` as wall-clock metadata; `id` is the stable primary key.
- **Tests**: `tests/schema.test.js` (Stage 3) + `tests/store.test.js` (Stage 5)
  + `tests/classify.test.js` & `tests/score.test.js` (Stage 6) +
  `tests/summarize.test.js` (Stage 7) + existing Stage 1/2/4 suites.
