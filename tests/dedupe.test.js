/*
 * Stage 4 tests: similarity-based story clustering (scripts/pipeline/dedupe.js).
 * Uses node:test (zero extra dependencies).
 *
 * Covers: exact + paraphrase merging, false-positive protection, source
 * aggregation, reportedBy, determinism, ordering independence, bounds,
 * empty/single input, and that existing Stage 1-3 contracts are untouched.
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert");

const Core = require("../js/shared.js");
const D = require("../scripts/pipeline/dedupe.js");

const NOW = Date.UTC(2026, 8, 2, 12, 0, 0);

/* Build a normalized canonical Story from synthetic source config + raw item. */
function story(title, link, sourceId, opts = {}) {
  const src = {
    id: sourceId,
    name: opts.name || sourceId,
    url: "http://placeholder.example/feed",
    category: opts.category || "media",
    enabled: true,
    priority: opts.priority != null ? opts.priority : 100,
    reliability: opts.reliability != null ? opts.reliability : 6,
    weight: opts.weight != null ? opts.weight : 3,
    color: "#abcdef",
  };
  const nowMs = opts.nowMs != null ? opts.nowMs : NOW;
  return Core.normalizeItem({ title, link, pubDate: opts.pubDate }, src, { nowMs });
}

/* ---------------- 1: exact duplicate ---------------- */

test("clusterStories: exact duplicate -> one story", () => {
  const a = story("OpenAI releases GPT-6", "https://openai.com/blog/gpt-6", "openai", { pubDate: "2026-09-02T00:00:00Z" });
  const b = story("OpenAI releases GPT-6", "https://openai.com/blog/gpt-6", "openai", { pubDate: "2026-09-02T00:00:00Z" });
  const r = D.clusterStories([a, b]);
  assert.strictEqual(r.items.length, 1);
  assert.strictEqual(r.stats.afterExactDedupe, 1);
});

/* ---------------- 2: highly similar titles ---------------- */

test("clusterStories: highly similar titles -> one story", () => {
  const a = story("OpenAI releases new GPT model", "https://openai.com/blog/new-model", "openai", { pubDate: "2026-09-02T00:00:00Z" });
  const b = story("OpenAI announces its latest GPT model", "https://technews.example/oai-new-model", "technews", { pubDate: "2026-09-02T02:00:00Z" });
  const r = D.clusterStories([a, b]);
  assert.strictEqual(r.items.length, 1);
  assert.strictEqual(r.items[0].reportedBy, 2);
});

/* ---------------- 3: same event, different wording ---------------- */

test("clusterStories: same event with different wording -> one story, sources preserved", () => {
  const a = story("OpenAI releases new GPT model", "https://openai.com/blog/new-model", "openai", { reliability: 9, pubDate: "2026-09-02T00:00:00Z" });
  const b = story("OpenAI announces its latest GPT model", "https://technews.example/oai-gpt", "technews", { pubDate: "2026-09-02T02:00:00Z" });
  const c = story("OpenAI launches new GPT model", "https://aiwire.example/openai-gpt-model", "aiwire", { pubDate: "2026-09-02T03:00:00Z" });
  const r = D.clusterStories([a, b, c]);
  assert.strictEqual(r.items.length, 1);
  const canon = r.items[0];
  assert.strictEqual(canon.reportedBy, 3);
  const srcIds = canon.sources.map((s) => s.id).sort();
  assert.deepStrictEqual(srcIds, ["aiwire", "openai", "technews"]);
  // every reporting source URL/id is retained
  assert.ok(canon.relatedStoryIds.length >= 3);
});

/* ---------------- 4: same company, different events ---------------- */

test("clusterStories: same company but different events -> remain separate", () => {
  const a = story("OpenAI launches GPT-6", "https://openai.com/blog/gpt6", "openai", { pubDate: "2026-09-02T00:00:00Z" });
  const b = story("OpenAI raises 10 billion dollars in funding", "https://cnn.example/oai-raise", "cnn", { pubDate: "2026-09-02T01:00:00Z" });
  const r = D.clusterStories([a, b]);
  assert.strictEqual(r.items.length, 2);
});

/* ---------------- 5: same model, unrelated announcements ---------------- */

