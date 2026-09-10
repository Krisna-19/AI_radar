/*
 * Stage 8 tests: dashboard helpers (js/dashboard.js).
 * Uses node:test (zero extra dependencies) and requires only the pure,
 * DOM-free helpers of the dashboard module, so no browser is needed.
 *
 * Covers: radar score bands/colors/labels, percent rounding, deterministic
 * donut arc paths, AI summary selection (summary preferred over description,
 * fallback to description, never fabricated), summary method, entity/tag
 * chip collection, subcategory grouping (ordering + other-last), virtual grid
 * slicing/paging, and top-signal selection. Also verifies the dashboard does
 * not disturb the Stage 1-7 canonical Story contract it depends on.
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert");

const Core = require("../js/shared.js");
const D = require("../js/dashboard.js");

/* A minimal canonical-shaped story with the fields the dashboard reads.
 * Built through the real Core.normalizeItem so it is genuinely schema-valid
 * (Stage 3 contract), then layered with the stage 5/6/7 fields the dashboard
 * consumes (radarScore, subcategory, ai, entities, tags). */
function story(overrides) {
  const source = {
    id: "demo",
    name: "Demo",
    category: "media",
    reliability: 6,
    priority: 100,
    weight: 3,
    color: "#666",
  };
  const s = Core.normalizeItem(
    {
      title: "A sample AI story",
      link: "https://example.com/story/1",
      description: "A longer descriptive body used when no summary exists.",
    },
    source,
    { nowMs: Date.UTC(2026, 8, 1, 10, 0, 0) }
  );
  s.radarScore = 80;
  s.score = 4;
  s.subcategory = "model";
  s.tags = [];
  s.companies = [];
  s.people = [];
  s.models = [];
  s.technologies = [];
  s.ai = { summary: null, whyItMatters: null, keyTakeaways: [], method: null };
  return Object.assign(s, overrides || {});
}

/* ------------------------------------------------------------------ */
/* Radar score bands (color + explicit text label - never color-only)  */
/* ------------------------------------------------------------------ */

test("radarBand maps high/medium/low/missing scores to label+color+band", () => {
  assert.deepStrictEqual(D.radarBand(100), { band: "high", color: "#22d3a5", label: "High" });
  assert.deepStrictEqual(D.radarBand(70), { band: "high", color: "#22d3a5", label: "High" });
  assert.deepStrictEqual(D.radarBand(69), { band: "medium", color: "#f59e0b", label: "Medium" });
  assert.deepStrictEqual(D.radarBand(40), { band: "medium", color: "#f59e0b", label: "Medium" });
  assert.deepStrictEqual(D.radarBand(39), { band: "low", color: "#8b96a9", label: "Low" });
  assert.deepStrictEqual(D.radarBand(0), { band: "low", color: "#8b96a9", label: "Low" });
});

test("radarBand handles invalid/negative/over-100 scores safely", () => {
  assert.strictEqual(D.radarBand(undefined).band, "unknown");
  assert.strictEqual(D.radarBand(null).band, "unknown");
  assert.strictEqual(D.radarBand(NaN).band, "unknown");
  assert.strictEqual(D.radarBand("80").band, "unknown");
  assert.strictEqual(D.radarBand(-10).label, "Low");
  assert.strictEqual(D.radarBand(150).label, "High");
});

test("radarPct clamps and rounds, and is null for non-numeric", () => {
  assert.strictEqual(D.radarPct(81.4), 81);
  assert.strictEqual(D.radarPct(100), 100);
  assert.strictEqual(D.radarPct(120), 100);
  assert.strictEqual(D.radarPct(-5), 0);
  assert.strictEqual(D.radarPct(null), null);
  assert.strictEqual(D.radarPct("90"), null);
});

/* ------------------------------------------------------------------ */
/* Deterministic donut arc paths                                       */
/* ------------------------------------------------------------------ */

test("arcPath is deterministic and yields an empty string for zero", () => {
  const a = D.arcPath(50, 20, 18, 15);
  assert.strictEqual(typeof a, "string");
  assert.strictEqual(a, D.arcPath(50, 20, 18, 15));
  assert.strictEqual(D.arcPath(0, 20, 18, 15), "");
  assert.strictEqual(D.arcPath(-5, 20, 18, 15), "");
});

