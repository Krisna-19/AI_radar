# 📡 AI RADAR

> **Your daily AI intelligence** — research, products, funding and policy aggregated from leading labs, journals and newsrooms, refreshed automatically throughout the day.

**Live site:** https://krisna-19.github.io/AI_radar/

---

## 1. What it is

AI RADAR is a **self-hosted daily AI-news aggregator**. Every few hours it fetches updates from 13 AI-focused RSS sources from a single canonical config file, dedupes and classifies them, then serves them as a polished, mobile-friendly feed — sorted so the freshest, most important stories surface at the top each day.

## 2. Features

| Feature | Details |
|---|---|
| **Daily digest** | "Top stories today" — top 3 ranked by recency × source weight |
| **Date ranges** | Tabs for *Today*, *Yesterday*, *This week* |
| **Categories** | Research 🧠 · Products 🚀 · Funding 💰 · Policy ⚖️ · News 📰 (auto-classified) |
| **Source filters** | Toggle any of the 13 sources on/off |
| **Search** | Live keyword search across titles & descriptions |
| **Auto refresh** | GitHub Actions re-aggregates every **3 hours** |
| **Resilience** | Falls back to live proxies, then sample content, if the snapshot is absent |
| **Zero config** | Pure HTML/CSS/JS — no build step, no API keys, no tracking |

## 3. Content sources (13)

| Category | Sources |
|---|---|
| Labs / companies | OpenAI, Google DeepMind, Google AI, Google Research, Hugging Face |
| Research | arXiv (cs.AI), Nature Machine Intelligence |
| Media / newsrooms | MIT Tech Review, VentureBeat AI, The Verge AI, WIRED AI, TechCrunch AI, Google News · AI |

The source list is **one file**: `sources/sources.json`. Add/disable/retune a feed
there and it takes effect in both the pipeline and the UI. See
[`SOURCES.md`](SOURCES.md) for the schema and how to add a source.

Two sources originally evaluated (Anthropic, MarkTechPost) were swapped during testing because they don't publish parseable RSS.

## 4. Tech stack & architecture

- **Frontend:** Vanilla HTML/CSS/JS (no frameworks, no build step)
- **Backend / API:** Zero-dependency Node `server.js` (static file server + RSS proxy)
- **Aggregation:** Node pipeline (`scripts/pipeline/`) using `fast-xml-parser`; browser-side fallback for local runs
- **Hosting & automation:** GitHub Pages + GitHub Actions (both free)

Data pipeline:

```
sources/sources.json  (canonical config — 13 feeds)
   │  (GitHub Actions: every 3h / on code push; runs npm test first)
   ▼
scripts/build-news.js ──┴─> scripts/pipeline/ingest.js  (fetch + parse RSS/Atom/RDF)
                          └─> shared js/shared.js        (enrich → stable IDs → dedupe → score)
   │
   ▼
data/news.json  (committed to repo; embeds per-source stats)
   │  (static file, same origin — no CORS, no proxies)
   ▼
Browser (js/aggregator.js)  ── reads snapshot + sources/sources.json → js/app.js renders
```

Shared pure logic lives in `js/shared.js`, used identically by the browser and the
Node pipeline (identical stories, identical IDs). Architecture details:
[`ARCHITECTURE.md`](ARCHITECTURE.md).

## 5. Project structure

```
AI_radar/
├── index.html                # Single-page layout
├── css/style.css             # Dark "radar" theme
├── js/
│   ├── config.js             # Fetch strategies + paths (Node loads sources)
│   ├── shared.js             # Pure helpers (browser + Node, single normalize step)
│   ├── aggregator.js         # Snapshot / cache / live aggregation
│   └── app.js                # Rendering, filters, search, clock
├── sources/
│   ├── sources.json          # Canonical source config (only place to add feeds)
│   └── index.js              # Sources loader + validation (Node)
├── scripts/
│   ├── build-news.js         # Snapshot builder (used by CI)
│   └── pipeline/
│       ├── env.js            # Minimal .env loader (zero-dep)
│       ├── http.js           # Classified timeout/http/network/empty fetch
│       ├── feed.js           # RSS 2.0 / Atom / RSS 1.0-RDF parser
│       └── ingest.js         # Unified ingestion (dry-run CLI too)
├── data/news.json            # Committed snapshot (auto-refreshed)
├── server.js                 # Local static server + RSS proxy (zero-dep)
├── package.json
├── .env.example              # Local env template (copy to .env)
└── .github/workflows/news.yml# 3-hourly snapshot refresh
```

