/*
 * Stage 13 tests: deterministic credential-string scrubbing
 * (scripts/pipeline/store.js). Verifies the scrubber redacts only
 * high-confidence credential-shaped strings and never touches ordinary prose
 * or drops a story. Runs under node:test.
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert");

const S = require("../scripts/pipeline/store.js");

const PLACEHOLDER = S.CREDENTIAL_PLACEHOLDER;

const GHP = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const PAT = "github_pat_" + "A1".repeat(35) + "_B2".repeat(5);
const HF = "hf_" + "a1".repeat(12).toUpperCase().toLowerCase() + "Z9Z";
const OPENAI = "sk-proj-ABCDEFGHIJKLMNOPQRST";
const OPENAI2 = "sk-ABCDEFGHIJKLMNOPQRST";
const AKIA = "AKIAIOSFODNN7EXAMPLE";

/* ---------------- 1: token families ---------------- */

test("scrubText redacts GitHub PATs (classic + fine-grained)", () => {
  const src = "Checkout token: " + GHP + " and fine token " + PAT + " end.";
  const out = S.scrubText(src);
  assert.ok(!out.includes(GHP), "classic PAT removed");
  assert.ok(!out.includes(PAT), "fine-grained PAT removed");
  assert.strictEqual(out, "Checkout token: " + PLACEHOLDER + " and fine token " + PLACEHOLDER + " end.");
});

test("scrubText redacts Hugging Face tokens", () => {
  const src = "Model weight auth via " + HF + " works.";
  const out = S.scrubText(src);
  assert.ok(!out.includes(HF), "HF token removed");
  assert.strictEqual(out, "Model weight auth via " + PLACEHOLDER + " works.");
});

test("scrubText redacts OpenAI-style keys (sk- and sk-proj-)", () => {
  assert.strictEqual(S.scrubText("key " + OPENAI + "!"), "key " + PLACEHOLDER + "!");
  assert.strictEqual(S.scrubText("key " + OPENAI2 + "!"), "key " + PLACEHOLDER + "!");
});

test("scrubText redacts AWS access key IDs (AKIA/ASIA)", () => {
  assert.strictEqual(S.scrubText("creds " + AKIA + " here"), "creds " + PLACEHOLDER + " here");
});

/* ---------------- 2: no false positives on ordinary prose ---------------- */

test("scrubText preserves ordinary prose containing prefixes", () => {
  const src =
    "The hf benchmark grew, sk metrics climbed, and the AKIA team shipped. " +
    "See hf.co/models and github_pat docs on sk-dev.blog.";
  assert.strictEqual(S.scrubText(src), src, "prose untouched");
  assert.strictEqual(S.scrubText("say hi to my friend Pat"), "say hi to my friend Pat");
});

test("scrubText does not redact short or malformed prefix strings", () => {
  assert.strictEqual(S.scrubText("hf_ab"), "hf_ab"); // too short
  assert.strictEqual(S.scrubText("ghp_12345"), "ghp_12345"); // too short
  assert.strictEqual(S.scrubText("sk-abc"), "sk-abc"); // too short
  assert.strictEqual(S.scrubText("AKIA1234"), "AKIA1234"); // wrong length
  assert.strictEqual(S.scrubText("github_pat_short"), "github_pat_short");
});

/* ---------------- 3: multiple credentials in one text ---------------- */

test("scrubText redacts multiple different credential families in one string", () => {
  const combined = "t=" + GHP + " h=" + HF + " o=" + OPENAI2 + " a=" + AKIA;
  const out = S.scrubText(combined);
  assert.ok(!out.includes(GHP) && !out.includes(HF) && !out.includes(OPENAI2) && !out.includes(AKIA));
  assert.ok(out.includes(PLACEHOLDER));
  assert.strictEqual(out, "t=" + PLACEHOLDER + " h=" + PLACEHOLDER + " o=" + PLACEHOLDER + " a=" + PLACEHOLDER);
});

/* ---------------- 4: story-level scrubbing across fields ---------------- */

