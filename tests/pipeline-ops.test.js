/*
 * Stage 11 tests: pipeline health pure module (js/pipeline-ops.js).
 * Runs under node:test; the module is dual-loaded (exports in Node).
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert");

const OPS = require("../js/pipeline-ops.js");

/* ---------------- 1: classify / runStatus ---------------- */

test("classify maps statuses to ok / warning / error", () => {
  assert.strictEqual(OPS.classify("ok"), "ok");
  assert.strictEqual(OPS.classify("empty"), "warning");
  assert.strictEqual(OPS.classify("error"), "error");
  assert.strictEqual(OPS.classify("unknown"), "warning");
  assert.strictEqual(OPS.classify(undefined), "warning");
});

test("runStatus honors error over warning over ok", () => {
  assert.strictEqual(OPS.runStatus({}), "ok");
  assert.strictEqual(OPS.runStatus({ sourcesOk: 5, sourcesWarning: 0, sourcesError: 0 }), "ok");
  assert.strictEqual(OPS.runStatus({ sourcesOk: 4, sourcesWarning: 2, sourcesError: 0 }), "degraded");
  assert.strictEqual(OPS.runStatus({ sourcesOk: 4, sourcesWarning: 0, sourcesError: 1 }), "error");
  assert.strictEqual(OPS.runStatus({ sourcesOk: 4, sourcesWarning: 2, sourcesError: 1 }), "error");
  assert.strictEqual(OPS.runStatus(null), "ok");
});

/* ---------------- 2: summarizeRun ---------------- */

test("summarizeRun normalizes a raw run record", () => {
  const r = OPS.summarizeRun({
    runId: "abc",
    finishedAt: "2026-09-04T01:00:00Z",
    stored: 100,
    radarMean: 51.5,
    sourcesOk: 3,
    sourcesWarning: 1,
    sourcesError: 0,
    degraded: true,
  });
  assert.strictEqual(r.status, "degraded");
  assert.strictEqual(r.runId, "abc");
  assert.strictEqual(r.sourcesOk, 3);
  assert.strictEqual(r.degraded, true);
  assert.strictEqual(r.summarized, null); // missing -> null
});

/* ---------------- 3: summarizeSources ---------------- */

test("summarizeSources tallies health and preserves input order", () => {
  const sources = [
    { id: "openai", name: "OpenAI", status: "ok", itemCount: 10 },
    { id: "arxiv", name: "arXiv", status: "empty" },
    { id: "venturebeat", name: "VentureBeat", status: "error", errorType: "http", responseMs: 5000 },
  ];
  const s = OPS.summarizeSources(sources);
  assert.strictEqual(s.total, 3);
  assert.strictEqual(s.ok, 1);
  assert.strictEqual(s.warning, 1);
  assert.strictEqual(s.error, 1);
  assert.strictEqual(s.degraded, true);
  assert.deepStrictEqual(
    s.health.map((h) => h.id),
    ["openai", "arxiv", "venturebeat"]
  );
  assert.strictEqual(s.health[0].status, "ok");
  assert.strictEqual(s.health[2].errorType, "http");
  assert.strictEqual(s.health[2].responseMs, 5000);
});

test("summarizeSources is safe with null / empty / partial entries", () => {
  const s = OPS.summarizeSources(null);
  assert.strictEqual(s.total, 0);
  assert.strictEqual(s.degraded, false);

  const s2 = OPS.summarizeSources([null, { name: "Ghost", itemCount: 3 }, {}]);
  assert.strictEqual(s2.total, 3);
  assert.strictEqual(s2.warning, 3); // missing status -> warning
  assert.strictEqual(s2.health[0].name, "unknown");
  assert.strictEqual(s2.health[1].name, "Ghost");
  assert.strictEqual(s2.health[1].itemCount, 3);
});

/* ---------------- 4: latestRun / runHealthHistory ---------------- */

test("latestRun returns the most recently finished run", () => {
  const runs = [
    { runId: "a", finishedAt: "2026-09-03T10:00:00Z", sourcesOk: 5 },
    { runId: "b", finishedAt: "2026-09-03T13:00:00Z", sourcesOk: 4 },
    { runId: "c", finishedAt: "2026-09-04T09:00:00Z", sourcesOk: 3 },
  ];
  assert.strictEqual(OPS.latestRun(runs).runId, "c");
  assert.strictEqual(OPS.latestRun([]), null);
  assert.strictEqual(OPS.latestRun(null), null);
});

test("runHealthHistory sorts newest-first, honors limit, and normalizes", () => {
  const runs = [
    { runId: "a", finishedAt: "2026-09-03T10:00:00Z" },
    { runId: "b", finishedAt: "2026-09-04T09:00:00Z", sourcesError: 1 },
    { runId: "c", finishedAt: "2026-09-03T13:00:00Z", sourcesWarning: 1 },
    { runId: "d", finishedAt: null },
  ];
  const h = OPS.runHealthHistory(runs, 30);
  assert.deepStrictEqual(
    h.map((r) => r.runId),
    ["b", "c", "a"] // null finishedAt filtered out
  );
  assert.strictEqual(h[0].status, "error");
  assert.strictEqual(h[1].status, "degraded");
  assert.strictEqual(h[2].status, "ok");

  const capped = OPS.runHealthHistory(runs, 2);
  assert.strictEqual(capped.length, 2);
  assert.strictEqual(OPS.runHealthHistory(null, 2).length, 0);
});

/* ---------------- 5: determinism & purity ---------------- */

test("pure helpers do not mutate their inputs", () => {
  const runs = [
    { runId: "a", finishedAt: "2026-09-04T09:00:00Z" },
    { runId: "b", finishedAt: "2026-09-03T10:00:00Z" },
  ];
  const before = JSON.stringify(runs);
  OPS.runHealthHistory(runs, 1);
  OPS.latestRun(runs);
  assert.strictEqual(JSON.stringify(runs), before, "input array untouched");

  const sources = [{ id: "x", status: "ok" }];
  const sBefore = JSON.stringify(sources);
  OPS.summarizeSources(sources);
  assert.strictEqual(JSON.stringify(sources), sBefore);
  OPS.summarizeSources(sources);
});