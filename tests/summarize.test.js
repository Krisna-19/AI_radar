/*
 * Stage 7 tests: summarization + optional LLM path
 * (scripts/pipeline/summarize.js). Uses node:test (zero extra dependencies).
 *
 * Covers: normal article summarization, title-only and short descriptions,
 * sentence-boundary handling, summary/takeaway limits, determinism,
 * idempotency, anti-hallucination, missing API key, mocked LLM success,
 * malformed/invalid LLM responses, and extractive fallback on LLM failure.
 * Also verifies Stage 1-6 contracts (id/category/chip/score/entities) are
 * untouched and that the `ai` object stays schema-compatible.
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert");

const Core = require("../js/shared.js");
const C = require("../scripts/pipeline/classify.js");
const S = require("../scripts/pipeline/score.js");
const SUM = require("../scripts/pipeline/summarize.js");

const NOW = Date.UTC(2026, 8, 2, 7, 0, 0);

/* Build a normalized canonical Story with classification + scoring applied
 * (mirrors the real pipeline up to summarization). */
function story(title, opts = {}) {
  const source = Object.assign(
    { id: "demo", name: "Demo", category: "media", reliability: 6, priority: 100, weight: 3, color: "#666" },
    opts.source || {}
  );
  const raw = {
    title,
    link: opts.link || "https://example.com/story/1",
    description: opts.description != null ? opts.description : title,
  };
  const s = Core.normalizeItem(raw, source, { nowMs: NOW });
  C.classifyStory(s);
  S.scoreStory(s);
  return s;
}

/* A realistic multi-sentence description a summarizer should handle well. */
const BODY =
  "OpenAI has released an updated version of GPT-5 with significant gains on " +
  "mathematical reasoning benchmarks. The company claims the new model solves a " +
  "larger share of competition-level problems. Independent researchers are still " +
  "evaluating the results. The model is available to developers through the API.";

function assertGrounded(story) {
  const src = ((story.description || "") + " " + (story.title || "")).toLowerCase();
  const fields = [story.ai.summary, story.ai.whyItMatters].filter(Boolean);
  for (const t of story.ai.keyTakeaways) fields.push(t);
  for (const text of fields) {
    const words = String(text).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1);
    for (const w of words) {
      assert.ok(src.indexOf(w) !== -1, `'${w}' in "${text}" must appear in source`);
    }
  }
}

/* ------------------------------------------------------------------ *
 * Extractive (default) behavior
 * ------------------------------------------------------------------ */

test("extractive: produces a non-null summary + takeaways from a normal article", async () => {
  const s = story("OpenAI releases GPT-5", { description: BODY });
  await SUM.summarizeStory(s, { mode: "extract" });
  assert.strictEqual(s.ai.method, "extractive");
  assert.ok(s.ai.summary, "summary should be populated");
  assert.ok(s.ai.summary.length <= SUM.DEFAULTS.SUMMARY_MAX_CHARS);
  assert.strictEqual(s.ai.whyItMatters, null, "extractive never invents a 'so what'");
  assert.ok(Array.isArray(s.ai.keyTakeaways));
  assert.ok(s.ai.keyTakeaways.length > 0 && s.ai.keyTakeaways.length <= 3);
  assertGrounded(s);
});

test("extractive: title-only article yields ai.summary = null (no fake summary)", async () => {
  const s = story("OpenAI releases GPT-5"); // description defaults to title
  // Simulate a title-only item (no body behind the title).
  s.description = null;
  s.content = null;
  await SUM.summarizeStory(s, { mode: "extract" });
  assert.strictEqual(s.ai.summary, null);
  assert.strictEqual(s.ai.whyItMatters, null);
  assert.deepStrictEqual(s.ai.keyTakeaways, []);
  assert.strictEqual(s.ai.method, null);
});

test("extractive: very-short description yields ai.summary = null", async () => {
  const s = story("Short item", { description: "A tiny note." }); // 3 words (<6)
  await SUM.summarizeStory(s, { mode: "extract" });
  assert.strictEqual(s.ai.summary, null);
  assert.deepStrictEqual(s.ai.keyTakeaways, []);
});

test("extractive: respects sentence boundaries (no mid-word clipping)", async () => {
  const s = story("Headline", { description: BODY });
  await SUM.summarizeStory(s, { mode: "extract" });
  const summary = s.ai.summary;
  assert.ok(/[.!?]$/u.test(summary), `summary should end on a sentence boundary: "${summary}"`);
  for (const t of s.ai.keyTakeaways) {
    assert.ok(/[.!?]$/u.test(t), `takeaway should end on a sentence boundary: "${t}"`);
  }
});

