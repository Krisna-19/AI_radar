(function () {
  "use strict";

  if (typeof window === "undefined" || typeof document === "undefined") return;

  const OPS = window.AIRadarPipelineOps;
  if (!OPS) return;

  const els = {
    view: document.getElementById("pipeline-view"),
    toggle: document.getElementById("pipeline-toggle"),
    status: document.getElementById("pipeline-status"),
    error: document.getElementById("pipeline-error"),
    banner: document.getElementById("pipeline-banner"),
    last: document.getElementById("pipeline-last"),
    sources: document.getElementById("pipeline-sources"),
    history: document.getElementById("pipeline-history"),
    empty: document.getElementById("pipeline-empty"),
  };

  const state = {
    runs: [],
    sources: [],
    lastRun: null,
    updatedAt: null,
    mode: null,
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

  function dbRunFileUrl(runId) {
    return "data/db/runs/" + runId + ".json";
  }

  function fmtDT(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return escapeHtml(String(iso));
    const pad = (n) => String(n).padStart(2, "0");
    const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    return (
      days[d.getUTCDay()] +
      " " +
      pad(d.getUTCMonth() + 1) +
      "/" +
      pad(d.getUTCDate()) +
      " " +
      pad(d.getUTCHours()) +
      ":" +
      pad(d.getUTCMinutes()) +
      " UTC"
    );
  }

  function statusChip(status) {
    const cls = status === "ok" ? "ok" : status === "error" ? "error" : "warn";
    const label = status === "ok" ? "Healthy" : status === "error" ? "Error" : "Degraded";
    return '<span class="status-chip chip-' + cls + '">' + label + "</span>";
  }

  function statCard(label, value) {
    return '<div class="run-stat"><b>' + escapeHtml(value) + "</b><span>" + escapeHtml(label) + "</span></div>";
  }

  function lastRunHtml() {
    const r = state.lastRun;
    if (!r) return "";
    const cards = [["Stored", String(r.stored == null ? "—" : r.stored)]];
    if (r.upserted != null) cards.push(["New", String(r.upserted)]);
    if (r.storedDays != null) cards.push(["Days", String(r.storedDays)]);
    if (r.radarMean != null) cards.push(["Radar avg", String(r.radarMean)]);
    if (r.summarized != null) cards.push(["Summarized", String(r.summarized)]);
    return (
      '<h4 class="run-title">' +
      statusChip(r.status) +
      " Last full build · " +
      fmtDT(r.finishedAt) +
      "</h4>" +
      '<div class="run-stats">' +
      cards.map((c) => statCard(c[0], c[1])).join("") +
      "</div>"
    );
  }

  function bannerHtml() {
    const sum = OPS.summarizeSources(state.sources);
    if (!sum.degraded) return "";
    const errors = sum.health.filter((h) => h.status === "error");
    const warns = sum.health.filter((h) => h.status === "warning");
    const parts = [];
    for (const e of errors) {
      parts.push(
        "<strong>" +
          escapeHtml(e.name) +
          "</strong> down" +
          (e.errorType ? " (" + escapeHtml(e.errorType) + ")" : "") +
          (e.itemCount == null ? "" : ", " + e.itemCount + " items")
      );
    }
    for (const w of warns) {
      parts.push("<strong>" + escapeHtml(w.name) + "</strong> empty");
    }
    const cls = errors.length ? "banner-error" : "banner-warn";
    return (
      '<div class="pipeline-banner ' +
      cls +
      '">Last build was partially degraded: ' +
      parts.join(" · ") +
      ".</div>"
    );
  }

  function sourcesHtml() {
    const sum = OPS.summarizeSources(state.sources);
    if (!sum.health.length)
      return '<div class="chart-note">No source health data yet — wait for a pipeline run, or check data/news.json.</div>';
    return (
      '<div class="health-chips">' +
      sum.health
        .map(
          (h) =>
            '<div class="health-chip chip-' +
            h.status +
            '"><b>' +
            escapeHtml(h.name) +
            "</b><span>" +
            (h.status === "ok"
              ? String(h.itemCount == null ? "ok" : h.itemCount + " items")
              : h.status === "error"
              ? (h.errorType ? escapeHtml(h.errorType) : "error") +
                (h.itemCount == null ? "" : " · " + h.itemCount + " items")
              : h.itemCount != null && h.itemCount > 0
              ? h.itemCount + " items"
              : "no items") +
            "</span></div>"
        )
        .join("") +
      "</div>" +
      '<p class="health-legend">' +
      sum.ok +
      " ok · " +
      sum.warning +
      " empty · " +
      sum.error +
      " error" +
      " · " +
      sum.total +
      " sources</p>"
    );
  }

  function historyHtml() {
    const list = OPS.runHealthHistory(state.runs, 30);
    if (!list.length) return "";
    return (
      '<table class="run-table"><thead><tr><th>Build</th><th>Status</th><th>Stored</th><th>Radar avg</th><th>Summarized</th><th>Sources ok-empty-err</th></tr></thead><tbody>' +
      list
        .map(
          (r) =>
            "<tr><td>" +
            fmtDT(r.finishedAt) +
            "</td><td>" +
            statusChip(r.status) +
            "</td><td>" +
            String(r.stored == null ? "—" : r.stored) +
            "</td><td>" +
            (r.radarMean == null ? "—" : String(r.radarMean)) +
            "</td><td>" +
            (r.summarized == null ? "—" : String(r.summarized)) +
            "</td><td>" +
            r.sourcesOk +
            "/" +
            r.sourcesWarning +
            "/" +
            r.sourcesError +
            "</td></tr>"
        )
        .join("") +
      "</tbody></table>"
    );
  }

  function render() {
    if (els.status) {
      els.status.textContent =
        state.mode === "snapshot"
          ? "Latest committed snapshot only (no run history yet)."
          : "Pipeline health from " + (state.updatedAt ? fmtDT(state.updatedAt) : "archive index") + ".";
    }
    if (els.banner) els.banner.innerHTML = bannerHtml();
    if (els.last) els.last.innerHTML = lastRunHtml();
    if (els.sources) els.sources.innerHTML = sourcesHtml();
    if (els.history) els.history.innerHTML = historyHtml();
    const empty = state.mode === "empty";
    if (els.empty) els.empty.style.display = empty ? "block" : "none";
  }

  async function loadSnapshotSources() {
    try {
      const snap = await fetchJson(SNAPSHOT_PATH);
      const prev = await fetchJson(SEARCH_DB_INDEX_PATH);
      const plot = [];
      for (const key of Object.keys(prev.days || {})) plot.push(key);
      const runs = (prev.runs || []).map((r) => ({ ...r }));
      const sources = Array.isArray(snap.sources) ? snap.sources : [];
      const srcSum = OPS.summarizeSources(sources);
      return {
        runs,
        sources,
        lastRun: {
          runId: null,
          status: srcSum.error > 0 ? "error" : srcSum.degraded ? "degraded" : "ok",
          finishedAt: snap.generatedAt || null,
          stored: null,
          storedDays: plot.length || null,
          radarMean: snap.stats && typeof snap.stats.radarMean === "number" ? snap.stats.radarMean : null,
          summarized:
            snap.stats && typeof snap.stats.summarized === "number" ? snap.stats.summarized : null,
        },
        updatedAt: null,
        mode: "snapshot",
      };
    } catch (e) {
      return { runs: [], sources: [], lastRun: null, updatedAt: null, mode: "empty" };
    }
  }

  async function loadRuns() {
    const idx = await fetchJson(SEARCH_DB_INDEX_PATH);
    const runs = idx.runs || [];
    if (!runs.length) return loadSnapshotSources();
    const list = OPS.runHealthHistory(runs, 10);
    let sources = [];
    for (const r of list) {
      try {
        const file = await fetchJson(dbRunFileUrl(r.runId));
        if (Array.isArray(file.sources) && file.sources.length) {
          sources = file.sources;
          break;
        }
      } catch (e) {
        continue;
      }
    }
    return {
      runs,
      sources,
      lastRun: list[0] || null,
      updatedAt: idx.updatedAt || null,
      mode: "runs",
    };
  }

  function bindEvents() {
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
      window.AIRadarHooks.activateView(active ? "pipeline" : "live");
    }
    if (active && !state.loading && state.mode === null) {
      init();
    }
  }

  async function init() {
    state.loading = true;
    try {
      const data = await loadRuns();
      state.runs = data.runs || [];
      state.sources = data.sources || [];
      state.lastRun = data.lastRun || null;
      state.updatedAt = data.updatedAt || null;
      state.mode = data.mode || "empty";
      render();
      if (els.error) els.error.style.display = "none";
    } catch (e) {
      try {
        const data = await loadSnapshotSources();
        state.runs = data.runs;
        state.sources = data.sources;
        state.lastRun = data.lastRun;
        state.updatedAt = data.updatedAt;
        state.mode = data.mode;
        render();
        if (els.error) els.error.style.display = "none";
      } catch (e2) {
        if (els.error) {
          els.error.style.display = "block";
          els.error.textContent = "Could not load pipeline data. " + (e2 && e2.message ? e2.message : "");
        }
      }
    } finally {
      state.loading = false;
    }
  }

  bindEvents();
  setView(false);
})();