Docs: [`ARCHITECTURE.md`](ARCHITECTURE.md) · [`SOURCES.md`](SOURCES.md) · [`SETUP.md`](SETUP.md)

## 6. Local development

```bash
npm install        # only needed for the snapshot builder
npm start          # serves the site at http://localhost:8080
npm run build:news # manually regenerate data/news.json from the 13 feeds
node scripts/pipeline/ingest.js   # dry-run: check every feed, no file writes
npm test           # 29 unit tests (config validation, parsers, identity keys)
```

See [`SETUP.md`](SETUP.md) for the full guide (env vars, tests, troubleshooting).
Without `npm install`, the site still runs: the frontend falls back to free CORS proxies and finally embedded sample content.

## 7. Deployment — where & how

### Current deployment: **GitHub Pages** (free)

- **Repo:** `Krisna-19/AI_radar` (public) — https://github.com/Krisna-19/AI_radar
- **URL:** https://krisna-19.github.io/AI_radar/
- **Pipeline:** GitHub Actions (`.github/workflows/news.yml`)
  - Schedule: `0 */3 * * *` (every 3 hours) + manual `workflow_dispatch`
  - Job: `npm ci` → `npm test` → `node scripts/build-news.js` → commit `data/news.json` → push → Pages redeploys (~1 min)

Every push to `main` also rebuilds Pages, so code changes propagate automatically.

### Why GitHub Pages?
- 100% free, no credit card, no ads/tracking
- Straight from the repo you already own
- Static HTTPS with no server to maintain
- The snapshot commits keep the feed updated even though Pages is static

## 8. Custom domain options (free) — since you don't own a domain yet

You currently get a free subdomain-style URL already: `krisna-19.github.io`. If you want a branded name, these are **free** ways to get one and point it at this site:

| Option | Example | What's needed |
|---|---|---|
| **GitHub Pages custom domain** (recommended start) | keep `krisna-19.github.io/AI_radar/` | nothing — already live |
| **is-a.dev** (free subdomain, popular) | `airadar.krisna.is-a.dev` | GitHub account; add a repo in `is-a-dev/register`; point DNS `CNAME` at `krisna-19.github.io` |
| **eu.org** (free real domain) | `airadar.eu.org` | Free DNS registration, then CNAME to GitHub Pages |
| **js.org** (free, for JS projects) | `airadar.js.org` | Open-source repo (yours qualifies); request via their repo |
| **Netlify / Vercel** (free hosting + domain) | `airadar.netlify.app` / `airadar.vercel.app` | One-click deploy of the folder; gives a shorter branded *.app URL |

To use any of these: create the account/registration, then in the GitHub repo go to **Settings → Pages → Custom domain** and enter it (GitHub Pages auto-provisions the TLS certificate).

> The site is already deployable anywhere static hosting works (Netlify Drop, Vercel, Cloudflare Pages, S3…) — just upload the folder (or keep the snapshot workflow in CI).

## 9. Troubleshooting / notes

- **Empty feed on a fresh deploy?** The first snapshot commits with `data/news.json`; if it's missing, the page auto-falls back to live CORS proxies and then to sample content.
- **Missing images/descriptions:** some feeds (e.g. Hugging Face, OpenAI) publish title-only entries; the UI hides empty descriptions and uses gradient placeholders.
- **Reliability design:** batching + retries prevent feed throttling; a 15-min `localStorage` cache avoids re-fetching on every local visit.

## 10. License

MIT — fork it, deploy it, share it.