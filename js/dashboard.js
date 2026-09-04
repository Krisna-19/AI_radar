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

  /* Text to surface as the "AI summary". Prefers a real ai.summary; falls back
   * to description; returns null only when neither exists. Never substitutes
   * the title as a fake summary. */
  function summaryText(item) {
    if (!item) return null;
    const ai = item.ai && typeof item.ai === "object" ? item.ai : null;
    if (ai && typeof ai.summary === "string" && ai.summary.trim()) {
      return ai.summary.trim();
    }
    if (typeof item.description === "string" && item.description.trim()) {
      return item.description.trim();
    }
    return null;
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

  /* ---------------- Public API (Node tests + browser) ---------------- */

  const api = {
    radarBand,
    radarPct,
    arcPath,
    summaryText,
    summaryMethod,
    collectChips,
    groupBySubcategory,
    windowSlice,
    topSignal,
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
        const band = radarBand(item.radarScore);
        const r = 15;
        html +=
          '<div class="dash-radar-row">' +
          '<svg class="radar" width="40" height="40" viewBox="0 0 40 40" role="img" aria-label="' +
          escapeHtml(band.label + " signal " + pct + "%") +
          '">' +
          '<circle class="radar-track" cx="20" cy="18" r="' + r + '" fill="none"/>' +
          '<path class="radar-val" style="stroke:' + band.color + '" fill="none" ' +
          'stroke-width="4" stroke-linecap="round" d="' + arcPath(pct, 20, 18, r) + '"/>' +
          '<text class="radar-num" x="20" y="18" text-anchor="middle" dy=".36em" ' +
          'style="fill:' + band.color + '">' + pct + "</text>" +
          "</svg>" +
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
        '<a class="signal-link" href="' +
        escapeHtml(sig.link && sig.link !== "#" ? sig.link : "#") +
        '" target="_blank" rel="noopener noreferrer">' +
        escapeHtml(sig.title || "") +
        "</a>" +
        "</div>";
    };

    /* Wire delegated clicks on entity chips that live anywhere in #news-grid,
     * forwarding the token to the host search (if set via AIRadarHooks). */
    api.attach = function () {
      const grid = document.getElementById("news-grid");
      if (!grid) return;
      grid.addEventListener("click", (e) => {
        const btn = e.target.closest(".entity-chip");
        if (!btn) return;
        const token = btn.dataset.token;
        if (!token) return;
        if (window.AIRadarHooks && typeof window.AIRadarHooks.setSearch === "function") {
          window.AIRadarHooks.setSearch(token);
        }
      });
    };
  }

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.AIRadarDashboard = api;
})(typeof window !== "undefined" ? window : this);
