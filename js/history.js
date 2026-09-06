/*
 * AI RADAR - Stage 9: History / cross-day search view (browser only).
 *
 * Loads the persistent archive (data/db/index.json + days/*.ndjson) and
 * provides a structured search + filter UI (free text, date range, category /
 * subcategory, source, company/entity, importance) over the full history.
 * Rendering reuses the Stage 8 dashboard visual language (radar donut, AI
 * summary reveal, entity chips) and virtualized "Show more" paging.
 *
 * RELIABILITY: this is a progressive-enhancement layer. If it (or the archive)
 * is unavailable it gracefully falls back to searching the live data/news.json
 * items, and if the whole file fails to load the existing Stage 1-8 live feed
 * is completely unaffected.
 *
 * Loaded AFTER dashboard.js so window.AIRadarSearch + AIRadarDashboard exist.
 */
(function () {
  "use strict";

  if (typeof window === "undefined" || typeof document === "undefined") return;

  const Search = window.AIRadarSearch;
  if (!Search) return;

  const els = {
    view: document.getElementById("history-view"),
    toggle: document.getElementById("history-toggle"),
    search: document.getElementById("history-search"),
    from: document.getElementById("history-from"),
    to: document.getElementById("history-to"),
    cats: document.getElementById("history-cats"),
    subs: document.getElementById("history-subs"),
    sources: document.getElementById("history-sources"),
    company: document.getElementById("history-company"),
    importance: document.getElementById("history-importance"),
    clear: document.getElementById("history-clear"),
    grid: document.getElementById("history-grid"),
    more: document.getElementById("history-more"),
    count: document.getElementById("history-count"),
    status: document.getElementById("history-status"),
    error: document.getElementById("history-error"),
    empty: document.getElementById("history-empty"),
  };

  const state = {
    records: [],
    usingFallback: false,
    page: 1,
    pageSize: 48,
    active: false,
    companyOptions: [],
    sourceOptions: [],
  };

  /* ---------------- small helpers (mirror Stage 8 style) ---------------- */

  function escapeHtml(s) {
    return (s == null ? "" : String(s))
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function timeAgo(d) {
    if (!d) return "";
    const s = Math.floor((Date.now() - d.getTime()) / 1000);
    if (s < 60) return "just now";
    const m = Math.floor(s / 60);
    if (m < 60) return m + "m ago";
    const h = Math.floor(m / 60);
    if (h < 24) return h + "h ago";
    return Math.floor(h / 24) + "d ago";
  }

  function domainFromLink(url) {
    try {
      return new URL(url).hostname.replace(/^www\./, "");
    } catch (e) {
      return "";
    }
  }

  function categoryMeta(id) {
    return (CATEGORIES || []).find((c) => c.id === id) || { label: "News", icon: "📰" };
  }

  function truncate(s, n) {
    if (!s) return "";
    s = String(s).trim();
    return s.length > n ? s.slice(0, n - 1) + "…" : s;
  }

  function hashCode(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) h = (h << 5) - h + str.charCodeAt(i);
    return Math.abs(h);
  }

  /* ---------------- archive loading ---------------- */

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

  /* Run async tasks with bounded concurrency (same approach as aggregator). */
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
      const txt = await fetchText(dbDayFileUrl(day), 8000);
      const out = [];
      for (const line of txt.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const rec = JSON.parse(line);
          if (rec && rec.id) out.push(rec);
        } catch (e) {
          /* skip a malformed line; never abort the whole day */
        }
      }
      return out;
    } catch (e) {
      return [];
    }
  }

  /* Load the full archive from data/db. Returns { records, days, updatedAt }.
   * Records are de-duplicated by id (a story may appear in multiple day files). */
  async function loadArchive() {
    const idx = await fetchJson(SEARCH_DB_INDEX_PATH);
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

  /* Fallback: search the live snapshot items instead of the archive. */
  async function loadFallback() {
    const snap = await fetchJson(SNAPSHOT_PATH);
    const items = Array.isArray(snap.items) ? snap.items : [];
    return { records: items, days: null, updatedAt: snap.generatedAt || null };
  }

  /* ---------------- facet control rendering ---------------- */

  function renderSourceFacet() {
    if (!els.sources) return;
    const sources = state.sourceOptions;
    let html = '<button type="button" class="facet-chip active" data-src="all">All</button>';
    for (const s of sources) {
      html +=
        '<button type="button" class="facet-chip" data-src="' +
        escapeHtml(s) +
        '">' +
        escapeHtml(s) +
        "</button>";
    }
    els.sources.innerHTML = html;
  }

  function renderCatFacet() {
    if (!els.cats) return;
    let html = '<button type="button" class="facet-chip active" data-cat="all">All</button>';
    for (const c of CATEGORIES || []) {
      html +=
        '<button type="button" class="facet-chip" data-cat="' +
        escapeHtml(c.id) +
        '">' +
        escapeHtml(c.icon + " " + c.label) +
        "</button>";
    }
    els.cats.innerHTML = html;
  }

  function renderSubFacet() {
    if (!els.subs) return;
    const subcats = Array.from(new Set(state.records.map((r) => r.subcategory).filter(Boolean)));
    subcats.sort((a, b) => a.localeCompare(b));
    let html = '<button type="button" class="facet-chip active" data-sub="all">All</button>';
    for (const s of subcats) {
      html +=
        '<button type="button" class="facet-chip" data-sub="' +
        escapeHtml(s) +
        '">' +
        escapeHtml(s) +
        "</button>";
    }
    els.subs.innerHTML = html;
  }

  function renderImportanceFacet() {
    if (!els.importance) return;
    const opts = [
      ["all", "Any"],
      ["high", "High (70+)"],
      ["medium", "Medium (40-69)"],
      ["low", "Low (<40)"],
    ];
    els.importance.innerHTML = opts
      .map(
        (o) =>
          '<button type="button" class="facet-chip' +
          (o[0] === "all" ? " active" : "") +
          '" data-imp="' +
          o[0] +
          '">' +
          o[1] +
          "</button>"
      )
      .join("");
  }

  /* ---------------- filter collection ---------------- */

  function activeMulti(el) {
    if (!el) return [];
    const arr = [];
    el.querySelectorAll(".facet-chip.active[data-cat]").forEach((b) => {
      if (b.dataset.cat && b.dataset.cat !== "all") arr.push(b.dataset.cat);
    });
    if (!arr.length) return undefined;
    return arr;
  }

  function activeSubs(el) {
    if (!el) return [];
    const arr = [];
    el.querySelectorAll(".facet-chip.active[data-sub]").forEach((b) => {
      if (b.dataset.sub && b.dataset.sub !== "all") arr.push(b.dataset.sub);
    });
    if (!arr.length) return undefined;
    return arr;
  }

  function activeSources(el) {
    if (!el) return [];
    const arr = [];
    el.querySelectorAll(".facet-chip.active[data-src]").forEach((b) => {
      if (b.dataset.src && b.dataset.src !== "all") arr.push(b.dataset.src);
    });
    if (!arr.length) return undefined;
    return arr;
  }

  function activeImportance(el) {
    if (!el) return [];
    const arr = [];
    el.querySelectorAll(".facet-chip.active[data-imp]").forEach((b) => {
      if (b.dataset.imp && b.dataset.imp !== "all") arr.push(b.dataset.imp);
    });
    if (!arr.length) return undefined;
    return arr;
  }

  function collectFilters() {
    const filters = {
      q: (els.search && els.search.value.trim()) || undefined,
      from: (els.from && els.from.value) || undefined,
      to: (els.to && els.to.value) || undefined,
      categories: activeMulti(els.cats),
      subcategories: activeSubs(els.subs),
      sources: activeSources(els.sources),
      importance: activeImportance(els.importance),
    };
    const company = (els.company && els.company.value.trim()) || "";
    if (company) filters.companies = [company];
    return filters;
  }

  /* ---------------- data-datalist for company autocomplete ---------------- */

  function renderCompanyList() {
    if (els.company && typeof els.company.setAttribute === "function") {
      const dl = document.getElementById("history-companies-list");
      if (dl) {
        dl.innerHTML = state.companyOptions
          .map((c) => '<option value="' + escapeHtml(c) + '"></option>')
          .join("");
      }
    }
  }

  /* ---------------- card rendering (Stage 8 visual language) ---------------- */

  function cardHtml(item) {
    const meta = categoryMeta(item.category);
    let img = "";
    if (item.imageUrl || item.image) {
      img =
        '<div class="card-img" style="background-image:url(\'' +
        escapeHtml(item.imageUrl || item.image) +
        '\')"></div>';
    } else {
      const g = placeholderGradient(item.id || item.title);
      img =
        '<div class="card-img placeholder" style="background:linear-gradient(135deg,' +
        g[0] +
        "," +
        g[1] +
        ')"><span>' +
        escapeHtml(meta.icon) +
        "</span></div>";
    }

    const dashHtml =
      window.AIRadarDashboard &&
      typeof window.AIRadarDashboard.cardEnhancement === "function"
        ? window.AIRadarDashboard.cardEnhancement(item)
        : "";

    return (
      '<article class="card dash-enhanced" data-cat="' +
      escapeHtml(item.category || "news") +
      '" data-src="' +
      escapeHtml(item.source && item.source.id ? item.source.id : "") +
      '">' +
      img +
      '<div class="card-body">' +
      '<div class="card-top">' +
      '<span class="badge badge-' +
      escapeHtml(item.category || "news") +
      '">' +
      escapeHtml(meta.icon + " " + meta.label) +
      "</span>" +
      '<span class="time">' +
      timeAgo(item.publishedAt ? new Date(item.publishedAt) : null) +
      "</span>" +
      "</div>" +
      '<h3 class="card-title">' +
      escapeHtml(truncate(item.title, 120)) +
      "</h3>" +
      (item.description
        ? '<p class="card-desc">' + escapeHtml(truncate(item.description, 200)) + "</p>"
        : "") +
      '<div class="card-meta">' +
      '<span class="source" style="--dot:' +
      escapeHtml(item.source && item.source.color ? item.source.color : "#888") +
      '"><span class="dot"></span>' +
      escapeHtml((item.source && item.source.name) || item.sourceName || "") +
      "</span>" +
      '<span class="link">Read · ' +
      escapeHtml(item.link && item.link !== "#" ? domainFromLink(item.link) : "Source") +
      " →</span>" +
      "</div>" +
      dashHtml +
      "</div>" +
      (item.link && item.link !== "#"
        ? '<a class="card-link" href="' +
          escapeHtml(item.link) +
          '" target="_blank" rel="noopener noreferrer" aria-label="Read article"></a>'
        : "") +
      "</article>"
    );
  }

  function placeholderGradient(id) {
    const colors = [
      ["#0ea5e9", "#6366f1"],
      ["#10b981", "#0ea5e9"],
      ["#f59e0b", "#ef4444"],
      ["#8b5cf6", "#ec4899"],
    ];
    const g = colors[hashCode(id || "x") % colors.length];
    return g;
  }

  /* ---------------- render ---------------- */

  function render() {
    const filters = collectFilters();
    const result = Search.search(state.records, filters, state.page, state.pageSize);

    let html = "";
    for (const it of result.items) html += cardHtml(it);

    if (els.grid) els.grid.innerHTML = html;

    if (els.more) {
      if (result.pageInfo.hasMore) {
        els.more.style.display = "block";
        els.more.innerHTML =
          '<button type="button" class="btn-more">Show more (' +
          (result.total - state.page * state.pageSize) +
          " more)</button>";
      } else {
        els.more.style.display = "none";
        els.more.innerHTML = "";
      }
    }

    if (els.count) {
      const rangeInfo =
        state.records.length === 0
          ? ""
          : (filters.from || filters.to)
          ? " (" + (filters.from || "start") + " → " + (filters.to || "end") + ")"
          : "";
      els.count.textContent =
        "Showing " + result.items.length + " of " + result.total + " stories" + rangeInfo;
    }

    if (els.empty) {
      const showEmpty = result.total === 0;
      els.empty.style.display = showEmpty ? "block" : "none";
      if (showEmpty) {
        els.empty.innerHTML =
          "<p>No stories match your search. Try a broader query or clear filters.</p>";
      }
    }
  }

  function resetPage() {
    state.page = 1;
  }

  /* ---------------- events ---------------- */

  function bindFacet(el) {
    if (!el) return;
    el.addEventListener("click", (e) => {
      const chip = e.target.closest(".facet-chip");
      if (!chip) return;
      const allHolder =
        chip.dataset.cat === "all" ||
        chip.dataset.sub === "all" ||
        chip.dataset.src === "all" ||
        chip.dataset.imp === "all";
      if (allHolder) {
        const container = chip.parentElement || el;
        container.querySelectorAll(".facet-chip").forEach((c) => c.classList.remove("active"));
        chip.classList.add("active");
      } else {
        chip.classList.toggle("active");
      }
      resetPage();
      render();
    });
  }

  function bindEvents() {
    if (els.search) {
      els.search.addEventListener("input", () => {
        resetPage();
        render();
      });
    }
    if (els.from || els.to) {
      (els.from || {}).addEventListener &&
        els.from.addEventListener("change", () => {
          resetPage();
          render();
        });
      (els.to || {}).addEventListener &&
        els.to.addEventListener("change", () => {
          resetPage();
          render();
        });
    }
    if (els.company) {
      els.company.addEventListener("input", () => {
        resetPage();
        render();
      });
    }
    bindFacet(els.cats);
    bindFacet(els.subs);
    bindFacet(els.sources);
    bindFacet(els.importance);

    if (els.clear) {
      els.clear.addEventListener("click", () => {
        if (els.search) els.search.value = "";
        if (els.from) els.from.value = "";
        if (els.to) els.to.value = "";
        if (els.company) els.company.value = "";
        if (els.cats) els.cats.querySelectorAll(".facet-chip").forEach((c) => c.classList.remove("active"));
        if (els.subs) els.subs.querySelectorAll(".facet-chip").forEach((c) => c.classList.remove("active"));
        if (els.sources) els.sources.querySelectorAll(".facet-chip").forEach((c) => c.classList.remove("active"));
        if (els.importance) els.importance.querySelectorAll(".facet-chip").forEach((c) => c.classList.remove("active"));
        if (els.cats) {
          const allChip = els.cats.querySelector('.facet-chip[data-cat="all"]');
          if (allChip) allChip.classList.add("active");
        }
        if (els.subs) {
          const allChip = els.subs.querySelector('.facet-chip[data-sub="all"]');
          if (allChip) allChip.classList.add("active");
        }
        if (els.sources) {
          const allChip = els.sources.querySelector('.facet-chip[data-src="all"]');
          if (allChip) allChip.classList.add("active");
        }
        if (els.importance) {
          const allChip = els.importance.querySelector('.facet-chip[data-imp="all"]');
          if (allChip) allChip.classList.add("active");
        }
        resetPage();
        render();
      });
    }

    if (els.more) {
      els.more.addEventListener("click", (e) => {
        if (!e.target.closest(".btn-more")) return;
        state.page += 1;
        render();
      });
    }

    if (els.toggle) {
      els.toggle.addEventListener("click", () => {
        setView(!state.active);
      });
    }

    if (els.grid) {
      els.grid.addEventListener("click", (e) => {
        const chip = e.target.closest(".entity-chip");
        if (!chip || !chip.dataset.token) return;
        if (els.company) {
          els.company.value = chip.dataset.token;
        } else if (window.AIRadarHooks && typeof window.AIRadarHooks.setSearch === "function") {
          window.AIRadarHooks.setSearch(chip.dataset.token);
        }
        resetPage();
        render();
      });
    }
  }

  /* ---------------- view activation ---------------- */

  function setView(active) {
    state.active = active;
    if (els.view) els.view.style.display = active ? "block" : "none";
    if (els.toggle) {
      els.toggle.classList.toggle("active", active);
      els.toggle.setAttribute("aria-pressed", active ? "true" : "false");
    }
    if (window.AIRadarHooks && typeof window.AIRadarHooks.activateView === "function") {
      window.AIRadarHooks.activateView(active ? "history" : "live");
    }
    if (active && state.records.length === 0 && !state.loading) {
      init();
    }
  }

  /* ---------------- boot ---------------- */

  async function init() {
    state.loading = true;
    var sourcePromise = null;
    if (els.sources && state.sourceOptions.length === 0) {
      sourcePromise = window.AIRadar && typeof window.AIRadar.getSources === "function"
        ? window.AIRadar.ensureSources().then(() => {
            state.sourceOptions = (window.AIRadar.getSources() || []).map((s) => s.id);
          })
        : Promise.resolve();
    }
    try {
      let archive;
      try {
        archive = await loadArchive();
        state.usingFallback = false;
      } catch (e) {
        // archive unavailable -> fall back to the live snapshot items
        archive = await loadFallback();
        state.usingFallback = true;
      }
      state.records = archive.records || [];
      if (els.status) {
        els.status.textContent = state.usingFallback
          ? "Archive unavailable — searching the current live snapshot instead."
          : "Searching " + archive.days + " archived day(s) · " + state.records.length + " stories";
      }
      const f = Search.facets(state.records);
      state.companyOptions = f.companies;
      if (f.sources && f.sources.length) state.sourceOptions = f.sources;
      renderSourceFacet();
      renderCatFacet();
      renderSubFacet();
      renderImportanceFacet();
      renderCompanyList();
      if (sourcePromise) await sourcePromise;
      render();
      if (els.error) els.error.style.display = "none";
    } catch (e) {
      if (els.error) {
        els.error.style.display = "block";
        els.error.textContent = "Could not load history. " + (e && e.message ? e.message : "");
      }
    } finally {
      state.loading = false;
    }
  }

  bindEvents();
  setView(false);
})();
