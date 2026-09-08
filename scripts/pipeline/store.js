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
 *     runs/<runId>.json       one per pipeline run (log/metadata, incl. sources)
 *     index.json              { format, updatedAt, days, stories, runs[] }
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
 * Stage 11: upsertStories self-heals day-bucket moves, runLog additionally
 * writes a capped runs[] summary into index.json for the static Pipeline view.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const Core = require("../../js/shared.js");

const DEFAULT_DB_DIR = path.join(__dirname, "..", "..", "data", "db");
const DEFAULT_RETENTION_DAYS = 90;
const INDEX_FORMAT = 1;
const RUNS_INDEX_LIMIT = 120;

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

  /* ---- 1. group storable stories by day; detect day-bucket moves ---- */
  const incomingByDay = new Map(); // day -> Map(id -> story)
  const idx = loadIndex(dbDir);
  const moves = new Map(); // id -> previous day when the bucket changes
  let skipped = 0;
  for (const s of stories || []) {
    if (!storable(s)) {
      skipped++;
      continue;
    }
    const day = storyDay(s);
    if (!incomingByDay.has(day)) incomingByDay.set(day, new Map());
    incomingByDay.get(day).set(s.id, s);

    const prev = idx.stories && idx.stories[s.id];
    if (prev && prev.day && prev.day !== day && !moves.has(s.id)) {
      moves.set(s.id, prev.day);
    }
  }

  for (const [id, fromDay] of moves) {
    const kept = readDaySync(dbDir, fromDay).filter((r) => r.id !== id);
    if (kept.length) {
      writeDaySync(dbDir, fromDay, kept);
    } else {
      try {
        fs.unlinkSync(dayFile(dbDir, fromDay));
      } catch (e) {
        /* best effort */
      }
    }
    const dayEntry = idx.days && idx.days[fromDay];
    if (dayEntry) {
      dayEntry.stories = dayEntry.stories.filter((x) => x !== id);
      dayEntry.count = dayEntry.stories.length;
      if (!dayEntry.stories.length) delete idx.days[fromDay];
    }
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

  /* ---- 4. refresh the index (reusing the map loaded in step 1) + save ---- */
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

function removeFromDay(dbDir, id, day) {
  dbDir = dbDir || DEFAULT_DB_DIR;
  if (typeof id !== "string" || !ID_RE.test(id) || !DAY_RE.test(day)) return false;
  const existing = readDaySync(dbDir, day);
  const kept = existing.filter((r) => r.id !== id);
  if (kept.length === existing.length) return false;
  if (kept.length) {
    writeDaySync(dbDir, day, kept);
  } else {
    try {
      fs.unlinkSync(dayFile(dbDir, day));
    } catch (e) {
      /* best effort */
    }
  }
  const idx = loadIndex(dbDir);
  const dayEntry = idx.days && idx.days[day];
  if (dayEntry) {
    dayEntry.stories = dayEntry.stories.filter((x) => x !== id);
    dayEntry.count = dayEntry.stories.length;
    if (!dayEntry.stories.length) delete idx.days[day];
  }
  saveIndex(dbDir, idx);
  return true;
}

/* Remove a story entirely: from its indexed day bucket, the id map and the
 * per-day id lists. Returns true if the story was found and removed. */
function removeStory(dbDir, id) {
  dbDir = dbDir || DEFAULT_DB_DIR;
  if (typeof id !== "string" || !ID_RE.test(id)) return false;
  const idx = loadIndex(dbDir);
  const meta = idx.stories && idx.stories[id];
  if (!meta) return false;
  const existing = readDaySync(dbDir, meta.day);
  const kept = existing.filter((r) => r.id !== id);
  if (kept.length) {
    writeDaySync(dbDir, meta.day, kept);
  } else {
    try {
      fs.unlinkSync(dayFile(dbDir, meta.day));
    } catch (e) {
      /* best effort */
    }
  }
  const dayEntry = idx.days && idx.days[meta.day];
  if (dayEntry) {
    dayEntry.stories = dayEntry.stories.filter((x) => x !== id);
    dayEntry.count = dayEntry.stories.length;
    if (!dayEntry.stories.length) delete idx.days[meta.day];
  }
  delete idx.stories[id];
  saveIndex(dbDir, idx);
  return true;
}

function assertNoDuplicateIds(dbDir) {
  dbDir = dbDir || DEFAULT_DB_DIR;
  const idDays = new Map();
  let checked = 0;
  for (const day of listDayFolders(dbDir)) {
    for (const rec of readDaySync(dbDir, day)) {
      checked++;
      if (!rec || !rec.id) continue;
      if (!idDays.has(rec.id)) idDays.set(rec.id, new Set());
      idDays.get(rec.id).add(day);
    }
  }
  const duplicates = [];
  for (const [id, days] of idDays) {
    const list = Array.from(days).sort();
    if (list.length > 1) duplicates.push({ id, days: list });
  }
  duplicates.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { checked, duplicates };
}

/* Stage 12: verify every archived row's stable id still matches its identity
 * after cleaning a trailing publisher-alias suffix from the title
 * ("… - Reuters" -> clean title). This is the invariant the one-time rekey
 * sweep restores and the pipeline build re-checks on every run. */
function assertIdentityConsistent(dbDir) {
  dbDir = dbDir || DEFAULT_DB_DIR;
  const inconsistent = [];
  let checked = 0;
  for (const day of listDayFolders(dbDir)) {
    for (const rec of readDaySync(dbDir, day)) {
      if (!rec) continue;
      checked++;
      const url = rec.originalUrl || rec.link || "";
      const clean = Core.cleanTitleForIdentity(rec.title);
      const cleanTitle = clean.title && clean.title.trim() ? clean.title.trim() : rec.title;
      const cleanId = Core.buildStoryId(cleanTitle, url);
      if (rec.id !== cleanId) {
        inconsistent.push({ id: rec.id, cleanId, day, title: rec.title, url });
      }
    }
  }
  inconsistent.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { checked, inconsistent };
}

/* Stage 12 one-time archive sweep: re-key every archived row onto the CLEAN
 * identity (id derived from the stripped title) and collapse duplicate copies
 * of the same story (same canonical url) that were previously filed under
 * different dirty-title ids.
 *
 * Safety rules (hard constraints):
 *   - rows are merged ONLY when they share the SAME clean id AND the SAME
 *     canonical url key. Different real stories are NEVER collapsed.
 *   - the surviving record for a merged group is deterministic (newest
 *     updatedAt, then longest description, then id asc) and is filed under its
 *     own home day (publishedAt, else discoveredAt).
 *   - when a clean id group mixes different url keys, only the largest
 *     same-url subgroup is merged; every other row keeps its LEGACY id in
 *     place and is reported as a "danger" (never silently dropped).
 *   - idempotent: re-running on an already-clean archive is a no-op.
 *
 * opts.now     injected clock (default Date.now()).
 * opts.write   false forces a dry run (nothing is written, index included).
 *
 * Returns { inputRows, inputDays, outputDays, unchanged, rekeyed, merged,
 *           moved, danger, dangerIds, idCollisions, removedDays }.
 */
function rekeyArchive(dbDir, opts = {}) {
  dbDir = dbDir || DEFAULT_DB_DIR;
  const now = opts.now == null ? Date.now() : opts.now;
  const write = opts.write !== false;

  const days = listDayFolders(dbDir);
  const entries = [];
  for (const day of days) {
    for (const rec of readDaySync(dbDir, day)) {
      if (!rec || !rec.id) continue;
      entries.push({ day, rec });
    }
  }

  /* ---- 1. derive the clean identity for every row ---- */
  for (const e of entries) {
    const url = e.rec.originalUrl || e.rec.link || "";
    const clean = Core.cleanTitleForIdentity(e.rec.title);
    const title = clean.title && clean.title.trim() ? clean.title.trim() : e.rec.title;
    e.url = url;
    e.cleanTitle = title;
    e.cleanId = Core.buildStoryId(title, url);
    e.unchanged = e.rec.id === e.cleanId;
  }

  /* ---- 2. group rows by clean id ---- */
  const byClean = new Map();
  for (const e of entries) {
    if (!byClean.has(e.cleanId)) byClean.set(e.cleanId, []);
    byClean.get(e.cleanId).push(e);
  }

  const urlKey = (url) => Core.canonicalUrlKey(url) || url || "";

  function pickWinner(members) {
    return members
      .slice()
      .sort((a, b) => {
        const ta = +new Date(a.rec.updatedAt || a.rec.createdAt || 0);
        const tb = +new Date(b.rec.updatedAt || b.rec.createdAt || 0);
        if (ta !== tb) return tb - ta;
        const la = (a.rec.description || "").length;
        const lb = (b.rec.description || "").length;
        if (la !== lb) return lb - la;
        return a.rec.id < b.rec.id ? -1 : a.rec.id > b.rec.id ? 1 : 0;
      })[0];
  }

  function mergeInto(base, others) {
    const out = JSON.parse(JSON.stringify(base));
    const uniq = (arr) => {
      const seen = new Set();
      const res = [];
      for (const v of arr || []) {
        const key = typeof v === "string" ? v : JSON.stringify(v);
        if (!seen.has(key)) {
          seen.add(key);
          res.push(v);
        }
      }
      return res;
    };
    const listFields = ["sources", "relatedStoryIds", "tags", "companies", "people", "models", "technologies", "countries"];
    for (const o of others) {
      for (const f of listFields) {
        const merged = uniq([].concat(out[f] || [], o[f] || []));
        out[f] = merged;
      }
      if (!out.description && o.description) out.description = o.description;
      if (!out.image && o.image) out.image = o.image;
      if (!out.author && o.author) out.author = o.author;
    }
    if (Array.isArray(out.sources)) out.reportedBy = out.sources.length;
    return out;
  }

  /* ---- 3. resolve every clean-id group into keepers / dropped / danger ---- */
  const keepers = []; // { rec, day, rekeyed, dropped, moved }
  const danger = [];
  for (const [cleanId, members] of byClean) {
    const byUrl = new Map();
    for (const m of members) {
      const k = urlKey(m.url);
      if (!byUrl.has(k)) byUrl.set(k, []);
      byUrl.get(k).push(m);
    }

    if (byUrl.size === 1) {
      const winner = pickWinner(members);
      const losers = members.filter((m) => m !== winner);
      const home = storyDay(winner.rec) || winner.day;
      if (winner.unchanged && losers.length === 0) {
        keepers.push({ rec: winner.rec, day: winner.day, rekeyed: false, dropped: 0, moved: false });
      } else {
        const base = losers.length ? mergeInto(winner.rec, losers.map((l) => l.rec)) : winner.rec;
        const merged = Object.assign({}, base, {
          title: winner.cleanTitle,
          id: cleanId,
          fingerprint: Core.canonicalKey(winner.cleanTitle, winner.url),
        });
        keepers.push({
          rec: merged,
          day: home,
          rekeyed: winner.rec.id !== cleanId,
          dropped: losers.length,
          moved: winner.day !== home,
        });
      }
    } else {
      /* Mixed url keys => NOT all the same story. Merge only the largest
       * same-url subgroup; every other subgroup keeps its legacy identity. */
      const subs = Array.from(byUrl.values()).sort((a, b) => b.length - a.length);
      const [main, ...rest] = subs;
      const winner = pickWinner(main);
      const losers = main.filter((m) => m !== winner);
      const home = storyDay(winner.rec) || winner.day;
      const base = losers.length ? mergeInto(winner.rec, losers.map((l) => l.rec)) : winner.rec;
      const merged = Object.assign({}, base, {
        title: winner.cleanTitle,
        id: cleanId,
        fingerprint: Core.canonicalKey(winner.cleanTitle, winner.url),
      });
      keepers.push({
        rec: merged,
        day: home,
        rekeyed: winner.rec.id !== cleanId,
        dropped: losers.length,
        moved: winner.day !== home,
      });
      for (const stray of rest.flat()) {
        danger.push({ cleanId, rec: stray.rec, day: stray.day });
      }
    }
  }

  /* ---- 4. assemble final per-day rows ---- */
  const finalByDay = new Map();
  const add = (day, rec) => {
    if (!DAY_RE.test(day)) return;
    if (!finalByDay.has(day)) finalByDay.set(day, []);
    finalByDay.get(day).push(rec);
  };
  for (const k of keepers) add(k.day, k.rec);
  for (const d of danger) add(storyDay(d.rec) || d.day, d.rec);

  const idCollisions = [];
  for (const [day, list] of finalByDay) {
    const seen = new Set();
    const clean = [];
    for (const rec of list) {
      if (seen.has(rec.id)) {
        idCollisions.push({ id: rec.id, day, title: rec.title });
        continue;
      }
      seen.add(rec.id);
      clean.push(rec);
    }
    finalByDay.set(day, clean);
  }

  const stats = {
    dbDir,
    inputRows: entries.length,
    inputDays: days.length,
    outputDays: 0,
    unchanged: keepers.filter((k) => !k.rekeyed && k.dropped === 0 && !k.moved).length,
    rekeyed: keepers.filter((k) => k.rekeyed).length,
    merged: keepers.reduce((n, k) => n + (k.dropped || 0), 0),
    moved: keepers.filter((k) => k.moved).length,
    danger: danger.length,
    dangerIds: danger.map((d) => ({ id: d.rec.id, day: d.day, cleanId: d.cleanId, title: d.rec.title })),
    idCollisions,
    removedDays: [],
  };

  if (!write) return stats;

  /* ---- 5. write day files; drop emptied days ---- */
  for (const day of listDayFolders(dbDir)) {
    if (!finalByDay.has(day) || !finalByDay.get(day).length) {
      stats.removedDays.push(day);
      try {
        fs.unlinkSync(dayFile(dbDir, day));
      } catch (e) {
        /* best effort */
      }
    }
  }
  for (const [day, recs] of finalByDay) {
    if (recs.length) writeDaySync(dbDir, day, recs);
  }
  stats.outputDays = finalByDay.size;

  /* ---- 6. rebuild index (preserving the capped runs[] summary) ---- */
  const idx = loadIndex(dbDir);
  const runs = Array.isArray(idx.runs) ? idx.runs : [];
  const fresh = emptyIndex();
  fresh.updatedAt = new Date(now).toISOString();
  for (const [day, recs] of finalByDay) {
    for (const rec of recs) {
      fresh.stories[rec.id] = {
        updatedAt: rec.updatedAt || new Date(now).toISOString(),
        day,
        source: rec.source ? { id: rec.source.id, name: rec.source.name } : { id: null, name: null },
      };
    }
  }
  fresh.days = {};
  for (const id of Object.keys(fresh.stories)) {
    const day = fresh.stories[id].day;
    if (!fresh.days[day]) fresh.days[day] = { count: 0, stories: [] };
    fresh.days[day].stories.push(id);
    fresh.days[day].count = fresh.days[day].stories.length;
  }
  for (const day of Object.keys(fresh.days)) fresh.days[day].stories.sort();
  fresh.runs = runs;
  saveIndex(dbDir, fresh);

  return stats;
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

  /* Stage 11: keep a capped, idempotent summary of recent runs inside
   * index.json so the static site can list run history without a directory
   * listing. Sources are the per-feed statuses of the run. */
  const idx = loadIndex(dbDir);
  if (!Array.isArray(idx.runs)) idx.runs = [];
  const src = Array.isArray(record.sources) ? record.sources : null;
  let sourcesOk = 0;
  let sourcesWarning = 0;
  let sourcesError = 0;
  if (src) {
    for (const s of src) {
      const status = s && s.status;
      if (status === "error") sourcesError++;
      else if (status === "empty" || (status && status !== "ok")) sourcesWarning++;
      else sourcesOk++;
    }
  }
  const summary = {
    runId,
    createdAt: body.createdAt,
    startedAt: body.startedAt,
    finishedAt: body.finishedAt,
    stored: typeof body.stored === "number" ? body.stored : null,
    upserted: typeof body.upserted === "number" ? body.upserted : null,
    storedDays: typeof body.storedDays === "number" ? body.storedDays : null,
    radarMean: typeof body.radarMean === "number" ? body.radarMean : null,
    summarized: typeof body.summarized === "number" ? body.summarized : null,
    sourcesOk,
    sourcesWarning,
    sourcesError,
    degraded: sourcesError + sourcesWarning > 0,
  };
  idx.runs = idx.runs.filter((r) => r && r.runId !== runId);
  idx.runs.push(summary);
  if (idx.runs.length > RUNS_INDEX_LIMIT) idx.runs = idx.runs.slice(-RUNS_INDEX_LIMIT);
  saveIndex(dbDir, idx);

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
  removeFromDay,
  removeStory,
  assertNoDuplicateIds,
  assertIdentityConsistent,
  rekeyArchive,
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