test("arcPath emits two arcs for a full circle (100%)", () => {
  const full = D.arcPath(100, 20, 18, 15);
  assert.ok(full.indexOf("A 15 15 0 1 1") !== -1);
  assert.ok((full.match(/A /g) || []).length >= 2);
});

/* ------------------------------------------------------------------ */
/* AI summary: real summary preferred, description fallback, no fake   */
/* ------------------------------------------------------------------ */

test("summaryText prefers a real ai.summary over description", () => {
  const s = story({
    description: "Long description body.",
    ai: { summary: "Concise real summary", whyItMatters: null, keyTakeaways: [], method: "extractive" },
  });
  assert.strictEqual(D.summaryText(s), "Concise real summary");
});

test("summaryText falls back to description when no summary exists", () => {
  assert.strictEqual(D.summaryText(story()), "A longer descriptive body used when no summary exists.");
});

test("summaryText returns null when neither summary nor description exists, never title", () => {
  const s = story({ description: null, ai: { summary: null, whyItMatters: null, keyTakeaways: [], method: null } });
  assert.strictEqual(D.summaryText(s), null);
  // title is explicitly not used as a fabricated summary
  assert.notStrictEqual(D.summaryText(s), "A sample AI story");
});

test("summaryText ignores blank/whitespace summaries", () => {
  const s = story({ ai: { summary: "   ", whyItMatters: null, keyTakeaways: [], method: null } });
  assert.strictEqual(D.summaryText(s), "A longer descriptive body used when no summary exists.");
});

test("summaryMethod returns the method or null", () => {
  assert.strictEqual(D.summaryMethod(story()), null);
  assert.strictEqual(
    D.summaryMethod(story({ ai: { summary: "x", whyItMatters: null, keyTakeaways: [], method: "llm" } })),
    "llm"
  );
});

/* ------------------------------------------------------------------ */
/* Summary fallback + redundancy (Stage 13, item 2)                    */
/* ------------------------------------------------------------------ */

test("levenshtein computes deterministic edit distance", () => {
  assert.strictEqual(D.levenshtein("", ""), 0);
  assert.strictEqual(D.levenshtein("abc", "abc"), 0);
  assert.strictEqual(D.levenshtein("kitten", "sitting"), 3);
  assert.strictEqual(D.levenshtein("", "abc"), 3);
  assert.strictEqual(D.levenshtein("abc", ""), 3);
  assert.strictEqual(D.levenshtein("abc", "abc"), D.levenshtein("abc", "abc"));
});

test("levenshteinRatio is 0..1 and deterministic", () => {
  assert.strictEqual(D.levenshteinRatio("abc", "abc"), 1);
  assert.strictEqual(D.levenshteinRatio("", ""), 1);
  assert.strictEqual(D.levenshteinRatio("kitten", "sitting") > 0, true);
  assert.strictEqual(D.levenshteinRatio("a", "b"), 0);
  assert.strictEqual(D.levenshteinRatio("abc", "abc"), D.levenshteinRatio("abc", "abc"));
});

test("isRedundantSummary flags only near-verbatim title echoes (>0.85), case-insensitive", () => {
  // Minor punctuation/case change -> redundant
  assert.strictEqual(D.isRedundantSummary("OpenAI unveils new model.", "OpenAI unveils new model"), true);
  // Exact match (different case) -> redundant
  assert.strictEqual(D.isRedundantSummary("openai unveils new model", "OpenAI unveils new model"), true);
  // Substantial additional information -> NOT redundant
  assert.strictEqual(
    D.isRedundantSummary(
      "OpenAI unveiled a frontier model with agentic tool use and broad reasoning gains.",
      "OpenAI unveils new model"
    ),
    false
  );
  // A short source echo on a long title is still >0.85 -> redundant
  // 80-char title, + " OpenAI" (7 chars) -> ratio 1-7/80=0.913
  assert.strictEqual(
    D.isRedundantSummary(
      "Apple Intelligence rolls out to more devices this quarter, confirming WWDC rumors OpenAI",
      "Apple Intelligence rolls out to more devices this quarter, confirming WWDC rumors"
    ),
    true
  );
  // Null/empty summary -> redundant
  assert.strictEqual(D.isRedundantSummary(null, "Some title"), true);
  assert.strictEqual(D.isRedundantSummary("   ", "Some title"), true);
});

