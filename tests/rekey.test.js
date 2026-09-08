/*
 * Stage 12 tests: archive re-key sweep (scripts/pipeline/store.js).
 *
 * The sweep re-keys legacy rows (whose ids were derived from dirty titles that
 * carry a trailing publisher-alias suffix) onto the CLEAN identity and merges
 * duplicate copies of the same article that previously split across two ids.
 * Uses node:test (zero extra dependencies). Every test uses a temp dbDir.
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const Core = require("../js/shared.js");
const Store = require("../scripts/pipeline/store.js");

const NOW = Date.UTC(2026, 8, 5, 12, 0, 0);

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

/* A LEGACY row: normalizeItem under an OLD ruleset would derive the id from
 * the dirty title ("... - Reuters") because no suffix stripping existed yet.
 * We simulate that by computing the dirty id manually. */
function dirtyStory(title, link, pubDate, opts = {}) {
  const rec = Core.normalizeItem({ title, link, pubDate }, SRC, {
    nowMs: opts.nowMs != null ? opts.nowMs : NOW,
  });
  rec.title = title;
  rec.id = Core.buildStoryId(title, link);
  rec.fingerprint = Core.canonicalKey(title, link);
  return rec;
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "airadar-rekey-test-"));
}

function cleanup(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    /* best effort */
  }
}

/* ---------------- assertIdentityConsistent ---------------- */

test("assertIdentityConsistent: flags legacy dirty-title rows, clean otherwise", () => {
  const dir = tempDir();
  try {
    // clean row (no suffix)
    const clean = Core.normalizeItem(
      { title: "Plain headline", link: "https://r.example.com/a", pubDate: "2026-09-04T10:00:00Z" },
      SRC,
      { nowMs: NOW }
    );
    // legacy row whose id was computed from the dirty title
    const dirty = dirtyStory("Plain headline - Reuters", "https://r.example.com/b", "2026-09-04T11:00:00Z");
    Store.upsertStories([clean, dirty], { dbDir: dir, now: NOW });

    const res = Store.assertIdentityConsistent(dir);
    assert.strictEqual(res.checked, 2);
    assert.strictEqual(res.inconsistent.length, 1);
    assert.strictEqual(res.inconsistent[0].id, dirty.id);
    assert.strictEqual(
      res.inconsistent[0].cleanId,
      Core.buildStoryId("Plain headline", "https://r.example.com/b")
    );
    assert.strictEqual(Core.cleanTitleForIdentity(dirty.title).title, "Plain headline");
  } finally {
    cleanup(dir);
  }
});

/* ---------------- rekey: suffix aliases collapse to one story ---------------- */

test("rekeyArchive: two suffix variants of one article collapse into one story", () => {
  const dir = tempDir();
  try {
    const link = "https://cnbc.example.com/space-gpu";
    const a = dirtyStory("Space GPU Momentum - CNBC", link, "2026-09-03T09:00:00Z");
    const b = dirtyStory("Space GPU Momentum - cnbc.com", link, "2026-09-04T09:00:00Z", {
      nowMs: NOW,
    });
    // second copy is newer -> its updatedAt/days should win
    b.updatedAt = new Date(NOW).toISOString();

    Store.upsertStories([a, b], { dbDir: dir, now: NOW });
    assert.strictEqual(Store.assertNoDuplicateIds(dir).duplicates.length, 0);
    assert.strictEqual(Store.assertIdentityConsistent(dir).inconsistent.length, 2);

    const stats = Store.rekeyArchive(dir, { write: true, now: NOW });
    assert.strictEqual(stats.inputRows, 2);
    assert.strictEqual(stats.outputRows || Store.assertNoDuplicateIds(dir).checked, 1);
    assert.strictEqual(stats.merged, 1);
    assert.strictEqual(stats.danger, 0);
    assert.strictEqual(stats.rekeyed, 1);
    assert.deepStrictEqual(stats.idCollisions, []);

    const afterIds = Store.assertNoDuplicateIds(dir);
    const afterIdentity = Store.assertIdentityConsistent(dir);
    assert.strictEqual(afterIds.duplicates.length, 0, "no duplicate ids after sweep");
    assert.strictEqual(afterIdentity.inconsistent.length, 0, "fully identity-consistent after sweep");

    const rows = [];
    for (const day of Store.listDayFolders(dir)) rows.push(...Store.readDay(dir, day));
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].id, Core.buildStoryId("Space GPU Momentum", link));
    assert.strictEqual(rows[0].title, "Space GPU Momentum");
  } finally {
    cleanup(dir);
  }
});

/* ---------------- rekey: idempotent / no-op on a clean archive ---------------- */

