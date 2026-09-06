/*
 * AI RADAR - Stage 9: pure history search + filters.
 * Dual-load (browser window.AIRadarSearch + Node module.exports, same pattern as
 * shared.js/dashboard.js) so the search logic is fully unit-testable without a
 * DOM or network. Zero dependencies.
 *
 * Operates on canonical Story records exactly as persisted in data/db/days/*.ndjson
 * (and, on fallback, the items array in data/news.json). Search only ever reads
 * and filters stored records - it never invents, mutates, or fabricates.
 *
 * Guarantees:
 *   - DETERMINISTIC: identical (records, filters, page, pageSize) always yields
 *     the same filtered/sorted results (stable id tiebreak).
 *   - READ-ONLY: filters/sort operate on new arrays; input records are untouched.
 *   - FILTER SEMANTICS: different facets (date/category/source/company/importance)
 *     are AND-combined; multiple values within one facet are OR-combined.
 */
(function (root) {
  "use strict";

  /* ---------------- Tokenization / matching ---------------- */

  /* Normalize a string into lowercase search tokens (letters+digits). */
  function tokenize(q) {
    if (!q || typeof q !== "string") return [];
    return q
      .toLowerCase()
      .split(/[^a-z0-9]+/i)
      .filter(Boolean);
  }

  /* Collect every free-text field a query may match against. Includes the
   * source id/name so a user can search by reporting outlet. */
  function haystack(rec) {
    if (!rec) return null;
    const ai = rec.ai && typeof rec.ai === "object" ? rec.ai : null;
    const src = rec.source && typeof rec.source === "object" ? rec.source : null;
    const parts = [
      rec.title,
      rec.description,
      ai && ai.summary,
      src && src.id,
      src && src.name,
      Array.isArray(rec.tags) ? rec.tags.join(" ") : "",
      Array.isArray(rec.companies) ? rec.companies.join(" ") : "",
      Array.isArray(rec.models) ? rec.models.join(" ") : "",
      Array.isArray(rec.people) ? rec.people.join(" ") : "",
      Array.isArray(rec.technologies) ? rec.technologies.join(" ") : "",
    ];
    return parts.filter(Boolean).join(" ").toLowerCase();
  }

  /* True if every query token appears as a substring of the haystack (AND of
   * all tokens -> a multi-word query narrows results). */
  function matchesQuery(rec, q) {
    const h = haystack(rec);
    if (h == null) return false;
    const tokens = tokenize(q);
    if (!tokens.length) return true;
    for (const t of tokens) if (h.indexOf(t) === -1) return false;
    return true;
  }

  /* ---------------- Importance bands (mirror Stage 8 radarBand) ---------------- */

  /* Map radarScore (0..100) to a band for the "importance" filter. Missing or
   * non-finite scores fall to "low" so an unscored record is never dropped from
   * an unknown-importance query (prefers inclusion over false exclusion). */
  function importanceBand(radarScore) {
    const s = typeof radarScore === "number" && !Number.isNaN(radarScore)
      ? (radarScore < 0 ? 0 : radarScore > 100 ? 100 : radarScore)
      : 0;
    if (s >= 70) return "high";
    if (s >= 40) return "medium";
    return "low";
  }

  /* ---------------- Facets (derive selectable values from the archive) ------- */

  function uniqueSorted(arr) {
    const out = [];
    const seen = new Set();
    for (const v of arr || []) {
      const s = String(v).trim();
      if (s && !seen.has(s)) {
        seen.add(s);
        out.push(s);
      }
    }
    out.sort((a, b) => a.localeCompare(b));
    return out;
  }

  function asArray(v) {
    return Array.isArray(v) ? v : [];
  }

  /* Compute the available facet options across a set of records, plus the
   * min/max UTC calendar days present. Deterministic (sorted). */
  function facets(records) {
    const companies = new Set();
    const models = new Set();
    const people = new Set();
    const technologies = new Set();
    const sources = new Set();
    let minDay = null;
    let maxDay = null;

    for (const r of records || []) {
      for (const v of asArray(r.companies)) if (String(v).trim()) companies.add(String(v).trim());
      for (const v of asArray(r.models)) if (String(v).trim()) models.add(String(v).trim());
      for (const v of asArray(r.people)) if (String(v).trim()) people.add(String(v).trim());
      for (const v of asArray(r.technologies)) if (String(v).trim()) technologies.add(String(v).trim());
      const sid = r.source && r.source.id;
      const sname = r.source && r.source.name;
      if (sid && String(sid).trim()) sources.add(String(sid).trim());
      if (sname && String(sname).trim()) sources.add(String(sname).trim());
      const day = utcDayOf(r);
      if (day) {
        if (!minDay || day < minDay) minDay = day;
        if (!maxDay || day > maxDay) maxDay = day;
      }
    }

    return {
      companies: uniqueSorted(Array.from(companies)),
      models: uniqueSorted(Array.from(models)),
      people: uniqueSorted(Array.from(people)),
      technologies: uniqueSorted(Array.from(technologies)),
      sources: uniqueSorted(Array.from(sources)),
      minDay,
      maxDay,
    };
  }

  /* UTC calendar day (YYYY-MM-DD) of a record: publishedAt, else discoveredAt.
   * Never invented - a record with neither yields null. */
  function utcDayOf(rec) {
    const cand = rec && (rec.publishedAt || rec.discoveredAt);
    if (!cand) return null;
    const t = new Date(cand).getTime();
    if (Number.isNaN(t)) return null;
    const d = new Date(t);
    const p = (n) => String(n).padStart(2, "0");
    return d.getUTCFullYear() + "-" + p(d.getUTCMonth() + 1) + "-" + p(d.getUTCDate());
  }

  /* ---------------- Filtering (AND across facets, OR within) ---------------- */

  /* Apply all active facets + free-text query to a record set. `filters` shape:
   *   { q, from, to, categories[], subcategories[], sources[], companies[],
   *     models[], people[], technologies[], importance[] }  (arrays optional).
   * An empty/absent facet list means "no restriction for that facet". */
  function applyFilters(records, filters) {
    filters = filters || {};
    const out = [];
    for (const rec of records || []) {
      if (!rec) continue;

      if (!matchesQuery(rec, filters.q)) continue;

      if (filters.from || filters.to) {
        const day = utcDayOf(rec);
        if (day) {
          if (filters.from && day < filters.from) continue;
          if (filters.to && day > filters.to) continue;
        } else if (filters.from || filters.to) {
          // record has no usable date -> keep it only if there is no date window
          continue;
        }
      }

      if (!inList(rec.category, filters.categories)) continue;
      if (filters.subcategories && filters.subcategories.length) {
        if (!inList(rec.subcategory, filters.subcategories)) continue;
      }

      if (filters.sources && filters.sources.length) {
        const srcId = rec.source && rec.source.id ? String(rec.source.id) : null;
        const srcName = rec.source && rec.source.name ? String(rec.source.name) : null;
        const hit = filters.sources.some(
          (s) => s === srcId || (s && srcName && s.toLowerCase() === srcName.toLowerCase())
        );
        if (!hit) continue;
      }

      if (filters.importance && filters.importance.length) {
        const band = importanceBand(rec.radarScore);
        if (!filters.importance.some((b) => b === band)) continue;
      }

      if (filters.companies && filters.companies.length && !overlap(asArray(rec.companies), filters.companies)) continue;
      if (filters.models && filters.models.length && !overlap(asArray(rec.models), filters.models)) continue;
      if (filters.people && filters.people.length && !overlap(asArray(rec.people), filters.people)) continue;
      if (filters.technologies && filters.technologies.length && !overlap(asArray(rec.technologies), filters.technologies)) continue;

      out.push(rec);
    }
    return out;
  }

  /* Case-insensitive membership for a single value against a candidate list. */
  function inList(value, list) {
    if (!list || !list.length) return true;
    if (value == null) return false;
    const v = String(value).toLowerCase();
    return list.some((x) => String(x).toLowerCase() === v);
  }

  /* True if any record value overlaps any filter value (case-insensitive). */
  function overlap(recValues, filterValues) {
    if (!filterValues || !filterValues.length) return true;
    const lower = filterValues.map((x) => String(x).toLowerCase());
    for (const v of recValues || []) {
      const s = String(v).toLowerCase();
      if (lower.indexOf(s) !== -1) return true;
    }
    return false;
  }

  /* ---------------- Sorting / pagination ---------------- */

  /* Deterministic sort: radarScore desc (unscored = -1 so they sink), then
   * publishedAt desc, then id asc as the final tiebreak. Returns a new array. */
  function sortHistory(records) {
    return (records || []).slice().sort((a, b) => {
      const sa = typeof a.radarScore === "number" ? a.radarScore : -1;
      const sb = typeof b.radarScore === "number" ? b.radarScore : -1;
      if (sa !== sb) return sb - sa;
      const ta = a && a.publishedAt ? +new Date(a.publishedAt) : 0;
      const tb = b && b.publishedAt ? +new Date(b.publishedAt) : 0;
      if (ta !== tb) return tb - ta;
      return (a.id || "") < (b.id || "") ? -1 : (a.id || "") > (b.id || "") ? 1 : 0;
    });
  }

  /* Paginate a pre-filtered/sorted list. Mirrors dashboard.windowSlice semantics
   * (clamped page/pageSize, hasMore/hasPrev). Pure + deterministic. */
  function paginate(records, page, pageSize) {
    page = Math.max(1, Math.floor(page) || 1);
    pageSize = Math.max(1, Math.floor(pageSize) || 48);
    const total = (records || []).length;
    const pages = Math.max(1, Math.ceil(total / pageSize));
    const p = Math.min(page, pages);
    const start = (p - 1) * pageSize;
    return {
      page: p,
      pageSize,
      slice: (records || []).slice(start, start + pageSize),
      total,
      pages,
      hasMore: p < pages,
      hasPrev: p > 1,
    };
  }

  /* Convenience: filter + sort + paginate in one call, returning the page
   * plus the total hit count (for the "Showing N of M" line). */
  function search(records, filters, page, pageSize) {
    const matched = applyFilters(records, filters);
    const sorted = sortHistory(matched);
    const pageInfo = paginate(sorted, page, pageSize);
    return {
      items: pageInfo.slice,
      total: pageInfo.total,
      pageInfo,
    };
  }

  const api = {
    tokenize,
    matchesQuery,
    importanceBand,
    facets,
    utcDayOf,
    applyFilters,
    sortHistory,
    paginate,
    search,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.AIRadarSearch = api;
})(typeof window !== "undefined" ? window : this);
