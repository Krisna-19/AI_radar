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
      const key = normalizeTitle(it.title);
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

  const api = {
    extractText,
    extractFirstImage,
    parseDate,
    normalizeTitle,
    categorize,
    computeScore,
    dedupe,
    isSameDay,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.AIRadarCore = api;
})(typeof window !== "undefined" ? window : this);