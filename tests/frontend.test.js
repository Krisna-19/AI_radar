/*
 * Stage 8 tests: dashboard helpers (js/dashboard.js).
 * Uses node:test (zero extra dependencies) and requires only the pure,
 * DOM-free helpers of the dashboard module, so no browser is needed.
 *
 * Covers: radar score bands/colors/labels, percent rounding, deterministic
 * donut arc paths, AI summary selection (summary preferred over description,
 * fallback to description, never fabricated), summary method, entity/tag
 * chip collection, subcategory grouping (ordering + other-last), virtual grid
 * slicing/paging, and top-signal selection. Also verifies the dashboard does
 * not disturb the Stage 1-7 canonical Story contract it depends on.
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert");

const Core = require("../js/shared.js");
const D = require("../js/dashboard.js");

/* A minimal canonical-shaped story with the fields the dashboard reads.
 * Built through the real Core.normalizeItem so it is genuinely schema-valid
 * (Stage 3 contract), then layered with the stage 5/6/7 fields the dashboard
 * consumes (radarScore, subcategory, ai, entities, tags). */
function story(overrides) {
  const source = {
    id: "demo",
    name: "Demo",
    category: "media",
    reliability: 6,
    priority: 100,
    weight: 3,
    color: "#666",
  };
  const s = Core.normalizeItem(
    {
      title: "A sample AI story",
      link: "https://example.com/story/1",
      description: "A longer descriptive body used when no summary exists.",
    },
    source,
    { nowMs: Date.UTC(2026, 8, 1, 10, 0, 0) }
  );
  s.radarScore = 80;
  s.score = 4;
  s.subcategory = "model";
  s.tags = [];
  s.companies = [];
  s.people = [];
  s.models = [];
  s.technologies = [];
  s.ai = { summary: null, whyItMatters: null, keyTakeaways: [], method: null };
  return Object.assign(s, overrides || {});
}

/* ------------------------------------------------------------------ */
/* Radar score bands (color + explicit text label - never color-only)  */
/* ------------------------------------------------------------------ */

test("radarBand maps high/medium/low/missing scores to label+color+band", () => {
  assert.deepStrictEqual(D.radarBand(100), { band: "high", color: "#22d3a5", label: "High" });
  assert.deepStrictEqual(D.radarBand(70), { band: "high", color: "#22d3a5", label: "High" });
  assert.deepStrictEqual(D.radarBand(69), { band: "medium", color: "#f59e0b", label: "Medium" });
  assert.deepStrictEqual(D.radarBand(40), { band: "medium", color: "#f59e0b", label: "Medium" });
  assert.deepStrictEqual(D.radarBand(39), { band: "low", color: "#8b96a9", label: "Low" });
  assert.deepStrictEqual(D.radarBand(0), { band: "low", color: "#8b96a9", label: "Low" });
});

test("radarBand handles invalid/negative/over-100 scores safely", () => {
  assert.strictEqual(D.radarBand(undefined).band, "unknown");
  assert.strictEqual(D.radarBand(null).band, "unknown");
  assert.strictEqual(D.radarBand(NaN).band, "unknown");
  assert.strictEqual(D.radarBand("80").band, "unknown");
  assert.strictEqual(D.radarBand(-10).label, "Low");
  assert.strictEqual(D.radarBand(150).label, "High");
});

test("radarPct clamps and rounds, and is null for non-numeric", () => {
  assert.strictEqual(D.radarPct(81.4), 81);
  assert.strictEqual(D.radarPct(100), 100);
  assert.strictEqual(D.radarPct(120), 100);
  assert.strictEqual(D.radarPct(-5), 0);
  assert.strictEqual(D.radarPct(null), null);
  assert.strictEqual(D.radarPct("90"), null);
});

/* ------------------------------------------------------------------ */
/* Deterministic donut arc paths                                       */
/* ------------------------------------------------------------------ */

test("arcPath is deterministic and yields an empty string for zero", () => {
  const a = D.arcPath(50, 20, 18, 15);
  assert.strictEqual(typeof a, "string");
  assert.strictEqual(a, D.arcPath(50, 20, 18, 15));
  assert.strictEqual(D.arcPath(0, 20, 18, 15), "");
  assert.strictEqual(D.arcPath(-5, 20, 18, 15), "");
});

test("arcPath emits two arcs for a full circle (100%)", () => {
  const full = D.arcPath(100, 20, 18, 15);
  assert.ok(full.indexOf("A 15 15 0 1 1") !== -1);
  assert.ok((full.match(/A /g) || []).length >= 2);
});

/* ------------------------------------------------------------------ */
/* AI summary: real summary preferred, description fallback, no fake   */
/* ------------------------------------------------------------------ */

test("summaryText prefers a real ai.summary over description", () => {
  const s = story({
    description: "Long description body.",
    ai: { summary: "Concise real summary", whyItMatters: null, keyTakeaways: [], method: "extractive" },
  });
  assert.strictEqual(D.summaryText(s), "Concise real summary");
});

test("summaryText falls back to description when no summary exists", () => {
  assert.strictEqual(D.summaryText(story()), "A longer descriptive body used when no summary exists.");
});

test("summaryText returns null when neither summary nor description exists, never title", () => {
  const s = story({ description: null, ai: { summary: null, whyItMatters: null, keyTakeaways: [], method: null } });
  assert.strictEqual(D.summaryText(s), null);
  // title is explicitly not used as a fabricated summary
  assert.notStrictEqual(D.summaryText(s), "A sample AI story");
});