test("scrubStory redacts title, description, author and content", () => {
  const story = {
    id: "s12345678",
    title: "Secret in title " + OPENAI,
    description: "Body mentions " + HF,
    author: "dev-" + GHP,
    content: "Full text token " + AKIA,
  };
  const changed = S.scrubStory(story);
  assert.ok(changed >= 4, "changed " + changed + " fields");
  assert.ok(!story.title.includes(OPENAI), "title scrubbed");
  assert.ok(!story.description.includes(HF), "description scrubbed");
  assert.ok(!story.author.includes(GHP), "author scrubbed");
  assert.ok(!story.content.includes(AKIA), "content scrubbed");
});

test("scrubStory redacts Stage 7 ai{} string and string[] fields", () => {
  const story = {
    id: "s12345678",
    title: "ok title",
    ai: {
      summary: "uses " + OPENAI2,
      whyItMatters: "key " + AKIA,
      keyTakeaways: ["point about " + HF, "clean point"],
    },
  };
  const changed = S.scrubStory(story);
  assert.ok(changed >= 3, "changed " + changed + " fields");
  assert.ok(!story.ai.summary.includes(OPENAI2));
  assert.ok(!story.ai.whyItMatters.includes(AKIA));
  assert.ok(!story.ai.keyTakeaways[0].includes(HF));
  assert.strictEqual(story.ai.keyTakeaways[1], "clean point");
});

test("scrubStory returns 0 and leaves the story untouched when nothing matches", () => {
  const story = {
    id: "s12345678",
    title: "radar detects a clean release",
    description: "no credentials here",
    content: "plain prose",
  };
  const snapshot = JSON.stringify(story);
  assert.strictEqual(S.scrubStory(story), 0);
  assert.strictEqual(JSON.stringify(story), snapshot, "story unchanged");
});

test("scrubStory is safe with missing / non-string fields", () => {
  const story = { id: "s12345678", title: null, content: undefined };
  assert.strictEqual(S.scrubStory(story), 0);
  assert.strictEqual(S.scrubStory(null), 0);
  assert.strictEqual(S.scrubStory("plain string"), 0);
});

/* ---------------- 5: scrubStories aggregates ---------------- */

test("scrubStories redacts a batch and aggregates counts without dropping stories", () => {
  const items = [
    { id: "s11111111", title: "clean" },
    { id: "s22222222", title: "boom " + GHP },
    { id: "s33333333", title: "boom " + HF },
  ];
  const agg = S.scrubStories(items);
  assert.strictEqual(items.length, 3, "no story dropped");
  assert.strictEqual(agg.scrubbedStories, 2);
  assert.strictEqual(agg.changedFields, 2);
  assert.strictEqual(agg.changedFields >= agg.scrubbedStories, true);
});

test("scrubStories handles null / non-array input", () => {
  assert.deepStrictEqual(S.scrubStories(), { scrubbedStories: 0, changedFields: 0 });
  assert.deepStrictEqual(S.scrubStories(null), { scrubbedStories: 0, changedFields: 0 });
  assert.deepStrictEqual(S.scrubStories([null, undefined]), { scrubbedStories: 0, changedFields: 0 });
});

/* ---------------- 6: determinism / idempotency ---------------- */

test("scrubText is idempotent (second pass is a no-op)", () => {
  const src = "t=" + GHP + " h=" + HF + " o=" + OPENAI2;
  const once = S.scrubText(src);
  const twice = S.scrubText(once);
  assert.strictEqual(twice, once, "placeholder is never re-scrubbed");
});

test("scrubStory is idempotent across a full story", () => {
  const story = {
    id: "s12345678",
    title: "t " + GHP,
    description: "d " + HF,
    content: "c " + AKIA,
    ai: { summary: "s " + OPENAI2 },
  };
  S.scrubStory(story);
  const afterFirst = JSON.stringify(story);
  assert.strictEqual(S.scrubStory(story), 0, "second pass changes nothing");
  assert.strictEqual(JSON.stringify(story), afterFirst);
});

/* ---------------- 7: findCredentialMatches diagnostics ---------------- */

test("findCredentialMatches locates matches with pattern + index", () => {
  const src = "a " + GHP + " b " + HF + " c";
  const matches = S.findCredentialMatches(src);
  assert.strictEqual(matches.length, 2);
  assert.deepStrictEqual(
    matches.map((m) => m.pattern),
    ["github-classic-pat", "huggingface-token"]
  );
  assert.ok(matches.every((m) => typeof m.index === "number"));
  assert.strictEqual(S.findCredentialMatches("clean prose").length, 0);
  assert.strictEqual(S.findCredentialMatches(null).length, 0);
});