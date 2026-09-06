(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.AIRadarPipelineOps = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  function classify(status) {
    if (status === "error") return "error";
    if (status === "ok") return "ok";
    return "warning";
  }

  function runStatus(record) {
    const s = record || {};
    const n = function (v) {
      return typeof v === "number" ? v : 0;
    };
    const err = n(s.sourcesError);
    const warn = n(s.sourcesWarning);
    if (err > 0) return "error";
    if (warn > 0) return "degraded";
    return "ok";
  }

  function summarizeRun(record) {
    const s = record || {};
    const n = function (v) {
      return typeof v === "number" ? v : null;
    };
    return {
      runId: s.runId || null,
      status: runStatus(s),
      createdAt: s.createdAt || null,
      startedAt: s.startedAt || null,
      finishedAt: s.finishedAt || null,
      stored: n(s.stored),
      upserted: n(s.upserted),
      storedDays: n(s.storedDays),
      radarMean: n(s.radarMean),
      summarized: n(s.summarized),
      sourcesOk: n(s.sourcesOk),
      sourcesWarning: n(s.sourcesWarning),
      sourcesError: n(s.sourcesError),
      degraded: !!s.degraded,
    };
  }

  function summarizeSources(sources) {
    const list = Array.isArray(sources) ? sources : [];
    const result = {
      total: list.length,
      ok: 0,
      warning: 0,
      error: 0,
      health: [],
      degraded: false,
    };
    for (const s of list) {
      const d = s || {};
      const status = classify(d.status);
      if (status === "ok") result.ok++;
      else if (status === "error") result.error++;
      else result.warning++;
      result.health.push({
        id: d.id || null,
        name: d.name || d.id || "unknown",
        status,
        itemCount: typeof d.itemCount === "number" ? d.itemCount : null,
        errorType: d.errorType || null,
        responseMs: typeof d.responseMs === "number" ? d.responseMs : null,
      });
    }
    result.degraded = result.warning + result.error > 0;
    return result;
  }

  function latestRun(runs) {
    const list = Array.isArray(runs) ? runs : [];
    if (!list.length) return null;
    const sorted = list.slice().sort(function (a, b) {
      return (a && a.finishedAt || "").localeCompare(b && b.finishedAt || "");
    });
    return sorted[sorted.length - 1];
  }

  function runHealthHistory(runs, limit) {
    const list = Array.isArray(runs) ? runs : [];
    const cap = typeof limit === "number" && limit > 0 ? limit : 30;
    return list
      .slice()
      .filter(function (r) {
        return r && r.finishedAt;
      })
      .sort(function (a, b) {
        return (b.finishedAt || "").localeCompare(a.finishedAt || "");
      })
      .slice(0, cap)
      .map(summarizeRun);
  }

  return {
    classify,
    runStatus,
    summarizeRun,
    summarizeSources,
    latestRun,
    runHealthHistory,
  };
});