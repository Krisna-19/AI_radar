/*
 * AI RADAR - Source configuration
 * List of RSS feeds aggregated daily by the site.
 */

const AI_SOURCES = [
  {
    id: "openai",
    name: "OpenAI",
    url: "https://openai.com/blog/rss.xml",
    type: "company",
    weight: 5,
    color: "#10a37f",
  },
  {
    id: "deepmind",
    name: "Google DeepMind",
    url: "https://deepmind.google/blog/rss.xml",
    type: "company",
    weight: 5,
    color: "#4285f4",
  },
  {
    id: "googleai",
    name: "Google AI",
    url: "https://blog.google/technology/ai/rss/",
    type: "company",
    weight: 4,
    color: "#ea4335",
  },
  {
    id: "huggingface",
    name: "Hugging Face",
    url: "https://huggingface.co/blog/feed.xml",
    type: "company",
    weight: 4,
    color: "#ffd21e",
  },
  {
    id: "googleresearch",
    name: "Google Research",
    url: "https://research.google/blog/rss/",
    type: "company",
    weight: 4,
    color: "#fbbc05",
  },
  {
    id: "arxiv",
    name: "arXiv (cs.AI)",
    url: "http://export.arxiv.org/rss/cs.AI",
    type: "research",
    weight: 3,
    color: "#b31b1b",
  },
  {
    id: "nature",
    name: "Nature Mach. Intel.",
    url: "https://www.nature.com/natmachintell.rss",
    type: "research",
    weight: 3,
    color: "#6cb4ee",
  },
  {
    id: "mit",
    name: "MIT Tech Review",
    url: "https://www.technologyreview.com/topic/artificial-intelligence/feed",
    type: "media",
    weight: 3,
    color: "#ef7b45",
  },
  {
    id: "venturebeat",
    name: "VentureBeat AI",
    url: "https://venturebeat.com/category/ai/feed/",
    type: "media",
    weight: 3,
    color: "#0ec1af",
  },
  {
    id: "verge",
    name: "The Verge AI",
    url: "https://www.theverge.com/rss/ai-artificial-intelligence/index.xml",
    type: "media",
    weight: 3,
    color: "#1b81e8",
  },
  {
    id: "wired",
    name: "WIRED AI",
    url: "https://www.wired.com/feed/tag/ai/latest/rss",
    type: "media",
    weight: 3,
    color: "#0a0a0a",
  },
  {
    id: "techcrunch",
    name: "TechCrunch AI",
    url: "https://techcrunch.com/category/artificial-intelligence/feed/",
    type: "media",
    weight: 3,
    color: "#2a9bd4",
  },
  {
    id: "googlenews",
    name: "Google News · AI",
    url: "https://news.google.com/rss/search?q=artificial%20intelligence&hl=en-US&gl=US&ceid=US:en",
    type: "media",
    weight: 2,
    color: "#4285f4",
  },
];

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

const CATEGORIES = [
  { id: "research", label: "Research & Papers", icon: "🧠" },
  { id: "product", label: "Products & Launches", icon: "🚀" },
  { id: "funding", label: "Funding & Business", icon: "💰" },
  { id: "policy", label: "Policy & Safety", icon: "⚖️" },
  { id: "news", label: "General AI News", icon: "📰" },
];

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    AI_SOURCES,
    PROXY_STRATEGIES,
    CACHE_KEY,
    CACHE_TTL_MS,
    FETCH_TIMEOUT_MS,
    SNAPSHOT_PATH,
  };
}