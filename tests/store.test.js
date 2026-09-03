/*
 * Stage 5 tests: persistent store (scripts/pipeline/store.js).
 * Uses node:test (zero extra dependencies). Every test uses a temp dbDir so
 * the real data/db is never touched.
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const Core = require("../js/shared.js");
const Store = require("../scripts/pipeline/store.js");

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

function story(title, link, pubDate, opts = {}) {
  return Core.normalizeItem(
    { title, link, pubDate },
    Object.assign({}, SRC, opts.source),
    { nowMs: opts.nowMs != null ? opts.nowMs : NOW }
  );
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "airadar-store-test-"));
}

function cleanup(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    /* best effort */
  }
}

/* ---------------- 1: day bucketing ---------------- */

test("upsertStories: files by publishedAt day; falls back to discoveredAt when null", () => {
  const dir = tempDir();
  try {
    const a = story("OpenAI launches GPT-6", "https://openai.com/blog/gpt6", "2026-09-02T01:00:00Z");
    const nullPub = story("Stories with no pubdate", "https://openai.com/blog/x", null, { nowMs: NOW });
    const r = Store.upsertStories([a, nullPub], { dbDir: dir, now: NOW });

    assert.deepStrictEqual(Store.listDayFolders(dir), ["2026-09-02"]);
    const day = Store.readDay(dir, "2026-09-02");
    assert.strictEqual(day.length, 2);

    const nullDay = Store.storyDay(nullPub);
    assert.strictEqual(nullDay, "2026-09-02"); // falls back to discoveredAt
    assert.strictEqual(r.upserted, 2);
  } finally {
    cleanup(dir);
  }
});

/* ---------------- 2: idempotent re-run ---------------- */

test("upsertStories: re-running the same upsert is a no-op", () => {
  const dir = tempDir();
  try {
    const a = story("OpenAI launches GPT-6", "https://openai.com/blog/gpt6", "2026-09-02T01:00:00Z");
    Store.upsertStories([a], { dbDir: dir, now: NOW });
    const dayFile = Store.dayFile(dir, "2026-09-02");
    const beforeBytes = fs.readFileSync(dayFile, "utf8");
    const beforeIndex = fs.readFileSync(Store.indexFile(dir), "utf8");

    // Same input + same time -> byte-for-byte identical (day + index).
    const second = Store.upsertStories([a], { dbDir: dir, now: NOW });
    assert.strictEqual(second.upserted, 0);
    assert.strictEqual(second.updated, 0);
    assert.strictEqual(second.unchanged, 1);
    assert.strictEqual(second.total, 1);
    assert.strictEqual(fs.readFileSync(dayFile, "utf8"), beforeBytes);
    assert.strictEqual(fs.readFileSync(Store.indexFile(dir), "utf8"), beforeIndex);

    // A later re-run must not duplicate or churn the story content (day file
    // unchanged); only the global index updatedAt metadata stamp advances.
    const third = Store.upsertStories([a], { dbDir: dir, now: NOW + 5000 });
    assert.strictEqual(third.unchanged, 1);
    assert.strictEqual(third.upserted, 0);
    assert.strictEqual(fs.readFileSync(dayFile, "utf8"), beforeBytes);
  } finally {
    cleanup(dir);
  }
});

/* ---------------- 3: update path ---------------- */

test("upsertStories: same id with newer updatedAt updates; older is ignored", () => {
  const dir = tempDir();
  try {
    // First pass: discover at NOW
    const a1 = story("OpenAI launches GPT-6", "https://openai.com/blog/gpt6", "2026-09-02T01:00:00Z", { nowMs: NOW });
    Store.upsertStories([a1], { dbDir: dir, now: NOW });

    // Newer discovery of the SAME story -> same id, updatedAt advanced
    const a2 = story("OpenAI launches GPT-6", "https://openai.com/blog/gpt6", "2026-09-02T01:00:00Z", { nowMs: NOW + 3600000 });
    assert.strictEqual(a2.id, a1.id);
    const upd = Store.upsertStories([a2], { dbDir: dir, now: NOW + 3600000 });
    assert.strictEqual(upd.updated, 1);
    assert.strictEqual(upd.unchanged, 0);

    // An OLDER version of the same story must NOT overwrite the newer record
    const aOld = story("OpenAI launches GPT-6", "https://openai.com/blog/gpt6", "2026-09-02T01:00:00Z", { nowMs: NOW });
    const ignored = Store.upsertStories([aOld], { dbDir: dir, now: NOW + 7200000 });
    assert.strictEqual(ignored.unchanged, 1);
    assert.strictEqual(ignored.updated, 0);
    const stored = Store.readById(dir, a2.id);
    assert.strictEqual(stored.updatedAt, a2.updatedAt);
  } finally {
    cleanup(dir);
  }
});