test("summaryText (a) missing summary -> null, no empty description block", () => {
  const s = story({ ai: { summary: null, whyItMatters: null, keyTakeaways: [], method: null }, description: null });
  assert.strictEqual(D.summaryText(s), null);
  // Empty/whitespace summary also -> null when description is absent too.
  assert.strictEqual(D.summaryText(story({ description: null, ai: { summary: "", whyItMatters: null, keyTakeaways: [], method: null } })), null);
});

test("summaryText (b) summary exactly equal to title -> unavailable", () => {
  const s = story({ ai: { summary: "A sample AI story", whyItMatters: null, keyTakeaways: [], method: "extractive" } });
  assert.strictEqual(D.summaryText(s), null);
});

test("summaryText (c) summary with only minor title changes -> unavailable", () => {
  const s = story({
    title: "OpenAI unveils new model today at conference",
    ai: { summary: "OpenAI unveils new model today at conference.", whyItMatters: null, keyTakeaways: [], method: "extractive" },
  });
  assert.strictEqual(D.summaryText(s), null);
});

test("summaryText (d) genuine summary with substantial info -> preserved", () => {
  const s = story({
    title: "OpenAI unveils GPT-6",
    ai: { summary: "OpenAI announced GPT-6, a frontier model with agentic tool use, modest parameter growth, and broad reasoning gains over prior releases.", whyItMatters: null, keyTakeaways: [], method: "llm" },
  });
  assert.strictEqual(D.summaryText(s), "OpenAI announced GPT-6, a frontier model with agentic tool use, modest parameter growth, and broad reasoning gains over prior releases.");
});

test("summaryText (e) long genuine summary is preserved", () => {
  const long = "Image editors satisfy regional plausibility constraints individually, yet global realism requires considering how edits interact across the whole canvas. This work introduces a certificate framework bounding composite edits to guarantee sharp feature coverage.";
  const s = story({ title: "Common-Witness Certificates", ai: { summary: long, whyItMatters: null, keyTakeaways: [], method: "llm" } });
  assert.strictEqual(D.summaryText(s), long);
});

test("summaryText rejects redundant description fallback but keeps useful description fallback", () => {
  // description is a near-copy of the title (Google News pattern) -> omit block
  const redundantDesc = story({
    ai: { summary: null, whyItMatters: null, keyTakeaways: [], method: null },
    description: "A sample AI story.",
  });
  assert.strictEqual(D.summaryText(redundantDesc), null);
  // useful description fallback still shown when summary absent
  const usefulDesc = story({ ai: { summary: null, whyItMatters: null, keyTakeaways: [], method: null }, description: "A longer descriptive body used when no summary exists." });
  assert.strictEqual(D.summaryText(usefulDesc), "A longer descriptive body used when no summary exists.");
});


/* ------------------------------------------------------------------ */
/* Entity + tag chips                                                  */
/* ------------------------------------------------------------------ */

test("collectChips gathers companies, people, models, technologies and tags, de-duplicated and stable", () => {
  const s = story({
    companies: ["OpenAI"],
    people: ["Sam Altman"],
    models: ["GPT-5"],
    technologies: ["RAG"],
    tags: ["Inference", "RAG"],
  });
  assert.deepStrictEqual(D.collectChips(s), ["OpenAI", "Sam Altman", "GPT-5", "RAG", "Inference"]);
});

test("collectChips returns empty array for a story with no entities/tags", () => {
  assert.deepStrictEqual(D.collectChips(story()), []);
  assert.deepStrictEqual(D.collectChips(null), []);
});

/* ------------------------------------------------------------------ */
/* Subcategory grouping                                                */
/* ------------------------------------------------------------------ */

test("groupBySubcategory groups and places 'other' last", () => {
  const items = [
    story({ id: "s00000001", subcategory: "other" }),
    story({ id: "s00000002", subcategory: "model" }),
    story({ id: "s00000003", subcategory: "model" }),
    story({ id: "s00000004", subcategory: "safety" }),
  ];
  const groups = D.groupBySubcategory(items);
  assert.deepStrictEqual(
    groups.map((g) => g.label),
    ["model", "safety", "other"]
  );
  assert.strictEqual(groups[0].count, 2);
  assert.strictEqual(groups[2].count, 1);
});

