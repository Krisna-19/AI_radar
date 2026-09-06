"use strict";

const test = require("node:test");
const assert = require("node:assert");

const T = require("../js/trends.js");

const RECORDS = [
  { id: "r1", title: "a", category: "research", radarScore: 85, publishedAt: "2026-06-08T10:00:00Z", companies: ["OpenAI"], models: ["GPT-5"], tags: ["safety"], source: { id: "arxiv", name: "arXiv" } },
  { id: "r2", title: "b", category: "news", radarScore: 45, publishedAt: "2026-06-08T12:00:00Z", companies: ["Google"], source: { id: "bbc", name: "BBC" } },
  { id: "r3", title: "c", category: "product", radarScore: 70, publishedAt: "2026-06-09T10:00:00Z", companies: ["OpenAI"], models: ["GPT-5"], source: { id: "techcrunch", name: "TechCrunch" } },
  { id: "r4", title: "d", category: "policy", publishedAt: "2026-06-10T10:00:00Z", companies: [], tags: ["policy"], source: { id: "politico", name: "Politico" } },
  { id: "r5", title: "e", category: "funding", radarScore: 20, publishedAt: "2026-06-11T10:00:00Z", companies: ["Google"], source: { id: "bbc", name: "BBC" } },
  { id: "r6", title: "f", category: "research", radarScore: null, publishedAt: "2026-06-12T10:00:00Z", companies: ["OpenAI"], tags: ["safety"], source: { id: "arxiv", name: "arXiv" } },
  { id: "r7", title: "g", category: "research", radarScore: 90, publishedAt: "2026-06-18T10:00:00Z", companies: ["OpenAI"], source: { id: "arxiv", name: "arXiv" } },
  { id: "r8", title: "h", category: "news", radarScore: 30, publishedAt: "2026-06-19T10:00:00Z", companies: ["OpenAI"], tags: ["agent"], source: { id: "bbc", name: "BBC" } },
  { id: "r9", title: "i", category: "research", radarScore: 60, publishedAt: "2026-06-19T12:00:00Z", companies: ["Anthropic"], models: ["Claude"], source: { id: "arxiv", name: "arXiv" } },
  { id: "r10", title: "j", category: "product", radarScore: 88, publishedAt: "2026-06-20T10:00:00Z", companies: ["OpenAI"], source: { id: "techcrunch", name: "TechCrunch" } },
];

test("utcDayOf prefers publishedAt, falls back to discoveredAt, null-safe", () => {
  assert.strictEqual(T.utcDayOf({ publishedAt: "2026-06-08T10:00:00Z" }), "2026-06-08");
  assert.strictEqual(T.utcDayOf({ discoveredAt: "2026-06-07T23:30:00Z" }), "2026-06-07");
  assert.strictEqual(T.utcDayOf({ publishedAt: "2026-06-08T10:00:00Z", discoveredAt: "2026-06-07T00:00:00Z" }), "2026-06-08");
  assert.strictEqual(T.utcDayOf({ publishedAt: "not-a-date" }), null);
  assert.strictEqual(T.utcDayOf({}), null);
  assert.strictEqual(T.utcDayOf(null), null);
});

test("windowBounds derives min/max for all and clamps 30d/7d to the latest day", () => {
  const all = T.windowBounds(RECORDS, "all");
  assert.deepStrictEqual(all, { start: "2026-06-08", end: "2026-06-20", mode: "all" });
  const d30 = T.windowBounds(RECORDS, "30d");
  assert.deepStrictEqual(d30, { start: "2026-05-22", end: "2026-06-20", mode: "30d" });
  const d7 = T.windowBounds(RECORDS, "7d");
  assert.deepStrictEqual(d7, { start: "2026-06-14", end: "2026-06-20", mode: "7d" });
  assert.deepStrictEqual(T.windowBounds([], "all"), { start: null, end: null, mode: "all" });
});