/* ---------------- 4: read APIs ---------------- */

test("readDay / readById / recent return the persisted data", () => {
  const dir = tempDir();
  try {
    const a = story("OpenAI launches GPT-6", "https://openai.com/blog/gpt6", "2026-09-02T01:00:00Z");
    const b = story("DeepMind protein folding", "https://deepmind.google/blog/protein", "2026-08-15T00:00:00Z");
    const c = story("Hugging Face transformers", "https://hf.co/blog/tr", "2026-09-02T02:00:00Z");
    Store.upsertStories([a, b, c], { dbDir: dir, now: NOW });

    assert.strictEqual(Store.readById(dir, a.id).id, a.id);
    assert.strictEqual(Store.readById(dir, b.id).title, b.title);
    assert.strictEqual(Store.readById(dir, "s00000000"), null); // unknown id
    assert.strictEqual(Store.readById(dir, "bogus"), null); // malformed id

    assert.strictEqual(Store.readDay(dir, "2026-09-02").length, 2);
    assert.strictEqual(Store.readDay(dir, "2026-08-15").length, 1);
    assert.strictEqual(Store.readDay(dir, "2020-01-01").length, 0); // empty day
    assert.strictEqual(Store.readDay(dir, "not-a-day").length, 0); // malformed day

    const r = Store.recent(dir, { limit: 10 });
    assert.strictEqual(r.length, 3);
    assert.strictEqual(r[0].id, c.id); // newest publishedAt first
  } finally {
    cleanup(dir);
  }
});

/* ---------------- 5: retention / prune ---------------- */

test("prune: removes only archives older than the retention window", () => {
  const dir = tempDir();
  try {
    const recent = story("Recent story", "https://x.example/recent", "2026-09-01T00:00:00Z");
    const ancient = story("Ancient story", "https://x.example/old", "2025-12-01T00:00:00Z");
    Store.upsertStories([recent, ancient], { dbDir: dir, now: NOW });

    // retention 200 days from 2026-09-02 -> cutoff ~2026-02-14; 2025-12-01 is older
    const pr = Store.prune(dir, { now: NOW, retentionDays: 200 });
    assert.deepStrictEqual(pr.prunedDays, ["2025-12-01"]);
    assert.strictEqual(pr.prunedStories, 1);

    assert.deepStrictEqual(Store.listDayFolders(dir), ["2026-09-01"]);
    assert.strictEqual(Store.readById(dir, ancient.id), null);
    assert.strictEqual(Store.readById(dir, recent.id).id, recent.id);
  } finally {
    cleanup(dir);
  }
});

/* ---------------- 6: run log ---------------- */

test("runLog: writes a per-run log file with the expected fields", () => {
  const dir = tempDir();
  try {
    const runId = Store.runLog(
      dir,
      { startedAt: new Date(NOW).toISOString(), normalized: 100, stored: 98, prunedDays: 2 },
      { now: NOW }
    );
    assert.ok(typeof runId === "string" && runId.length > 0);
    const files = Store.listRuns(dir);
    assert.strictEqual(files.length, 1);
    assert.ok(files[0].endsWith(".json"));

    const rec = JSON.parse(fs.readFileSync(Store.runsFile(dir, runId), "utf8"));
    assert.strictEqual(rec.runId, runId);
    assert.strictEqual(rec.normalized, 100);
    assert.strictEqual(rec.stored, 98);
    assert.strictEqual(rec.prunedDays, 2);
    assert.ok(rec.createdAt && rec.finishedAt);
  } finally {
    cleanup(dir);
  }
});

/* ---------------- 7: determinism ---------------- */

