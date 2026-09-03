/*
 * AI RADAR - Stage 4: similarity-based story clustering (Node pipeline).
 *
 * Purpose
 *   When several sources report the SAME underlying AI event under slightly
 *   different titles/URLs, collapse them into ONE canonical Story with every
 *   reporting source preserved ("Reported by N sources").
 *
 *   This runs AFTER the Stage 1 exact-match dedupe. It is a deterministic,
 *   transparent, multi-signal algorithm - no ML/LLM, no external calls, no new
 *   dependencies. It deliberately PRIVILEGES FALSE NEGATIVES over dangerous
 *   false positives: if a merge is ambiguous the stories stay separate. Two
 *   different stories about the same company (e.g. "OpenAI launches GPT-6" vs
 *   "OpenAI raises $10B") are NEVER merged.
 *
 * Why this is conservative (false-positive protection)
 *   Cross-outlet paraphrases differ mostly in the verb/adjective (one outlet
 *   says "releases", another "announces", another "launches ... new"). We drop
 *   that low-information vocabulary and require a HIGH symmetric Jaccard
 *   overlap (default 0.70) on the residual core content tokens, plus a
 *   publication-time proximity window. Distinct-content headlines ("GPT-6
 *   launch" vs "GPT-6 wins a benchmark") keep a distinguishing content token,
 *   so their core Jaccard stays below threshold and they are left separate.
 *
 * Determinism
 *   Identical input always yields identical output. Neither the blocking
 *   buckets nor the similarity score nor the canonical-selection ranking use
 *   randomness, wall-clock time, or iteration order.
 *
 * Pipeline slot (roadmap 3.dedupe.js):
 *   ingest -> normalize -> exact dedupe -> similarity clustering -> snapshot
 */

"use strict";

const Core = require("../../js/shared.js");

/* ------------------------------------------------------------------ *
 * Tuning constants (documented in ARCHITECTURE.md)
 * ------------------------------------------------------------------ */

/* Meaningless title tokens: removed before any token overlap is computed.
 * Kept strictly minimal to avoid over-blocking / over-merging. */
const STOPWORDS = new Set(
  "a an the and or but of to in on for with from by at as is are was were be been being it its this that these those s t more about".split(
    /\s+/
  )
);

/* Low-information vocabulary: words that commonly differ between outlets
 * reporting the SAME event (product-announcement verbs, reporting verbs and
 * filler adjectives). These are removed so that paraphrase pairs reach a high
 * core-overlap. Content nouns/numbers are intentionally NOT here. */
const LOW_INFO = new Set(
  (
    "releases release releases announced announces announce launching launches launch " +
    "unveils unveil unveiling introduces introduce debut debuts debuting premiere premieres " +
    "rolls roll rollout rolling reveals reveal revealed presents present showcase showcases " +
    "shows show publishes publish published ships ship adds add updates update upgrades upgrade " +
    "details detail highlights highlight previews preview brings bring opens open " +
    "new latest first now official officially out says said " +
    "unlocks unlock break breakthrough milestones milestone breakthrough achieves achieves reaches reach " +
    "crosses cross "
  ).split(/\s+/)
);

/* Symmetric Jaccard over CORE tokens at/above which a pair may be merged.
 * High bar + low-info dropping = accurate paraphrase merging, strong
 * false-positive guard. */
const SIMILARITY_THRESHOLD = 0.70;

/* Hard minimum on the number of distinct meaningful tokens a story must carry
 * to be considered for clustering. Stories with almost no signal are left
 * alone - merging them invites false positives. */
const MIN_MEANINGFUL_TOKENS = 2;

/* Stories published farther apart than this (hours) are not the same event,
 * regardless of title overlap. Null timestamps are treated as in-window (we
 * never invent dates; clustering still works when a feed omits a date). */
const MAX_TIME_GAP_MS = 72 * 3600000;

/* Same-host bonus added to core Jaccard (same outlet re-reporting its own
 * headline) - never enough on its own to cross the threshold. */
const HOST_BONUS = 0.08;

/* ------------------------------------------------------------------ *
 * Tokenization helpers (deterministic)
 * ------------------------------------------------------------------ */

