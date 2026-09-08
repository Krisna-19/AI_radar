/*
 * Stage 12 tests: identity hardening.
 *
 * cleanTitleForIdentity strips a trailing known-publisher suffix so one
 * article reported by several aggregator copies maps to a single stable
 * identity. The strip is deliberately conservative: it happens ONLY on an
 * exact (case-insensitive, word-normalised) match against the curated
 * PUBLISHER_ALIASES manifest. All other titles are preserved verbatim.
 * Uses node:test (built-in runner, zero extra dependencies).
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert");

const Core = require("../js/shared.js");

/* ---- cleanTitleForIdentity: stripping ---- */

test("cleanTitleForIdentity: strips exact known publisher suffixes", () => {
  const cases = [
    ["GPT-6 Astra - OpenAI", "GPT-6 Astra", "openai"],
    ["GPT-6 Astra - openai.com", "GPT-6 Astra", "openai com"],
    ["A new era - Reuters", "A new era", "reuters"],
    ["A new era - The Washington Post", "A new era", "the washington post"],
    ["A new era - The New York Times", "A new era", "the new york times"],
    ["A new era | CNBC", "A new era", "cnbc"],
    ["A new era — Politico", "A new era", "politico"],
    ["A new era · BBC", "A new era", "bbc"],
    ["A new era - futurism.com", "A new era", "futurism com"],
  ];
  for (const [input, title, publisher] of cases) {
    const r = Core.cleanTitleForIdentity(input);
    assert.strictEqual(r.title, title, "title for: " + input);
    assert.strictEqual(r.publisher, publisher, "publisher for: " + input);
  }
});

test("cleanTitleForIdentity: tolerates doubled separators and case", () => {
  assert.deepStrictEqual(
    Core.cleanTitleForIdentity("Iran halts IAEA - - Reuters"),
    { title: "Iran halts IAEA", publisher: "reuters" }
  );
  assert.deepStrictEqual(
    Core.cleanTitleForIdentity("Iran halts IAEA -  -  reuters"),
    { title: "Iran halts IAEA", publisher: "reuters" }
  );
});

test("cleanTitleForIdentity: strips rightmost known aliases iteratively", () => {
  // Both "Reuters" and "Yahoo Finance" are aliases, so the loop strips them
  // left-to-right (from the end) and the headline is left intact.
  const r = Core.cleanTitleForIdentity("X - Yahoo Finance - Reuters");
  assert.strictEqual(r.title, "X");
  assert.strictEqual(r.publisher, "reuters");
  // An unknown tail stops the loop; matched aliases further in are NOT reached,
  // so the remainder keeps its suffix verbatim.
  const r2 = Core.cleanTitleForIdentity("X - Yahoo Finance - Le Monde diplomatique");
  assert.strictEqual(r2.title, "X - Yahoo Finance - Le Monde diplomatique");
});

test("cleanTitleForIdentity: preserves titles with unknown/unmatched suffixes", () => {
  const keep = [
    "AI and the left - Le Monde diplomatique - English edition",
    "The Original Article Title - YouTube",
    "Iran Integrates AI Systems - - WANA News Agency",
    "A mystery title by Nobody-in-Particular",
    "Plain title",
    "",
  ];
  for (const input of keep) {
    const r = Core.cleanTitleForIdentity(input);
    if (!input) {
      assert.strictEqual(r.title, "");
      continue;
    }
    // None of these have a trailing EXACT alias => verbatim.
    assert.strictEqual(r.title, input, "preserved for: " + input);
  }
});

test("cleanTitleForIdentity: never collapses to an empty title", () => {
  const r = Core.cleanTitleForIdentity(" - Reuters");
  assert.ok(r.title.length > 0, "title must remain non-empty");
});

test("cleanTitleForIdentity: deterministic across calls", () => {
  const a = Core.cleanTitleForIdentity("Announcing GPT - OpenAI");
  const b = Core.cleanTitleForIdentity("Announcing GPT - OpenAI");
  assert.deepStrictEqual(a, b);
});

