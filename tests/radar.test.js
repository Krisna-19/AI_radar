/*
 * Stage 12 tests: Radar module (js/radar.js) - pure fragments and per-entity
 * aggregation. No DOM/browser required (matches the node:test convention).
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert");

const Radar = require("../js/radar.js");

function record(id, overrides) {
  return Object.assign(
    {
      id: "s" + id,
      title: "Story " + id,
      companies: [],
      models: [],
      technologies: [],
      radarScore: 60,
      category: "news",
      publishedAt: "2026-09-05T10:00:00Z",
      discoveredAt: "2026-09-05T11:00:00Z",
    },
    overrides
  );
}

/* ---------------- routing / slugs ---------------- */

test("slugify is deterministic and URL-safe", () => {
  assert.strictEqual(Radar.slugify("OpenAI"), "openai");
  assert.strictEqual(Radar.slugify("Google DeepMind"), "google-deepmind");
  assert.strictEqual(Radar.slugify("Anthropic AI"), "anthropic-ai");
  assert.strictEqual(Radar.slugify("  Mistral   (2026)  "), "mistral-2026");
  assert.strictEqual(Radar.slugify(""), "");
});

test("radarUrl / parseHash round-trip for every group", () => {
  for (const g of Radar.GROUP_ORDER) {
    const url = Radar.radarUrl(g, "OpenAI");
    const r = Radar.parseHash(url);
    assert.strictEqual(r.kind, "radar-entity");
    assert.strictEqual(r.group, g);
    assert.strictEqual(r.slug, "openai");
  }
});

test("parseHash: global, entity, non-radar and malformed", () => {
  assert.deepStrictEqual(Radar.parseHash("#/radar/global"), { kind: "radar-global" });
  assert.strictEqual(Radar.parseHash("#/radar/model/gpt-5").kind, "radar-entity");
  assert.strictEqual(Radar.parseHash("#/radar/research/multilingual").kind, "radar-entity");
  assert.strictEqual(Radar.parseHash("").kind, "none");
  assert.strictEqual(Radar.parseHash("#/history").kind, "none");
  assert.strictEqual(Radar.parseHash("#/radar/people/sam-altman").kind, "radar-unknown");
  assert.strictEqual(Radar.parseHash("#/radar/company/--").kind, "radar-entity");
  assert.strictEqual(Radar.isRadarHash("#/radar/company/openai"), true);
  assert.strictEqual(Radar.isRadarHash("#/history"), false);
});

/* ---------------- entity aggregation ---------------- */

const RECORDS = [
  record("1", { companies: ["OpenAI", "Anthropic"], models: ["GPT-6", "Claude 5"], technologies: ["Agents"] , radarScore: 90 }),
  record("2", { companies: ["OpenAI"], models: ["GPT-6"], technologies: ["Agents", "RLHF"], radarScore: 70 }),
  record("3", { companies: ["Anthropic"], models: ["Claude 5"], technologies: ["Pricing"], radarScore: 50 }),
  record("4", { companies: ["Mistral"], models: ["Mistral Large"], technologies: [], radarScore: null }),
  record("5", { companies: ["OpenAI"], models: ["GPT-6 Astra"], technologies: [], radarScore: 30 }),
];

test("entityNames: distinct counts, sorted count desc then name asc", () => {
  const names = Radar.entityNames(RECORDS, "company");
  assert.deepStrictEqual(names, [
    { name: "OpenAI", slug: "openai", count: 3 },
    { name: "Anthropic", slug: "anthropic", count: 2 },
    { name: "Mistral", slug: "mistral", count: 1 },
  ]);
  assert.strictEqual(Radar.entityNames(RECORDS, "model").length, 4);
});

test("entityStats: count + average radar score (null scores skipped)", () => {
  const stats = Radar.entityStats(RECORDS, "company");
  const openai = stats.find((e) => e.name === "OpenAI");
  assert.strictEqual(openai.count, 3);
  assert.strictEqual(openai.avgScore, Math.round(((90 + 70 + 30) / 3) * 10) / 10);
  const mistral = stats.find((e) => e.name === "Mistral");
  assert.strictEqual(mistral.count, 1);
  assert.strictEqual(mistral.avgScore, null);
});

test("resolveEntity: slug lookup, null when absent", () => {
  assert.deepStrictEqual(
    Radar.resolveEntity(RECORDS, "company", "openai"),
    { name: "OpenAI", slug: "openai", count: 3 }
  );
  assert.strictEqual(Radar.resolveEntity(RECORDS, "company", "elsewhere"), null);
});

test("groupOfToken: exact case-insensitive match, priority company > model > research", () => {
  assert.strictEqual(Radar.groupOfToken(RECORDS, "openai"), "company");
  assert.strictEqual(Radar.groupOfToken(RECORDS, "gpt-6"), "model");
  assert.strictEqual(Radar.groupOfToken(RECORDS, "Agents"), "research");
  assert.strictEqual(Radar.groupOfToken(RECORDS, "MISTRAL"), "company"); // exact name match
  assert.strictEqual(Radar.groupOfToken(RECORDS, "Open"), null); // no fuzzy prefix match
  assert.strictEqual(Radar.groupOfToken(RECORDS, ""), null);
});

test("entityStories: exact name filter (case-insensitive), no partial matches", () => {
  assert.strictEqual(Radar.entityStories(RECORDS, "company", "OpenAI").length, 3);
  assert.strictEqual(Radar.entityStories(RECORDS, "model", "GPT-6").length, 2);
  assert.strictEqual(Radar.entityStories(RECORDS, "model", "GPT").length, 0); // stem not a name
});

test("relatedEntities: co-occurring entities across a company's stories", () => {
  const related = Radar.relatedEntities(RECORDS, "company", "OpenAI");
  const models = related.filter((r) => r.group === "model");
  assert.ok(models.some((r) => r.name === "GPT-6" && r.count === 2));
  assert.ok(models.some((r) => r.name === "GPT-6 Astra" && r.count === 1));
  assert.ok(related.every((r) => r.group !== "company"), "same group excluded");
  assert.ok(related.every((r) => r.name !== "OpenAI"));
});

/* ---------------- index hint ---------------- */

test("setIndex/getIndex round-trip used for chip routing", () => {
  Radar.setIndex(RECORDS);
  assert.strictEqual(Radar.getIndex(), RECORDS);
  assert.strictEqual(Radar.groupOfToken(Radar.getIndex(), "Claude 5"), "model");
  Radar.setIndex(null);
  assert.strictEqual(Radar.getIndex(), null);
});

/* ---------------- determinism / emptiness ---------------- */

test("empty and null inputs are safe", () => {
  assert.deepStrictEqual(Radar.entityNames([], "company"), []);
  assert.deepStrictEqual(Radar.entityStats(null, "company"), []);
  assert.deepStrictEqual(Radar.relatedEntities(null, "company", "X"), []);
  assert.strictEqual(Radar.entityStories([], "company", "X").length, 0);
  assert.strictEqual(Radar.parseHash(null).kind, "none");
  assert.strictEqual(Radar.radarUrl("company", null), "#/radar/company/");
});

test("aggregation is deterministic across calls", () => {
  const a = JSON.stringify(Radar.entityStats(RECORDS, "company"));
  const b = JSON.stringify(Radar.entityStats(RECORDS, "company"));
  assert.strictEqual(a, b);
});