test("spanDays counts inclusive days", () => {
  assert.strictEqual(T.spanDays("2026-06-08", "2026-06-20"), 13);
  assert.strictEqual(T.spanDays("2026-06-08", "2026-06-08"), 1);
  assert.strictEqual(T.spanDays(null, "2026-06-08"), 0);
});

test("series is contiguous over the bounds and counts sum to the window total", () => {
  const s = T.series(RECORDS, "all");
  assert.strictEqual(s.length, 13);
  assert.strictEqual(s[0].day, "2026-06-08");
  assert.strictEqual(s[s.length - 1].day, "2026-06-20");
  const total = s.reduce((n, d) => n + d.count, 0);
  assert.strictEqual(total, 10);
  const zeroDays = s.filter((d) => d.count === 0).map((d) => d.day);
  assert.deepStrictEqual(zeroDays, ["2026-06-13", "2026-06-14", "2026-06-15", "2026-06-16", "2026-06-17"]);
});

test("series splits each day into radar bands", () => {
  const day8 = T.series(RECORDS, "all")[0];
  assert.deepStrictEqual({ high: day8.high, medium: day8.medium, low: day8.low, unknown: day8.unknown }, { high: 1, medium: 1, low: 0, unknown: 0 });
  const day12 = T.series(RECORDS, "all").find((d) => d.day === "2026-06-12");
  assert.strictEqual(day12.unknown, 1);
  assert.strictEqual(day12.avgScore, null);
});

test("bandOf mirrors the Stage 8 thresholds with an unknown band", () => {
  assert.strictEqual(T.bandOf(70), "high");
  assert.strictEqual(T.bandOf(100), "high");
  assert.strictEqual(T.bandOf(69), "medium");
  assert.strictEqual(T.bandOf(40), "medium");
  assert.strictEqual(T.bandOf(39), "low");
  assert.strictEqual(T.bandOf(0), "low");
  assert.strictEqual(T.bandOf(undefined), "unknown");
  assert.strictEqual(T.bandOf(null), "unknown");
  assert.strictEqual(T.bandOf("7"), "unknown");
});

test("avgScore is the mean of numerically scored records only", () => {
  assert.strictEqual(T.avgScore(RECORDS), 61);
  assert.strictEqual(T.avgScore([{ radarScore: null }, { radarScore: "80" }, { radarScore: 40 }]), 40);
  assert.strictEqual(T.avgScore([]), null);
});

test("distribution groups every record into exactly one band", () => {
  const d = T.distribution(RECORDS);
  assert.deepStrictEqual(d, { high: 4, medium: 2, low: 2, unknown: 2 });
  assert.strictEqual(d.high + d.medium + d.low + d.unknown, RECORDS.length);
});

test("categoryMix keeps canonical order, sums counts, computes percentages", () => {
  const c = T.categoryMix(RECORDS);
  assert.deepStrictEqual(c.map((x) => x.id), ["research", "product", "funding", "policy", "news"]);
  assert.deepStrictEqual(
    c.map((x) => x.count),
    [4, 2, 1, 1, 2]
  );
  const sumPct = c.reduce((n, x) => n + x.pct, 0);
  assert.ok(Math.abs(sumPct - 100) < 0.01);
});

test("countBy tallies array fields with deterministic desc/asc sort", () => {
  const companies = T.countBy(RECORDS, "companies");
  assert.deepStrictEqual(companies, [
    { name: "OpenAI", count: 6 },
    { name: "Google", count: 2 },
    { name: "Anthropic", count: 1 },
  ]);
  const tags = T.countBy(RECORDS, "tags");
  assert.deepStrictEqual(tags, [
    { name: "safety", count: 2 },
    { name: "agent", count: 1 },
    { name: "policy", count: 1 },
  ]);
});