test("cleanTitleForIdentity: no fuzzy guessing - similar-but-different names kept", () => {
  // "OpenAl" and "Open AI (different)" are NOT in the manifest -> verbatim.
  assert.strictEqual(
    Core.cleanTitleForIdentity("Great model - OpenAl").title,
    "Great model - OpenAl"
  );
  assert.strictEqual(
    Core.cleanTitleForIdentity("Great model - Open AI (different)").title,
    "Great model - Open AI (different)"
  );
});

/* ---- manifest sanity ---- */

test("PUBLISHER_ALIASES: every entry has a real name (no empty names)", () => {
  assert.ok(Array.isArray(Core.PUBLISHER_ALIASES));
  assert.ok(Core.PUBLISHER_ALIASES.length > 50, "manifest should be curated, not tiny");
  for (const p of Core.PUBLISHER_ALIASES) {
    assert.ok(typeof p.name === "string" && p.name.trim().length > 0, "name required");
    assert.ok(Array.isArray(p.hosts || []), "hosts must be an array");
  }
});

test("PUBLISHER_ALIASES: the 13 configured sources are present", () => {
  const names = Core.PUBLISHER_ALIASES.map((p) => p.name);
  for (const expected of [
    "OpenAI",
    "Google DeepMind",
    "Google AI",
    "Google Research",
    "Hugging Face",
    "arXiv",
    "Nature",
    "MIT Tech Review",
    "VentureBeat",
    "The Verge",
    "WIRED",
    "TechCrunch",
  ]) {
    assert.ok(names.includes(expected), "missing alias: " + expected);
  }
});

/* ---- normalisation integration ---- */

const SRC = {
  id: "tst",
  name: "Test",
  category: "technology",
  reliability: "top",
  priority: 1,
  weight: 2,
  color: "#000",
};

test("normalizeItem: one identity for one article with any alias suffix", () => {
  const opts = { nowMs: new Date("2026-09-06T00:00:00Z").getTime() };
  const variants = [
    { title: "1 Heart of the Matter - CNBC", link: "https://cnbc.com/x/y", pubDate: "2026-09-05T10:00:00Z" },
    { title: "1 Heart of the Matter - cnbc.com", link: "https://cnbc.com/x/y", pubDate: "2026-09-05T10:00:00Z" },
    { title: "1 Heart of the Matter", link: "https://cnbc.com/x/y", pubDate: "2026-09-05T10:00:00Z" },
  ];
  const stories = variants.map((v) => Core.normalizeItem(v, SRC, opts));
  assert.strictEqual(stories[0].id, stories[1].id);
  assert.strictEqual(stories[1].id, stories[2].id);
  assert.strictEqual(stories[0].title, "1 Heart of the Matter");
});

test("normalizeItem: different articles never collide after stripping", () => {
  const opts = { nowMs: new Date("2026-09-06T00:00:00Z").getTime() };
  const a = Core.normalizeItem(
    { title: "Alpha story - CNBC", link: "https://cbsnews.com/alpha", pubDate: "2026-09-05T10:00:00Z" },
    SRC,
    opts
  );
  const b = Core.normalizeItem(
    { title: "Beta story - CNBC", link: "https://cbsnews.com/beta", pubDate: "2026-09-05T10:00:00Z" },
    SRC,
    opts
  );
  assert.notStrictEqual(a.id, b.id);
});

test("normalizeItem: same title on two urls keeps distinct ids (identity is title+url)", () => {
  const opts = { nowMs: new Date("2026-09-06T00:00:00Z").getTime() };
  const a = Core.normalizeItem(
    { title: "Same headline", link: "https://a.example.com/story-one", pubDate: "2026-09-05T10:00:00Z" },
    SRC,
    opts
  );
  const b = Core.normalizeItem(
    { title: "Same headline", link: "https://b.example.com/story-two", pubDate: "2026-09-05T10:00:00Z" },
    SRC,
    opts
  );
  assert.notStrictEqual(a.id, b.id);
});