(function () {
  "use strict";

  if (typeof window === "undefined" || typeof document === "undefined") return;

  const T = window.AIRadarTrends;
  if (!T) return;

  const els = {
    view: document.getElementById("trends-view"),
    toggle: document.getElementById("trends-toggle"),
    range: document.getElementById("trends-range"),
    status: document.getElementById("trends-status"),
    error: document.getElementById("trends-error"),
    stats: document.getElementById("trends-stats"),
    summary: document.getElementById("trends-summary"),
    volume: document.getElementById("trends-chart-volume"),
    score: document.getElementById("trends-chart-score"),
    bands: document.getElementById("trends-bands"),
    categories: document.getElementById("trends-categories"),
    trending: document.getElementById("trends-trending"),
    entities: document.getElementById("trends-entities"),
    sources: document.getElementById("trends-sources"),
    empty: document.getElementById("trends-empty"),
  };

  const state = {
    records: [],
    usingFallback: false,
    range: "all",
    active: false,
    loading: false,
  };

  function escapeHtml(s) {
    return (s == null ? "" : String(s))
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function categoryMeta(id) {
    return (window.CATEGORIES || []).find((c) => c.id === id) || { label: "News", icon: "📰" };
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
      const txt = await fetchText(dbDayFileUrl(day), 8000);
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

  async function loadFallback() {
    const snap = await fetchJson(SNAPSHOT_PATH);
    const items = Array.isArray(snap.items) ? snap.items : [];
    return { records: items, days: null, updatedAt: snap.generatedAt || null };
  }

  function renderRangeChips() {
    if (!els.range) return;
    const ranges = [
      ["all", "All"],
      ["30d", "30 days"],
      ["7d", "7 days"],
    ];
    els.range.innerHTML = ranges
      .map(
        (o) =>
          '<button type="button" class="facet-chip' +
          (state.range === o[0] ? " active" : "") +
          '" data-range="' +
          o[0] +
          '">' +
          o[1] +
          "</button>"
      )
      .join("");
  }

  function chartAxis(firstDay, mid, lastDay) {
    return (
      '<div class="chart-axis"><span>' +
      escapeHtml(firstDay) +
      "</span><span>" +
      escapeHtml(mid) +
      "</span><span>" +
      escapeHtml(lastDay) +
      "</span></div>"
    );
  }

  function volumeChart(s) {
    if (!s || s.length < 2) return '<div class="chart-note">Not enough dated stories for a volume chart yet.</div>';
    const w = 720;
    const h = 110;
    const pad = 6;
    let max = 1;
    for (const d of s) if (d.count > max) max = d.count;
    const pts = s.map((d, i) => {
      const x = (i / (s.length - 1)) * (w - pad * 2) + pad;
      const y = h - pad - (d.count / max) * (h - pad * 2);
      return x.toFixed(1) + "," + y.toFixed(1);
    });
    let peak = s[0];
    for (const d of s) if (d.count > peak.count) peak = d;
    return (
      '<div class="chart-block">' +
      '<svg class="trend-chart" viewBox="0 0 ' +
      w +
      " " +
      h +
      '" role="img" aria-label="Story volume per day; peak ' +
      peak.count +
      " on " +
      escapeHtml(peak.day) +
      '" preserveAspectRatio="none">' +
      '<polyline class="chart-line" points="' +
      pts.join(" ") +
      '"/></svg>' +
      chartAxis(s[0].day, "Peak " + peak.day + " · " + peak.count, s[s.length - 1].day) +
      "</div>"
    );
  }

  function scoreChart(s) {
    const pts = (s || []).filter((d) => d.avgScore != null);
    if (pts.length < 2) return '<div class="chart-note">Add more scored stories for a score trend.</div>';
    const w = 720;
    const h = 110;
    const pad = 6;
    const vals = pts.map((d) => d.avgScore);
    let lo = vals[0];
    let hi = vals[0];
    for (const v of vals) {
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    const span = hi - lo || 1;
    const plot = pts.map((d, i) => {
      const x = (i / (pts.length - 1)) * (w - pad * 2) + pad;
      const y = h - pad - ((d.avgScore - lo) / span) * (h - pad * 2);
      return x.toFixed(1) + "," + y.toFixed(1);
    });
    return (
      '<div class="chart-block">' +
      '<svg class="trend-chart" viewBox="0 0 ' +
      w +
      " " +
      h +
      '" role="img" aria-label="Average radar score per day, ranging ' +
      lo +
      " to " +
      hi +
      '" preserveAspectRatio="none">' +
      '<polyline class="chart-line score-line" points="' +
      plot.join(" ") +
      '"/></svg>' +
      chartAxis(pts[0].day, lo + " – " + hi, pts[pts.length - 1].day) +
      "</div>"
    );
  }

  function bandsHtml(v) {
    const bands = [
      ["high", "High (70+)"],
      ["medium", "Medium (40-69)"],
      ["low", "Low (<40)"],
      ["unknown", "Unscored"],
    ];
    const total = (v.high || 0) + (v.medium || 0) + (v.low || 0) + (v.unknown || 0) || 1;
    return (
      '<div class="signal-bars">' +
      bands
        .map((b) => {
          const n = v[b[0]] || 0;
          const pct = Math.round((n / total) * 100);
          return (
            '<div class="bar-row"><span class="bar-label">' +
            b[1] +
            '</span><span class="bar-track"><span class="bar-fill band-' +
            b[0] +
            '" style="width:' +
            pct +
            '%"></span></span><span class="bar-num">' +
            n +
            " · " +
            pct +
            "%</span></div>"
          );
        })
        .join("") +
      "</div>"
    );
  }

  function categoriesHtml(list) {
    if (!list.length) return '<div class="chart-note">No categorized stories in this range yet.</div>';
    let total = 0;
    for (const c of list) total += c.count;
    return (
      '<div class="signal-bars">' +
      list
        .map((c) => {
          const meta = categoryMeta(c.id);
          const pct = Math.round((c.count / (total || 1)) * 100);
          return (
            '<div class="bar-row"><span class="bar-label">' +
            escapeHtml(meta.icon + " " + meta.label) +
            '</span><span class="bar-track"><span class="bar-fill" style="width:' +
            pct +
            '%"></span></span><span class="bar-num">' +
            c.count +
            " · " +
            c.pct +
            "%</span></div>"
          );
        })
        .join("") +
      "</div>"
    );
  }

  function leaderboardHtml(list, label) {
    if (!list.length) return "";
    return (
      '<div class="leaderboard"><h4 class="leader-title">' +
      escapeHtml(label) +
      '</h4><ul class="rank-list">' +
      list
        .map((e, i) => {
          const chip =
            e.direction || e.pct == null
              ? ""
              : '<span class="trend-chip trend-' +
                (e.direction === "up" ? "up" : e.direction === "down" ? "down" : "flat") +
                '">' +
                (e.pct >= 0 ? "+" : "") +
                e.pct +
                "% ▲</span>";
          return (
            '<li class="rank-item"><span class="rank-num">' +
            (i + 1) +
            '</span><span class="rank-name">' +
            escapeHtml(e.name) +
            '</span><span class="rank-count">' +
            e.count +
            (e.count === 1 ? " story" : " stories") +
            "</span>" +
            chip +
            "</li>"
          );
        })
        .join("") +
      "</ul></div>"
    );
  }

  function trendingBlock(groups) {
    const html = [];
    if (groups.companies.length) html.push('<h4 class="trend-sub">Companies</h4>' + trendingList(groups.companies));
    if (groups.models.length) html.push('<h4 class="trend-sub">Models</h4>' + trendingList(groups.models));
    if (groups.tags.length) html.push('<h4 class="trend-sub">Tags</h4>' + trendingList(groups.tags));
    if (!html.length) return '<div class="chart-note">Not enough history for a 7-day vs prior-7 comparison yet.</div>';
    return html.join("");
  }

  function trendingList(list) {
    return (
      '<ul class="rank-list">' +
      list
        .map((e, i) => {
          let chip = "";
          const after = e.direction === "new" ? "NEW" : e.direction === "down" ? (e.pct == null ? "—" : e.pct + "%") : e.pct + "%";
          const arrow = e.direction === "up" ? "▲" : e.direction === "down" ? "▼" : e.direction === "new" ? "✦" : "＝";
          const cls = e.direction === "up" ? "trend-up" : e.direction === "down" ? "trend-down" : e.direction === "new" ? "trend-new" : "trend-flat";
          chip = '<span class="trend-chip ' + cls + '">' + arrow + " " + escapeHtml(after) + "</span>";
          return (
            '<li class="rank-item"><span class="rank-num">' +
            (i + 1) +
            '</span><span class="rank-name">' +
            escapeHtml(e.name) +
            '</span><span class="rank-count">' +
            e.current +
            (e.current === 1 ? " story" : " stories") +
            "</span>" +
            chip +
            "</li>"
          );
        })
        .join("") +
      "</ul>"
    );
  }

  function entitiesHtml(entities) {
    const groups = [
      ["companies", "Companies"],
      ["models", "Models"],
      ["people", "People"],
      ["technologies", "Technologies"],
      ["tags", "Tags"],
    ];
    let html = "";
    for (const g of groups) html += leaderboardHtml(entities[g[0]] || [], g[1]);
    return html || '<div class="chart-note">No entities recognized in this range.</div>';
  }

  function sourcesHtml(list) {
    if (!list.length) return '<div class="chart-note">No sources in this range.</div>';
    return (
      '<ul class="rank-list">' +
      list
        .map(
          (s, i) =>
            '<li class="rank-item"><span class="rank-num">' +
            (i + 1) +
            '</span><span class="rank-name">' +
            escapeHtml(s.name) +
            '</span><span class="rank-count">' +
            s.count +
            (s.count === 1 ? " story" : " stories") +
            "</span></li>"
        )
        .join("") +
      "</ul>"
    );
  }

  function statsHtml(r) {
    const rangeLabel = r.range === "7d" ? "7 days" : r.range === "30d" ? "30 days" : "All time";
    const peakEl = r.peak ? r.peak.day + " · " + r.peak.count : "—";
    const stats = [
      ["Stories in view", String(r.total)],
      ["Active days", String(r.activeDays || 0)],
      ["Avg Radar Score", r.avgScore == null ? "n/a" : String(r.avgScore)],
      ["Peak day", peakEl],
      ["Window", rangeLabel + (r.start ? " (" + r.start + " → " + r.end + ")" : "")],
    ];
    return (
      '<div class="trend-stats">' +
      stats
        .map(
          (s) =>
            '<div class="trend-stat"><b>' +
            escapeHtml(s[1]) +
            "</b><span>" +
            escapeHtml(s[0]) +
            "</span></div>"
        )
        .join("") +
      "</div>"
    );
  }

  function summaryHtml(r) {
    if (!r.facts.length) return "";
    return (
      "Trends at a glance: " +
      r.facts
        .map((f) => "<strong>" + escapeHtml(f.label) + "</strong> " + escapeHtml(f.value))
        .join(" · ")
    );
  }

  function render() {
    const r = T.aggregate(state.records, { range: state.range });
    if (els.stats) els.stats.innerHTML = statsHtml(r);
    if (els.summary) els.summary.innerHTML = summaryHtml(r);
    if (els.volume) els.volume.innerHTML = volumeChart(r.series);
    if (els.score) els.score.innerHTML = scoreChart(r.series);
    if (els.bands) els.bands.innerHTML = bandsHtml(r.variance);
    if (els.categories) els.categories.innerHTML = categoriesHtml(r.categories);
    if (els.trending) els.trending.innerHTML = trendingBlock(r.trending);
    if (els.entities) els.entities.innerHTML = entitiesHtml(r.entities);
    if (els.sources) els.sources.innerHTML = sourcesHtml(r.sources);
    if (els.empty) els.empty.style.display = r.total ? "none" : "block";
    if (els.status) {
      els.status.textContent = state.usingFallback
        ? "Archive unavailable — analyzing the current live snapshot instead."
        : "Analyzed " + r.total + " stories across " + (r.activeDays || 0) + " active days (" + r.start + " → " + r.end + ").";
    }
  }

  function bindEvents() {
    if (els.range) {
      els.range.addEventListener("click", (e) => {
        const chip = e.target.closest(".facet-chip");
        if (!chip || !chip.dataset.range) return;
        state.range = chip.dataset.range;
        renderRangeChips();
        render();
      });
    }
    if (els.toggle) {
      els.toggle.addEventListener("click", () => {
        setView(!state.active);
      });
    }
  }

  function setView(active) {
    state.active = active;
    if (els.view) els.view.style.display = active ? "block" : "none";
    if (els.toggle) {
      els.toggle.classList.toggle("active", active);
      els.toggle.setAttribute("aria-pressed", active ? "true" : "false");
    }
    if (window.AIRadarHooks && typeof window.AIRadarHooks.activateView === "function") {
      window.AIRadarHooks.activateView(active ? "trends" : "live");
    }
    if (active && state.records.length === 0 && !state.loading) {
      init();
    }
  }

  async function init() {
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
      renderRangeChips();
      render();
      if (els.error) els.error.style.display = "none";
    } catch (e) {
      if (els.error) {
        els.error.style.display = "block";
        els.error.textContent = "Could not load trends. " + (e && e.message ? e.message : "");
      }
    } finally {
      state.loading = false;
    }
  }

  bindEvents();
  setView(false);
})();