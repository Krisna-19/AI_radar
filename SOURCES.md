# AI RADAR — Content Sources

The **single source of truth** for every feed is [`sources/sources.json`](sources/sources.json).
It is read by:

- the Node pipeline (`scripts/pipeline/ingest.js` via `sources/index.js`) when the
  snapshot is generated, and
- the browser (`js/aggregator.js` fetches `sources/sources.json` at runtime) when
  it builds the source filter chips.

Both environments validate the same shape through the shared helpers in
`js/shared.js` (`validateSourceConfig` / `applySourceDefaults` / `normalizeItem`),
so a source added here works everywhere with **no code changes**. Each fetched
item is normalized into the canonical Story model (see [SCHEMA.md](SCHEMA.md)).

> Policy: only **public feeds (RSS / Atom)** are used. No aggressive scraping —
> if a site has no parseable feed, it is not a source.

---

## How to add a source

1. Open `sources/sources.json`.
2. Append one entry to the `sources` array:

```json
{
  "id": "examplecorp",
  "name": "Example Corp AI Blog",
  "url": "https://example.com/rss.xml",
  "category": "company",
  "enabled": true,
  "priority": 140,
  "fetchIntervalHours": 3,
  "parser": "auto",
  "reliability": 7,
  "weight": 3,
  "color": "#8b5cf6"
}
```

3. Validate + smoke-test locally:

```bash
node scripts/pipeline/ingest.js          # fetches every enabled feed, prints [OK]/[WARN]/[ERROR]
npm run build:news                       # regenerates the snapshot (aborts if config is invalid)
npm test                                  # 29/29 unit tests
```

4. Commit (the snapshot regenerates automatically on push) or open a PR in the
   public repo so reviewers can verify the feed is clean.

To **disable** a source temporarily, set `"enabled": false` — it then disappears
from the pipeline and the UI filter but stays in the config.

---

## Source schema

| Field              | Required | Type             | Constraint / default                    | Meaning |
|--------------------|----------|------------------|-----------------------------------------|---------|
| `id`               | yes      | string           | lowercase slug `[a-z0-9][a-z0-9-]*`      | Stable identifier used in story `sourceId` |
| `name`             | yes      | string           | non-empty                                | Display name (chips, story labels, footer) |
| `url`              | yes      | string           | `http(s)://` feed URL                    | The RSS/Atom endpoint |
| `category`         | yes      | string           | `company` \| `research` \| `media`       | Source type (not to be confused with story categories) |
| `enabled`          | no       | boolean          | default `true`                           | Include in pipeline + UI |
| `priority`         | no       | number (int)     | default `100`, `>= 0`                    | Sort order (lower = listed/fetched first) |
| `fetchIntervalHours` | no     | number           | default `3`, `>= 0.5`                    | How often CI refreshes (documentation; the schedule is the workflow cron) |
| `parser`           | no       | string           | `rss` \| `atom` \| `auto` (default `auto`) | Hints; the parser auto-detects RSS 1.0/2.0, RDF and Atom either way |
| `reliability`      | no       | number (0–10)    | default `5`                              | Editorial trust, feeds future Radar Score component |
| `weight`           | no       | number (1–5)     | default `3`                              | Score multiplier for this source's stories |
| `color`            | no       | hex string       | default `#666666`                        | Chip / story accent color |

Unknown or invalid fields are rejected by `validateSourceConfig` — the loader
(`sources/index.js`) reports every problem and refuses to build a snapshot until
the config is valid (`configValid === true`).

---

## Currently configured sources (13)

| Priority | id | Name | Category | URL | Parser |
|---|---|---|---|---|---|
| 10 | `openai` | OpenAI | company | `https://openai.com/blog/rss.xml` | rss |
| 20 | `deepmind` | Google DeepMind | company | `https://deepmind.google/blog/rss.xml` | auto |
| 30 | `googleai` | Google AI | company | `https://blog.google/technology/ai/rss/` | auto |
| 40 | `huggingface` | Hugging Face | company | `https://huggingface.co/blog/feed.xml` | atom |
| 50 | `googleresearch` | Google Research | company | `https://research.google/blog/rss/` | auto |
| 60 | `arxiv` | arXiv (cs.AI) | research | `http://export.arxiv.org/rss/cs.AI` | rss |
| 70 | `nature` | Nature Mach. Intel. | research | `https://www.nature.com/natmachintell.rss` | rss |
| 80 | `mit` | MIT Tech Review | media | `https://www.technologyreview.com/topic/artificial-intelligence/feed` | auto |
| 90 | `venturebeat` | VentureBeat AI | media | `https://venturebeat.com/category/ai/feed/` | auto |
| 100 | `verge` | The Verge AI | media | `https://www.theverge.com/rss/ai-artificial-intelligence/index.xml` | auto |
| 110 | `wired` | WIRED AI | media | `https://www.wired.com/feed/tag/ai/latest/rss` | auto |
| 120 | `techcrunch` | TechCrunch AI | media | `https://techcrunch.com/category/artificial-intelligence/feed/` | auto |
| 130 | `googlenews` | Google News AI | media | `https://news.google.com/rss/search?q=artificial+intelligence&hl=en-US&gl=US&ceid=US:en` | auto |

Two feeds evaluated during Stage 2 (Anthropic, MarkTechPost) were rejected because
they publish no parseable RSS.

---

## Per-source diagnostics

`ingest.js` records response time, item count and an error class per source and
prints one line per feed:

```
[OK]   OpenAI — 32 items (412ms)
[WARN] VentureBeat AI — 0 items (180ms)         # valid but empty feed
[ERROR] Some Blog — HTTP 403 (250ms)            # http / timeout / network / parse
```

That per-source data (`ok/failed/empty`, item counts, error types, response times)
is also embedded into the snapshot's `stats` + `sources` sections — useful for
spotting a silently dying feed.