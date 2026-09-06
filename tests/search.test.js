/*
 * Stage 9 tests: pure history search + filter helpers (js/search.js).
 * Uses node:test (zero extra dependencies) and requires only the DOM-free,
 * network-free dual-load module, mirroring how dashboard tests are organised.
 *
 * The module operates on canonical Story records exactly as persisted in
 * data/db/days/*.ndjson (and, on fallback, data/news.json items). It only ever
 * reads/filters stored fields - it never invents data. These tests assert:
 *   - tokenization + free-text matching (AND of tokens, case-insensitive)
 *   - importance bands mirroring the Stage 8 radarBand thresholds
 *   - deterministic facet derivation across the archive
 *   - facet semantics (AND across facets, OR within a facet)
 *   - date-window filtering (inclusive bounds, undated records excluded)
 *   - deterministic sorting (radarScore desc, publishedAt desc, id asc tiebreak)
 *   - pagination (clamping, hasMore/hasPrev)
 *   - read-only safety (inputs are never mutated)
 *   - empty / null / malformed-input safety
 *   - fallback contract for news.json-style (possibly unscored) items
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert");

const S = require("../js/search.js");

/* Canned canonical-shaped records spanning categories, entities, scores and
 * dates. `radarScore` is absent on one to model an unscored snapshot item. */
const RECORDS = [
  {
    id: "a",
    title: "OpenAI ships a new frontier model",
    description: "Announcement with benchmark details.",
    category: "news",
    subcategory: "frontier",
    companies: ["OpenAI"],
    models: ["GPT-5"],
    technologies: ["transformers"],
    radarScore: 82,
    publishedAt: "2025-05-01T10:00:00Z",
    source: { id: "bbc", name: "BBC" },
    tags: ["model"],
  },
  {
    id: "b",
    title: "Google demonstrates quantum error correction",
    description: "A milestone in quantum computing.",
    category: "papers",
    subcategory: "quantum",
    companies: ["Google", "Alphabet"],
    radarScore: 45,
    publishedAt: "2025-04-20T10:00:00Z",
    source: { id: "ctx", name: "Context" },
  },
  {
    id: "c",
    title: "Small local meetup recap",
    description: "Notes from a community event.",
    category: "community",
    subcategory: "events",
    radarScore: 22,
    publishedAt: "2025-06-01T10:00:00Z",
    source: { id: "local", name: "Local News" },
  },
  {
    id: "d",
    title: "Unscored snapshot item",
    description: "Appears in the live data/news.json fallback corpus.",
    category: "news",
    subcategory: "frontier",
    companies: ["Anthropic"],
    publishedAt: "2025-06-05T10:00:00Z",
    source: { id: "bbc", name: "BBC" },
    tags: ["agent"],
  },
];

test("tokenize splits on non-alphanumerics, lowercases, drops empties", () => {
  assert.deepStrictEqual(S.tokenize("OpenAI GPT-5!!"), ["openai", "gpt", "5"]);
  assert.deepStrictEqual(S.tokenize(""), []);
  assert.deepStrictEqual(S.tokenize(null), []);
  assert.deepStrictEqual(S.tokenize("   "), []);
});

test("matchesQuery is a case-insensitive AND over all tokens", () => {
  assert.strictEqual(S.matchesQuery(RECORDS[0], "openai"), true);
  assert.strictEqual(S.matchesQuery(RECORDS[0], "OPENAI"), true);
  assert.strictEqual(S.matchesQuery(RECORDS[0], "openai model frontier"), true);
  assert.strictEqual(S.matchesQuery(RECORDS[0], "openai zzz"), false);
  assert.strictEqual(S.matchesQuery(RECORDS[0], "quantum"), false);
});

test("matchesQuery matches against summary, tags, entities, not just title", () => {
  const rec = {
    id: "x",
    title: "Plain title",
    ai: { summary: "an anomalous insight" },
    tags: ["frontier"],
    companies: ["OpenAI"],
    models: ["GPT-5"],
    people: ["Sam"],
    technologies: ["GPU"],
  };
  assert.strictEqual(S.matchesQuery(rec, "anomalous"), true);
  assert.strictEqual(S.matchesQuery(rec, "frontier"), true);
  assert.strictEqual(S.matchesQuery(rec, "gpt 5"), true);
  assert.strictEqual(S.matchesQuery(rec, "sam"), true);
  assert.strictEqual(S.matchesQuery(rec, "gpu"), true);
  assert.strictEqual(S.matchesQuery(rec, "nothing-here"), false);
});