test("groupBySubcategory is empty-safe and deterministic", () => {
  assert.deepStrictEqual(D.groupBySubcategory([]), []);
  assert.deepStrictEqual(D.groupBySubcategory(null), []);
  const a = D.groupBySubcategory([story({ subcategory: "model" }), story({ subcategory: "tools" })]);
  const b = D.groupBySubcategory([story({ subcategory: "model" }), story({ subcategory: "tools" })]);
  assert.deepStrictEqual(a, b);
});

/* ------------------------------------------------------------------ */
/* Virtual grid slicing / paging                                       */
/* ------------------------------------------------------------------ */

function many(n) {
  return Array.from({ length: n }, (_, i) => story({ id: "s" + String(i).padStart(8, "0") }));
}

test("windowSlice renders the requested page and reports hasMore/hasPrev", () => {
  const w = D.windowSlice(many(100), 1, 40);
  assert.strictEqual(w.slice.length, 40);
  assert.strictEqual(w.total, 100);
  assert.strictEqual(w.pages, 3);
  assert.strictEqual(w.hasMore, true);
  assert.strictEqual(w.hasPrev, false);

  const w2 = D.windowSlice(many(100), 3, 40);
  assert.strictEqual(w2.slice.length, 20);
  assert.strictEqual(w2.hasMore, false);
  assert.strictEqual(w2.hasPrev, true);
});

test("windowSlice clamps page/pageSize and handles empty safely", () => {
  const w = D.windowSlice(many(10), 99, 5);
  assert.strictEqual(w.page, 2);
  assert.strictEqual(w.hasMore, false);
  const e = D.windowSlice([], 1, 40);
  assert.strictEqual(e.total, 0);
  assert.deepStrictEqual(e.slice, []);
});

/* ------------------------------------------------------------------ */
/* Top signal selection                                                */
/* ------------------------------------------------------------------ */

test("topSignal picks the highest radarScore, ties broken by newest publishedAt", () => {
  const a = story({ id: "s00000001", radarScore: 60, publishedAt: "2026-09-01T10:00:00.000Z" });
  const b = story({ id: "s00000002", radarScore: 90, publishedAt: "2026-09-01T09:00:00.000Z" });
  const c = story({ id: "s00000003", radarScore: 90, publishedAt: "2026-09-01T11:00:00.000Z" });
  assert.strictEqual(D.topSignal([a, b, c]), c);
  assert.strictEqual(D.topSignal([a]), a);
  assert.strictEqual(D.topSignal([]), null);
  assert.strictEqual(D.topSignal(null), null);
});

/* ------------------------------------------------------------------ */
/* Dashboard dedup partition (Stage 13, item 1)                        */
/* ------------------------------------------------------------------ */

function hlStory(id, overrides) {
  return story(Object.assign({ id }, overrides || {}));
}

test("articleIdentity keys on the normalized article URL, else the canonical identity", () => {
  // Two copies of the same Google-News article (same URL, differing title
  // suffix) collapse to one identity.
  const a = hlStory("s00000001", {
    title: "Some story - cureus.com",
    link: "https://news.google.com/rss/articles/CBMaaa?oc=5",
    canonicalUrl: "https://news.google.com/rss/articles/CBMaaa?oc=5",
  });
  const b = hlStory("s00000002", {
    title: "Some story - Cureus",
    link: "https://news.google.com/rss/articles/CBMaaa?oc=5",
    canonicalUrl: "https://news.google.com/rss/articles/CBMaaa?oc=5",
  });
  assert.strictEqual(D.articleIdentity(a), D.articleIdentity(b));

  // Two genuinely distinct articles (different URLs, same-ish title) differ.
  const c = hlStory("s00000003", {
    title: "AI at work - expr",
    link: "https://example.com/a/1",
    canonicalUrl: "https://example.com/a/1",
  });
  const d = hlStory("s00000004", {
    title: "AI at work - San Antonio",
    link: "https://example.com/a/2",
    canonicalUrl: "https://example.com/a/2",
  });
  assert.notStrictEqual(D.articleIdentity(c), D.articleIdentity(d));
});