test("clusterStories: same AI model but unrelated announcements -> remain separate", () => {
  const a = story("OpenAI releases GPT-6", "https://openai.com/blog/gpt6", "openai", { pubDate: "2026-09-02T00:00:00Z" });
  const b = story("GPT-6 wins a major coding benchmark", "https://technews.example/gpt6-bench", "technews", { pubDate: "2026-09-02T01:00:00Z" });
  const r = D.clusterStories([a, b]);
  assert.strictEqual(r.items.length, 2);
});

/* ---------------- 6: different sources, same event ---------------- */

test("clusterStories: different sources reporting same event -> sources preserved", () => {
  const a = story("DeepMind protein folding breakthrough", "https://deepmind.google/blog/protein", "deepmind", { pubDate: "2026-09-02T00:00:00Z" });
  const b = story("DeepMind unlocks protein folding", "https://technews.example/deepmind-protein", "technews", { pubDate: "2026-09-02T01:00:00Z" });
  const r = D.clusterStories([a, b]);
  assert.strictEqual(r.items.length, 1);
  assert.strictEqual(r.items[0].reportedBy, 2);
  assert.deepStrictEqual(r.items[0].sources.map((s) => s.id).sort(), ["deepmind", "technews"]);
});

/* ---------------- 7: reportedBy / source count ---------------- */

test("clusterStories: reportedBy equals distinct source count", () => {
  const a = story("Anthropic Claude 4 launch", "https://anthropic.com/blog/claude4", "anthropic", { reliability: 8, pubDate: "2026-09-02T00:00:00Z" });
  const b = story("Anthropic Claude 4 launch", "https://technews.example/claude4", "technews", { pubDate: "2026-09-02T01:00:00Z" });
  const c = story("Anthropic Claude 4 launch", "https://aiwire.example/claude4", "aiwire", { pubDate: "2026-09-02T02:00:00Z" });
  const r = D.clusterStories([a, b, c]);
  assert.strictEqual(r.items.length, 1);
  assert.strictEqual(r.items[0].reportedBy, 3);
  assert.strictEqual(r.stats.multiSource, 1);
});

/* ---------------- 8: determinism ---------------- */

test("clusterStories: result is deterministic (same input -> same output)", () => {
  const items = [
    story("OpenAI releases new model", "https://openai.com/blog/m", "openai", { pubDate: "2026-09-02T00:00:00Z" }),
    story("OpenAI launches a new model", "https://technews.example/m", "technews", { pubDate: "2026-09-02T01:00:00Z" }),
    story("Google DeepMind unveils Gemini 3", "https://deepmind.google/blog/g3", "deepmind", { pubDate: "2026-09-02T00:30:00Z" }),
  ];
  const r1 = D.clusterStories(items);
  const r2 = D.clusterStories(items);
  assert.deepStrictEqual(r1.items.map((i) => i.id), r2.items.map((i) => i.id));
  assert.deepStrictEqual(r1.items.map((i) => i.reportedBy), r2.items.map((i) => i.reportedBy));
  assert.strictEqual(r1.stats.mergedInto, r2.stats.mergedInto);
});

/* ---------------- 9: input ordering independence ---------------- */

test("clusterStories: input ordering does not change the clustering", () => {
  const mk = [
    story("OpenAI model launch", "https://openai.com/blog/ml", "openai", { pubDate: "2026-09-02T00:00:00Z" }),
    story("OpenAI new model launch", "https://technews.example/ml", "technews", { pubDate: "2026-09-02T01:00:00Z" }),
    story("Nature publishes protein study", "https://nature.com/paper", "nature", { reliability: 9, pubDate: "2026-09-02T00:00:00Z" }),
  ];
  const rA = D.clusterStories(mk);
  const rB = D.clusterStories(mk.slice().reverse());
  assert.strictEqual(rA.items.length, rB.items.length);
  assert.strictEqual(rA.stats.mergedInto, rB.stats.mergedInto);
  // same set of story ids
  assert.deepStrictEqual(
    rA.items.map((i) => i.id).slice().sort(),
    rB.items.map((i) => i.id).slice().sort()
  );
});

/* ---------------- 10: near-threshold handling ---------------- */

