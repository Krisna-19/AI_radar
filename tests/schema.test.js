/*
 * Stage 3 tests: canonical Story schema (normalizeItem + validateStory).
 * Uses node:test (zero extra dependencies).
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert");

const Core = require("../js/shared.js");

const NOW = Date.UTC(2026, 8, 2, 12, 0, 0);

const SRC = {
  id: "demo",
  name: "Demo Feed",
  url: "http://placeholder.example/feed",
  category: "media",
  enabled: true,
  priority: 100,
  fetchIntervalHours: 3,
  parser: "auto",
  reliability: 6,
  weight: 3,
  color: "#abcdef",
};

/* ---------------- 1-3: valid RSS / Atom / RDF items ---------------- */

test("normalizeItem: valid RSS item -> canonical story", () => {
  const raw = {
    title: "  OpenAI   Launches  NEW! Model  ",
    link: "https://openai.com/blog/new-model?utm_source=rss&utm_medium=feed",
    pubDate: "Mon, 01 Sep 2026 09:00:00 GMT",
    description: "<p>A&nbsp;quick&nbsp;summary</p>",
  };
  const s = Core.normalizeItem(raw, SRC, { nowMs: NOW });
  assert.strictEqual(s.schemaVersion, "1.0");
  assert.strictEqual(s.title, "OpenAI Launches NEW! Model");
  assert.strictEqual(s.source.id, "demo");
  assert.strictEqual(s.source.type, "media");
  assert.strictEqual(s.category, "product");
  assert.strictEqual(s.publishedAt, "2026-09-01T09:00:00.000Z");
  assert.strictEqual(s.discoveredAt, new Date(NOW).toISOString());
});

test("normalizeItem: valid Atom item (published/updated timestamps)", () => {
  const rawUpdated = { title: "Atom update", link: "https://hf.co/blog/update", pubDate: "2026-09-02T08:30:00Z" };
  const s = Core.normalizeItem(rawUpdated, SRC, { nowMs: NOW });
  assert.strictEqual(s.publishedAt, "2026-09-02T08:30:00.000Z");
});

test("normalizeItem: valid RDF (RSS 1.0) item", () => {
  const raw = {
    title: "AI cracks long-standing protein problem",
    link: "https://www.nature.com/d41586-026-00001-0",
    pubDate: "2026-09-01T10:00:00Z",
  };
  const s = Core.normalizeItem(raw, SRC, { nowMs: NOW });
  assert.strictEqual(s.title, "AI cracks long-standing protein problem");
  assert.strictEqual(s.originalUrl, "https://www.nature.com/d41586-026-00001-0");
  assert.strictEqual(Core.validateStory(s).valid, true);
});

/* ---------------- 4: missing optional fields ---------------- */

test("normalizeItem: missing optional fields -> null/[] and still valid", () => {
  const s = Core.normalizeItem({ title: "Only a title", link: "https://x.dev/a" }, SRC, { nowMs: NOW });
  assert.strictEqual(s.description, null);
  assert.strictEqual(s.author, null);
  assert.strictEqual(s.imageUrl, null);
  assert.strictEqual(s.content, null);
  assert.strictEqual(s.subcategory, null);
  assert.deepStrictEqual(s.tags, []);
  assert.deepStrictEqual(s.companies, []);
  assert.deepStrictEqual(s.ai.keyTakeaways, []);
  assert.deepStrictEqual(s.relatedStoryIds, []);
  assert.strictEqual(Core.validateStory(s).valid, true);
});

/* ---------------- 5: missing title ---------------- */

test("normalizeItem: missing title -> falls back to 'Untitled' but url stays", () => {
  const s = Core.normalizeItem({ link: "https://x.dev/no-title" }, SRC, { nowMs: NOW });
  assert.strictEqual(s.title, "Untitled");
  assert.strictEqual(s.originalUrl, "https://x.dev/no-title");
});

/* ---------------- 6: missing URL ---------------- */

test("normalizeItem: missing URL -> originalUrl '' but canonicalUrl stays ''", () => {
  const s = Core.normalizeItem({ title: "No link" }, SRC, { nowMs: NOW });
  assert.strictEqual(s.originalUrl, "");
  assert.strictEqual(s.canonicalUrl, "");
});

/* ---------------- 7: invalid URL ---------------- */

test("canonicalizeUrl: invalid URL -> null; validateStory flags bad url", () => {
  assert.strictEqual(Core.canonicalizeUrl("not a url"), null);
  const bad = Core.normalizeItem({ title: "t", link: "not a url" }, SRC, { nowMs: NOW });
  assert.strictEqual(bad.canonicalUrl, "not a url"); // preserved as-is when unparseable
  const check = Core.validateStory(bad);
  assert.strictEqual(check.valid, false);
  assert.ok(check.errors.some((e) => e.field === "originalUrl"));
});

