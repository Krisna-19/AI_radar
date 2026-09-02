/*
 * AI RADAR - Runtime configuration.
 *
 * The canonical list of news sources lives in sources/sources.json (see
 * sources/index.js for loading + validation in Node). Browser code fetches
 * that same file at runtime, so every environment shares ONE source
 * definition instead of scattered copies.
 */

/*
 * Ordered list of fetch strategies. Each one must be CORS-friendly
 * when the page is opened without a local backend.
 * The local backend (server.js) proxies and is tried first.
 */
const PROXY_STRATEGIES = [
  { name: "local", build: (u) => "/api/fetch?url=" + encodeURIComponent(u) },
  {
    name: "rss2json",
    build: (u) => "https://api.rss2json.com/v1/api.json?rss_url=" + encodeURIComponent(u),
  },
  {
    name: "allorigins",
    build: (u) => "https://api.allorigins.win/raw?url=" + encodeURIComponent(u),
  },
  {
    name: "codetabs",
    build: (u) => "https://api.codetabs.com/v1/proxy?quest=" + encodeURIComponent(u),
  },
];

const CACHE_KEY = "airadar_cache_v1";
const CACHE_TTL_MS = 15 * 60 * 1000; // reuse cache for 15 minutes
const FETCH_TIMEOUT_MS = 8000;

/* Relative path of the pre-aggregated snapshot produced by scripts/build-news.js. */
const SNAPSHOT_PATH = "data/news.json";

/* Relative path of the canonical source configuration (fetched by the browser). */
const SOURCES_PATH = "sources/sources.json";

const CATEGORIES = [
  { id: "research", label: "Research & Papers", icon: "🧠" },
  { id: "product", label: "Products & Launches", icon: "🚀" },
  { id: "funding", label: "Funding & Business", icon: "💰" },
  { id: "policy", label: "Policy & Safety", icon: "⚖️" },
  { id: "news", label: "General AI News", icon: "📰" },
];

if (typeof module !== "undefined" && module.exports) {
  // Node: load the canonical source list (validated) for the snapshot pipeline.
  const sources = require("../sources/index.js");
  module.exports = {
    AI_SOURCES: sources.enabledSources,
    SOURCES: sources,
    SOURCES_PATH,
    PROXY_STRATEGIES,
    CACHE_KEY,
    CACHE_TTL_MS,
    FETCH_TIMEOUT_MS,
    SNAPSHOT_PATH,
  };
}