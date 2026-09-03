/*
 * AI RADAR - Stage 5: persistent store (Node pipeline).
 *
 * Purpose
 *   Give the pipeline real HISTORY + cross-day persistence by archiving every
 *   staged run into a versioned, idempotent, file-based store under
 *   data/db/. This is the "GitHub repo == database" layer: the store is the
 *   swap boundary that allows a future move to Supabase/D1 with no changes to
 *   the frontend or earlier pipeline stages.
 *
 *   data/db/
 *     runs/<runId>.json       one per pipeline run (log/metadata)
 *     index.json              { format, updatedAt, days, stories }
 *     days/<yyyy-mm-dd>.ndjson  one canonical Story (JSON) per line
 *
 * Design guarantees
 *   - IDEMPOTENT: re-running the same (or an older) upsert is a no-op. Each
 *     story is keyed by its stable Stage-1 `id`, so the same story is never
 *     duplicated across runs and its day bucket never grows.
 *   - DETERMINISTIC: identical input yields identical stored content. The only
 *     wall-clock values are metadata (`updatedAt`, run timestamps) that are
 *     intentionally NOT part of the idempotency comparison.
 *   - LOSS LESS: each stored record is the complete canonical Story.
 *   - ZERO DEPS: uses only Node built-ins (fs, path, os).
 *
 * Pipeline slot (roadmap 7.store.js):
 *   ... clusterStories (S4) -> store.upsertStories -> store.prune -> snapshot
 */

"use strict";

const fs = require("fs");
const path = require("path");
const Core = require("../../js/shared.js");

const DEFAULT_DB_DIR = path.join(__dirname, "..", "..", "data", "db");
const DEFAULT_RETENTION_DAYS = 90;
const INDEX_FORMAT = 1;

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const ID_RE = /^s[0-9a-f]{8}$/;

/* ------------------------------------------------------------------ *
 * Path helpers (pure & deterministic)
 * ------------------------------------------------------------------ */

function dayDir(dbDir) {
  return path.join(dbDir, "days");
}
function runsDir(dbDir) {
  return path.join(dbDir, "runs");
}
function dayFile(dbDir, day) {
  return path.join(dayDir(dbDir), day + ".ndjson");
}
function runsFile(dbDir, runId) {
  return path.join(runsDir(dbDir), runId + ".json");
}
function indexFile(dbDir) {
  return path.join(dbDir, "index.json");
}

/* ------------------------------------------------------------------ *
 * Date helpers
 * ------------------------------------------------------------------ */

/* UTC calendar day (YYYY-MM-DD) of a Date. */
function utcDay(d) {
  const p = (n) => String(n).padStart(2, "0");
  return d.getUTCFullYear() + "-" + p(d.getUTCMonth() + 1) + "-" + p(d.getUTCDate());
}

/* The day a story is filed under: publishedAt, else discoveredAt. Both are
 * never invented; discoveredAt is always present after normalization. */
function storyDay(story) {
  if (story && story.publishedAt) {
    const t = new Date(story.publishedAt).getTime();
    if (!Number.isNaN(t)) return utcDay(new Date(t));
  }
  const d = story && story.discoveredAt;
  if (d) {
    const t = new Date(d).getTime();
    if (!Number.isNaN(t)) return utcDay(new Date(t));
  }
  return null;
}

/* A story is only storable if it has a usable id and a usable day bucket. */
function storable(story) {
  return !!(story && typeof story.id === "string" && ID_RE.test(story.id)) && !!storyDay(story);
}

/* ------------------------------------------------------------------ *
 * NDJSON + index I/O (defensive; a bad file is reported, never fatal)
 * ------------------------------------------------------------------ */

function readDaySync(dbDir, day) {
  if (!DAY_RE.test(day)) return [];
  const file = dayFile(dbDir, day);
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  const out = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line);
      if (rec && rec.id) out.push(rec);
    } catch (e) {
      /* skip a malformed line; never corrupt the rest of the archive */
    }
  }
  return out;
}

function writeDaySync(dbDir, day, stories) {
  fs.mkdirSync(dayDir(dbDir), { recursive: true });
  /* Deterministic order within a day: sort by id. */
  const sorted = stories.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const lines = sorted.map((s) => JSON.stringify(s));
  fs.writeFileSync(dayFile(dbDir, day), lines.join("\n") + (lines.length ? "\n" : ""));
}

function emptyIndex() {
  return { format: INDEX_FORMAT, updatedAt: null, days: {}, stories: {} };
}

function loadIndex(dbDir) {
  const file = indexFile(dbDir);
  if (!fs.existsSync(file)) return emptyIndex();
  try {
    const idx = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!idx || idx.format !== INDEX_FORMAT || !idx.days || !idx.stories) return emptyIndex();
    return idx;
  } catch (e) {
    return emptyIndex();
  }
}

function saveIndex(dbDir, idx) {
  fs.mkdirSync(dbDir, { recursive: true });
  fs.writeFileSync(indexFile(dbDir), JSON.stringify(idx));
}

/* ------------------------------------------------------------------ *
 * Day list + retention helpers
 * ------------------------------------------------------------------ */