/* ---------------- 8: invalid date ---------------- */

test("normalizeItem: invalid date -> publishedAt null (never invented)", () => {
  const s = Core.normalizeItem({ title: "t", link: "https://x.dev/d", pubDate: "not a date" }, SRC, { nowMs: NOW });
  assert.strictEqual(s.publishedAt, null);
  assert.ok(Core.validateStory(s).valid);
});

/* ---------------- 9: URL tracking parameters ---------------- */

test("canonicalizeUrl: strips utm_* and known tracking params, preserves originalUrl", () => {
  const raw = {
    title: "tracked",
    link: "https://example.com/story?a=1&utm_source=rss&utm_campaign=summer&fbclid=xyz&gclid=abc",
  };
  const s = Core.normalizeItem(raw, SRC, { nowMs: NOW });
  assert.strictEqual(s.originalUrl, "https://example.com/story?a=1&utm_source=rss&utm_campaign=summer&fbclid=xyz&gclid=abc");
  assert.ok(!s.canonicalUrl.includes("utm_"));
  assert.ok(!s.canonicalUrl.includes("fbclid"));
  assert.ok(!s.canonicalUrl.includes("gclid"));
  assert.ok(s.canonicalUrl.includes("a=1"), "legitimate param preserved");
  assert.ok(s.canonicalUrl.startsWith("https://example.com/story"));
});

test("canonicalizeUrl: keeps url path case and does not alter host except lowercase", () => {
  const s = Core.normalizeItem({ title: "t", link: "https://WWW.Example.com/Path/To/Story" }, SRC, { nowMs: NOW });
  assert.strictEqual(s.canonicalUrl, "https://www.example.com/Path/To/Story");
});

/* ---------------- 10: timestamp normalization ---------------- */

test("normalizeTimestamp: returns UTC ISO-8601 for many formats, null for garbage", () => {
  assert.strictEqual(Core.normalizeTimestamp("Mon, 01 Sep 2026 09:00:00 GMT"), "2026-09-01T09:00:00.000Z");
  assert.strictEqual(Core.normalizeTimestamp("2026-09-02T08:00:00Z"), "2026-09-02T08:00:00.000Z");
  assert.strictEqual(Core.normalizeTimestamp("2026-09-01"), "2026-09-01T00:00:00.000Z");
  assert.strictEqual(Core.normalizeTimestamp(""), null);
  assert.strictEqual(Core.normalizeTimestamp("garbage"), null);
});

/* ---------------- 11: source metadata ---------------- */

test("normalizeItem: nested source metadata captured from sources.json config", () => {
  const s = Core.normalizeItem({ title: "t", link: "https://x.dev/s" }, SRC, { nowMs: NOW });
  assert.deepStrictEqual(s.source, {
    id: "demo",
    name: "Demo Feed",
    type: "media",
    reliability: 6,
    priority: 100,
    weight: 3,
    color: "#abcdef",
  });
  // flat aliases mirror the nested source for the current frontend
  assert.strictEqual(s.sourceId, "demo");
  assert.strictEqual(s.sourceName, "Demo Feed");
  assert.strictEqual(s.sourceType, "media");
  assert.strictEqual(s.sourceColor, "#abcdef");
});

/* ---------------- 12-13: stable id + fingerprint ---------------- */

test("normalizeItem: same input -> same id, fingerprint and canonicalUrl (deterministic)", () => {
  const raw = { title: "OpenAI launches new model", link: "https://openai.com/blog/new-model?utm_source=rss", pubDate: "2026-09-02T00:00:00Z" };
  const a = Core.normalizeItem(raw, SRC, { nowMs: 1 });
  const b = Core.normalizeItem(raw, SRC, { nowMs: 2 });
  assert.strictEqual(a.id, b.id);
  assert.strictEqual(a.fingerprint, b.fingerprint);
  assert.strictEqual(a.canonicalUrl, b.canonicalUrl);
  assert.match(a.id, /^s[0-9a-f]{8}$/);
  // id equal to the Stage 1 id derived from the SAME title+originalUrl
  assert.strictEqual(a.id, Core.buildStoryId(raw.title, raw.link));
});

/* ---------------- 14: deterministic normalization ---------------- */

test("normalizeItem: whitespace/case normalization is idempotent and stable", () => {
  const raw = { title: "  DeepMind  Unlocks  Protein  ", link: "https://DeepMind.google/Blog/Protein?utm_source=x", pubDate: "2026-09-01T00:00:00Z" };
  const s1 = Core.normalizeItem(raw, SRC, { nowMs: NOW });
  const s2 = Core.normalizeItem(
    { title: " DeepMind Unlocks Protein ", link: "https://deepmind.google/Blog/Protein", pubDate: "2026-09-01T00:00:00Z" },
    SRC,
    { nowMs: NOW }
  );
  assert.strictEqual(s1.title, s2.title);
  assert.strictEqual(s1.id, s2.id);
  assert.strictEqual(s1.canonicalUrl, s2.canonicalUrl);
});

