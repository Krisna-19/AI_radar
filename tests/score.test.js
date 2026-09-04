/*
 * Stage 6 tests: transparent, explainable Radar Score
 * (scripts/pipeline/score.js). Uses node:test (zero extra dependencies).
 *
 * Covers: score range, the documented weight blend, each component's monotonic
 * response to its driver, multi-source confirmation bonus, legacy 0-5
 * story.score, determinism, empty/degenerate input, and that classify fields
 * are auto-populated when absent (default path).
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert");

const Core = require("../js/shared.js");
const C = require("../scripts/pipeline/classify.js");
const S = require("../scripts/pipeline/score.js");

function story(title, opts = {}) {
  const source = Object.assign(
    { id: "demo", name: "Demo", category: "media", reliability: 6, priority: 100, weight: 3, color: "#666" },
    opts.source || {}
  );
  return Core.normalizeItem(
    { title, link: "https://example.com/s/1", description: opts.description || title },
    source,
    { nowMs: Date.UTC(2026, 8, 2, 7, 0, 0) }
  );
}

test("score-story: produces a radar score in [0,100] with all components present", () => {
  const s = story("OpenAI releases GPT-5 with strong benchmark gains");
  C.classifyStory(s);
  S.scoreStory(s);
  assert.equal(typeof s.radarScore, "number");
  assert.ok(s.radarScore >= 0 && s.radarScore <= 100, `radarScore ${s.radarScore}`);
  for (const k of ["impact", "novelty", "credibility", "relevance", "sourceConfidence"]) {
    assert.ok(
      typeof s.scores[k] === "number" && s.scores[k] >= 0 && s.scores[k] <= 100,
      `component ${k} = ${s.scores[k]}`
    );
  }
});

test("score-story: weights sum to 100% and the total is the weighted blend", () => {
  const w = Object.values(S.SCORE_WEIGHTS).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(w - 1) < 1e-9, `weights sum to ~1, got ${w}`);

  // The total radar score is exactly the weighted blend of the five components.
  const s = story("OpenAI releases GPT-5 with strong benchmark gains");
  C.classifyStory(s);
  S.scoreStory(s);
  const recomputed =
    S.SCORE_WEIGHTS.impact * s.scores.impact +
    S.SCORE_WEIGHTS.novelty * s.scores.novelty +
    S.SCORE_WEIGHTS.credibility * s.scores.credibility +
    S.SCORE_WEIGHTS.relevance * s.scores.relevance +
    S.SCORE_WEIGHTS.sourceConfidence * s.scores.sourceConfidence;
  assert.strictEqual(s.radarScore, Math.round(recomputed));
});

test("score-story: higher source reliability yields higher credibility", () => {
  const low = story("Something", { source: { reliability: 4, weight: 3 } });
  const high = story("Something", { source: { reliability: 9, weight: 3 } });
  C.classifyStory(low); C.classifyStory(high);
  S.scoreStory(low); S.scoreStory(high);
  assert.ok(high.scores.credibility > low.scores.credibility,
    `${high.scores.credibility} > ${low.scores.credibility}`);
});

test("score-story: higher source weight yields higher source confidence", () => {
  const low = story("Something", { source: { reliability: 6, weight: 1 } });
  const high = story("Something", { source: { reliability: 6, weight: 5 } });
  C.classifyStory(low); C.classifyStory(high);
  S.scoreStory(low); S.scoreStory(high);
  assert.ok(high.scores.sourceConfidence > low.scores.sourceConfidence);
});

test("score-story: older publishedAt (vs discoveredAt) lowers novelty", () => {
  const fresh = story("A recent development in AI models", { description: "new" });
  fresh.publishedAt = "2026-09-01T00:00:00Z"; // discovered 2026-09-02 => ~1 day
  const old = story("A recent development in AI models", { description: "new" });
  old.publishedAt = "2026-01-01T00:00:00Z"; // ~8 months old
  C.classifyStory(fresh); C.classifyStory(old);
  S.scoreStory(fresh); S.scoreStory(old);
  assert.ok(fresh.scores.novelty > old.scores.novelty,
    `${fresh.scores.novelty} > ${old.scores.novelty}`);
});

test("score-story: multi-source reporting boosts impact and source confidence", () => {
  const single = story("A big AI event happened", { source: { reliability: 8, weight: 4 } });
  const multi = story("A big AI event happened", { source: { reliability: 8, weight: 4 } });
  multi.sources = [{ id: "a", name: "A" }, { id: "b", name: "B" }];
  C.classifyStory(single); C.classifyStory(multi);
  S.scoreStory(single); S.scoreStory(multi);
  assert.ok(multi.scores.impact > single.scores.impact);
  assert.ok(multi.scores.sourceConfidence > single.scores.sourceConfidence);
});

test("score-story: legacy flat score stays in the 0-5 range and is radarScore/20", () => {
  const s = story("OpenAI releases GPT-5 with strong benchmark gains");
  C.classifyStory(s);
  S.scoreStory(s);
  assert.ok(s.score >= 0 && s.score <= 5, `score ${s.score}`);
  assert.strictEqual(s.score, s.radarScore / 20);
});

test("score-story: auto-classifies when classify fields are absent (default path)", () => {
  const s = story("EU passes AI Act regulation"); // no classifyStory call
  S.scoreStory(s);
  assert.ok(s.subcategory, "should auto-populate subcategory");
  assert.equal(typeof s.radarScore, "number");
});

test("score-story: null / non-object input is tolerated", () => {
  assert.strictEqual(S.scoreStory(null), null);
  assert.strictEqual(S.scoreStory(undefined), undefined);
  const out = S.scoreStories(null);
  assert.deepStrictEqual(out.items, []);
});

test("score-stories: deterministic - identical input yields identical output", () => {
  const mk = () => [
    story("OpenAI launches GPT-5 model"),
    story("Startup raises $5M seed round managed by top investors"),
  ];
  const a = mk(), b = mk();
  S.scoreStories(a); S.scoreStories(b);
  assert.strictEqual(JSON.stringify(a), JSON.stringify(b));
});