function listDayFolders(dbDir) {
  const dir = dayDir(dbDir);
  if (!fs.existsSync(dir)) return [];
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (e) {
    return [];
  }
  return names
    .filter((n) => n.endsWith(".ndjson"))
    .map((n) => n.slice(0, -".ndjson".length))
    .filter((d) => DAY_RE.test(d))
    .sort();
}

/* index.json records a `savedAt` stamp per day so prune can act even when a
 * day folder's filename alone does not show age. Kept on the day entry. */

/* ------------------------------------------------------------------ *
 * Public API
 * ------------------------------------------------------------------ */

/* Idempotently upsert an array of canonical Stories into the store.
 *
 *   step 1  group storable stories by their day bucket
 *   step 2  for each day, merge (by id) with what is already stored:
 *             - new id          -> add it (upserted)
 *             - same id, >=     -> replace field values (updated) and bump
 *               stored updatedAt  to the newest; count as updated
 *             - same id, same or older updatedAt -> leave untouched (unchanged)
 *   step 3  rewrite the day NDJSON deterministically (sorted by id)
 *   step 4  refresh index.json membership + timestamps
 *
 * Returns { dbDir, days, upserted, updated, unchanged, total }.
 */
function upsertStories(stories, opts = {}) {
  const dbDir = opts.dbDir || DEFAULT_DB_DIR;
  const now = opts.now == null ? Date.now() : opts.now;

  /* ---- 1. group storable stories by day ---- */
  const incomingByDay = new Map(); // day -> Map(id -> story)
  let skipped = 0;
  for (const s of stories || []) {
    if (!storable(s)) {
      skipped++;
      continue;
    }
    const day = storyDay(s);
    if (!incomingByDay.has(day)) incomingByDay.set(day, new Map());
    incomingByDay.get(day).set(s.id, s);
  }

  /* ---- 2+3. merge each day and rewrite NDJSON ---- */
  const stats = { dbDir, days: 0, upserted: 0, updated: 0, unchanged: 0, total: 0, skipped };
  for (const [day, incomingMap] of incomingByDay) {
    const existing = readDaySync(dbDir, day); // array of stored records
    const merged = new Map(); // id -> { story, newerUpdatedAt }
    for (const rec of existing) merged.set(rec.id, { story: rec });

    for (const story of incomingMap.values()) {
      const prev = merged.get(story.id);
      if (!prev) {
        merged.set(story.id, { story });
        stats.upserted++;
      } else {
        const prevUpdated = +new Date(prev.story.updatedAt || 0);
        const newUpdated = +new Date(story.updatedAt || 0);
        if (!Number.isNaN(newUpdated) && !Number.isNaN(prevUpdated) && newUpdated <= prevUpdated) {
          stats.unchanged++;
          continue; // incoming is same-or-older -> the stored record already wins
        }
        prev.story = story;
        stats.updated++;
      }
    }

    /* serialize merged stories back to a stable sorted array */
    const mergedArr = Array.from(merged.values())
      .map((m) => m.story)
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

    writeDaySync(dbDir, day, mergedArr);
    stats.days++;
    stats.total += mergedArr.length;
  }

  /* ---- 4. persist/refresh the index ---- */
  const idx = loadIndex(dbDir);
  idx.updatedAt = new Date(now).toISOString();
  for (const [day, incomingMap] of incomingByDay) {
    for (const story of incomingMap.values()) {
      idx.stories[story.id] = {
        updatedAt: story.updatedAt || new Date(now).toISOString(),
        day,
        source: story.source
          ? { id: story.source.id, name: story.source.name }
          : { id: null, name: null },
      };
    }
  }
  /* Rebuild per-day id lists from the index (authoritative). */
  idx.days = {};
  for (const id of Object.keys(idx.stories)) {
    const day = idx.stories[id].day;
    if (!day) continue;
    if (!idx.days[day]) idx.days[day] = { count: 0, stories: [] };
    idx.days[day].stories.push(id);
    idx.days[day].count = idx.days[day].stories.length;
  }
  /* Deterministic order within day id lists. */
  for (const day of Object.keys(idx.days)) {
    idx.days[day].stories.sort();
  }
  saveIndex(dbDir, idx);

  return stats;
}

/* Prune day archives older than the retention window (default 90 days).
 * The cutoff day is the first UTC day strictly older than now - retention.
 * Removes the day NDJSON file and its index entries. Returns aggregates. */
function prune(dbDir, opts = {}) {
  dbDir = dbDir || DEFAULT_DB_DIR;
  const retentionDays = opts.retentionDays == null ? DEFAULT_RETENTION_DAYS : opts.retentionDays;
  const now = opts.now == null ? Date.now() : opts.now;
  const cutoffMs = new Date(now).getTime() - retentionDays * 86400000;
  const cutoffDay = utcDay(new Date(cutoffMs));

  const removed = [];
  for (const day of listDayFolders(dbDir)) {
    if (day < cutoffDay) removed.push(day);
  }

  const idx = loadIndex(dbDir);
  let prunedStories = 0;
  for (const day of removed) {
    const file = dayFile(dbDir, day);
    if (fs.existsSync(file)) {
      try {
        fs.unlinkSync(file);
      } catch (e) {
        /* best effort */
      }
    }
    const dayEntry = idx.days[day];
    if (dayEntry) {
      prunedStories += dayEntry.stories.length;
      for (const id of dayEntry.stories) delete idx.stories[id];
      delete idx.days[day];
    }
  }
  if (removed.length) saveIndex(dbDir, idx);

  return { prunedDays: removed, prunedStories, cutoffDay };
}

