/*
 * AI RADAR - shared pure helpers.
 * Loaded both in the browser (window.AIRadarCore) and in Node build scripts
 * (module.exports) so aggregation behaves identically everywhere.
 */
(function (root) {
  "use strict";

  function extractText(html) {
    if (!html) return "";
    return html
      .replace(/<\s*script[\s\S]*?<\s*\/\s*script\s*>/gi, " ")
      .replace(/<\s*style[\s\S]*?<\s*\/\s*style\s*>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"')
      .replace(/&#0?39;/gi, "'")
      .replace(/\s+/g, " ")
      .trim();
  }

  function extractFirstImage(html) {
    if (!html) return null;
    const m = html.match(/<img[^>]+src=["']([^"']+)["']/i);
    return m ? m[1] : null;
  }

  function parseDate(str) {
    if (!str) return null;
    try {
      const d = new Date(str);
      return isNaN(d.getTime()) ? null : d;
    } catch (e) {
      return null;
    }
  }

  function normalizeTitle(t) {
    return (t || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  /*
   * Stable identity helpers.
   * A story's identity is derived from its normalised title and canonical URL,
   * so the same story maps to the same key/id across runs, sources and days.
   * This is the foundation for idempotent pipeline runs (upserts) and for
   * cross-run deduplication ("Reported by N sources").
   */

  function canonicalUrlKey(url) {
    if (!url) return "";
    try {
      const u = new URL(url);
      const host = u.hostname.toLowerCase().replace(/^www\./, "");
      const segs = u.pathname
        .split("/")
        .filter(Boolean)
        .slice(0, 2)
        .map((s) => s.toLowerCase());
      return host + "/" + segs.join("/");
    } catch (e) {
      return "";
    }
  }

  function canonicalKey(title, url) {
    const t = normalizeTitle(title);
    const u = canonicalUrlKey(url);
    return (t + "|" + u).slice(0, 200);
  }

  /* djb2 hash -> 8 hex chars, compact and deterministic. */
  function hashString(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) {
      h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
    }
    return h.toString(16).padStart(8, "0");
  }

  function buildStoryId(title, url) {
    return "s" + hashString(canonicalKey(title, url));
  }

  /* Categorise using the combined title + description text. */
  function categorize(hay) {
    hay = (hay || "").toLowerCase();
    const has = (words) => words.some((w) => hay.includes(w));

    if (
      has([
        "arxiv",
        "paper",
        "research",
        "study",
        "benchmark",
        "model card",
        "preprint",
        "nature",
      ])
    )
      return "research";
    if (
      has([
        "raise",
        "raises",
        "funding",
        "funded",
        "valuation",
        "acqui",
        "investment",
        "million",
        "billion",
        "ipo",
        "series a",
        "series b",
        "series c",
        "startup",
      ])
    )
      return "funding";
    if (
      has([
        "safety",
        "regulation",
        "regulatory",
        "policy",
        "government",
        "law",
        "lawmaker",
        "ai act",
        "legislat",
        "ban",
        "transparency",
        "ethics",
      ])
    )
      return "policy";
    if (
      has([
        "launch",
        "release",
        "releases",
        "announce",
        "introduces",
        "unveils",
        "rollout",
        "upgrade",
        "chatgpt",
        "gpt-",
        "claude",
        "gemini",
        "llama",
        "microsoft",
        "google",
        "openai",
        "anthropic",
        "tool",
        "app",
      ])
    )
      return "product";
    return "news";
  }

  function computeScore(weight, date, index) {
    let recency = 0;
    if (date) {
      const hours = Math.max(0, (Date.now() - date.getTime()) / 3600000);
      recency = Math.exp(-hours / 30);
    } else {
      recency = Math.max(0, 0.2 - index * 0.02);
    }
    return recency * weight;
  }

  function dedupe(items) {
    const seen = new Set();
    const out = [];
    for (const it of items) {
      const key = canonicalKey(it.title, it.link) || normalizeTitle(it.title);
      if (!key) continue;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(it);
    }
    return out;
  }

  function isSameDay(d, ref) {
    return (
      d.getFullYear() === ref.getFullYear() &&
      d.getMonth() === ref.getMonth() &&
      d.getDate() === ref.getDate()
    );
  }

  /* ---------------- Source configuration ----------------
   * The canonical source definitions live in sources/sources.json.
   * Validation + defaults below are shared by the browser (js/aggregator.js),
   * the Node loader (sources/index.js) and the tests, so every environment
   * accepts exactly the same shape. */

  const SOURCE_CATEGORIES = ["company", "research", "media"];
  const SOURCE_PARSERS = ["rss", "atom", "auto"];
  const DEFAULT_SOURCE_SETTINGS = {
    enabled: true,
    priority: 100,
    fetchIntervalHours: 3,
    parser: "auto",
    reliability: 5,
    weight: 3,
    color: "#666666",
  };

  function validateSourceConfig(source) {
    const errors = [];
    if (!source || typeof source !== "object") {
      return { valid: false, errors: [{ field: "*", message: "missing source" }] };
    }
    if (
      typeof source.id !== "string" ||
      !/^[a-z0-9][a-z0-9-]*$/.test(source.id)
    ) {
      errors.push({ field: "id", message: "required lowercase slug (a-z, 0-9, -)" });
    }
    if (typeof source.name !== "string" || !source.name.trim()) {
      errors.push({ field: "name", message: "required non-empty string" });
    }
    if (typeof source.url !== "string" || !/^https?:\/\/\S+$/i.test(source.url)) {
      errors.push({ field: "url", message: "required http(s) feed URL" });
    }
    if (!SOURCE_CATEGORIES.includes(source.category)) {
      errors.push({
        field: "category",
        message: "must be one of " + SOURCE_CATEGORIES.join(", "),
      });
    }
    if (source.enabled != null && typeof source.enabled !== "boolean") {
      errors.push({ field: "enabled", message: "must be a boolean" });
    }
    if (
      source.priority != null &&
      (!Number.isFinite(source.priority) || source.priority < 0)
    ) {
      errors.push({ field: "priority", message: "must be a non-negative number" });
    }
    if (
      source.fetchIntervalHours != null &&
      (!Number.isFinite(source.fetchIntervalHours) ||
        source.fetchIntervalHours < 0.5)
    ) {
      errors.push({ field: "fetchIntervalHours", message: "must be >= 0.5 hours" });
    }
    if (source.parser != null && !SOURCE_PARSERS.includes(source.parser)) {
      errors.push({
        field: "parser",
        message: "must be one of " + SOURCE_PARSERS.join(", "),
      });
    }
    if (
      source.reliability != null &&
      (!Number.isFinite(source.reliability) ||
        source.reliability < 0 ||
        source.reliability > 10)
    ) {
      errors.push({ field: "reliability", message: "must be a number 0..10" });
    }
    if (
      source.weight != null &&
      (!Number.isFinite(source.weight) || source.weight < 1 || source.weight > 5)
    ) {
      errors.push({ field: "weight", message: "must be a number 1..5" });
    }
    if (source.color != null && !/^#[0-9a-fA-F]{3,8}$/.test(source.color)) {
      errors.push({ field: "color", message: "must be a hex color (#rgb/#rrggbb)" });
    }
    return { valid: errors.length === 0, errors };
  }

  /* Fill in defaults. Only call after validateSourceConfig() passed. */
  function applySourceDefaults(source) {
    return Object.assign({}, DEFAULT_SOURCE_SETTINGS, source, {
      enabled: source.enabled !== false,
      color: source.color || DEFAULT_SOURCE_SETTINGS.color,
    });
  }

  /* ---------------- Basic normalization (unified) ----------------
   * The single normalize step used by BOTH the browser pipeline (js/aggregator.js)
   * and the Node pipeline (scripts/pipeline/ingest.js). Raw parser output
   * (generic {title, link, pubDate, description, image}) becomes a fully
   * enriched story. Stable ids from Stage 1 are produced here so they are
   * guaranteed identical in every environment. */

  function enrichItem(rawItem, source, index, nowMs) {
    const date = parseDate(rawItem.pubDate);
    const title = (rawItem && rawItem.title) || "Untitled";
    const link = (rawItem && rawItem.link) || "#";
    const description = (rawItem && rawItem.description) || "";
    return {
      id: buildStoryId(title, link),
      fingerprint: canonicalKey(title, link),
      discoveredAt: new Date(nowMs == null ? Date.now() : nowMs).toISOString(),
      sourceId: source.id,
      sourceName: source.name,
      sourceType: source.category,
      sourceColor: source.color,
      sourceWeight: source.weight,
      title,
      link,
      date: date ? date.toISOString() : "",
      description,
      image: (rawItem && rawItem.image) || null,
      category: categorize(title + " " + description),
      score: computeScore(source.weight, date, index || 0),
    };
  }

  const api = {
    extractText,
    extractFirstImage,
    parseDate,
    normalizeTitle,
    canonicalUrlKey,
    canonicalKey,
    hashString,
    buildStoryId,
    categorize,
    computeScore,
    dedupe,
    isSameDay,
    sourceCategories: SOURCE_CATEGORIES,
    sourceParsers: SOURCE_PARSERS,
    defaultSourceSettings: DEFAULT_SOURCE_SETTINGS,
    validateSourceConfig,
    applySourceDefaults,
    enrichItem,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.AIRadarCore = api;
})(typeof window !== "undefined" ? window : this);