test("extractive: limits key takeaways to 3 and caps summary length", async () => {
  const many =
    "First sentence of the article. Second sentence adds more detail here. " +
    "Third sentence goes further into the problem. Fourth sentence continues. " +
    "Fifth sentence keeps going and going and going.";
  const s = story("Multi sentence piece", { description: many });
  await SUM.summarizeStory(s, { mode: "extract" });
  assert.ok(s.ai.keyTakeaways.length <= 3, `takeaways=${s.ai.keyTakeaways.length}`);
  assert.ok(s.ai.summary.length <= SUM.DEFAULTS.SUMMARY_MAX_CHARS);
});

test("extractive: deterministic repeated runs produce identical ai output", async () => {
  const a = story("Determinism piece", { description: BODY });
  const b = story("Determinism piece", { description: BODY });
  await SUM.summarizeStory(a, { mode: "extract" });
  await SUM.summarizeStory(b, { mode: "extract" });
  assert.deepStrictEqual(a.ai, b.ai);
});

/* ------------------------------------------------------------------ *
 * idempotency
 * ------------------------------------------------------------------ */

test("idempotency: an existing populated summary is never overwritten", async () => {
  const s = story("Idempotent piece", { description: BODY });
  await SUM.summarizeStory(s, { mode: "extract" });
  const first = s.ai.summary;
  // Re-run would produce an identical result anyway; set a sentinel to prove
  // the guard short-circuits (i.e. it does not recompute).
  s.ai.summary = "custom pre-existing summary";
  s.ai.method = "extractive";
  await SUM.summarizeStory(s, { mode: "extract" });
  assert.strictEqual(s.ai.summary, "custom pre-existing summary", "must not overwrite");
});

test("idempotency: LLM-labeled summary is not overwritten by a later extract run", async () => {
  const s = story("Idempotent piece", { description: BODY });
  s.ai.summary = "a grounded llm summary that appears in the body";
  s.ai.method = "llm";
  s.ai.keyTakeaways = [];
  await SUM.summarizeStory(s, { mode: "extract" });
  assert.strictEqual(s.ai.method, "llm", "existing LLM summary left intact");
  assert.strictEqual(s.ai.summary, "a grounded llm summary that appears in the body");
});

/* ------------------------------------------------------------------ *
 * Optional LLM path
 * ------------------------------------------------------------------ */

function mockFetch(responder) {
  return async function (url, init) {
    return await responder(url, init);
  };
}

function llmOkResponse(summary, takeaways) {
  return async function (url, init) {
    const body = JSON.parse(init.body);
    const content = JSON.stringify({
      summary: summary || "OpenAI released GPT-5 with benchmark gains.",
      whyItMatters: null,
      keyTakeaways: takeaways || ["OpenAI released GPT-5."],
    });
    return {
      ok: true,
      status: 200,
      async json() { return { choices: [{ message: { content } }] }; },
    };
  };
}

test("llm: missing API key falls back to extractive", async () => {
  const s = story("LLM missing key", { description: BODY });
  await SUM.summarizeStory(s, { mode: "llm", apiKey: null, fetchImpl: mockFetch(llmOkResponse()) });
  assert.strictEqual(s.ai.method, "extractive", "missing key must not use llm");
  assert.ok(s.ai.summary);
  assertGrounded(s);
});

test("llm: mocked successful grounded response is labeled llm", async () => {
  const s = story("OpenAI releases GPT-5", { description: BODY });
  await SUM.summarizeStory(s, {
    mode: "llm",
    apiKey: "sk-test",
    fetchImpl: mockFetch(llmOkResponse("OpenAI released GPT-5 with gains.")),
  });
  assert.strictEqual(s.ai.method, "llm");
  assert.strictEqual(s.ai.summary, "OpenAI released GPT-5 with gains.");
  assertGrounded(s);
});

test("llm: non-ok HTTP response falls back to extractive (never fails)", async () => {
  const s = story("LLM http fail", { description: BODY });
  await SUM.summarizeStory(s, {
    mode: "llm",
    apiKey: "sk-test",
    fetchImpl: async () => ({ ok: false, status: 429, async json() { return {}; } }),
  });
  assert.strictEqual(s.ai.method, "extractive");
  assert.ok(s.ai.summary);
});

test("llm: malformed / invalid JSON response falls back to extractive", async () => {
  const s = story("LLM malformed", { description: BODY });
  await SUM.summarizeStory(s, {
    mode: "llm",
    apiKey: "sk-test",
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      async json() { return { choices: [{ message: { content: "not json at all" } }] }; },
    }),
  });
  assert.strictEqual(s.ai.method, "extractive", "invalid LLM JSON must fall back");
  assert.ok(s.ai.summary);
});

test("llm: fetch throws (network error) falls back to extractive", async () => {
  const s = story("LLM network fail", { description: BODY });
  await SUM.summarizeStory(s, {
    mode: "llm",
    apiKey: "sk-test",
    fetchImpl: async () => { throw new Error("network down"); },
  });
  assert.strictEqual(s.ai.method, "extractive");
  assert.ok(s.ai.summary);
});