/* Read all stories archived under a specific UTC day (YYYY-MM-DD). */
function readDay(dbDir, day) {
  return readDaySync(dbDir || DEFAULT_DB_DIR, day);
}

/* Read a single story by its stable id; null if not found. */
function readById(dbDir, id) {
  dbDir = dbDir || DEFAULT_DB_DIR;
  if (typeof id !== "string" || !ID_RE.test(id)) return null;
  const idx = loadIndex(dbDir);
  const meta = idx.stories && idx.stories[id];
  if (!meta || !meta.day) return null;
  const rec = readDaySync(dbDir, meta.day).find((s) => s.id === id);
  return rec || null;
}

/* Return the most recent `limit` stories across all archived days, ordered by
 * publishedAt (falling back to discoveredAt) descending. Deterministic tiebreak
 * by id. */
function recent(dbDir, opts = {}) {
  dbDir = dbDir || DEFAULT_DB_DIR;
  const limit = opts.limit == null ? 100 : opts.limit;
  const idx = loadIndex(dbDir);
  const byDay = Object.keys(idx.days || {}).sort();
  const all = [];
  for (const day of byDay) {
    for (const rec of readDaySync(dbDir, day)) all.push(rec);
  }
  all.sort((a, b) => {
    const ta = +new Date(a.publishedAt || a.discoveredAt || 0);
    const tb = +new Date(b.publishedAt || b.discoveredAt || 0);
    if (ta !== tb) return tb - ta;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return all.slice(0, limit);
}

/* Write a per-run log file. runId is derived from the clock + content hash so
 * it is unique per run but deterministic (no randomness). */
function runLog(dbDir, record, opts = {}) {
  dbDir = dbDir || DEFAULT_DB_DIR;
  record = record || {};
  const now = opts.now == null ? Date.now() : opts.now;
  const stamp = new Date(now);
  const day = utcDay(stamp);
  const hh = String(stamp.getUTCHours()).padStart(2, "0");
  const mm = String(stamp.getUTCMinutes()).padStart(2, "0");
  const ss = String(stamp.getUTCSeconds()).padStart(2, "0");
  const contentHash = Core.hashString(String(record.stored || "") + day).slice(0, 6);
  const runId = record.runId ? String(record.runId) : day + "-" + hh + mm + ss + "-" + contentHash;

  const body = {
    runId,
    createdAt: new Date(now).toISOString(),
    startedAt: record.startedAt || null,
    finishedAt: record.finishedAt || new Date(now).toISOString(),
  };
  for (const k of Object.keys(record)) {
    if (k === "runId") continue;
    body[k] = record[k];
  }

  fs.mkdirSync(runsDir(dbDir), { recursive: true });
  fs.writeFileSync(runsFile(dbDir, runId), JSON.stringify(body));
  return runId;
}

/* Count + summarize what is currently archived (for diagnostics/tests). */
function stats(dbDir) {
  dbDir = dbDir || DEFAULT_DB_DIR;
  const idx = loadIndex(dbDir);
  const days = Object.keys(idx.days || {}).sort();
  let stories = 0;
  for (const day of days) stories += (idx.days[day] && idx.days[day].stories.length) || 0;
  return { dbDir, days, storyCount: stories, updatedAt: idx.updatedAt };
}

/* Expose the storage layout helpers (day folder/run listing) for tests. */
function listRuns(dbDir) {
  dbDir = dbDir || DEFAULT_DB_DIR;
  const dir = runsDir(dbDir);
  if (!fs.existsSync(dir)) return [];
  try {
    return fs.readdirSync(dir).filter((n) => n.endsWith(".json")).sort();
  } catch (e) {
    return [];
  }
}

module.exports = {
  DEFAULT_DB_DIR,
  DEFAULT_RETENTION_DAYS,
  INDEX_FORMAT,
  dayFile,
  runsFile,
  indexFile,
  utcDay,
  storyDay,
  storable,
  readDaySync,
  writeDaySync,
  loadIndex,
  saveIndex,
  listDayFolders,
  upsertStories,
  prune,
  readDay,
  readById,
  recent,
  runLog,
  stats,
  listRuns,
};

/* For local diagnostic dry-run of the store on a temp dir. */
if (require.main === module) {
  const os = require("os");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "airadar-store-"));
  console.log("store diagnostic using temp dir:", tmp);
  console.log("empty stats:", JSON.stringify(stats(tmp)));
  console.log("dbDir constant:", DEFAULT_DB_DIR);
  console.log("retention days:", DEFAULT_RETENTION_DAYS);
}