test("partitionHighlights: distinct Top Signal + Top Stories + feed, URL-deduped", () => {
  // Six stories: a top, three runners-up (one is a duplicate copy of another
  // runner-up with the same URL but a different title suffix), plus one that IS
  // the top signal's URL-duplicate.
  const items = [
    hlStory("s00000001", { radarScore: 95, publishedAt: "2026-09-01T09:00:00.000Z", link: "https://n.com/top", canonicalUrl: "https://n.com/top", title: "Top story" }),
    hlStory("s00000002", { radarScore: 90, publishedAt: "2026-09-01T09:00:00.000Z", link: "https://n.com/r/1", canonicalUrl: "https://n.com/r/1", title: "R1 - gdnet.net" }),
    hlStory("s00000003", { radarScore: 90, publishedAt: "2026-09-01T09:00:00.000Z", link: "https://n.com/r/1", canonicalUrl: "https://n.com/r/1", title: "R1 - gdnet" }),
    hlStory("s00000004", { radarScore: 80, publishedAt: "2026-09-01T09:00:00.000Z", link: "https://n.com/r/2", canonicalUrl: "https://n.com/r/2", title: "R2" }),
    hlStory("s00000005", { radarScore: 70, publishedAt: "2026-09-01T09:00:00.000Z", link: "https://n.com/r/3", canonicalUrl: "https://n.com/r/3", title: "R3" }),
    hlStory("s00000006", { radarScore: 95, publishedAt: "2026-09-01T09:00:00.000Z", link: "https://n.com/top", canonicalUrl: "https://n.com/top", title: "Top story duplicate copy" }),
  ];

  const hl = D.partitionHighlights(items);
  assert.strictEqual(hl.topSignal.length, 1);
  // The URL-duplicate of the top signal is NOT promoted (identity dedup).
  assert.strictEqual(hl.topSignal[0].title, "Top story");
  assert.strictEqual(hl.topStories.length, 3);
  // Unique set is exactly top + R1 + R2 + R3, so nothing remains for the feed.
  assert.strictEqual(hl.feed.length, 0);
  assert.deepStrictEqual(
    hl.topStories.map((s) => s.title),
    ["R1 - gdnet.net", "R2", "R3"]
  );

  // No identity key may appear in more than one section.
  const allIds = hl.topSignal.concat(hl.topStories, hl.feed).map(D.articleIdentity).filter(Boolean);
  assert.strictEqual(new Set(allIds).size, allIds.length);
  // And nothing overlaps with the top signal's identity.
  const sig = D.articleIdentity(hl.topSignal[0]);
  assert.ok(!hl.topStories.some((s) => D.articleIdentity(s) === sig));
  assert.ok(!hl.feed.some((s) => D.articleIdentity(s) === sig));
});

test("partitionHighlights preserves legitimate same-title/different-URL stories", () => {
  // Two legitimately distinct articles with the SAME title but DIFFERENT URLs
  // must both be preserved (never merged by title similarity).
  const items = [
    hlStory("s00000001", { radarScore: 90, link: "https://a.com/x/1", canonicalUrl: "https://a.com/x/1", title: "AI at work" }),
    hlStory("s00000002", { radarScore: 85, link: "https://b.com/y/2", canonicalUrl: "https://b.com/y/2", title: "AI at work" }),
    hlStory("s00000003", { radarScore: 70, link: "https://c.com/z/3", canonicalUrl: "https://c.com/z/3", title: "R3" }),
  ];
  const hl = D.partitionHighlights(items);
  const titles = hl.topSignal.concat(hl.topStories).map((s) => s.title);
  // Both "AI at work" articles survive as distinct items.
  assert.strictEqual(titles.filter((t) => t === "AI at work").length, 2);
  assert.strictEqual(hl.topSignal.length + hl.topStories.length, 3);
});

test("partitionHighlights is empty/null-safe and deterministic", () => {
  assert.deepStrictEqual(D.partitionHighlights([]), { topSignal: [], topStories: [], feed: [] });
  assert.deepStrictEqual(D.partitionHighlights(null), { topSignal: [], topStories: [], feed: [] });
  const items = [
    hlStory("s00000001", { radarScore: 90, link: "https://a.com/x/1" }),
    hlStory("s00000002", { radarScore: 80, link: "https://b.com/x/2" }),
  ];
  const a = D.partitionHighlights(items);
  const b = D.partitionHighlights(items);
  assert.deepStrictEqual(a, b);
});

/* ------------------------------------------------------------------ */
/* Contract safety: dashboard helpers never mutate the Story           */
/* ------------------------------------------------------------------ */