test("store: identical input produces identical stored bytes (deterministic)", () => {
  const dirA = tempDir();
  const dirB = tempDir();
  try {
    const items = [
      story("OpenAI launches GPT-6", "https://openai.com/blog/gpt6", "2026-09-02T01:00:00Z", { nowMs: NOW }),
      story("DeepMind protein folding", "https://deepmind.google/blog/protein", "2026-08-15T00:00:00Z", { nowMs: NOW }),
    ];
    const ra = Store.upsertStories(items, { dbDir: dirA, now: NOW });
    const rb = Store.upsertStories(items, { dbDir: dirB, now: NOW });
    assert.strictEqual(ra.total, rb.total);

    // Day + index bytes identical (updatedAt derives from fixed now)
    assert.strictEqual(
      fs.readFileSync(Store.dayFile(dirA, "2026-09-02"), "utf8"),
      fs.readFileSync(Store.dayFile(dirB, "2026-09-02"), "utf8")
    );
    assert.strictEqual(
      fs.readFileSync(Store.indexFile(dirA), "utf8"),
      fs.readFileSync(Store.indexFile(dirB), "utf8")
    );
  } finally {
    cleanup(dirA);
    cleanup(dirB);
  }
});

/* ---------------- 8: malformed data / edge cases ---------------- */

test("store: malformed lines in a day file are skipped, not fatal", () => {
  const dir = tempDir();
  try {
    const a = story("Good story", "https://x.example/good", "2026-09-02T01:00:00Z");
    Store.upsertStories([a], { dbDir: dir, now: NOW });

    // Corrupt the day file with one bad line
    const file = Store.dayFile(dir, "2026-09-02");
    fs.writeFileSync(file, '{not valid json}\n' + fs.readFileSync(file, "utf8"));

    assert.strictEqual(Store.readDay(dir, "2026-09-02").length, 1); // good line survives
  } finally {
    cleanup(dir);
  }
});

test("store: invalid ids and empty input are handled safely", () => {
  const dir = tempDir();
  try {
    const bad = Object.assign({}, story("Bad", "https://x/ok", "2026-09-02T00:00:00Z"), { id: "not-an-id" });
    const r = Store.upsertStories([bad], { dbDir: dir, now: NOW });
    assert.strictEqual(r.skipped, 1);
    assert.strictEqual(r.total, 0);
    assert.deepStrictEqual(Store.listDayFolders(dir), []);

    // Empty input -> empty store, no crash
    const empty = Store.upsertStories([], { dbDir: dir, now: NOW });
    assert.strictEqual(empty.total, 0);
    assert.deepStrictEqual(Store.readDay(dir, "2026-09-02"), []);
    assert.strictEqual(Store.stats(dir).storyCount, 0);
  } finally {
    cleanup(dir);
  }
});

/* ---------------- 9: store leaves no schema/Stage-1/4 regressions ---------------- */

test("store does not mutate the canonical Story objects it receives", () => {
  const dir = tempDir();
  try {
    const a = story("OpenAI launches GPT-6", "https://openai.com/blog/gpt6", "2026-09-02T01:00:00Z");
    const before = JSON.stringify(a);
    Store.upsertStories([a], { dbDir: dir, now: NOW });
    assert.strictEqual(JSON.stringify(a), before);
    // round-trip preserves the schema-valid story
    const round = Store.readById(dir, a.id);
    assert.strictEqual(Core.validateStory(round).valid, true);
    assert.strictEqual(round.schemaVersion, "1.0");
  } finally {
    cleanup(dir);
  }
});

/* ---------------- 10: storyDay / storable helpers ---------------- */

test("storyDay uses publishedAt then discoveredAt; storable requires a valid id", () => {
  const a = story("Num one", "https://x.example/n1", "2026-09-02T01:30:00Z", { nowMs: NOW });
  assert.strictEqual(Store.storyDay(a), "2026-09-02");
  assert.strictEqual(Store.storable(a), true);

  const noPub = story("No pubdate", "https://x.example/n2", null, { nowMs: NOW });
  assert.strictEqual(Store.storyDay(noPub), "2026-09-02");
  assert.strictEqual(Store.storable(noPub), true);

  assert.strictEqual(Store.storable({ ...noPub, id: "BAD" }), false);
  assert.strictEqual(Store.storable(null), false);
});
