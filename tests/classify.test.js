/*
 * Stage 6 tests: transparent classification + entity extraction
 * (scripts/pipeline/classify.js). Uses node:test (zero extra dependencies).
 *
 * Covers: the 12-category taxonomy, faithful legacy top-5 bucket mapping,
 * entity extraction (companies/models/people/countries/technologies) with
 * false-positive guards and prefix-subsumption, subcategory/tags/chip,
 * determinism, empty/low-signal input, and that Stage 1-5 contracts are
 * untouched (id/category/score not clobbered).
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert");

const Core = require("../js/shared.js");
const C = require("../scripts/pipeline/classify.js");

/* Build a normalized canonical Story. */
function story(title, opts = {}) {
  const source = Object.assign(
    { id: "demo", name: "Demo Feed", category: "media", reliability: 6, priority: 100, weight: 3, color: "#666666" },
    opts.source || {}
  );
  return Core.normalizeItem(
    { title, link: opts.link || "https://example.com/story/1", description: opts.description || title },
    source,
    { nowMs: Date.UTC(2026, 8, 2, 7, 0, 0) }
  );
}

test("classify-story: maps a representative headline to each of the 12 taxonomy labels", () => {
  const cases = [
    ["New paper shows 5x speedup on math benchmarks", "research"],
    ["OpenAI introduces GPT-5 model with advanced reasoning", "model"],
    ["Anthropic releases Claude 4 with advanced reasoning", "model"],
    ["Hugging Face ships a new agent SDK and API", "tools"],
    ["AI startup raises $10B series B funding round", "funding"],
    ["OpenAI appoints a new chief executive officer", "business"],
    ["Congress passes federal AI regulation bill", "policy"],
    ["DeepMind publishes a new alignment safety framework", "safety"],
    ["Meta open-sources Llama under an Apache license", "opensource"],
    ["Microsoft teams up with Mistral on a new partnership", "partnership"],
    ["Enterprise survey shows rapid industry adoption of AI", "industry"],
    ["A quiet evening read about life and weekend walks", "other"],
  ];
  for (const [title, expected] of cases) {
    const s = story(title);
    C.classifyStory(s);
    assert.strictEqual(s.subcategory, expected, `expected '${expected}' for: ${title}`);
  }
});

test("classify-story: legacy chip bucket stays one of the original 5", () => {
  for (const fine of C.TAXONOMY) {
    const bucket = C.LEGACY_BUCKET[fine];
    assert.ok(
      ["research", "product", "funding", "policy", "news"].includes(bucket),
      `bucket for ${fine} must be a legacy top-5 category, got ${bucket}`
    );
  }
  const map = { model: "product", tools: "product", funding: "funding", policy: "policy", other: "news" };
  for (const [fine, bucket] of Object.entries(map)) {
    assert.strictEqual(C.LEGACY_BUCKET[fine], bucket, `chip mapping for ${fine}`);
  }
});

test("classify-story: entity extraction finds companies/models/countries/technologies", () => {
  const s = story("Google DeepMind and OpenAI collaborate on Gemini 2 for EU research");
  C.classifyStory(s);
  assert.ok(s.companies.includes("Google DeepMind"), JSON.stringify(s.companies));
  assert.ok(s.companies.includes("OpenAI"), JSON.stringify(s.companies));
  assert.ok(s.models.includes("Gemini 2"), JSON.stringify(s.models));
  assert.ok(s.countries.includes("European Union"), JSON.stringify(s.countries));
  assert.equal(s.subcategory, "research");
});

test("classify-story: prefix-subsumption prevents double-listing model/company stems", () => {
  const s = story("OpenAI launches GPT-5 today");
  C.classifyStory(s);
  assert.deepStrictEqual(s.models, ["GPT-5"], JSON.stringify(s.models));
  assert.deepStrictEqual(s.companies, ["OpenAI"], JSON.stringify(s.companies));
});

test("classify-story: false-positive guard does NOT fire on partial-word tokens", () => {
  const s = story("The gem industry and japanese travel market grow");
  C.classifyStory(s);
  // "gem" must not match "Gemini"; "Japanese" must not match "Japan".
  assert.deepStrictEqual(s.models, []);
  assert.deepStrictEqual(s.companies, []);
  assert.deepStrictEqual(s.countries, [], JSON.stringify(s.countries));
});

test("classify-story: tags include entities and topical keywords, ordered and capped", () => {
  const s = story("Meta open-sources Llama model under open source license");
  C.classifyStory(s);
  assert.ok(s.tags.length > 0);
  assert.ok(s.tags.length <= 6, JSON.stringify(s.tags));
  assert.ok(s.tags.includes("Llama") || s.tags.includes("Meta"), JSON.stringify(s.tags));
});

test("classify-story: people extraction works by full name", () => {
  const s = story("Sam Altman and Demis Hassabis discuss AI regulation in Washington");
  C.classifyStory(s);
  assert.ok(s.people.includes("Sam Altman"), JSON.stringify(s.people));
  assert.ok(s.people.includes("Demis Hassabis"), JSON.stringify(s.people));
});

test("classify-story: identity & legacy numeric fields are preserved, category stays a legacy top-5 id", () => {
  const s = story("OpenAI releases a new GPT-5 model");
  const id = s.id;
  const fingerprint = s.fingerprint;
  const score = s.score;
  C.classifyStory(s);
  assert.strictEqual(s.id, id);
  assert.strictEqual(s.fingerprint, fingerprint);
  assert.strictEqual(s.schemaVersion, "1.0");
  assert.equal(typeof s.score, "number");
  assert.equal(s.score, score);
  // Stage 6 refines story.category to one of the 5 legacy ids the UI filters on.
  assert.ok(
    ["research", "product", "funding", "policy", "news"].includes(s.category),
    `category ${s.category}`
  );
  assert.strictEqual(s.chip, s.category);
  assert.strictEqual(s.subcategory, "model");
});

test("classify-story: empty / low-signal story is safe (falls back to other)", () => {
  const s = story("Untitled");
  const out = C.classifyStory(s);
  assert.strictEqual(out.subcategory, "other");
  assert.strictEqual(out.chip, "news");
  assert.ok(Array.isArray(out.companies));
  assert.ok(Array.isArray(out.models));
});

test("classify-story: null / non-object input is tolerated", () => {
  assert.strictEqual(C.classifyStory(null), null);
  assert.strictEqual(C.classifyStory(undefined), undefined);
  const out = C.classifyStories(null);
  assert.deepStrictEqual(out, { items: [], stats: { categories: {}, chips: {} } });
});

test("classify-stories: deterministic - identical input yields identical output", () => {
  const a = [story("OpenAI launches GPT-5 model"), story("Startup raises $5M seed round")];
  const b = [story("OpenAI launches GPT-5 model"), story("Startup raises $5M seed round")];
  C.classifyStories(a);
  C.classifyStories(b);
  assert.strictEqual(JSON.stringify(a), JSON.stringify(b));
});

test("classify-stories: stats expose per-category counts", () => {
  const items = [story("OpenAI launches GPT-5 model"), story("Startup raises funding")];
  const { stats } = C.classifyStories(items);
  assert.strictEqual(stats.categories.model, 1);
  assert.strictEqual(stats.categories.funding, 1);
  assert.strictEqual(stats.chips.product, 1);
  assert.strictEqual(stats.chips.funding, 1);
});
