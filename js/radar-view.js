/*
 * AI RADAR - Stage 12: Radar view controller.
 *
 * Renders the fragment routes produced by js/router.js inside the #radar-view
 * section: the global dashboard (#/radar/global) and per-entity pages
 * (#/radar/company|model|research/<slug>) over the archived data/db corpus
 * (falling back to the news.json snapshot when the archive is unreachable).
 * It also publishes the loaded records back to AIRadarRadar.setIndex so entity
 * chips anywhere on the site can hop straight to their radar page.
 */
(function (root) {
  "use strict";

  if (typeof window === "undefined" || typeof document === "undefined") return;

  const R = root.AIRadarRadar;
  const T = root.AIRadarTrends;
  const SEO = root.AIRadarSEO;
  if (!R) return;

  const els = {
    view: document.getElementById("radar-view"),
    toggle: document.getElementById("radar-toggle"),
    title: document.getElementById("radar-title"),
    subtitle: document.getElementById("radar-subtitle"),
    status: document.getElementById("radar-status"),
    error: document.getElementById("radar-error"),
    body: document.getElementById("radar-body"),
    empty: document.getElementById("radar-empty"),
  };

  const state = {
    records: [],
    usingFallback: false,
    active: false,
    loading: false,
    route: { kind: "none" },
    entity: null,
    range: "all",
  };

  const RANGES = [
    ["all", "All"],
    ["30d", "30 days"],
    ["7d", "7 days"],
  ];

  function escapeHtml(s) {
    return (s == null ? "" : String(s))
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function categoryMeta(id) {
    return (root.CATEGORIES || []).find((c) => c.id === id) || { label: "News", icon: "📰" };
  }

  function fetchText(url, ms) {
    const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), ms || 8000) : null;
    return fetch(url, ctrl ? { signal: ctrl.signal } : {})
      .then((res) => {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.text();
      })
      .finally(() => timer && clearTimeout(timer));
  }

  async function fetchJson(url) {
    const txt = await fetchText(url);
    return JSON.parse(txt);
  }

  function mapLimit(arr, limit, fn) {
    const results = new Array(arr.length);
    let cursor = 0;
    const workers = Array.from({ length: Math.min(limit, arr.length) }, async () => {
      while (cursor < arr.length) {
        const i = cursor++;
        results[i] = await fn(arr[i], i);
      }
    });
    return Promise.all(workers).then(() => results);
  }

  async function fetchDayRecords(day) {
    try {
      const txt = await fetchText(root.AIRadarConfig
        ? root.AIRadarConfig.dbDayFileUrl(day)
        : "data/db/days/" + day + ".ndjson", 8000);
      const out = [];
      for (const line of txt.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const rec = JSON.parse(line);
          if (rec && rec.id) out.push(rec);
        } catch (e) {
          continue;
        }
      }
      return out;
    } catch (e) {
      return [];
    }
  }

  async function loadArchive() {
    const cfg = root.AIRadarConfig || {};
    const idxUrl = cfg.SEARCH_DB_INDEX_PATH || "data/db/index.json";
    const idx = await fetchJson(idxUrl);
    const days = Object.keys(idx.days || {}).sort();
    const byId = new Map();
    await mapLimit(days, 4, async (day) => {
      const recs = await fetchDayRecords(day);
      for (const r of recs) if (r && r.id) byId.set(r.id, r);
    });
    return {
      records: Array.from(byId.values()),
      days: days.length,
      updatedAt: idx.updatedAt || null,
    };
  }

  async function loadFallback() {
    const cfg = root.AIRadarConfig || {};
    const snap = await fetchJson(cfg.SNAPSHOT_PATH || "data/news.json");
    const items = Array.isArray(snap.items) ? snap.items : [];
    return { records: items, days: null, updatedAt: snap.generatedAt || null };
  }

  async function ensureRecords() {
    if (state.records.length) return;
    if (state.loading) return;
    state.loading = true;
    try {
      let archive;
      try {
        archive = await loadArchive();
        state.usingFallback = false;
      } catch (e) {
        archive = await loadFallback();
        state.usingFallback = true;
      }
      state.records = archive.records || [];
      /* Publish the index so entity chips can resolve their group without a
       * second archive fetch. Global entity sets are re-derived on demand. */
      if (R && typeof R.setIndex === "function") R.setIndex(state.records);
      if (els.error) {
        els.error.style.display = "none";
        els.error.textContent = "";
      }
    } catch (e) {
      state.records = [];
      if (els.error) {
        els.error.style.display = "block";
        els.error.textContent = "Could not load radar data. " + (e && e.message ? e.message : "");
      }
    } finally {
      state.loading = false;
    }
  }

  /* ---------------- rendering ---------------- */

  function formatDay(iso) {
    if (!iso) return "";
    const parts = String(iso).slice(0, 10).split("-");
    return parts.length === 3 ? parts[1] + "/" + parts[2] + "/" + parts[0] : String(iso);
  }

  function statusText() {
    const total = state.records.length;
    if (state.usingFallback) {
      return "Archive unavailable — showing the current live snapshot (" + total + " stories).";
    }
    const bounds = T && typeof T.windowBounds === "function" ? T.windowBounds(state.records, "all") : null;
    const range =
      bounds && bounds.start
        ? formatDay(bounds.start) + " → " + formatDay(bounds.end)
        : "";
    return total + " stories in the archive" + (range ? " (" + range + ")" : "") + ".";
  }

  function entityRowHtml(e, group) {
    const label = R.GROUP_LABELS[group];
    const icon = R.GROUP_ICONS[group];
    return (
      '<a class="radar-entity-row" href="' +
      escapeHtml(R.radarUrl(group, e.name)) +
      '">' +
      '<span class="radar-entity-icon">' +
      icon +
      "</span>" +
      '<span class="radar-entity-name">' +
      escapeHtml(e.name) +
      "</span>" +
      '<span class="radar-entity-metrics">' +
      '<span class="radar-entity-count">' +
      e.count +
      " story" +
      (e.count === 1 ? "" : "s") +
      "</span>" +
      (e.avgScore != null
        ? '<span class="radar-entity-score">score ' +
          e.avgScore +
          "</span>"
        : "") +
      "</span>" +
      "</a>"
    );
  }

  function overviewHtml() {
    const stats = R.GROUP_ORDER.map((g) => {
      const ents = R.entityNames(state.records, g);
      const stories = ents.reduce((n, e) => n + e.count, 0);
      return { group: g, entities: ents, stories, total: ents.length };
    });
    const totals = {
      stories: state.records.length,
      companies: stats[0].entities.length,
      models: stats[1].entities.length,
      research: stats[2].entities.length,
    };
    let html =
      '<div class="radar-hero">' +
      "<p>" +
      "<b>" +
      totals.stories +
      "</b> stories · <b>" +
      totals.companies +
      "</b> companies · <b>" +
      totals.models +
      "</b> models · <b>" +
      totals.research +
      "</b> research topics</p></div>";
    html += '<div class="radar-groups">';
    for (const s of stats) {
      html +=
        '<div class="radar-group-column">' +
        '<h3 class="radar-group-title">' +
        R.GROUP_ICONS[s.group] +
        " " +
        escapeHtml(R.GROUP_LABELS[s.group]) +
        ' <span class="radar-group-count">' +
        s.entities.length +
        "</span></h3>";
      html += s.entities.length
        ? s.entities.slice(0, 50).map((e) => entityRowHtml(e, s.group)).join("")
        : '<p class="radar-muted">No entities in the archive yet.</p>';
      html += "</div>";
    }
    html += "</div>";
    return html;
  }

  function chipHtml(group, name) {
    return (
      '<button type="button" class="entity-chip" data-radar-group="' +
      group +
      '" data-token="' +
      escapeHtml(name) +
      '">' +
      escapeHtml(name) +
      "</button>"
    );
  }

  function storyCardHtml(rec, isWindowed) {
    const meta = categoryMeta(rec.category);
    const src = rec.source && rec.source.name ? rec.source.name : rec.sourceName || "";
    const date = rec.date || rec.publishedAt || "";
    const when = date
      ? new Date(date).toLocaleDateString(undefined, { month: "short", day: "numeric" })
      : "";
    const score = typeof rec.radarScore === "number" ? rec.radarScore : typeof rec.score === "number" ? rec.score * 20 : null;
    const chips = [];
    if (Array.isArray(rec.companies)) for (const n of rec.companies) chips.push(["company", n]);
    if (Array.isArray(rec.models)) for (const n of rec.models) chips.push(["model", n]);
    if (Array.isArray(rec.technologies)) for (const n of rec.technologies) chips.push(["research", n]);
    const chipHtmlList = chips
      .filter((c) => c[0] !== (state.entity && state.entity.group) || c[1] !== (state.entity && state.entity.name))
      .slice(0, 6)
      .map((c) => chipHtml(c[0], c[1]))
      .join("");
    return (
      '<article class="radar-card' +
      (isWindowed ? "" : "") +
      '" data-cat="' +
      escapeHtml(rec.category || "news") +
      '">' +
      '<div class="radar-card-top">' +
      '<span class="badge badge-' +
      escapeHtml(rec.category || "news") +
      '">' +
      escapeHtml(meta.icon + " " + meta.label) +
      "</span>" +
      (score != null
        ? '<span class="radar-score">Radar ' +
          Math.round(score) +
          "</span>"
        : "") +
      "</div>" +
      '<h4 class="radar-card-title">' +
      (rec.link && rec.link !== "#"
        ? '<a href="' +
          escapeHtml(rec.link) +
          '" target="_blank" rel="noopener noreferrer">' +
          escapeHtml(rec.title || "") +
          "</a>"
        : escapeHtml(rec.title || "")) +
      "</h4>" +
      '<p class="radar-card-desc">' +
      escapeHtml((rec.description || rec.aiSummary || "").slice(0, 240)) +
      "</p>" +
      '<div class="radar-card-meta">' +
      "<span>" +
      escapeHtml(src) +
      "</span>" +
      (when ? "<span>" + when + "</span>" : "") +
      "</div>" +
      (chipHtmlList
        ? '<div class="radar-card-chips">' + chipHtmlList + "</div>"
        : "") +
      "</article>"
    );
  }

  function rangeChipHtml(key, label) {
    return (
      '<button type="button" class="facet-chip' +
      (state.range === key ? " active" : "") +
      '" data-range="' +
      key +
      '">' +
      label +
      "</button>"
    );
  }

  function entityPageHtml() {
    const ent = state.entity;
    const stories = R.entityStories(state.records, ent.group, ent.name);
    const windowed = T && typeof T.windowItems === "function" ? T.windowItems(stories, state.range) : stories;
    const avg = R.avgScore(stories);
    const related = R.relatedEntities(state.records, ent.group, ent.name).slice(0, 12);

    let html =
      '<div class="radar-entity-banner">' +
      '<a class="radar-back" href="' +
      R.radarGlobalUrl() +
      '">← All entities</a>' +
      '<div class="radar-entity-head">' +
      '<span class="radar-entity-icon big">' +
      R.GROUP_ICONS[ent.group] +
      "</span>" +
      "<div>" +
      '<h2 class="radar-entity-name">' +
      escapeHtml(ent.name) +
      "</h2>" +
      '<span class="radar-entity-type">' +
      escapeHtml(R.GROUP_LABELS[ent.group]) +
      "</span>" +
      "</div>" +
      "</div>" +
      '<div class="radar-entity-stats">' +
      "<b>" +
      ent.count +
      "</b> stories" +
      (avg != null ? " · <b>" + avg + "</b> avg radar score" : "") +
      "</div>" +
      "</div>" +
      '<div class="facet-row" id="radar-range">' +
      RANGES.map((r) => rangeChipHtml(r[0], r[1])).join("") +
      "</div>";
    html += windowed.length
      ? windowed
          .slice()
          .sort((a, b) => (b.radarScore || 0) - (a.radarScore || 0))
          .map((r) => storyCardHtml(r))
          .join("")
      : '<div class="state-box">No stories mention this entity' +
        (state.range !== "all" ? " in the selected range" : "") +
        ".</div>";
    if (related.length) {
      html +=
        '<h3 class="section-title small"><span>🔗</span> Often paired with</h3>' +
        '<div class="radar-related">' +
        related.map((r) => chipHtml(r.group, r.name)).join("") +
        "</div>";
    }
    return html;
  }

  function renderRoute() {
    if (!els.body) return;
    const route = state.route;
    if (route.kind === "radar-global") {
      if (els.title) els.title.textContent = "Radar · every slice of the signal";
      if (els.subtitle) els.subtitle.textContent = statusText();
      if (els.empty) els.empty.style.display = state.records.length ? "none" : "block";
      els.body.innerHTML = state.records.length ? overviewHtml() : "";
    } else if (route.kind === "radar-entity") {
      const ent = R.resolveEntity(state.records, route.group, route.slug);
      state.entity = ent ? { group: route.group, name: ent.name, slug: ent.slug } : null;
      if (!ent) {
        if (els.title) els.title.textContent = "Entity not found";
        if (els.subtitle) els.subtitle.textContent = "No stories reference this entity in the archive.";
        els.body.innerHTML =
          '<div class="state-box"><a href="' +
          R.radarGlobalUrl() +
          '">Browse all entities</a></div>';
        return;
      }
      if (els.title) els.title.textContent = ent.name;
      if (els.subtitle) els.subtitle.textContent =
        R.GROUP_LABELS[route.group] + " · " + R.entityStories(state.records, route.group, ent.name).length + " stories in the archive.";
      els.body.innerHTML = entityPageHtml();
    } else {
      if (els.title) els.title.textContent = "Radar";
      if (els.subtitle) els.subtitle.textContent = "";
      if (els.body) els.body.innerHTML = "";
      if (els.empty) els.empty.style.display = "none";
    }
  }

  function setupSeo() {
    if (!SEO) return;
    const route = state.route;
    if (route.kind === "radar-global") {
      SEO.setRouteMeta(
        "Radar · " + state.records.length + " stories | AI RADAR",
        "AI RADAR summary across " +
          state.records.length +
          " archived stories — companies, models and research topics in the AI frontier.",
        R.radarGlobalUrl()
      );
    } else if (route.kind === "radar-entity" && state.entity) {
      const e = state.entity;
      SEO.setRouteMeta(
        e.name + " · Radar | AI RADAR",
        e.name +
          " appears in " +
          R.entityStories(state.records, e.group, e.name).length +
          " AI RADAR archive stories (" +
          R.GROUP_LABELS[e.group].toLowerCase() +
          ").",
        R.radarUrl(e.group, e.name)
      );
    } else {
      SEO.reset();
    }
  }

  /* ---------------- view lifecycle ---------------- */

  function setView(active) {
    state.active = active;
    if (els.view) els.view.style.display = active ? "block" : "none";
    if (els.toggle) {
      els.toggle.classList.toggle("active", active);
      els.toggle.setAttribute("aria-pressed", active ? "true" : "false");
    }
    if (root.AIRadarHooks && typeof root.AIRadarHooks.activateView === "function") {
      root.AIRadarHooks.activateView(active ? "radar" : "live");
    }
  }

  async function show(route) {
    state.route = route || { kind: "none" };
    if (!state.active) setView(true);
    if (state.records.length === 0 && !state.loading) {
      await ensureRecords();
    }
    renderRoute();
    setupSeo();
  }

  function hide() {
    if (state.active) setView(false);
    if (SEO) SEO.reset();
  }

  /* ---------------- events ---------------- */

  function bindEvents() {
    if (els.toggle) {
      els.toggle.addEventListener("click", () => {
        const target = R.isRadarHash(location.hash || "") ? "#" : R.radarGlobalUrl();
        if (location.hash !== target) location.hash = target;
        else hide();
      });
    }
    if (els.body) {
      els.body.addEventListener("click", (e) => {
        const chip = e.target.closest(".entity-chip");
        if (chip && chip.dataset && chip.dataset.radarGroup && chip.dataset.token) {
          e.preventDefault();
          location.hash = R.radarUrl(chip.dataset.radarGroup, chip.dataset.token);
          return;
        }
        const range = e.target.closest(".facet-chip[data-range]");
        if (range && range.dataset.range) {
          state.range = range.dataset.range;
          if (els.body.querySelector("#radar-range")) {
            renderRoute();
          }
        }
      });
    }
  }

  bindEvents();

  const api = { show, hide, renderRoute, ensureRecords };
  root.AIRadarRadarView = api;
})(typeof window !== "undefined" ? window : this);