test("matchesQuery with empty query matches everything", () => {
  assert.strictEqual(S.matchesQuery(RECORDS[0], ""), true);
  assert.strictEqual(S.matchesQuery(RECORDS[0], null), true);
});

test("importanceBand mirrors radarBand thresholds (high>=70, med 40-69, low<40)", () => {
  assert.strictEqual(S.importanceBand(100), "high");
  assert.strictEqual(S.importanceBand(70), "high");
  assert.strictEqual(S.importanceBand(69), "medium");
  assert.strictEqual(S.importanceBand(40), "medium");
  assert.strictEqual(S.importanceBand(39), "low");
  assert.strictEqual(S.importanceBand(0), "low");
});

test("importanceBand treats missing/non-finite scores as low (prefers inclusion)", () => {
  assert.strictEqual(S.importanceBand(undefined), "low");
  assert.strictEqual(S.importanceBand(null), "low");
  assert.strictEqual(S.importanceBand(NaN), "low");
  assert.strictEqual(S.importanceBand("abc"), "low");
});

test("facets derives deterministic sorted options and min/max day", () => {
  const f = S.facets(RECORDS);
  assert.deepStrictEqual(f.companies, ["Alphabet", "Anthropic", "Google", "OpenAI"]);
  assert.ok(f.sources.includes("bbc"));
  assert.ok(f.sources.includes("Context"));
  assert.strictEqual(f.minDay, "2025-04-20");
  assert.strictEqual(f.maxDay, "2025-06-05");
});

test("applyFilters filters by category (exact, case-insensitive)", () => {
  const ids = S.applyFilters(RECORDS, { categories: ["news"] }).map((r) => r.id);
  assert.deepStrictEqual(ids.sort(), ["a", "d"]);
  const ids2 = S.applyFilters(RECORDS, { categories: ["NEWS"] }).map((r) => r.id);
  assert.deepStrictEqual(ids2.sort(), ["a", "d"]);
});

test("applyFilters filters by subcategory", () => {
  const ids = S.applyFilters(RECORDS, { subcategories: ["frontier"] }).map((r) => r.id);
  assert.deepStrictEqual(ids.sort(), ["a", "d"]);
  const none = S.applyFilters(RECORDS, { subcategories: ["mars-rover"] });
  assert.strictEqual(none.length, 0);
});

test("applyFilters filters by source by id or name, case-insensitive", () => {
  const byId = S.applyFilters(RECORDS, { sources: ["bbc"] }).map((r) => r.id);
  assert.deepStrictEqual(byId.sort(), ["a", "d"]);
  const byName = S.applyFilters(RECORDS, { sources: ["context"] }).map((r) => r.id);
  assert.deepStrictEqual(byName, ["b"]);
});

test("applyFilters companies facet ORs across values, ANDs with other facets", () => {
  const google = S.applyFilters(RECORDS, { companies: ["Google"] }).map((r) => r.id);
  assert.deepStrictEqual(google, ["b"]);
  const either = S.applyFilters(RECORDS, { companies: ["Google", "Anthropic"] })
    .map((r) => r.id)
    .sort();
  assert.deepStrictEqual(either, ["b", "d"]);
  const both = S.applyFilters(RECORDS, { companies: ["Google"], categories: ["news"] });
  assert.strictEqual(both.length, 0);
});

test("applyFilters importance facet matches bands; unscored defaults to low", () => {
  const high = S.applyFilters(RECORDS, { importance: ["high"] }).map((r) => r.id);
  assert.deepStrictEqual(high, ["a"]);
  const medium = S.applyFilters(RECORDS, { importance: ["medium"] }).map((r) => r.id);
  assert.deepStrictEqual(medium, ["b"]);
  const low = S.applyFilters(RECORDS, { importance: ["low"] }).map((r) => r.id);
  assert.deepStrictEqual(low.sort(), ["c", "d"]);
});

test("applyFilters importance can OR across multiple bands", () => {
  const ids = S.applyFilters(RECORDS, { importance: ["high", "medium"] })
    .map((r) => r.id)
    .sort();
  assert.deepStrictEqual(ids, ["a", "b"]);
});

test("applyFilters date window: inclusive bounds, undated excluded", () => {
  const from = S.applyFilters(RECORDS, { from: "2025-05-01" }).map((r) => r.id).sort();
  assert.deepStrictEqual(from, ["a", "c", "d"]);
  const to = S.applyFilters(RECORDS, { to: "2025-05-01" }).map((r) => r.id).sort();
  assert.deepStrictEqual(to, ["a", "b"]);
  const window = S.applyFilters(RECORDS, { from: "2025-04-20", to: "2025-05-01" })
    .map((r) => r.id)
    .sort();
  assert.deepStrictEqual(window, ["a", "b"]);
});

