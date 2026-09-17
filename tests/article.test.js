/*
 * Article reader tests: the pure, DOM-free helpers in js/article.js.
 *
 * Covers the content/description priority contract, the collected fields the
 * in-app reader shows (title, source, published, signal, AI summary, extracted
 * content, chips), the safe fallback when nothing is available, the absence of
 * ANY external navigation in the rendered reader, and escape-based sanitisation
 * (never raw HTML from extracted content).
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert");

const Core = require("../js/shared.js");
const A = require("../js/article.js");

/* A realistic canonical Story built through the real normalizer, then layered
 * with the stage 5/6/7 fields the article reader consumes. */
function story(overrides) {
  const source = {
    id: "demo",
    name: "Demo Source",
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
  s.category = "product";
  s.ai = { summary: null, whyItMatters: null, keyTakeaways: [], method: null };
  return Object.assign(s, overrides || {});
}

function esc(s) {
  return (s == null ? "" : String(s))
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/* ------------------------------------------------------------------ */
/* Body text priority: content -> description -> safe fallback         */
/* ------------------------------------------------------------------ */

test("readerText prefers extracted content over description", () => {
  const s = story({
    description: "Description body.",
    content: "Full extracted article body with real details.",
  });
  assert.strictEqual(A.readerText(s), "Full extracted article body with real details.");
});

test("readerText falls back to description when content is unavailable", () => {
  assert.strictEqual(A.readerText(story()), "A longer descriptive body used when no summary exists.");
});

test("readerText falls back to description for empty/whitespace-only content", () => {
  const s = story({ content: "   \n  " });
  assert.strictEqual(A.readerText(s), "A longer descriptive body used when no summary exists.");
});

test("readerText returns '' (safe fallback) when neither content nor description exists, never the title", () => {
  const s = story({ content: null, description: null });
  assert.strictEqual(A.readerText(s), "");
  assert.notStrictEqual(A.readerText(s), "A sample AI story");
});

test("readerText is null-safe and trims", () => {
  assert.strictEqual(A.readerText(null), "");
  assert.strictEqual(A.readerText(undefined), "");
  assert.strictEqual(A.readerText(story({ content: "  x  " })), "x");
});

/* ------------------------------------------------------------------ */
/* Summary + score helpers                                             */
/* ------------------------------------------------------------------ */

test("summaryText prefers the real ai.summary, ignores blanks, is null-safe", () => {
  const s = story({ ai: { summary: "Concise real summary", whyItMatters: null, keyTakeaways: [], method: "extractive" } });
  assert.strictEqual(A.summaryText(s), "Concise real summary");
  assert.strictEqual(A.summaryText(story({ ai: { summary: "   " } })), "");
  assert.strictEqual(A.summaryText(story()), "");
  assert.strictEqual(A.summaryText(null), "");
});

test("scoreValue prefers radarScore (0-100) then legacy score*20, else null", () => {
  assert.strictEqual(A.scoreValue(story({ radarScore: 67 })), 67);
  assert.strictEqual(A.scoreValue(story({ radarScore: 67.4 })), 67);
  assert.strictEqual(A.scoreValue(story({ radarScore: null, score: 4 })), 80);
  assert.strictEqual(A.scoreValue(story({ radarScore: null, score: null })), null);
  assert.strictEqual(A.scoreValue(null), null);
});

/* ------------------------------------------------------------------ */
/* Entity chips                                                        */
/* ------------------------------------------------------------------ */

test("collectChips de-duplicates and keeps stable order", () => {
  const s = story({
    companies: ["OpenAI"],
    people: ["Sam Altman"],
    models: ["GPT-5"],
    technologies: ["RAG"],
    tags: ["Inference", "RAG"],
  });
  assert.deepStrictEqual(A.collectChips(s), ["OpenAI", "Sam Altman", "GPT-5", "RAG", "Inference"]);
});

test("collectChips returns [] for empty/null input", () => {
  assert.deepStrictEqual(A.collectChips(story()), []);
  assert.deepStrictEqual(A.collectChips(null), []);
});

/* ------------------------------------------------------------------ */
/* formatDate                                                          */
/* ------------------------------------------------------------------ */

test("formatDate renders a readable date and '' for invalid/null input", () => {
  const out = A.formatDate(new Date("2026-08-13T11:00:00.000Z"));
  assert.strictEqual(typeof out, "string");
  assert.ok(out.includes("2026"));
  assert.ok(out.includes("at"));
  assert.strictEqual(A.formatDate(new Date("nonsense")), "");
  assert.strictEqual(A.formatDate(null), "");
  assert.strictEqual(A.formatDate(), "");
});

/* ------------------------------------------------------------------ */
/* Reader markup: collected fields + content priority                  */
/* ------------------------------------------------------------------ */

test("readerHtml shows title, source, published date and signal", () => {
  const s = story({
    publishedAt: "2026-08-13T11:00:00.000Z",
    ai: { summary: "AI summary text.", whyItMatters: null, keyTakeaways: [], method: "extractive" },
  });
  const h = A.readerHtml(s, esc);
  assert.match(h, />A sample AI story</);
  assert.match(h, /<b>Source:<\/b> Demo Source/);
  assert.match(h, /<b>Published:<\/b>/);
  assert.ok(h.includes("80%</span>"));
  assert.match(h, />AI summary text\.<\/p>/);
});

test("readerHtml shows extracted content when available and labels it Full story", () => {
  const h = A.readerHtml(story({ content: "The extracted article plain text." }), esc);
  assert.match(h, /class="article-body"/);
  assert.match(h, />Full story</);
  assert.match(h, />The extracted article plain text\.</);
});

test("readerHtml uses description (flagged as Description) when content is unavailable", () => {
  const h = A.readerHtml(story(), esc);
  assert.match(h, />A longer descriptive body used when no summary exists\.</);
  assert.ok(h.includes("Description"));
  assert.ok(!h.includes("Full story"));
});

test("readerHtml content wins over description", () => {
  const h = A.readerHtml(
    story({
      description: "The description body.",
      content: "The full extracted content body.",
    }),
    esc
  );
  assert.match(h, />The full extracted content body\.</);
  assert.ok(!h.includes("The description body."));
  assert.ok(h.includes("Full story"));
});

test("readerHtml never shows empty body sections and gives a safe note when nothing is available", () => {
  const s = story({ content: null, description: null, ai: { summary: null, whyItMatters: null, keyTakeaways: [], method: null } });
  const h = A.readerHtml(s, esc);
  assert.ok(!h.includes("Full story"));
  assert.ok(!h.includes("Description</div>"));
  assert.match(h, />Only the headline is available for this story/);
  // The title is shown as the heading, but is never fabricated into a body.
  assert.match(h, />A sample AI story</);
  assert.ok(!h.includes('class="article-text"'));
});

test("readerHtml always renders the back-to-feed control", () => {
  const h = A.readerHtml(story(), esc);
  assert.match(h, /data-article-close/);
  assert.match(h, /Back to feed/);
});

test("readerHtml renders entity chips", () => {
  const h = A.readerHtml(story({ companies: ["OpenAI"], tags: ["Inference"] }), esc);
  assert.match(h, />OpenAI</);
  assert.match(h, />Inference</);
});

test("readerHtml omits chips when there are none", () => {
  const h = A.readerHtml(story(), esc);
  assert.ok(!h.includes("article-chips"));
});

test("readerHtml omits the summary block when no ai.summary exists", () => {
  const h = A.readerHtml(story({ ai: { summary: null, whyItMatters: null, keyTakeaways: [], method: null } }), esc);
  assert.ok(!h.includes("article-summary"));
});

test("readerHtml omits the source fact when no source name exists", () => {
  const h = A.readerHtml(story({ sourceName: null, source: { id: "x", name: "" } }), esc);
  assert.ok(!h.includes("<b>Source:</b>"));
});

/* ------------------------------------------------------------------ */
/* Security: no raw HTML, no external navigation                       */
/* ------------------------------------------------------------------ */

test("readerHtml escapes extracted content, never renders raw HTML", () => {
  const s = story({
    content:
      "<script>window.evilsite=true</script>Article with an iframe <iframe src=\"https://evil.example/\"> and a link <a href=\"https://evil.example/\">evil</a>.",
  });
  const h = A.readerHtml(s, esc);
  assert.ok(!h.includes("<script>"));
  assert.ok(!h.includes("<iframe"));
  assert.ok(!h.includes('<a href="https://evil.example/"'));
  assert.match(h, /&lt;script&gt;/);
  assert.match(h, /&lt;iframe/);
});

test("readerHtml escapes titles, summaries and descriptions", () => {
  const s = story({
    title: "Story <script>bad()</script>",
    ai: { summary: "Sum <b>bold</b> & more", whyItMatters: null, keyTakeaways: [], method: "extractive" },
    description: "Desc \"quoted\" & 'single'",
  });
  const h = A.readerHtml(s, esc);
  assert.ok(!h.includes("<script>"));
  assert.ok(!h.includes("<b>bold</b>"));
  assert.match(h, /&lt;script&gt;/);
  assert.match(h, /&lt;b&gt;/);
  assert.match(h, /&amp; more/);
  assert.match(h, /&quot;quoted&quot;/);
});

test("readerHtml contains no target=_blank and no external href", () => {
  const s = story({ content: "Body text.", link: "https://evil.example/out" });
  const h = A.readerHtml(s, esc);
  assert.ok(!h.includes('target="_blank"'));
  assert.ok(!h.includes("href="));
  assert.ok(!h.includes("https://evil.example/out"));
});

test("notFoundHtml returns a safe back-to-feed state with no external link", () => {
  const h = A.notFoundHtml();
  assert.match(h, /data-article-close/);
  assert.match(h, /Back to feed/);
  assert.match(h, /Story unavailable/);
  assert.ok(!h.includes("href="));
  assert.ok(!h.includes('target="_blank"'));
});

test("readerHtml(null) and readerHtml({}) degrade to the not-found state", () => {
  assert.match(A.readerHtml(null, esc), /Story unavailable/);
  assert.ok(!A.readerHtml({}, esc).includes("href="));
});

/* ------------------------------------------------------------------ */
/* Contract safety: helpers never mutate the Story object              */
/* ------------------------------------------------------------------ */

test("article reader helpers do not mutate their inputs", () => {
  const s = story({ content: "Body.", companies: ["OpenAI"], tags: ["Inference"] });
  const snapshot = JSON.stringify(s);
  A.readerText(s);
  A.summaryText(s);
  A.scoreValue(s);
  A.collectChips(s);
  A.readerHtml(s, esc);
  assert.strictEqual(JSON.stringify(s), snapshot);
  assert.strictEqual(Core.validateStory(s).valid, true);
});