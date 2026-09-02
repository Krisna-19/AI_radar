/*
 * Stage 1 tests: stable identity helpers and dedupe.
 * Uses node:test (built-in runner, zero extra dependencies).
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert");

const Core = require("../js/shared.js");

test("normalizeTitle: lowercases and collapses punctuation", () => {
  assert.strictEqual(
    Core.normalizeTitle("  OpenAI   Launches  NEW! Model "),
    "openai launches new model"
  );
  assert.strictEqual(Core.normalizeTitle(""), "");
  assert.strictEqual(Core.normalizeTitle(null), "");
});

test("canonicalUrlKey: strips www and keeps host + first path segments", () => {
  assert.strictEqual(
    Core.canonicalUrlKey("https://www.Example.com/path/To/Story?utm_source=rss#frag"),
    "example.com/path/to"
  );
  assert.strictEqual(Core.canonicalUrlKey("https://blog.openai.com/hello-world"), "blog.openai.com/hello-world");
  assert.strictEqual(Core.canonicalUrlKey(""), "");
  assert.strictEqual(Core.canonicalUrlKey("not a url"), "");
});

test("canonicalKey: stable regardless of case, query params and fragments", () => {
  const a = Core.canonicalKey("  Agentic AI Survey ", "https://www.ArXiV.org/abs/2401.12345?x=1");
  const b = Core.canonicalKey("agentic ai survey", "https://arxiv.org/abs/2401.12345");
  assert.strictEqual(a, b);
  const c = Core.canonicalKey("A different story", "https://arxiv.org/abs/9999.00001");
  assert.notStrictEqual(a, c);
});

test("buildStoryId: deterministic, same id across runs for the same story", () => {
  const id1 = Core.buildStoryId("OpenAI launches new model", "https://openai.com/blog/new-model");
  const id2 = Core.buildStoryId("OpenAI launches new model", "https://openai.com/blog/new-model");
  assert.strictEqual(id1, id2);
  assert.ok(/^s[0-9a-f]{8}$/.test(id1));
  assert.notStrictEqual(
    id1,
    Core.buildStoryId("OpenAI launches new model", "https://openai.com/blog/other-post")
  );
});

test("dedupe: idempotent, collapses exact title+url duplicates, keeps first", () => {
  // Same title AND same canonical URL duplicates are collapsed.
  const dupes = [
    { title: "OpenAI launches new model", link: "https://www.OpenAI.com/blog/new-model?utm=rss" },
    { title: "OpenAI launches new model", link: "https://openai.com/blog/new-model" },
    { title: "DeepMind unlocks protein folding", link: "https://deepmind.google/blog/protein" },
  ];
  assert.strictEqual(Core.dedupe(dupes).length, 2);

  // Same title from different outlets is intentionally kept for Stage 4
  // (similarity clustering merges those into "Reported by N sources").
  const crossOutlets = [
    { title: "OpenAI launches new model", link: "https://openai.com/blog/new-model" },
    { title: "OpenAI launches new model!", link: "https://technews.example/openai-new-model" },
  ];
  assert.strictEqual(Core.dedupe(crossOutlets).length, 2);

  // Idempotent: same input, same output order.
  const items = [
    { title: "OpenAI launches new model", link: "https://openai.com/blog/new-model" },
    { title: "DeepMind unlocks protein folding", link: "https://deepmind.google/blog/protein" },
  ];
  const first = Core.dedupe(items);
  const second = Core.dedupe(items);
  assert.deepStrictEqual(first.map((i) => i.title), second.map((i) => i.title));
});

test("categorize: research, funding, policy and product detection", () => {
  const cases = [
    ["A new arXiv paper proposes retrieval-augmented reasoning", "research"],
    ["Startup raises $120M Series B to scale enterprise copilots", "funding"],
    ["Regulators publish draft framework for AI transparency law", "policy"],
    ["Anthropic launches a new Claude app for engineers", "product"],
    ["Editorial: the state of artificial intelligence", "news"],
  ];
  for (const [text, expected] of cases) {
    assert.strictEqual(Core.categorize(text), expected, "for: " + text);
  }
});

test("computeScore: newer items score higher, weight scales output", () => {
  const fresh = Core.computeScore(5, new Date(Date.now() - 3600000), 0);
  const old = Core.computeScore(5, new Date(Date.now() - 72 * 3600000), 0);
  assert.ok(fresh > old);
  const heavy = Core.computeScore(5, new Date(Date.now() - 3600000), 0);
  const light = Core.computeScore(1, new Date(Date.now() - 3600000), 0);
  assert.ok(heavy > light);
});