test("dashboard helpers do not mutate their inputs", () => {
  const s = story({
    companies: ["OpenAI"],
    tags: ["Inference"],
    ai: { summary: "x", whyItMatters: null, keyTakeaways: [], method: "extractive" },
  });
  const snapshot = JSON.stringify(s);
  D.collectChips(s);
  D.summaryText(s);
  D.radarBand(s.radarScore);
  D.groupBySubcategory([s]);
  assert.strictEqual(JSON.stringify(s), snapshot);
  // And it still satisfies the canonical schema validator (Stage 3 contract).
  assert.strictEqual(Core.validateStory(s).valid, true);
});

/* ------------------------------------------------------------------ */
/* Item 3 — Card visuals: og:image thumbnail vs category left-strip    */
/* ------------------------------------------------------------------ */

test("cardVisual prefers an existing archive image URL for the thumbnail", () => {
  const cfg = D.cardVisual(story({ image: "https://cdn.example.com/art.jpg" }));
  assert.strictEqual(cfg.hasThumb, true);
  assert.strictEqual(cfg.thumbUrl, "https://cdn.example.com/art.jpg");
  assert.strictEqual(cfg.category, "news");
});

test("cardVisual falls back to a left-strip (no thumb) when no image URL exists", () => {
  const none = D.cardVisual(story({}));
  assert.strictEqual(none.hasThumb, false);
  assert.strictEqual(none.thumbUrl, "");
});

test("cardVisual ignores blank/whitespace image values and keeps category accent", () => {
  const blank = D.cardVisual(
    Object.assign(story({}), { image: "   ", category: "product" })
  );
  assert.strictEqual(blank.hasThumb, false);
  assert.strictEqual(blank.category, "product");

  const prod = D.cardVisual(Object.assign(story({}), { category: "funding" }));
  assert.strictEqual(prod.category, "funding");
});

test("cardVisual is deterministic and null-safe", () => {
  assert.deepStrictEqual(D.cardVisual(null), { category: "news", thumbUrl: "", hasThumb: false });
  const a = D.cardVisual(story({ image: "https://cdn.example.com/x.png", category: "research" }));
  const b = D.cardVisual(story({ image: "https://cdn.example.com/x.png", category: "research" }));
  assert.deepStrictEqual(a, b);
});

/* ------------------------------------------------------------------ */
/* Item 4 — Score tooltip (scoreBadgeHtml)                             */
/* ------------------------------------------------------------------ */

test("scoreBadgeHtml wraps the unchanged score badge with the tooltip", () => {
  const esc = (s) =>
    String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  const h = D.scoreBadgeHtml({ radarScore: 85, id: "s00000001" }, esc);
  // The numeric score value + band label are unchanged.
  assert.match(h, /aria-label="High signal 85%"/);
  assert.match(h, />85<\/text>/);
  // Badge surface + wrappers for the CSS-only tooltip.
  assert.match(h, /class="score-tip"/);
  assert.match(h, /class="radar"/);
  assert.match(h, /class="score-tip-bubble"/);
  // Keyboard focusability + accessible description wiring.
  assert.match(h, /tabindex="0"/);
  assert.match(h, /aria-describedby="dash-score-tip-s00000001"/);
  // Tooltip content (hover/focus visualization) + ARIA role.
  assert.match(h, /role="tooltip"/);
  assert.match(h, /Signal Score: weighted by recency, source authority, and topic relevance\./);
  assert.match(h, /data-tooltip="Signal Score: weighted/);
  // aria-describedby id matches the tooltip element id.
  assert.match(h, /id="dash-score-tip-s00000001"/);
});

test("scoreBadgeHtml emits no markup when there is no numeric score", () => {
  const esc = (s) => s;
  assert.strictEqual(D.scoreBadgeHtml({ radarScore: null, id: "s1" }, esc), "");
  assert.strictEqual(D.scoreBadgeHtml({}, esc), "");
  assert.strictEqual(D.scoreBadgeHtml(null, esc), "");
});

test("scoreBadgeHtml is deterministic and escapes tooltip attributes", () => {
  const esc = (s) => String(s).replace(/"/g, "&quot;");
  const a = D.scoreBadgeHtml({ radarScore: 60, id: "s2" }, esc);
  const b = D.scoreBadgeHtml({ radarScore: 60, id: "s2" }, esc);
  assert.strictEqual(a, b);
  assert.ok(a.includes(">60</text>"));
  assert.ok(a.includes("Medium signal 60%"));
  assert.strictEqual(D.SCORE_TOOLTIP_TEXT, "Signal Score: weighted by recency, source authority, and topic relevance.");
});