test("rekeyArchive: idempotent - a clean archive is left byte-identical", () => {
  const dir = tempDir();
  try {
    const s = Core.normalizeItem(
      { title: "OpenAI GPT-6", link: "https://openai.example.com/gpt6", pubDate: "2026-09-04T10:00:00Z" },
      SRC,
      { nowMs: NOW }
    );
    Store.upsertStories([s], { dbDir: dir, now: NOW });
    const before = fs.readFileSync(path.join(dir, "days", "2026-09-04.ndjson"), "utf8");

    const stats = Store.rekeyArchive(dir, { write: true, now: NOW });
    const after = fs.readFileSync(path.join(dir, "days", "2026-09-04.ndjson"), "utf8");
    assert.strictEqual(stats.unchanged, 1);
    assert.strictEqual(stats.merged, 0);
    assert.strictEqual(stats.rekeyed, 0);
    assert.strictEqual(stats.danger, 0);
    assert.strictEqual(after, before, "day file bytes must not change");
    assert.strictEqual(Store.assertIdentityConsistent(dir).inconsistent.length, 0);
  } finally {
    cleanup(dir);
  }
});

/* ---------------- rekey: never collapses different stories ---------------- */

test("rekeyArchive: same cleaned title on different urls stays separate", () => {
  const dir = tempDir();
  try {
    const a = Core.normalizeItem(
      { title: "Model nudges - WIRED", link: "https://a.example.com/one", pubDate: "2026-09-04T10:00:00Z" },
      SRC,
      { nowMs: NOW }
    );
    const b = Core.normalizeItem(
      { title: "Model nudges", link: "https://b.example.com/two", pubDate: "2026-09-04T11:00:00Z" },
      SRC,
      { nowMs: NOW }
    );
    Store.upsertStories([a, b], { dbDir: dir, now: NOW });

    const stats = Store.rekeyArchive(dir, { write: true, now: NOW });
    assert.strictEqual(stats.merged, 0, "different stories must never merge");
    assert.strictEqual(stats.danger, 0);
    const rows = [];
    for (const day of Store.listDayFolders(dir)) rows.push(...Store.readDay(dir, day));
    assert.strictEqual(rows.length, 2, "both stories preserved");
    assert.strictEqual(Store.assertIdentityConsistent(dir).inconsistent.length, 0);
  } finally {
    cleanup(dir);
  }
});

/* ---------------- rekey: legacy duplicate-id anomaly heals ---------------- */

test("rekeyArchive: a legacy duplicate id spread over two days is collapsed to its home day", () => {
  const dir = tempDir();
  try {
    const link = "https://ex.example.com/update";
    const day1 = Core.normalizeItem(
      { title: "Capacity upstream - The Verge", link, pubDate: "2026-09-04T20:00:00Z" },
      SRC,
      { nowMs: NOW }
    );
    const day2 = Core.normalizeItem(
      { title: "Capacity upstream", link, pubDate: "2026-09-03T19:00:00Z" },
      SRC,
      { nowMs: NOW }
    );
    // Simulate the same legacy id parked in two buckets (Stage 11 anomaly).
    day2.id = day1.id;
    day2.fingerprint = day1.fingerprint;
    Store.upsertStories([day1, day2], { dbDir: dir, now: NOW });
    assert.strictEqual(Store.assertNoDuplicateIds(dir).duplicates.length, 1);

    const before = Store.assertNoDuplicateIds(dir).duplicates[0];
    const stats = Store.rekeyArchive(dir, { write: true, now: NOW });
    assert.strictEqual(stats.merged, 1, "duplicate copy removed");
    assert.strictEqual(stats.danger, 0);
    assert.strictEqual(Store.assertNoDuplicateIds(dir).duplicates.length, 0);
    assert.strictEqual(Store.assertIdentityConsistent(dir).inconsistent.length, 0);

    const rows = [];
    for (const day of Store.listDayFolders(dir)) rows.push(...Store.readDay(dir, day));
    assert.strictEqual(rows.length, 1);
    // the two legacy buckets collapse into exactly one (the survivor's home day)
    assert.deepStrictEqual(Store.listDayFolders(dir), [Store.storyDay(rows[0])]);
    assert.strictEqual(before.days.length, 2);
  } finally {
    cleanup(dir);
  }
});

/* ---------------- dry run touches nothing ---------------- */

test("rekeyArchive: write:false is a dry run - files and index untouched", () => {
  const dir = tempDir();
  try {
    const dirty = dirtyStory("Dry run story - Yahoo Finance", "https://y.example.com/dry", "2026-09-04T10:00:00Z");
    Store.upsertStories([dirty], { dbDir: dir, now: NOW });
    const dayFile = path.join(dir, "days", "2026-09-04.ndjson");
    const indexFile = path.join(dir, "index.json");
    const dayBefore = fs.readFileSync(dayFile, "utf8");
    const indexBefore = fs.readFileSync(indexFile, "utf8");

    const stats = Store.rekeyArchive(dir, { write: false, now: NOW });
    assert.strictEqual(stats.rekeyed, 1, "dry run still reports the planned work");
    assert.strictEqual(fs.readFileSync(dayFile, "utf8"), dayBefore, "day file untouched");
    assert.strictEqual(fs.readFileSync(indexFile, "utf8"), indexBefore, "index untouched");
  } finally {
    cleanup(dir);
  }
});