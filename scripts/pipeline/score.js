/*
 * AI RADAR - Stage 6: transparent, explainable Radar Score (Node).
 *
 * Purpose
 *   Compute a deterministic 0-100 Radar Score for each staged story, plus the
 *   five stored components so the score is explainable (a roadmap requirement).
 *
 *   Radar Score = 30% impact + 25% novelty + 20% credibility
 *               + 15% relevance + 10% sourceConfidence
 *
 *   Every component is a number in [0,100] and is stored back on the story
 *   (story.scores.{impact, novelty, credibility, relevance, sourceConfidence}),
 *   with the aggregate on story.radarScore (0-100). The legacy flat
 *   story.score (0-5) is derived as radarScore/20 so the existing frontend sort
 *   and the snapshot build keep working unchanged.
 *
 * Determinism
 *   Recency/novelty is computed against story.discoveredAt (a stable field that
 *   is part of the story), NOT against an external wall clock - so identical
 *   input always yields identical Radar Score. No randomness, no external calls.
 *
 * False-positive / gaming concerns
 *   Weights are a single documented table (see ARCHITECTURE.md / SCHEMA.md).
 *   No single signal can dominate: category boosts are small, and an arbitrary
 *   keyword cannot inflate credibility. Multi-source reporting (from Stage 4
 *   clustering) gives a modest, bounded credibility + relevance confirmation
 *   bonus only.
 *
 * Pipeline slot (roadmap 6.score.js): after classify, before store.
 */

"use strict";

const Core = require("../../js/shared.js");
const classify = require("./classify.js");

/* ------------------------------------------------------------------ *
 * Weights (sum to 100)
 * ------------------------------------------------------------------ */
const SCORE_WEIGHTS = {
  impact: 0.30,
  novelty: 0.25,
  credibility: 0.20,
  relevance: 0.15,
  sourceConfidence: 0.10,
};

/* Components to expose on story.scores (schema-compatible keys). */
const COMPONENTS = ["impact", "novelty", "credibility", "relevance", "sourceConfidence"];

/* ------------------------------------------------------------------ *
 * Component scorers (each returns 0..100)
 * ------------------------------------------------------------------ */

/* IMPACT (30%): a story's likely importance. Driven by breadth of reporting
 * (Stage 4 cluster size), the fine category, and source reach. */
function scoreImpact(story) {
  const base = { model: 78, research: 74, product: 66, tools: 62, funding: 70,
    safety: 76, policy: 72, partnership: 60, opensource: 68, business: 58,
    industry: 56, other: 45 }[story.subcategory] || 50;

  // Multi-source reporting => higher confidence it matters (bounded).
  const reported = story.sources && story.sources.length > 1
    ? Math.min(18, (story.sources.length - 1) * 9)
    : 0;

  // Research papers that hit multiple outlets are the archetypal "big news".
  return clamp(Math.round(base + reported));
}

/* NOVELTY (25%): freshness. Computed against discoveredAt (a stable story
 * field) so it is deterministic. Recent => high; > ~5 days => decays to a
 * floor. Papers/benchmarks age faster than evergreen analysis. */
function scoreNovelty(story) {
  const ref = ts(story.discoveredAt);
  const pub = ts(story.publishedAt);
  const ageMs = pub != null && ref != null ? Math.max(0, ref - pub) : 0;
  const ageDays = ageMs / 86400000;

  let fresh = Math.exp(-ageDays / 2.0) * 100; // half-life ~1.4 days
  if (pub == null || ref == null) fresh = 55; // unknown age: neutral, no inventing

  // A story discovered but with a very old publishedAt (evergreen) is not novel.
  // Floor so it never reaches 0 for a genuinely today story.
  const min = ageDays > 30 ? 8 : ageDays > 14 ? 14 : 20;
  return clamp(Math.round(Math.max(min, fresh)));
}

/* CREDIBILITY (20%): how trustworthy the reporting is. From the source's
 * configured reliability (0-10 -> 0-100) plus a robustness bonus when we have
 * a description/content (more signal than a bare title). */
function scoreCredibility(story) {
  const rel = story.source && story.source.reliability != null
    ? story.source.reliability
    : 5;
  const relScore = (rel / 10) * 100;

  const hasBody = Boolean(story.description || story.content) ? 6 : 0;
  return clamp(Math.round(relScore * 0.92 + hasBody));
}

