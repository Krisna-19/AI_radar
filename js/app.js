/*
 * AI RADAR - UI layer
 * Renders feeds, top stories, filters, search, live clock, daily digest.
 */
(function () {
  "use strict";

  const els = {
    clock: document.getElementById("clock"),
    todayDate: document.getElementById("today-date"),
    statToday: document.getElementById("stat-today"),
    statSources: document.getElementById("stat-sources"),
    statUpdated: document.getElementById("stat-updated"),
    sourceBar: document.getElementById("source-bar"),
    chips: document.getElementById("category-chips"),
    search: document.getElementById("search-input"),
    refresh: document.getElementById("refresh-btn"),
    rangeTabs: document.getElementById("range-tabs"),
    grid: document.getElementById("news-grid"),
    gridMore: document.getElementById("grid-more"),
    topStories: document.getElementById("top-stories"),
    loading: document.getElementById("loading"),
    error: document.getElementById("error"),
    empty: document.getElementById("empty"),
    notice: document.getElementById("notice"),
    footerStatus: document.getElementById("footer-status"),
  };

  let state = {
    items: [],
    range: "today",
    category: "all",
    search: "",
    sources: new Set(),
    fromCache: false,
    page: 1,
    pageSize: 48,
    group: false,
  };

  /* ---------------- Sample fallback data ---------------- */
  const SAMPLE_ITEMS = [
    {
      id: "s1",
      sourceId: "openai",
      sourceName: "OpenAI",
      sourceType: "company",
      sourceWeight: 5,
      title: "OpenAI introduces faster model updates with a new developer toolchain",
      link: "#",
      date: new Date(Date.now() - 3 * 3600000),
      description:
        "OpenAI unveiled a streamlined update pipeline aimed at developers, promising lower latency and broader tool integration. Sample content (shown when live feeds are unavailable).",
      image: null,
      category: "product",
      score: 5,
    },
    {
      id: "s2",
      sourceId: "deepmind",
      sourceName: "Google DeepMind",
      sourceType: "company",
      sourceWeight: 5,
      title: "DeepMind publishes a new benchmark for long-horizon planning",
      link: "#",
      date: new Date(Date.now() - 6 * 3600000),
      description:
        "Researchers at Google DeepMind released a benchmark suite that measures agent performance across long-horizon tasks, with results across several frontier models.",
      image: null,
      category: "research",
      score: 4.8,
    },
    {
      id: "s3",
      sourceId: "arxiv",
      sourceName: "arXiv (cs.AI)",
      sourceType: "research",
      sourceWeight: 3,
      title: "A new paper explores retrieval-augmented reasoning at inference time",
      link: "#",
      date: new Date(Date.now() - 9 * 3600000),
      description:
        "A preprint on arXiv proposes a retrieval-augmented reasoning framework that improves factual precision on knowledge-heavy tasks without additional fine-tuning.",
      image: null,
      category: "research",
      score: 3.5,
    },
    {
      id: "s4",
      sourceId: "venturebeat",
      sourceName: "VentureBeat AI",
      sourceType: "media",
      sourceWeight: 3,
      title: "AI startup raises $120M to scale enterprise copilots",
      link: "#",
      date: new Date(Date.now() - 12 * 3600000),
      description:
        "An enterprise AI startup closed a $120 million Series C round to expand its copilot platform across finance, legal, and customer support verticals.",
      image: null,
      category: "funding",
      score: 3.1,
    },
    {
      id: "s5",
      sourceId: "mit",
      sourceName: "MIT Tech Review",
      sourceType: "media",
      sourceWeight: 3,
      title: "Regulators publish a draft framework for frontier-model transparency",
      link: "#",
      date: new Date(Date.now() - 15 * 3600000),
      description:
        "A new regulatory draft proposes mandatory transparency reporting for frontier AI systems, including training compute, safety evaluations, and incident disclosures.",
      image: null,
      category: "policy",
      score: 2.9,
    },
  ];

  /* ---------------- Utilities ---------------- */

  function timeAgo(d) {
    if (!d) return "";
    const s = Math.floor((Date.now() - d.getTime()) / 1000);
    if (s < 60) return "just now";
    const m = Math.floor(s / 60);
    if (m < 60) return m + "m ago";
    const h = Math.floor(m / 60);
    if (h < 24) return h + "h ago";
    const days = Math.floor(h / 24);
    return days + "d ago";
  }

  function fmtDate(d) {
    return d.toLocaleDateString(undefined, {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  }

  function escapeHtml(s) {
    return (s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function categoryMeta(id) {
    return CATEGORIES.find((c) => c.id === id) || { label: "News", icon: "📰" };
  }

  function truncate(s, n) {
    if (!s) return "";
    s = s.trim();
    return s.length > n ? s.slice(0, n - 1) + "…" : s;
  }

  function placeholderGradient(id) {
    const colors = [
      ["#0ea5e9", "#6366f1"],
      ["#10b981", "#0ea5e9"],
      ["#f59e0b", "#ef4444"],
      ["#8b5cf6", "#ec4899"],
    ];
    const g = colors[hashCode(id) % colors.length];
    return g;
  }

  function hashCode(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) h = (h << 5) - h + str.charCodeAt(i);
    return Math.abs(h);
  }

  function domainFromLink(url) {
    try {
      return new URL(url).hostname.replace(/^www\./, "");
    } catch (e) {
      return "";
    }
  }

  /* ---------------- Rendering ---------------- */

  function renderClock() {
    const now = new Date();
    els.clock.textContent =
      now.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    els.todayDate.textContent = fmtDate(now);
  }

  /* Combined view of the canonical source config plus any sources only
   * observable through ingested items (fallback if sources.json is unreachable). */
  function sourceList() {
    const map = Object.create(null);
    (AIRadar.getSources() || []).forEach((s) => {
      map[s.id] = { id: s.id, name: s.name, color: s.color };
    });
    state.items.forEach((it) => {
      if (!map[it.sourceId]) {
        map[it.sourceId] = { id: it.sourceId, name: it.sourceName, color: it.sourceColor };
      }
    });
    return Object.values(map);
  }

  function renderSourceBar() {
    const srcs = sourceList();
    const allActive = state.sources.size === 0;
    let html =
      '<button class="chip source-chip' +
      (allActive ? " active" : "") +
      '" data-src="all">All sources</button>';
    for (const s of srcs) {
      const active = state.sources.has(s.id);
      html +=
        '<button class="chip source-chip' +
        (active ? " active" : "") +
        '" data-src="' +
        escapeHtml(s.id) +
        '" style="--dot:' +
        escapeHtml(s.color || "#888") +
        '"><span class="dot"></span>' +
        escapeHtml(s.name) +
        "</button>";
    }
    els.sourceBar.innerHTML = html;
  }

  function renderChips() {
    let html =
      '<button class="chip filter-chip' +
      (state.category === "all" ? " active" : "") +
      '" data-cat="all">✨ All</button>';
    for (const c of CATEGORIES) {
      html +=
        '<button class="chip filter-chip' +
        (state.category === c.id ? " active" : "") +
        '" data-cat="' +
        escapeHtml(c.id) +
        '">' +
        escapeHtml(c.icon + " " + c.label) +
        "</button>";
    }
    els.chips.innerHTML = html;
  }

  function renderRangeTabs() {
    const ranges = [
      { id: "today", label: "Today" },
      { id: "yesterday", label: "Yesterday" },
      { id: "week", label: "This week" },
    ];
    els.rangeTabs.innerHTML = ranges
      .map(
        (r) =>
          '<button class="chip range-chip' +
          (state.range === r.id ? " active" : "") +
          '" data-range="' +
          r.id +
          '">' +
          r.label +
          "</button>"
      )
      .join("");
  }

  function cardHtml(item) {
    const meta = categoryMeta(item.category);
    let img = "";
    if (item.image) {
      img =
        '<div class="card-img" style="background-image:url(\'' +
        escapeHtml(item.image) +
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

    const initials = (item.sourceName || "??")
      .split(" ")
      .map((w) => w[0])
      .slice(0, 2)
      .join("")
      .toUpperCase();

    const dashHtml =
      window.AIRadarDashboard && typeof window.AIRadarDashboard.cardEnhancement === "function"
        ? window.AIRadarDashboard.cardEnhancement(item)
        : "";

    return (
      '<article class="card dash-enhanced' +
      (window.AIRadarDashboard ? "" : " dash-off") +
      '" data-cat="' +
      item.category +
      '" data-src="' +
      escapeHtml(item.sourceId) +
      '">' +
      img +
      '<div class="card-body">' +
      '<div class="card-top">' +
      '<span class="badge badge-' +
      item.category +
      '">' +
      escapeHtml(meta.icon + " " + meta.label) +
      "</span>" +
      '<span class="time">' +
      timeAgo(item.date) +
      "</span>" +
      "</div>" +
      '<h3 class="card-title">' +
      escapeHtml(truncate(item.title, 120)) +
      "</h3>" +
      '<p class="card-desc">' +
      (item.description
        ? escapeHtml(truncate(item.description, 260))
        : "") +
      "</p>" +
      '<div class="card-meta">' +
      '<span class="source" style="--dot:' +
      escapeHtml(item.sourceColor || "#888") +
      '"><span class="dot"></span>' +
      escapeHtml(item.sourceName) +
      "</span>" +
      '<span class="link">Read · ' +
      escapeHtml(item.link && item.link !== "#" ? domainFromLink(item.link) : "Sample") +
      ' →</span>' +
      "</div>" +
      dashHtml +
      "</div>" +
      (item.link && item.link !== "#"
        ? "<a class=\"card-link\" href=\"" + escapeHtml(item.link) + "\" target=\"_blank\" rel=\"noopener noreferrer\" aria-label=\"Read article\"></a>"
        : "") +
      "</article>"
    );
  }

  function topStoryHtml(item, i) {
    const meta = categoryMeta(item.category);
    let thumb = "";
    if (item.image) {
      thumb =
        '<div class="top-img" style="background-image:url(\'' +
        escapeHtml(item.image) +
        '\')"></div>';
    } else {
      const g = placeholderGradient(item.id || item.title);
      thumb =
        '<div class="top-img placeholder" style="background:linear-gradient(135deg,' +
        g[0] +
        "," +
        g[1] +
        ')"><span>' +
        escapeHtml(meta.icon) +
        "</span></div>";
    }
    return (
      '<a class="top-card" href="' +
      (item.link && item.link !== "#"
        ? escapeHtml(item.link)
        : "#") +
      '" target="_blank" rel="noopener noreferrer">' +
      '<span class="rank">' +
      escapeHtml("#" + (i + 1)) +
      "</span>" +
      thumb +
      '<span class="top-body">' +
      '<span class="badge badge-' +
      item.category +
      '">' +
      escapeHtml(meta.icon + " " + meta.label) +
      "</span>" +
      "<h3>" +
      escapeHtml(truncate(item.title, 100)) +
      "</h3>" +
      '<span class="top-src">' +
      escapeHtml(item.sourceName) +
      " · " +
      timeAgo(item.date) +
      "</span>" +
      "</span>" +
      "</a>"
    );
  }

  function renderTopStories(items) {
    els.topStories.innerHTML = items.length
      ? items.slice(0, 3).map(topStoryHtml).join("")
      : "";
  }

  function renderGrid(items) {
    els.grid.innerHTML = items.map(cardHtml).join("");
  }

  function applyFilters() {
    let items = state.items;

    if (state.sources.size > 0) {
      items = items.filter((it) => state.sources.has(it.sourceId));
    }
    if (state.category !== "all") {
      items = items.filter((it) => it.category === state.category);
    }
    if (state.search) {
      const q = state.search.toLowerCase();
      items = items.filter(
        (it) =>
          (it.title || "").toLowerCase().includes(q) ||
          (it.description || "").toLowerCase().includes(q)
      );
    }
    const ranged = AIRadar.filterByRange(items, state.range);
    return { base: items, ranged };
  }

  /* Most recent items within N hours - used as a graceful fallback when the
   * "Today" tab is legitimately empty early in the day. */
  function latestItems(items, hours) {
    hours = hours || 48;
    const now = Date.now();
    return items
      .filter((it) => it.date && now - it.date.getTime() <= hours * 3600000)
      .sort((a, b) => (b.date ? +b.date : 0) - (a.date ? +a.date : 0));
  }

  function emptyMessage() {
    if (state.search) {
      return (
        "<p>No stories match \u201C" + escapeHtml(state.search) + "\u201D. Try a different search or clear filters.</p>"
      );
    }
    if (state.category !== "all") {
      return "<p>No stories in this category for the selected range. Try another category or range.</p>";
    }
    if (state.sources.size > 0) {
      return "<p>No stories from the selected sources for this range. Tap \u201CAll sources\u201D to widen.</p>";
    }
    if (state.range !== "week") {
      return "<p>No stories published yet for this range. Check back later or switch to \u201CThis week\u201D.</p>";
    }
    return "<p>Nothing here yet. New stories are added continuously throughout the day.</p>";
  }

  function renderNotice(html) {
    els.notice.innerHTML = html || "";
    els.notice.style.display = html ? "block" : "none";
  }

  function renderAll() {
    const { base, ranged } = applyFilters();

    // "Today" with no published stories yet -> never show a confusing empty
    // page; explain it and surface the most recent stories instead.
    const todayFallback =
      state.range === "today" && ranged.length === 0 && base.length > 0;
    const showItems = todayFallback
      ? latestItems(base, 48)
      : ranged;

    if (state.range === "today") {
      const top = todayFallback
        ? []
        : [...ranged].sort((a, b) => (b.score || 0) - (a.score || 0));
      renderTopStories(top);
      if (
        window.AIRadarDashboard &&
        typeof window.AIRadarDashboard.renderTopSignal === "function"
      ) {
        window.AIRadarDashboard.renderTopSignal(top);
      }
    } else {
      els.topStories.innerHTML = "";
      if (
        window.AIRadarDashboard &&
        typeof window.AIRadarDashboard.renderTopSignal === "function"
      ) {
        window.AIRadarDashboard.renderTopSignal([]);
      }
    }

    renderNotice(
      todayFallback
        ? "<strong>No new stories published yet today.</strong> Showing the most recent 48 hours instead (snapshot generated " +
            timeAgo(new Date(state.fetchedAt)) +
            ")."
        : ""
    );

    renderGridLayout(showItems);
  }

  /* Render the feed grid. Capped to a virtual page (see state.page/pageSize)
   * so 2.6k+ story snapshots stay responsive, then a "Load more" control when
   * more pages remain. Optionally groups by subcategory when toggled on. */
  function renderGridLayout(showItems) {
    const D = window.AIRadarDashboard;
    const cap = state.page * state.pageSize;
    const slice = showItems.slice(0, cap);
    const hasMore = showItems.length > cap;

    let html = "";
    if (state.group && D && typeof D.groupBySubcategory === "function") {
      const groups = D.groupBySubcategory(slice);
      for (const g of groups) {
        html +=
          '<div class="subcat-block">' +
          '<h3 class="subcat-title">' +
          escapeHtml(g.label) +
          ' <span class="subcat-count">' +
          g.count +
          "</span></h3>" +
          g.items.map(cardHtml).join("") +
          "</div>";
      }
    } else {
      html += slice.map(cardHtml).join("");
    }

    els.grid.innerHTML = html;

    if (els.gridMore) {
      if (hasMore) {
        els.gridMore.style.display = "block";
        els.gridMore.innerHTML =
          '<button type="button" class="btn-more">Show more (' +
          (showItems.length - cap) +
          " more)</button>";
      } else {
        els.gridMore.style.display = "none";
        els.gridMore.innerHTML = "";
      }
    }

    els.empty.style.display = showItems.length ? "none" : "block";
    if (!showItems.length) els.empty.innerHTML = emptyMessage();
  }


  function renderStats() {
    const { today, total } = AIRadar.statsFor(state.items);
    els.statToday.textContent = today;
    els.statSources.textContent = state.sourcesActiveCount ?? "\u2014";
    const mode =
      state.mode === "snapshot"
        ? "snapshot"
        : state.mode === "cache" || state.fromCache
        ? "cached"
        : "live";
    els.statUpdated.textContent = mode;
  }

  function setLoading(on) {
    els.loading.style.display = on ? "block" : "none";
  }

  function showError(msg) {
    els.error.textContent = msg || "";
    els.error.style.display = msg ? "block" : "none";
  }

  /* ---------------- Events ---------------- */

  function setupEvents() {
    els.chips.addEventListener("click", (e) => {
      const chip = e.target.closest(".filter-chip");
      if (!chip) return;
      state.category = chip.dataset.cat;
      state.page = 1;
      renderChips();
      renderAll();
    });

    els.rangeTabs.addEventListener("click", (e) => {
      const chip = e.target.closest(".range-chip");
      if (!chip) return;
      state.range = chip.dataset.range;
      state.page = 1;
      renderRangeTabs();
      renderStats();
      renderAll();
    });

    els.sourceBar.addEventListener("click", (e) => {
      const chip = e.target.closest(".source-chip");
      if (!chip) return;
      const src = chip.dataset.src;
      if (src === "all") state.sources = new Set();
      else if (state.sources.has(src)) state.sources.delete(src);
      else state.sources.add(src);
      state.page = 1;
      renderSourceBar();
      renderAll();
    });

    els.search.addEventListener("input", (e) => {
      state.search = e.target.value.trim();
      state.page = 1;
      renderAll();
    });

    if (els.gridMore) {
      els.gridMore.addEventListener("click", (e) => {
        if (!e.target.closest(".btn-more")) return;
        state.page += 1;
        renderAll();
      });
    }

    const groupToggle = document.getElementById("group-toggle");
    if (groupToggle) {
      groupToggle.addEventListener("change", (e) => {
        state.group = e.target.checked;
        state.page = 1;
        renderAll();
      });
    }

    els.refresh.addEventListener("click", () => {
      state.refresh = true;
      load(true);
    });

    els.error.addEventListener("click", () => load(true));
  }

  /* ---------------- Boot ---------------- */

  async function load(force) {
    setLoading(true);
    try {
      await AIRadar.ensureSources();
      const result = await AIRadar.aggregate({ force: force || state.refresh });
      state.refresh = false;
      state.mode = result.mode || (result.fromCache ? "cache" : "live");
      state.fetchedAt = result.fetchedAt || Date.now();
      const items = result.items;
      if (!items.length) {
        // Fall back to embedded sample so the site is never empty.
        state.items = SAMPLE_ITEMS;
        state.mode = "sample";
        showError("Live feeds are unreachable right now – showing sample content.");
      } else {
        state.items = items;
        showError("");
      }
      state.sourcesActiveCount = new Set(state.items.map((i) => i.sourceId)).size;
      state.sources = state.sources.size
        ? new Set([...state.sources].filter((s) => sourceList().some((x) => x.id === s)))
        : state.sources;
      renderSourceBar();
      renderAll();
      renderStats();
      const count = sourceList().length || state.sourcesActiveCount;
      const updatedInfo = state.mode === "snapshot"
        ? "Automatic snapshot generated " + timeAgo(new Date(state.fetchedAt)) + " from " + count + " sources."
        : state.mode === "cache"
        ? "Showing cached snapshot — pull to refresh for the latest."
        : "Fetched live from " + count + " sources.";
      els.footerStatus.textContent = updatedInfo;
    } catch (e) {
      showError("Could not load news. Click here to try again.");
    } finally {
      setLoading(false);
    }
  }

  /* Expose a small contract for the dashboard layer: read current filter state
   * and/or jump the search box to a token (e.g. when an entity/tag chip is
   * clicked). Falls back gracefully if the dashboard layer is absent. */
  window.AIRadarHooks = {
    getState: function () {
      return state;
    },
    setSearch: function (token) {
      if (els.search) els.search.value = token || "";
      state.search = (token || "").trim();
      state.page = 1;
      renderAll();
    },
  };

  if (window.AIRadarDashboard && typeof window.AIRadarDashboard.attach === "function") {
    window.AIRadarDashboard.attach();
  }

  renderSourceBar();
  renderChips();
  renderRangeTabs();
  renderClock();
  setInterval(renderClock, 30000);
  setInterval(renderAll, 60000);
  setupEvents();
  load(false);
})();