test("sourceCounts groups by source id, keeps canonical name, sorts by count", () => {
  const s = T.sourceCounts(RECORDS);
  assert.deepStrictEqual(s[0], { id: "arxiv", name: "arXiv", count: 4 });
  assert.deepStrictEqual(s[1], { id: "bbc", name: "BBC", count: 3 });
  assert.deepStrictEqual(s[2], { id: "techcrunch", name: "TechCrunch", count: 2 });
  assert.deepStrictEqual(s[3], { id: "politico", name: "Politico", count: 1 });
});

test("topN clamps to the requested depth", () => {
  assert.deepStrictEqual(T.topN(T.countBy(RECORDS, "companies"), 2), [
    { name: "OpenAI", count: 6 },
    { name: "Google", count: 2 },
  ]);
  assert.deepStrictEqual(T.topN([], 8), []);
});

test("trendingFor compares last 7 days vs prior 7, marking new/flat/down", () => {
  const t = T.trendingFor(RECORDS, "companies");
  assert.deepStrictEqual(t[0], { name: "Anthropic", current: 1, previous: 0, pct: null, direction: "new" });
  assert.deepStrictEqual(t[1], { name: "OpenAI", current: 3, previous: 3, pct: 0, direction: "flat" });
  assert.deepStrictEqual(t[2], { name: "Google", current: 0, previous: 2, pct: -100, direction: "down" });
});

test("aggregate all-time window has correct totals, peak, variance, categories", () => {
  const a = T.aggregate(RECORDS, { range: "all" });
  assert.strictEqual(a.total, 10);
  assert.strictEqual(a.days, 13);
  assert.strictEqual(a.activeDays, 8);
  assert.strictEqual(a.range, "all");
  assert.strictEqual(a.avgScore, 61);
  assert.deepStrictEqual(a.peak, { day: "2026-06-08", count: 2 });
  assert.deepStrictEqual(a.variance, { high: 4, medium: 2, low: 2, unknown: 2 });
  assert.strictEqual(a.categories[0].id, "research");
  assert.strictEqual(a.sources[0].id, "arxiv");
  assert.strictEqual(a.entities.companies[0].name, "OpenAI");
  assert.strictEqual(a.facts.length, 8);
});

test("aggregate 7d window narrows totals to the page", () => {
  const a = T.aggregate(RECORDS, { range: "7d" });
  assert.strictEqual(a.total, 4);
  assert.strictEqual(a.days, 7);
  assert.strictEqual(a.activeDays, 3);
  assert.strictEqual(a.avgScore, 67);
  assert.deepStrictEqual(a.variance, { high: 2, medium: 1, low: 1, unknown: 0 });
});

test("aggregate 30d default fallback: unknown ranges behave like all", () => {
  const a = T.aggregate(RECORDS, { range: "quarter" });
  assert.strictEqual(a.range, "all");
  assert.strictEqual(a.total, 10);
});

test("aggregate is deterministic across repeated calls", () => {
  const a1 = T.aggregate(RECORDS, { range: "all" });
  const a2 = T.aggregate(RECORDS, { range: "all" });
  assert.deepStrictEqual(a1, a2);
});

test("aggregate never mutates input records", () => {
  const copy = RECORDS.map((r) => ({ ...r, companies: r.companies && r.companies.slice() }));
  T.aggregate(RECORDS, { range: "all" });
  T.series(RECORDS, "all");
  T.trendingFor(RECORDS, "companies");
  assert.deepStrictEqual(RECORDS.map((r) => r.id), copy.map((r) => r.id));
});

test("empty and null inputs are safe and yield an empty result", () => {
  for (const input of [[], null, undefined]) {
    const a = T.aggregate(input, { range: "all" });
    assert.strictEqual(a.total, 0);
    assert.strictEqual(a.activeDays, 0);
    assert.deepStrictEqual(a.series, []);
    assert.deepStrictEqual(a.categories, []);
    assert.deepStrictEqual(a.facts, []);
    assert.strictEqual(a.peak, null);
    assert.deepStrictEqual(a.variance, { high: 0, medium: 0, low: 0, unknown: 0 });
  }
});