test("clusterStories: near-threshold stories are handled safely (no merge below bar)", () => {
  // share openai + gpt but differ on a content token -> core Jaccard below 0.70
  const a = story("OpenAI GPT pro tier", "https://openai.com/blog/gpt-pro", "openai", { pubDate: "2026-09-02T00:00:00Z" });
  const b = story("OpenAI GPT chat history", "https://openai.com/blog/gpt-chat", "technews", { pubDate: "2026-09-02T01:00:00Z" });
  const r = D.clusterStories([a, b]);
  assert.strictEqual(r.items.length, 2);
  assert.strictEqual(r.stats.mergedInto, 0);
});

/* ---------------- 11 & 12: empty / single ---------------- */

test("clusterStories: empty input -> empty result", () => {
  const r = D.clusterStories([]);
  assert.deepStrictEqual(r.items, []);
  assert.strictEqual(r.stats.input, 0);
});

test("clusterStories: null/undefined input -> empty result", () => {
  assert.deepStrictEqual(D.clusterStories(null).items, []);
  assert.deepStrictEqual(D.clusterStories(undefined).items, []);
});

test("clusterStories: single story -> unchanged, no clustering stats", () => {
  const s = story("Solo story here", "https://x.dev/solo", "openai", { pubDate: "2026-09-02T00:00:00Z" });
  const r = D.clusterStories([s]);
  assert.strictEqual(r.items.length, 1);
  assert.strictEqual(r.stats.mergedInto, 0);
  assert.deepStrictEqual(r.items[0].sources, []);
  assert.strictEqual(r.items[0].reportedBy, undefined);
});

/* ---------------- time-proximity guard ---------------- */

test("clusterStories: same headline on different days stays separate", () => {
  const a = story("OpenAI releases model X", "https://openai.com/blog/x", "openai", { pubDate: "2026-08-01T00:00:00Z" });
  const b = story("OpenAI releases model X", "https://technews.example/x", "technews", { pubDate: "2026-09-01T00:00:00Z" });
  const r = D.clusterStories([a, b]);
  assert.strictEqual(r.items.length, 2);
});

/* ---------------- canonical selection rule ---------------- */

test("clusterStories: canonical story is highest-reliability member", () => {
  const low = story("OpenAI new model", "https://technews.example/m", "technews", { reliability: 3, pubDate: "2026-09-02T01:00:00Z" });
  const high = story("OpenAI new model", "https://openai.com/blog/m", "openai", { reliability: 9, pubDate: "2026-09-02T00:00:00Z" });
  const r = D.clusterStories([low, high]);
  assert.strictEqual(r.items.length, 1);
  assert.strictEqual(r.items[0].source.id, "openai");
});

/* ---------------- existing contracts preserved ---------------- */

test("clusterStories: single-source canonical keeps its own identity/url intact", () => {
  const s = story("Google launches Veo 3", "https://blog.google/veo3?utm_source=rss", "googleai", { pubDate: "2026-09-02T00:00:00Z" });
  const r = D.clusterStories([s]);
  const out = r.items[0];
  assert.strictEqual(out.id, s.id);
  assert.strictEqual(out.fingerprint, s.fingerprint);
  assert.strictEqual(out.originalUrl, s.originalUrl);
  assert.strictEqual(out.canonicalUrl, s.canonicalUrl);
  assert.strictEqual(Core.validateStory(out).valid, true);
});

test("clusterStories: merged canonical remains schema-valid", () => {
  const a = story("Hugging Face releases Transformers 5", "https://hf.co/blog/tr5", "huggingface", { pubDate: "2026-09-02T00:00:00Z" });
  const b = story("Hugging Face launches Transformers 5", "https://technews.example/tr5", "technews", { pubDate: "2026-09-02T01:00:00Z" });
  const r = D.clusterStories([a, b]);
  assert.strictEqual(r.items.length, 1);
  const canon = r.items[0];
  assert.ok(Array.isArray(canon.sources));
  assert.ok(Array.isArray(canon.relatedStoryIds));
  assert.strictEqual(typeof canon.reportedBy, "number");
  assert.strictEqual(Core.validateStory(canon).valid, true);
});