test("llm: hallucinated (ungrounded) response is rejected and falls back to extractive", async () => {
  // A confident but fabricated summary shares no vocabulary with the source.
  const s = story("OpenAI releases GPT-5", { description: BODY });
  await SUM.summarizeStory(s, {
    mode: "llm",
    apiKey: "sk-test",
    fetchImpl: mockFetch(llmOkResponse("The moon is made entirely of green cheese today.")),
  });
  assert.strictEqual(s.ai.method, "extractive", "ungrounded LLM output must be rejected");
  assertGrounded(s);
});

test("llm: capped to 3 takeaways and max summary chars", async () => {
  const s = story("LLM limits", { description: BODY });
  await SUM.summarizeStory(s, {
    mode: "llm",
    apiKey: "sk-test",
    fetchImpl: mockFetch(llmOkResponse(
      "OpenAI released GPT-5.",
      ["t1.", "t2.", "t3.", "t4."] // 4 takeaways -> capped to 3
    )),
  });
  assert.strictEqual(s.ai.method, "llm");
  assert.ok(s.ai.keyTakeaways.length <= 3, `takeaways=${s.ai.keyTakeaways.length}`);
  assert.ok(s.ai.summary.length <= SUM.DEFAULTS.SUMMARY_MAX_CHARS);
});

/* ------------------------------------------------------------------ *
 * Stage 1-6 contracts untouched + schema compatibility
 * ------------------------------------------------------------------ */

test("summarize: Stage 1-6 fields are preserved (id/category/chip/score/entities)", async () => {
  const s = story("OpenAI releases GPT-5 with strong benchmark gains", { description: BODY });
  const before = {
    id: s.id,
    fingerprint: s.fingerprint,
    category: s.category,
    chip: s.chip,
    score: s.score,
    radarScore: s.radarScore,
    subcategory: s.subcategory,
    entities: JSON.stringify([s.companies, s.models, s.technologies]),
    sources: JSON.stringify(s.sources),
    relatedStoryIds: JSON.stringify(s.relatedStoryIds),
    originalUrl: s.originalUrl,
    publishedAt: s.publishedAt,
    discoveredAt: s.discoveredAt,
  };
  await SUM.summarizeStory(s, { mode: "extract" });
  assert.strictEqual(s.id, before.id);
  assert.strictEqual(s.fingerprint, before.fingerprint);
  assert.strictEqual(s.category, before.category);
  assert.strictEqual(s.chip, before.chip);
  assert.strictEqual(s.score, before.score);
  assert.strictEqual(s.radarScore, before.radarScore);
  assert.strictEqual(s.subcategory, before.subcategory);
  assert.strictEqual(JSON.stringify([s.companies, s.models, s.technologies]), before.entities);
  assert.strictEqual(JSON.stringify(s.sources), before.sources);
  assert.strictEqual(JSON.stringify(s.relatedStoryIds), before.relatedStoryIds);
  assert.strictEqual(s.originalUrl, before.originalUrl);
  assert.strictEqual(s.publishedAt, before.publishedAt);
  assert.strictEqual(s.discoveredAt, before.discoveredAt);
});

test("summarize: ai object remains schema-compatible and passes validateStory", async () => {
  const s = story("OpenAI releases GPT-5", { description: BODY });
  await SUM.summarizeStory(s, { mode: "extract" });
  // Sub-fields present with schema-consistent empty values for the null case.
  const t = story("Title only", { description: "Title only" });
  t.description = null;
  t.content = null;
  await SUM.summarizeStory(t, { mode: "extract" });
  assert.ok(Core.validateStory(s).valid, "summarized story still valid");
  assert.ok(Core.validateStory(t).valid, "null-summary story still valid");
  assert.ok(typeof s.ai.summary === "string");
  assert.ok(Array.isArray(s.ai.keyTakeaways));
  assert.ok(["extractive", "llm", null].includes(s.ai.method));
});

test("summarizeStories: returns mode + stats and processes a batch", async () => {
  const items = [
    story("OpenAI releases GPT-5", { description: BODY }),
    story("Title only item", { description: "Title only item" }), // null body below
  ];
  items[1].description = null;
  items[1].content = null;
  const res = await SUM.summarizeStories(items, { mode: "extract" });
  assert.strictEqual(res.mode, "extract");
  assert.strictEqual(res.items, items);
  assert.ok(res.stats.summarized >= 1);
  assert.strictEqual(res.stats.extractive, res.stats.summarized);
  assert.strictEqual(res.stats.llm, 0);
  assert.strictEqual(res.stats.none, 1, "the title-only story has no summary");
});