test("summaryText ignores blank/whitespace summaries", () => {
  const s = story({ ai: { summary: "   ", whyItMatters: null, keyTakeaways: [], method: null } });
  assert.strictEqual(D.summaryText(s), "A longer descriptive body used when no summary exists.");
});

test("summaryMethod returns the method or null", () => {
  assert.strictEqual(D.summaryMethod(story()), null);
  assert.strictEqual(
    D.summaryMethod(story({ ai: { summary: "x", whyItMatters: null, keyTakeaways: [], method: "llm" } })),
    "llm"
  );
});

/* ------------------------------------------------------------------ */
/* Entity + tag chips                                                  */
/* ------------------------------------------------------------------ */

test("collectChips gathers companies, people, models, technologies and tags, de-duplicated and stable", () => {
  const s = story({
    companies: ["OpenAI"],
    people: ["Sam Altman"],
    models: ["GPT-5"],
    technologies: ["RAG"],
    tags: ["Inference", "RAG"],
  });
  assert.deepStrictEqual(D.collectChips(s), ["OpenAI", "Sam Altman", "GPT-5", "RAG", "Inference"]);
});

test("collectChips returns empty array for a story with no entities/tags", () => {
  assert.deepStrictEqual(D.collectChips(story()), []);
  assert.deepStrictEqual(D.collectChips(null), []);
});

/* ------------------------------------------------------------------ */
/* Subcategory grouping                                                */
/* ------------------------------------------------------------------ */

test("groupBySubcategory groups and places 'other' last", () => {
  const items = [
    story({ id: "s00000001", subcategory: "other" }),
    story({ id: "s00000002", subcategory: "model" }),
    story({ id: "s00000003", subcategory: "model" }),
    story({ id: "s00000004", subcategory: "safety" }),
  ];
  const groups = D.groupBySubcategory(items);
  assert.deepStrictEqual(
    groups.map((g) => g.label),
    ["model", "safety", "other"]
  );
  assert.strictEqual(groups[0].count, 2);
  assert.strictEqual(groups[2].count, 1);
});

test("groupBySubcategory is empty-safe and deterministic", () => {
  assert.deepStrictEqual(D.groupBySubcategory([]), []);
  assert.deepStrictEqual(D.groupBySubcategory(null), []);
  const a = D.groupBySubcategory([story({ subcategory: "model" }), story({ subcategory: "tools" })]);
  const b = D.groupBySubcategory([story({ subcategory: "model" }), story({ subcategory: "tools" })]);
  assert.deepStrictEqual(a, b);
});

/* ------------------------------------------------------------------ */
/* Virtual grid slicing / paging                                       */
/* ------------------------------------------------------------------ */

function many(n) {
  return Array.from({ length: n }, (_, i) => story({ id: "s" + String(i).padStart(8, "0") }));
}

test("windowSlice renders the requested page and reports hasMore/hasPrev", () => {
  const w = D.windowSlice(many(100), 1, 40);
  assert.strictEqual(w.slice.length, 40);
  assert.strictEqual(w.total, 100);
  assert.strictEqual(w.pages, 3);
  assert.strictEqual(w.hasMore, true);
  assert.strictEqual(w.hasPrev, false);

  const w2 = D.windowSlice(many(100), 3, 40);
  assert.strictEqual(w2.slice.length, 20);
  assert.strictEqual(w2.hasMore, false);
  assert.strictEqual(w2.hasPrev, true);
});

test("windowSlice clamps page/pageSize and handles empty safely", () => {
  const w = D.windowSlice(many(10), 99, 5);
  assert.strictEqual(w.page, 2);
  assert.strictEqual(w.hasMore, false);
  const e = D.windowSlice([], 1, 40);
  assert.strictEqual(e.total, 0);
  assert.deepStrictEqual(e.slice, []);
});

/* ------------------------------------------------------------------ */
/* Top signal selection                                                */
/* ------------------------------------------------------------------ */

test("topSignal picks the highest radarScore, ties broken by newest publishedAt", () => {
  const a = story({ id: "s00000001", radarScore: 60, publishedAt: "2026-09-01T10:00:00.000Z" });
  const b = story({ id: "s00000002", radarScore: 90, publishedAt: "2026-09-01T09:00:00.000Z" });
  const c = story({ id: "s00000003", radarScore: 90, publishedAt: "2026-09-01T11:00:00.000Z" });
  assert.strictEqual(D.topSignal([a, b, c]), c);
  assert.strictEqual(D.topSignal([a]), a);
  assert.strictEqual(D.topSignal([]), null);
  assert.strictEqual(D.topSignal(null), null);
});

/* ------------------------------------------------------------------ */
/* Contract safety: dashboard helpers never mutate the Story           */
/* ------------------------------------------------------------------ */

test("dashboard helpers do not mutate their inputs", () => {
  const s = story({
    companies: ["OpenAI"],
    tags: ["Inference"],
    ai: { summary: "x", whyItMatters: null, keyTakeaways: [], method: "extractive" },
  });
  const snapshot = JSON.stringify(s);
  D.collectChips(s);
  D.summaryText(s);
  D.radarBand(s.radarScore);
  D.groupBySubcategory([s]);
  assert.strictEqual(JSON.stringify(s), snapshot);
  // And it still satisfies the canonical schema validator (Stage 3 contract).
  assert.strictEqual(Core.validateStory(s).valid, true);
});
