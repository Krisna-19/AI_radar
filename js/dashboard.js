/*
 * AI RADAR - Dashboard enhancements (Stage 8)
 * Progressive-enhancement layer that adds richer signals WITHOUT changing the
 * classic app.js card markup or any Stage 1-7 contract. It exposes a single
 * hook (cardEnhancement) that app.js calls while rendering each card, plus an
 * optional attach() for the "top signal" hero and entity-chip search wiring.
 *
 * Adds:
 *   - radar score donut per card (radarScore 0..100) with a text label (a11y)
 *   - AI summary reveal (ai.summary / whyItMatters / keyTakeaways), falling
 *     back to description only when no summary exists - never fabricated
 *   - entity + tag chips (companies/people/models/technologies/tags)
 *   - "top signal" hero honoring the highest-radarScore story
 *
 * RELIABILITY: must never take the page down. cardEnhancement returns a plain
 * HTML string (app.js injects it only if non-empty); every DOM helper no-ops
 * gracefully. If this file fails to load, app.js renders the classic feed
 * unchanged.
 *
 * Dual-load: pure helpers also exported as CommonJS so Node tests can unit-test
 * them without a DOM (same pattern as shared.js).
 */
(function (root) {
  "use strict";

  /* Shared pure helpers for identity/dedup. Browser: window.AIRadarCore;
   * Node tests: ../js/shared.js. Loaded before this dashboard layer. */
  const Core =
    (typeof window !== "undefined" && window.AIRadarCore) ||
    (typeof require !== "undefined" && require("./shared.js")) ||
    null;

  /* ---------------- Pure helpers (DOM-free, unit-testable) ---------------- */

  /* Map radarScore (0..100) to band + hex color + *text label* so the signal is
   * never color-only (a11y). Missing/non-finite -> neutral "Unknown". */
  function radarBand(score) {
    if (typeof score !== "number" || Number.isNaN(score)) {
      return { band: "unknown", color: "#8b96a9", label: "Unknown" };
    }
    const s = score < 0 ? 0 : score > 100 ? 100 : score;
    if (s >= 70) return { band: "high", color: "#22d3a5", label: "High" };
    if (s >= 40) return { band: "medium", color: "#f59e0b", label: "Medium" };
    return { band: "low", color: "#8b96a9", label: "Low" };
  }

  /* Round 0..100 score to integer percent; null-safe. */
  function radarPct(score) {
    if (typeof score !== "number" || Number.isNaN(score)) return null;
    const s = score < 0 ? 0 : score > 100 ? 100 : score;
    return Math.round(s);
  }

  /* Deterministic SVG donut arc path `d` for a percent value (start at 12
   * o'clock). "" for 0; two arcs for a full circle. */
  function arcPath(pct, cx, cy, r) {
    const p = typeof pct === "number" && !Number.isNaN(pct)
      ? (pct < 0 ? 0 : pct > 100 ? 100 : pct)
      : 0;
    const frac = p / 100;
    const a1 = Math.PI * 1.5;
    const x1 = cx + r * Math.cos(a1);
    const y1 = cy + r * Math.sin(a1);
    if (p <= 0) return "";
    if (frac >= 1) {
      const x3 = cx + r * Math.cos(a1 + Math.PI);
      const y3 = cy + r * Math.sin(a1 + Math.PI);
      return (
        "M " + x1 + " " + y1 +
        " A " + r + " " + r + " 0 1 1 " + x3 + " " + y3 +
        " A " + r + " " + r + " 0 1 1 " + x1 + " " + y1
      );
    }
    const a2 = a1 + 2 * Math.PI * frac;
    const x2 = cx + r * Math.cos(a2);
    const y2 = cy + r * Math.sin(a2);
    const large = frac > 0.5 ? 1 : 0;
    return (
      "M " + x1 + " " + y1 +
      " A " + r + " " + r + " 0 " + large + " 1 " + x2 + " " + y2
    );
  }

  /* Deterministic Levenshtein (edit) distance between two strings. Used only to
   * decide whether a summary is a near-copy of its headline; NEVER used for
   * story identity/dedup (that stays URL/canonical-key based). */
  function levenshtein(a, b) {
    a = a == null ? "" : String(a);
    b = b == null ? "" : String(b);
    const m = a.length;
    const n = b.length;
    if (m === 0) return n;
    if (n === 0) return m;
    let prev = new Array(n + 1);
    let cur = new Array(n + 1);
    for (let j = 0; j <= n; j++) prev[j] = j;
    for (let i = 1; i <= m; i++) {
      cur[0] = i;
      for (let j = 1; j <= n; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      }
      const tmp = prev;
      prev = cur;
      cur = tmp;
    }
    return prev[n];
  }

  /* Similarity ratio in 0..1 (1 - dist/maxLen), matching the classic
   * Levenshtein ratio. Deterministic. */
  function levenshteinRatio(a, b) {
    a = a == null ? "" : String(a);
    b = b == null ? "" : String(b);
    const denom = Math.max(a.length, b.length);
    if (denom === 0) return 1;
    return 1 - levenshtein(a, b) / denom;
  }

  const REDUNDANT_SUMMARY_THRESHOLD = 0.85;

  /* A summary is "useful" only if it is a genuinely distinct sentence, not a
   * near-verbatim copy of the headline. Case-insensitive Levenshtein ratio
   * above 0.85 is treated as a redundant echo of the title. This is purely a
   * display decision and never feeds story identity/dedup. */
  function isRedundantSummary(summary, title) {
    const s = summary == null ? "" : String(summary).trim();
    const t = title == null ? "" : String(title).trim();
    if (!s) return true;
    if (!t) return false;
    if (s.toLowerCase() === t.toLowerCase()) return true;
    return levenshteinRatio(s.toLowerCase(), t.toLowerCase()) > REDUNDANT_SUMMARY_THRESHOLD;
  }

  /* Text to surface as the "AI summary". Prefers a real ai.summary; falls back
   * to description when that summary is absent (never fabricated). A candidate
   * that is missing, empty, invalid, or a near-copy of the title is treated as
   * unavailable and returns null so the card omits the summary block (no empty
   * whitespace). */
  function summaryText(item) {
    if (!item) return null;
    const ai = item.ai && typeof item.ai === "object" ? item.ai : null;
    let cand = null;
    if (ai && typeof ai.summary === "string" && ai.summary.trim()) {
      cand = ai.summary.trim();
    } else if (typeof item.description === "string" && item.description.trim()) {
      cand = item.description.trim();
    }
    if (!cand) return null;
    if (isRedundantSummary(cand, item.title)) return null;
    return cand;
  }

  function summaryMethod(item) {
    const ai = item && item.ai && typeof item.ai === "object" ? item.ai : null;
    return ai && typeof ai.method === "string" ? ai.method : null;
  }

  /* Collect de-duplicated entity + tag tokens in stable order: companies,
   * people, models, technologies, then tags. */
  function collectChips(item) {
    const chips = [];
    const seen = new Set();
    if (!item) return chips;
    const groups = ["companies", "people", "models", "technologies"];
    for (const g of groups) {
      const arr = Array.isArray(item[g]) ? item[g] : [];
      for (const v of arr) {
        const t = String(v).trim();
        if (t && !seen.has(t)) {
          seen.add(t);
          chips.push(t);
        }
      }
    }
    const tags = Array.isArray(item.tags) ? item.tags : [];
    for (const v of tags) {
      const t = String(v).trim();
      if (t && !seen.has(t)) {
        seen.add(t);
        chips.push(t);
      }
    }
    return chips;
  }

  /* Group items by `subcategory`. Real labels first (desc count, ties by first
   * appearance), the "other" catch-all last. Returns [{label,items,count}]. */
  function groupBySubcategory(items) {
    const order = [];
    const map = Object.create(null);
    for (const it of items || []) {
      const label = it && it.subcategory ? String(it.subcategory) : "other";
      if (!map[label]) {
        map[label] = { label, items: [] };
        order.push(label);
      }
      map[label].items.push(it);
    }
    const groups = order
      .filter((l) => l !== "other")
      .map((l) => map[l])
      .sort(
        (a, b) =>
          b.items.length - a.items.length ||
          order.indexOf(a.label) - order.indexOf(b.label)
      );
    if (map["other"] && map["other"].items.length) groups.push(map["other"]);
    return groups.map((g) => ({ label: g.label, items: g.items, count: g.items.length }));
  }

  /* Virtual/paginated window over a full list. Pure + deterministic. */
  function windowSlice(items, page, pageSize) {
    page = Math.max(1, Math.floor(page) || 1);
    pageSize = Math.max(1, Math.floor(pageSize) || 40);
    const total = (items || []).length;
    const pages = Math.max(1, Math.ceil(total / pageSize));
    const p = Math.min(page, pages);
    const start = (p - 1) * pageSize;
    const slice = (items || []).slice(start, start + pageSize);
    return {
      page: p,
      pageSize,
      slice,
      total,
      pages,
      hasMore: p < pages,
      hasPrev: p > 1,
    };
  }

  /* Top signal story: highest radarScore, ties broken by newest publishedAt. */
  function topSignal(items) {
    if (!items || !items.length) return null;
    let best = null;
    for (const it of items) {
      if (!best) {
        best = it;
        continue;
      }
      const a = typeof it.radarScore === "number" ? it.radarScore : -1;
      const b = typeof best.radarScore === "number" ? best.radarScore : -1;
      const aT = it.publishedAt ? +new Date(it.publishedAt) : 0;
      const bT = best.publishedAt ? +new Date(best.publishedAt) : 0;
      if (a > b || (a === b && aT > bT)) best = it;
    }
    return best;
  }

  /* Deterministic article identity used for dashboard dedup. The normalized
   * article URL is the primary key when the item carries a real URL; otherwise
   * it falls back to the existing canonical identity signature (title + url
   * bucket), which mirrors Core.buildStoryId/clean identity. Never fuzzy: two
   * stories collapse only when they share the exact same URL or the exact same
   * canonical identity key. Distinct real articles (different URLs, even with
   * similar titles) are always preserved. */
  function articleIdentity(item) {
    if (!item) return null;
    const url = (item && (item.canonicalUrl || item.originalUrl || item.link)) || "";
    const norm = Core && Core.canonicalizeUrl ? Core.canonicalizeUrl(url) : null;
    if (norm) return "url:" + norm;
    return (
      "key:" +
      (item.fingerprint ||
        (Core && Core.canonicalKey ? Core.canonicalKey(item.title, url) : ""))
    );
  }

  /* Partition today's stories into mutually exclusive headline sections using
   * a single radarScore (desc) / publishedAt (desc) ranking consistent with
   * topSignal, deduplicated by deterministic articleIdentity:
   *   - topSignal  : the single highest-scoring distinct story
   *   - topStories : the next 3 highest-scoring distinct stories (never the
   *                  top signal, never each other)
   *   - feed       : every remaining distinct story (excludes everything shown
   *                  in topSignal and topStories, and any same-identity copy)
   * Returns { topSignal:[story], topStories:[3], feed:[...] }. Deterministic. */
  function partitionHighlights(items) {
    const empty = { topSignal: [], topStories: [], feed: [] };
    if (!items || !items.length) return empty;
    const sorted = items
      .slice()
      .sort((a, b) => {
        const aS = typeof a.radarScore === "number" ? a.radarScore : -1;
        const bS = typeof b.radarScore === "number" ? b.radarScore : -1;
        if (aS !== bS) return bS - aS;
        const aT = a.publishedAt ? +new Date(a.publishedAt) : 0;
        const bT = b.publishedAt ? +new Date(b.publishedAt) : 0;
        return bT - aT;
      });
    const seen = new Set();
    const topSignal = [];
    const topStories = [];
    const feed = [];
    for (const it of sorted) {
      const id = articleIdentity(it);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      if (!topSignal.length) topSignal.push(it);
      else if (topStories.length < 3) topStories.push(it);
      else feed.push(it);
    }
    return { topSignal, topStories, feed };
  }

  /* Deterministic visual decision for a story card (Item 3):
   *   - category  : the category id used for the accent/class
   *   - thumbUrl  : the existing archive og:image URL when present, else ""
   *   - hasThumb  : true only when a usable image URL already exists in the data
   * Never scrapes/fetches; relies solely on the supplied story fields. */
  function cardVisual(item) {
    const category = item && item.category ? String(item.category) : "news";
    const raw = item && item.image;
    const thumbUrl =
      typeof raw === "string" && raw.trim() ? raw.trim() : "";
    return {
      category,
      thumbUrl,
      hasThumb: Boolean(thumbUrl),
    };
  }

  /* Score badge + tooltip markup (Item 4). Pure: takes an escape function so it
   * is testable in Node and reused by the browser cardEnhancement. Returns ""
   * when there is no numeric score. The badge itself is unchanged; only its
   * wrapper gains the CSS hover/focus tooltip + accessible description. */
  const SCORE_TOOLTIP_TEXT =
    "Signal Score: weighted by recency, source authority, and topic relevance.";
  function scoreBadgeHtml(item, esc) {
    const pct = radarPct(item && item.radarScore);
    if (pct == null || typeof esc !== "function") return "";
    const band = radarBand(item.radarScore);
    const r = 15;
    const tipId = "dash-score-tip-" + (item && item.id ? String(item.id) : "sig");
    return (
      '<div class="score-tip" data-tooltip="' + esc(SCORE_TOOLTIP_TEXT) + '">' +
      '<svg class="radar" tabindex="0" width="40" height="40" viewBox="0 0 40 40" ' +
      'role="img" aria-label="' + esc(band.label + " signal " + pct + "%") +
      '" aria-describedby="' + esc(tipId) + '">' +
      '<circle class="radar-track" cx="20" cy="18" r="' + r + '" fill="none"/>' +
      '<path class="radar-val" style="stroke:' + band.color + '" fill="none" ' +
      'stroke-width="4" stroke-linecap="round" d="' + arcPath(pct, 20, 18, r) + '"/>' +
      '<text class="radar-num" x="20" y="18" text-anchor="middle" dy=".36em" ' +
      'style="fill:' + band.color + '">' + pct + "</text>" +
      "</svg>" +
      '<span class="score-tip-bubble" id="' + esc(tipId) + '" role="tooltip">' +
      esc(SCORE_TOOLTIP_TEXT) +
      "</span>" +
      "</div>"
    );
  }

  /* ---------------- Public API (Node tests + browser) ---------------- */

  const api = {
    radarBand,
    radarPct,
    arcPath,
    summaryText,
    summaryMethod,
    levenshtein,
    levenshteinRatio,
    isRedundantSummary,
    REDUNDANT_SUMMARY_THRESHOLD,
    collectChips,
    groupBySubcategory,
    windowSlice,
    topSignal,
    articleIdentity,
    partitionHighlights,
    cardVisual,
    scoreBadgeHtml,
    SCORE_TOOLTIP_TEXT,
  };

  /* ---------------- Browser-only card enhancement string ---------------- */

  if (typeof window !== "undefined" && typeof document !== "undefined") {
    function escapeHtml(s) {
      return (s == null ? "" : String(s))
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
    }

    /* Return the extra HTML injected into a .card-body by app.js. Empty string
     * when there is nothing to show, so the classic card stays unchanged. */
    api.cardEnhancement = function (item) {
      if (!item) return "";
      let html = "";
      const pct = radarPct(item.radarScore);
      if (pct != null) {
        html +=
          '<div class="dash-radar-row">' +
          scoreBadgeHtml(item, escapeHtml) +
          "</div>";
      }

      const txt = summaryText(item);
      if (txt) {
        html +=
          '<details class="ai-summary"><summary><span class="ai-badge">AI</span> Summary</summary>' +
          "<p>" + escapeHtml(txt) + "</p></details>";
      }

      const chips = collectChips(item);
      if (chips.length) {
        html += '<div class="chip-row">' + chips
          .slice(0, 6)
          .map(
            (c) =>
              '<button type="button" class="entity-chip" data-token="' +
              escapeHtml(c) +
              '">' +
              escapeHtml(c) +
              "</button>"
          )
          .join("") + "</div>";
      }
      return html;
    };

    /* Optional: render a "top signal" hero into #top-signal (highest radar). */
    api.renderTopSignal = function (items) {
      const host = document.getElementById("top-signal");
      if (!host) return;
      const sig = topSignal(items);
      if (!sig) {
        host.style.display = "none";
        host.innerHTML = "";
        return;
      }
      const band = radarBand(sig.radarScore);
      const pct = radarPct(sig.radarScore);
      host.style.display = "block";
      host.innerHTML =
        '<div class="signal-card">' +
        '<span class="signal-tag" style="color:' + band.color + '">📡 Top signal · ' +
        escapeHtml(band.label + " " + pct + "%") +
        "</span>" +
        '<span class="signal-link" data-story-id="' +
        escapeHtml(sig.id || "") +
        '" tabindex="0" role="button" aria-label="Read story inside AI Radar">' +
        escapeHtml(sig.title || "") +
        "</span>" +
        "</div>";
    };

    /* Wire delegated clicks on entity chips that live anywhere in #news-grid.
     * Stage 12: if the token resolves to an entity in the radar index, hop to
     * its #/radar/<group>/<slug> page; otherwise fall back to search. */
    api.attach = function () {
      const grid = document.getElementById("news-grid");
      if (!grid) return;
      grid.addEventListener("click", (e) => {
        const btn = e.target.closest(".entity-chip");
        if (!btn) return;
        const token = btn.dataset.token;
        if (!token) return;
        const Radar = window.AIRadarRadar;
        if (Radar && typeof Radar.groupOfToken === "function") {
          const records =
            (window.AIRadarRadar.getIndex && window.AIRadarRadar.getIndex()) ||
            (window.AIRadarHooks.getState && window.AIRadarHooks.getState().items) ||
            [];
          const group = Radar.groupOfToken(records, token);
          if (group) {
            const url = Radar.radarUrl(group, token);
            if (location.hash !== url) location.hash = url;
            return;
          }
        }
        if (window.AIRadarHooks && typeof window.AIRadarHooks.setSearch === "function") {
          window.AIRadarHooks.setSearch(token);
        }
      });
    };
  }

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.AIRadarDashboard = api;
})(typeof window !== "undefined" ? window : this);