/* RELEVANCE (15%): how sharply the item is about AI specifically (the site's
 * focus) vs generic. High-signal AI terms and matched entities raise it. */
function scoreRelevance(story) {
  const text = [story.title, story.description, story.content]
    .filter(Boolean).join(" ").toLowerCase();
  const aiTerms = [
    "artificial intelligence", "machine learning", "model", "ai", "agent",
    "neural", "deep learning", "generative", "llm", "gpt", "transformer",
  ];
  let hits = 0;
  for (const t of aiTerms) if (text.indexOf(t) !== -1) hits++;
  const score = Math.min(100, 38 + hits * 12);

  // Strong presence of recognized entities => clearly AI-topic.
  const entityCount = (story.companies || []).length + (story.models || []).length
    + (story.technologies || []).length;
  return clamp(Math.round(score + Math.min(20, entityCount * 4)));
}

/* SOURCE CONFIDENCE (10%): the source's configured weight (1-5 -> 0-100)
 * plus a small confirmation bonus when multiple sources corroborate. */
function scoreSourceConfidence(story) {
  const w = story.source && story.source.weight != null ? story.source.weight : 3;
  const wScore = ((w - 1) / 4) * 100;

  const confirmed = story.sources && story.sources.length > 1 ? 8 : 0;
  return clamp(Math.round(wScore * 0.9 + confirmed));
}

function ts(v) {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d.getTime();
}

function clamp(n) {
  return n < 0 ? 0 : n > 100 ? 100 : n;
}

/* ------------------------------------------------------------------ *
 * Public API
 * ------------------------------------------------------------------ */

/* Score one story in place. Adds story.scores.{impact, novelty, credibility,
 * relevance, sourceConfidence} (each 0-100), story.radarScore (0-100, rounded),
 * and keeps story.score as radarScore/20 (legacy 0-5 range). importance is
 * kept as an alias of impact for schema compatibility. Returns the story. */
function scoreStory(story) {
  if (!story || typeof story !== "object") return story;

  // Ensure the fine classification exists (score uses story.subcategory/chip).
  // Only the stage-6 fields are (re)computed; never touch Stage 1-5 fields.
  if (!story.subcategory || !story.chip) classify.classifyStory(story);

  const impact = scoreImpact(story);
  const novelty = scoreNovelty(story);
  const credibility = scoreCredibility(story);
  const relevance = scoreRelevance(story);
  const sourceConfidence = scoreSourceConfidence(story);

  const radar =
    SCORE_WEIGHTS.impact * impact +
    SCORE_WEIGHTS.novelty * novelty +
    SCORE_WEIGHTS.credibility * credibility +
    SCORE_WEIGHTS.relevance * relevance +
    SCORE_WEIGHTS.sourceConfidence * sourceConfidence;

  const rounded = Math.round(radar);

  story.scores = story.scores || {};
  story.scores.impact = impact;
  story.scores.importance = impact; // schema alias
  story.scores.novelty = novelty;
  story.scores.credibility = credibility;
  story.scores.relevance = relevance;
  story.scores.sourceConfidence = sourceConfidence;

  story.radarScore = rounded;
  // Legacy flat 0-5 score used by the current frontend + build sort.
  story.score = rounded / 20;
  return story;
}

/* Score an array of stories in place. Returns the array plus stats. */
function scoreStories(stories) {
  const input = Array.isArray(stories) ? stories : [];
  for (const s of input) scoreStory(s);

  let min = 100, max = 0, sum = 0, n = 0;
  for (const s of input) {
    if (s && typeof s.radarScore === "number") {
      if (s.radarScore < min) min = s.radarScore;
      if (s.radarScore > max) max = s.radarScore;
      sum += s.radarScore;
      n++;
    }
  }
  return {
    items: input,
    stats: { scored: n, min, max, mean: n ? Math.round((sum / n) * 10) / 10 : 0 },
  };
}

module.exports = {
  SCORE_WEIGHTS,
  COMPONENTS,
  scoreImpact,
  scoreNovelty,
  scoreCredibility,
  scoreRelevance,
  scoreSourceConfidence,
  scoreStory,
  scoreStories,
};