/* ---------------- 15: schema validation ---------------- */

test("validateStory: rejects missing required fields with field errors", () => {
  const s = Core.normalizeItem({ title: "t", link: "https://x.dev/v", pubDate: "2026-09-01T00:00:00Z" }, SRC, { nowMs: NOW });
  // A story missing schemaVersion should be invalid
  const bad = Object.assign({}, s, { schemaVersion: "9.9" });
  const r = Core.validateStory(bad);
  assert.strictEqual(r.valid, false);
  assert.ok(r.errors.some((e) => e.field === "schemaVersion"));

  // missing title
  const noTitle = Object.assign({}, s, { title: "" });
  assert.strictEqual(Core.validateStory(noTitle).valid, false);

  // invalid discoveredAt
  const noDate = Object.assign({}, s, { discoveredAt: "garbage" });
  assert.strictEqual(Core.validateStory(noDate).valid, false);

  assert.strictEqual(Core.validateStory(s).valid, true);
});

/* ---------------- 16: schema version ---------------- */

test("schema: SCHEMA_VERSION is 1.0 and every normalized story carries it", () => {
  assert.strictEqual(Core.SCHEMA_VERSION, "1.0");
  const s = Core.normalizeItem({ title: "t", link: "https://x.dev/sv", pubDate: "2026-09-01T00:00:00Z" }, SRC, { nowMs: NOW });
  assert.strictEqual(s.schemaVersion, "1.0");
});

/* ---------------- 17: empty arrays ---------------- */

test("normalizeArray: null/missing/array handled consistently (never undefined)", () => {
  assert.deepStrictEqual(Core.normalizeArray(null), []);
  assert.deepStrictEqual(Core.normalizeArray(undefined), []);
  assert.deepStrictEqual(Core.normalizeArray(["a", "b"]), ["a", "b"]);
  const s = Core.normalizeItem({ title: "t", link: "https://x.dev/arr", pubDate: "2026-09-01T00:00:00Z" }, SRC, { nowMs: NOW });
  for (const f of ["tags", "companies", "people", "models", "technologies", "countries", "relatedStoryIds", "sources"]) {
    assert.ok(Array.isArray(s[f]), f + " is an array");
  }
  assert.strictEqual(Core.validateStory(s).valid, true);
});

/* ---------------- 18: multiple sources ---------------- */

test("normalizeItem: same raw story from different sources gets same id but different source context", () => {
  const raw = { title: "Shared story", link: "https://x.dev/shared", pubDate: "2026-09-01T00:00:00Z" };
  const srcA = Object.assign({}, SRC, { id: "outlet-a", name: "Outlet A", reliability: 9, priority: 5, weight: 4 });
  const srcB = Object.assign({}, SRC, { id: "outlet-b", name: "Outlet B", reliability: 3, priority: 90, weight: 2 });
  const a = Core.normalizeItem(raw, srcA, { nowMs: NOW });
  const b = Core.normalizeItem(raw, srcB, { nowMs: NOW });
  // identical story identity
  assert.strictEqual(a.id, b.id);
  assert.strictEqual(a.fingerprint, b.fingerprint);
  // distinct source context (the cross-outlet merge is Stage 4)
  assert.strictEqual(a.source.id, "outlet-a");
  assert.strictEqual(b.source.id, "outlet-b");
  assert.strictEqual(a.source.reliability, 9);
  assert.strictEqual(b.source.reliability, 3);
});

/* ---------------- backward-compat: enrichItem wrapper ---------------- */

test("enrichItem: legacy wrapper preserves Stage 2 flat contract (stable ids)", () => {
  const raw = { title: "OpenAI launches new model", link: "https://openai.com/blog/new-model", pubDate: "2026-09-02T00:00:00Z" };
  const e1 = Core.enrichItem(raw, SRC, 0, 1234567890);
  const e2 = Core.enrichItem(raw, SRC, 0, 9999999999);
  assert.strictEqual(e1.id, e2.id);
  assert.strictEqual(e1.id, Core.buildStoryId(raw.title, raw.link));
  assert.strictEqual(e1.fingerprint, Core.canonicalKey(raw.title, raw.link));
  assert.strictEqual(e1.sourceType, SRC.category);
  assert.strictEqual(e1.sourceName, "Demo Feed");
  assert.ok(e1.discoveredAt);
});