/* Lowercase, split on non-alphanumerics, drop empties + stopwords. */
function meaningfulTokens(title) {
  const norm = Core.normalizeTitle(title || "");
  const toks = norm.split(/\s+/).filter(Boolean);
  const out = [];
  for (const t of toks) {
    if (STOPWORDS.has(t)) continue;
    out.push(t);
  }
  return out;
}

/* CORE content tokens: meaningful tokens minus the low-information vocabulary.
 * Two paraphrases of one event collapse to nearly identical core sets. */
function coreTokens(title) {
  return meaningfulTokens(title).filter((t) => !LOW_INFO.has(t));
}

function jaccard(a, b) {
  if (!a.length || !b.length) return 0;
  const setA = new Set(a);
  let inter = 0;
  const seen = new Set();
  for (const t of b) {
    if (setA.has(t) && !seen.has(t)) {
      inter++;
      seen.add(t);
    }
  }
  const union = new Set(a.concat(b)).size;
  return union ? inter / union : 0;
}

function hostOf(url) {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch (e) {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Core similarity + ranking helpers (pure & deterministic)
 * ------------------------------------------------------------------ */

/* Compute a symmetric similarity score for ONE candidate pair (0..1).
 * Exported for targeted unit testing. This is the entire merge decision. */
function similarityScore(a, b) {
  const ma = meaningfulTokens(a.title);
  const mb = meaningfulTokens(b.title);
  if (ma.length < MIN_MEANINGFUL_TOKENS || mb.length < MIN_MEANINGFUL_TOKENS) {
    return 0;
  }

  const ca = coreTokens(a.title);
  const cb = coreTokens(b.title);
  if (ca.length < MIN_MEANINGFUL_TOKENS || cb.length < MIN_MEANINGFUL_TOKENS) {
    return 0;
  }

  let score = jaccard(ca, cb);
  if (score < SIMILARITY_THRESHOLD) return 0;

  // Time proximity: if BOTH have timestamps they must be close. Otherwise a
  // similar headline on different days is likely two events, not one.
  const pa = a.publishedAt ? +new Date(a.publishedAt) : null;
  const pb = b.publishedAt ? +new Date(b.publishedAt) : null;
  if (pa != null && pb != null && Math.abs(pa - pb) > MAX_TIME_GAP_MS) {
    return 0;
  }

  // Same host -> small boost (same outlet re-reporting).
  const ha = hostOf(a.originalUrl || a.link);
  const hb = hostOf(b.originalUrl || b.link);
  if (ha && ha === hb) score = Math.min(1, score + HOST_BONUS);

  return score;
}

/* Deterministic ranking used to pick the canonical story of a cluster.
 * 1) higher source reliability  2) earlier publishedAt (likely the original)
 * 3) longer title               4) stable id as a final tiebreak. */
function canonicalRankKey(story) {
  const rel = story.source && story.source.reliability != null ? story.source.reliability : -1;
  const ts = story.publishedAt ? +new Date(story.publishedAt) : 0;
  const len = story.title ? story.title.length : 0;
  return [-rel, ts, -len, String(story.id || "")];
}

/* ------------------------------------------------------------------ *
 * Public API
 * ------------------------------------------------------------------ */

/* Merge an array of already-normalized canonical Stories into clusters.
 *
 *  1. Exact-match duplicates (same canonicalKey) are collapsed first.
 *  2. Token blocking buckets candidates sharing >=1 meaningful title token.
 *  3. Within each block, deterministic similarity pairs are merged (union-find)
 *     gated by the conservative `similarityScore`.
 *
 * Returns { items, stats }:
 *   - single-story clusters are returned unchanged;
 *   - multi-story clusters return the rank-1 canonical story with `sources`,
 *     `relatedStoryIds` and `reportedBy` populated.
 * Output order = order of each cluster's first occurrence in the input, which
 * preserves the previous "first occurrence wins" ordering behavior.
 */
function clusterStories(stories) {
  const input = Array.isArray(stories) ? stories : [];

  /* ---- 1. exact-match dedupe (Stage 1) ---- */
  const exactKey = new Set();
  const staged = [];
  for (const s of input) {
    if (!s) continue;
    const key =
      Core.canonicalKey(s.title, s.originalUrl || s.link) ||
      Core.normalizeTitle(s.title);
    if (!key || exactKey.has(key)) continue;
    exactKey.add(key);
    staged.push(s);
  }

  /* ---- 2. token blocking (deterministic; avoids blind O(n^2)) ---- */
  const byToken = new Map(); // meaningful token -> indices into `staged`
  staged.forEach((s, idx) => {
    const seenTok = new Set();
    for (const t of meaningfulTokens(s.title)) {
      if (seenTok.has(t)) continue;
      seenTok.add(t);
      if (byToken.has(t)) byToken.get(t).push(idx);
      else byToken.set(t, [idx]);
    }
  });

  /* ---- 3. intra-block similarity clustering (union-find) ---- */
  const n = staged.length;
  const parent = new Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  function find(x) {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  }
  function union(a, b) {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  }

  for (const idxs of byToken.values()) {
    if (idxs.length < 2) continue;
    for (let i = 0; i < idxs.length; i++) {
      for (let j = i + 1; j < idxs.length; j++) {
        const A = staged[idxs[i]];
        const B = staged[idxs[j]];
        if (find(idxs[i]) === find(idxs[j])) continue;
        if (similarityScore(A, B) >= SIMILARITY_THRESHOLD) {
          union(idxs[i], idxs[j]);
        }
      }
    }
  }

  /* ---- 4. gather clusters preserving first-occurrence order ---- */
  const clusters = new Map(); // root -> member indices
  staged.forEach((s, idx) => {
    const root = find(idx);
    if (clusters.has(root)) clusters.get(root).push(idx);
    else clusters.set(root, [idx]);
  });

  /* ---- 5. build one canonical story per cluster ---- */
  const items = [];
  let multiSource = 0;
  let maxCluster = 1;
  let mergedInto = 0;

  const roots = Array.from(clusters.keys()).sort((a, b) => a - b);
  for (const root of roots) {
    const memberIdx = clusters.get(root);
    if (memberIdx.length === 1) {
      items.push(staged[memberIdx[0]]);
      continue;
    }

    const members = memberIdx.map((i) => staged[i]);
    members.sort((a, b) => {
      const ka = canonicalRankKey(a);
      const kb = canonicalRankKey(b);
      for (let i = 0; i < ka.length; i++) {
        const av = ka[i];
        const bv = kb[i];
        if (av !== bv) {
          if (typeof av === "number" && typeof bv === "number") return av - bv;
          return String(av) < String(bv) ? -1 : 1;
        }
      }
      return 0;
    });

    const canonical = members[0];

    // Aggregate distinct reporting sources (dedupe by source id, first-seen).
    const sourceArr = [];
    const seenId = new Set();
    const related = [];
    const seenRelated = new Set();
    for (const m of members) {
      const sid = m.source && m.source.id;
      if (sid && !seenId.has(sid)) {
        seenId.add(sid);
        sourceArr.push({ id: sid, name: (m.source && m.source.name) || sid });
      }
      if (m.id && !seenRelated.has(m.id)) {
        seenRelated.add(m.id);
        related.push(m.id);
      }
    }
    if (canonical.id && !seenRelated.has(canonical.id)) {
      related.unshift(canonical.id);
    }

    canonical.sources = sourceArr;
    canonical.relatedStoryIds = related;
    canonical.reportedBy = sourceArr.length;

    items.push(canonical);
    mergedInto += members.length - 1;

    if (sourceArr.length > 1) multiSource++;
    if (memberIdx.length > maxCluster) maxCluster = memberIdx.length;
  }

  return {
    items,
    stats: {
      input: input.length,
      afterExactDedupe: staged.length,
      mergedInto: mergedInto,
      multiSource: multiSource,
      maxClusterSize: maxCluster,
    },
  };
}

module.exports = {
  simThreshold: SIMILARITY_THRESHOLD,
  maxTimeGapMs: MAX_TIME_GAP_MS,
  hostBonus: HOST_BONUS,
  stopwords: STOPWORDS,
  lowInfo: LOW_INFO,
  meaningfulTokens,
  coreTokens,
  jaccard,
  similarityScore,
  canonicalRankKey,
  clusterStories,
};