test("applyFilters combines free-text AND facets (no record invented)", () => {
  const r = S.applyFilters(RECORDS, { q: "bbc", categories: ["news"] }).map((r) => r.id);
  assert.deepStrictEqual(r, ["a", "d"]);
  const nothing = S.applyFilters(RECORDS, { q: "definitely-not-present" });
  assert.strictEqual(nothing.length, 0);
});

test("applyFilters never mutates input records (read-only guarantee)", () => {
  const copy = RECORDS.map((r) => ({ ...r, companies: r.companies && r.companies.slice() }));
  S.applyFilters(RECORDS, { companies: ["OpenAI"] });
  S.search(RECORDS, { q: "openai" }, 1, 10);
  assert.deepStrictEqual(RECORDS.map((r) => r.id), copy.map((r) => r.id));
});

test("applyFilters tolerates null/empty records and filters", () => {
  assert.strictEqual(S.applyFilters([null, undefined], {}).length, 0);
  assert.strictEqual(S.applyFilters(null, null).length, 0);
  assert.strictEqual(S.applyFilters(RECORDS, null).length, RECORDS.length);
});

test("sortHistory is deterministic: score desc, then date desc, then id asc", () => {
  const r = [
    { id: "z", radarScore: 50, publishedAt: "2025-01-01T00:00:00Z" },
    { id: "y", radarScore: 50, publishedAt: "2025-02-01T00:00:00Z" },
    { id: "x", radarScore: 80, publishedAt: "2024-01-01T00:00:00Z" },
    { id: "w", publishedAt: "2025-03-01T00:00:00Z" },
  ];
  const ids = S.sortHistory(r).map((x) => x.id);
  assert.deepStrictEqual(ids, ["x", "y", "z", "w"]);
  const again = S.sortHistory(r).map((x) => x.id);
  assert.deepStrictEqual(again, ids);
  assert.strictEqual(r[0].radarScore, 50, "input order preserved");
});

test("sortHistory is stable and does not mutate input", () => {
  const r = [
    { id: "1", radarScore: 10, publishedAt: "2025-01-01T00:00:00Z" },
    { id: "2", radarScore: 10, publishedAt: "2025-01-01T00:00:00Z" },
  ];
  const out = S.sortHistory(r);
  assert.deepStrictEqual(out.map((x) => x.id), ["1", "2"]);
  assert.strictEqual(r[0].id, "1");
});

test("paginate clamps page/pageSize and computes hasMore/hasPrev", () => {
  const items = Array.from({ length: 10 }, (_, i) => ({ id: String(i) }));
  const p1 = S.paginate(items, 0, 3); // page 0 -> clamped to 1
  assert.strictEqual(p1.page, 1);
  assert.strictEqual(p1.slice.length, 3);
  assert.strictEqual(p1.hasMore, true);
  assert.strictEqual(p1.hasPrev, false);
  assert.strictEqual(p1.total, 10);
  const p4 = S.paginate(items, 4, 3); // page beyond end -> clamped
  assert.strictEqual(p4.page, 4);
  assert.strictEqual(p4.slice.length, 1);
  assert.strictEqual(p4.hasMore, false);
  assert.strictEqual(p4.hasPrev, true);
});

test("search returns items, total, and pageInfo for the given page", () => {
  const r = S.search(RECORDS, { categories: ["news"] }, 1, 1);
  assert.strictEqual(r.total, 2);
  assert.strictEqual(r.items.length, 1);
  assert.strictEqual(r.pageInfo.hasMore, true);
  assert.strictEqual(r.pageInfo.page, 1);
});

test("fallback contract: news.json-style unscored items search inclusively", () => {
  // Simulate data/news.json items (no radarScore) flowing through on fallback.
  const fallback = [
    { id: "f1", title: "training run", category: "news", companies: ["OpenAI"] },
  ];
  assert.strictEqual(S.search(fallback, { q: "training" }, 1, 10).total, 1);
  assert.strictEqual(S.search(fallback, { importance: ["low"] }, 1, 10).total, 1);
  assert.strictEqual(S.search(fallback, { importance: ["high"] }, 1, 10).total, 0);
  assert.strictEqual(S.search(fallback, { companies: ["OpenAI"] }, 1, 10).total, 1);
});
