/*
 * AI RADAR - Stage 12: Radar module (pure aggregation + routing helpers).
 *
 * Per-entity navigation model:
 *   #/radar/global        - the whole archive at a glance
 *   #/radar/company/<slug>- one company's coverage
 *   #/radar/model/<slug>  - one model's coverage
 *   #/radar/research/<slug>- one research topic's coverage
 *
 * Entities map onto the classified Story arrays:
 *   company  <-> companies[]   model  <-> models[]   research <-> technologies[]
 * There is no fuzzy identity: entities are matched exactly (case-insensitive)
 * against those arrays. This module is pure and DOM-free (runs in Node for
 * tests and in the browser for the views).
 */
(function (root) {
  "use strict";

  const GROUPS = { company: "companies", model: "models", research: "technologies" };
  const GROUP_ORDER = ["company", "model", "research"];
  const GROUP_LABELS = { company: "Companies", model: "Models", research: "Research" };
  const GROUP_ICONS = { company: "🏢", model: "🤖", research: "🧪" };
  const RADAR_ROUTE_PREFIX = "#/radar";

  function slugify(name) {
    return String(name == null ? "" : name)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
  }

  function radarUrl(group, name) {
    return RADAR_ROUTE_PREFIX + "/" + group + "/" + slugify(name);
  }

  function radarGlobalUrl() {
    return RADAR_ROUTE_PREFIX + "/global";
  }

  const GLOBAL_RE = /^#\/radar\/global$/;
  const ENTITY_RE = /^#\/radar\/(company|model|research)\/([a-z0-9-]+)$/;

  /* Is `hash` a radar route at all? */
  function isRadarHash(hash) {
    return typeof hash === "string" && hash.indexOf(RADAR_ROUTE_PREFIX) === 0;
  }

  /* Parse a location hash into a route descriptor. Never throws; always
   * returns an object so callers can branch on `kind`. */
  function parseHash(hash) {
    hash = String(hash || "");
    if (!isRadarHash(hash)) return { kind: "none" };
    if (GLOBAL_RE.test(hash)) return { kind: "radar-global" };
    const m = ENTITY_RE.exec(hash);
    if (m) return { kind: "radar-entity", group: m[1], slug: m[2] };
    return { kind: "radar-unknown", hash };
  }

  /* Distinct entity names under a group, with occurrence counts, deterministic
   * ordering (count desc, then name asc). */
  function entityNames(records, group) {
    const key = GROUPS[group];
    if (!key) return [];
    const counts = Object.create(null);
    for (const r of records || []) {
      const arr = Array.isArray(r && r[key]) ? r[key] : [];
      for (const v of arr) {
        const n = String(v).trim();
        if (!n) continue;
        counts[n] = (counts[n] || 0) + 1;
      }
    }
    return Object.keys(counts)
      .map((name) => ({ name, slug: slugify(name), count: counts[name] }))
      .sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  /* Resolve an entity <slug> within a group; null when absent. */
  function resolveEntity(records, group, slug) {
    const found = entityNames(records, group).find((e) => e.slug === slug);
    return found || null;
  }

  /* Which group does a token belong to? EXACT (case-insensitive) name match
   * only - never fuzzy. Priority: company > model > research. Returns null
   * when the token matches none of the three lexicons. */
  function groupOfToken(records, token) {
    const t = String(token == null ? "" : token).trim().toLowerCase();
    if (!t) return null;
    for (const g of GROUP_ORDER) {
      if (entityNames(records, g).some((e) => e.name.toLowerCase() === t)) return g;
    }
    return null;
  }

  /* All stories mentioning an entity (exact, case-insensitive). */
  function entityStories(records, group, name) {
    const key = GROUPS[group];
    if (!key) return [];
    const t = String(name == null ? "" : name).trim().toLowerCase();
    return (records || []).filter((r) => {
      const arr = Array.isArray(r && r[key]) ? r[key] : [];
      return arr.some((v) => String(v).trim().toLowerCase() === t);
    });
  }

  function avgScore(items) {
    if (root && root.AIRadarTrends && typeof root.AIRadarTrends.avgScore === "function") {
      return root.AIRadarTrends.avgScore(items);
    }
    let sum = 0;
    let n = 0;
    for (const it of items || []) {
      const s = typeof it.radarScore === "number" ? it.radarScore : NaN;
      if (!Number.isNaN(s)) {
        sum += s;
        n++;
      }
    }
    return n ? Math.round((sum / n) * 10) / 10 : null;
  }

  /* Per-entity stats for a group: { name, slug, count, avgScore }. */
  function entityStats(records, group) {
    return entityNames(records, group).map((e) => ({
      name: e.name,
      slug: e.slug,
      count: e.count,
      avgScore: avgScore(entityStories(records, group, e.name)),
    }));
  }

  /* Other entities that co-occur across an entity's stories, top by frequency
   * (deterministic ties by name). Excludes the group being viewed. */
  function relatedEntities(records, group, name) {
    const map = Object.create(null);
    for (const r of entityStories(records, group, name)) {
      for (const g of GROUP_ORDER) {
        if (g === group) continue;
        const key = GROUPS[g];
        const arr = Array.isArray(r && r[key]) ? r[key] : [];
        for (const v of arr) {
          const n = String(v).trim();
          if (!n) continue;
          const k = g + "|" + n;
          if (!map[k]) map[k] = { group: g, name: n, count: 0 };
          map[k].count++;
        }
      }
    }
    return Object.keys(map)
      .map((k) => map[k])
      .sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  /* The archive index the views load once and reuse for chip routing. It is a
   * hint only - groupOfToken falls back to whatever records are passed. */
  let _index = null;
  function setIndex(records) {
    _index = records && records.length ? records : null;
  }
  function getIndex() {
    return _index;
  }

  /* Single-hash-owner escape hatch: drop a radar hash without firing another
   * hashchange round-trip (used when a non-radar toggle takes over). */
  function clearHash() {
    if (typeof history !== "undefined" && typeof location !== "undefined") {
      history.replaceState(null, "", location.pathname + location.search);
    }
  }

  const api = {
    GROUPS,
    GROUP_ORDER,
    GROUP_LABELS,
    GROUP_ICONS,
    RADAR_ROUTE_PREFIX,
    slugify,
    radarUrl,
    radarGlobalUrl,
    isRadarHash,
    parseHash,
    entityNames,
    resolveEntity,
    groupOfToken,
    entityStories,
    entityStats,
    relatedEntities,
    avgScore,
    setIndex,
    getIndex,
    clearHash,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.AIRadarRadar = api;
})(typeof window !== "undefined" ? window : this);