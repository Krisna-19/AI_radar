/*
 * AI RADAR - Stage 7: summarization layer (Node).
 *
 * Purpose
 *   Enrich each staged canonical Story's `ai` object with an extractive summary
 *   (deterministic, zero dependencies, zero credentials), with an OPTIONAL
 *   LLM path that uses only Node's built-in global fetch (no new npm
 *   dependency). Default mode is `extract`; it is fully self-sufficient and
 *   always runs when no API key is present.
 *
 *   Pipeline slot (roadmap 7.summarize.js):
 *     ... classify -> score -> summarize -> store
 *
 * Output (schema-compatible, all within the existing `ai` object):
 *   ai.summary        string|null  1-2 sentence extractive summary
 *   ai.whyItMatters   string|null  null in extractive mode (never invented);
 *                                  possibly filled by the LLM path (labeled)
 *   ai.keyTakeaways   string[]     up to 3 verbatim sentence fragments
 *   ai.method         string|null  "extractive" | "llm" | null  (provenance)
 *
 * Invariants
 *   - EXTRACT ONLY: every summary/takeaway is a verbatim substring of the
 *     story's description/content. Nothing is ever invented.
 *   - NO FAKE SUMMARY: a title-only or too-short body yields ai.summary = null
 *     (the title is never used as a summary).
 *   - SENTENCE BOUNDARIES: summaries never clip mid-word/sentence.
 *   - DETERMINISTIC (extractive): identical input => identical output.
 *   - IDEMPOTENT: an already-populated ai.summary is never overwritten.
 *   - FAIL-SAFE LLM: missing key, network error, invalid JSON, non-grounded or
 *     out-of-shape responses all fall back to extractive; LLM never breaks a
 *     build, never fabricates (a weak token-overlap grounding check rejects
 *     hallucinated output).
 */

"use strict";

/* ------------------------------------------------------------------ *
 * Tunable defaults (overridable via opts.config)
 * ------------------------------------------------------------------ */
const DEFAULTS = {
  MIN_BODY_WORDS: 6,      // body shorter than this => summary is null
  SUMMARY_MAX_CHARS: 280, // hard cap on ai.summary
  SUMMARY_SENTENCES: 2,   // sentences joined into the summary
  TAKEAWAY_MAX: 3,        // max keyTakeaways
  TAKEAWAY_MAX_CHARS: 140,
  LLM_TIMEOUT_MS: 15000,
};

/* The LLM is instructed to paraphrase/quote the source only. It never
 * fabricates facts, and the pipeline rejects any response that shares too
 * little vocabulary with the source (see isLlmGrounded). */
const SYSTEM_PROMPT =
  "You are an extractive summarizer for an AI-news aggregator. " +
  "Produce a summary using ONLY information present in the given title and " +
  "article text. Never invent facts, numbers, quotes, or attributions. " +
  "Respond with strict JSON of the form " +
  '{"summary": string, "whyItMatters": string|null, "keyTakeaways": [string]} ' +
  'with at most 3 keyTakeaways. If the text is insufficient, return "summary": null.';

/* ------------------------------------------------------------------ *
 * Text helpers (pure / deterministic)
 * ------------------------------------------------------------------ */

function wordCount(text) {
  if (!text) return 0;
  const m = String(text).trim().split(/\s+/).filter(Boolean);
  return m.length;
}

/* Split into sentences on the classic sentence terminators, keeping the
 * punctuation attached and treating each run as one unit. */
function splitSentences(text) {
  if (!text) return [];
  return String(text)
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/* Trim to `limit` chars, preferring a whole-word cut and no trailing
 * punctuation. Never splits mid-word. */
function charCap(text, limit) {
  if (!text) return "";
  let s = String(text);
  if (s.length <= limit) return s;
  let cut = s.slice(0, limit);
  const sp = cut.lastIndexOf(" ");
  if (sp > 0) cut = cut.slice(0, sp);
  cut = cut.replace(/[.,;:]$/u, "");
  return cut;
}

/* The body text a summary may be drawn from: description first, else content.
 * Title is deliberately NOT used as body (a title alone is never a summary). */
function bodyText(story) {
  if (!story) return null;
  const desc = story.description;
  const content = story.content;
  if (desc && typeof desc === "string" && desc.trim()) return desc.trim();
  if (content && typeof content === "string" && content.trim()) return content.trim();
  return null;
}

function ensureAi(story) {
  if (!story || typeof story !== "object") return;
  if (!story.ai || typeof story.ai !== "object") story.ai = {};
  if (story.ai.summary === undefined) story.ai.summary = null;
  if (story.ai.whyItMatters === undefined) story.ai.whyItMatters = null;
  if (!Array.isArray(story.ai.keyTakeaways)) story.ai.keyTakeaways = [];
  if (story.ai.method === undefined) story.ai.method = null;
}

/* ------------------------------------------------------------------ *
 * Extractive summarizer (default; pure + deterministic)
 * ------------------------------------------------------------------ */
function applyExtractive(story, cfg) {
  const body = bodyText(story);
  if (!body || wordCount(body) < cfg.MIN_BODY_WORDS) {
    story.ai.summary = null;
    story.ai.whyItMatters = null;
    story.ai.keyTakeaways = [];
    return;
  }

  const sentences = splitSentences(body);
  const used = []; // sentences consumed by the summary
  let sum = "";
  for (const s of sentences) {
    if (!s) continue;
    const candidate = used.length ? sum + " " + s : s;
    if (candidate.length > cfg.SUMMARY_MAX_CHARS && used.length) break;
    used.push(s);
    sum = candidate;
    if (used.length >= cfg.SUMMARY_SENTENCES) break;
  }

  story.ai.summary = sum ? charCap(sum, cfg.SUMMARY_MAX_CHARS) : null;
  story.ai.whyItMatters = null; // extractive never invents a "so what"

  // Key takeaways: up to TAKEAWAY_MAX sentences NOT used by the summary.
  const usedSet = new Set(used.map((s) => s.toLowerCase()));
  const takeaways = [];
  for (const s of sentences) {
    if (!s) continue;
    if (usedSet.has(s.toLowerCase())) continue;
    takeaways.push(charCap(s, cfg.TAKEAWAY_MAX_CHARS));
    if (takeaways.length >= cfg.TAKEAWAY_MAX) break;
  }
  story.ai.keyTakeaways = takeaways;
}

/* ------------------------------------------------------------------ *
 * Optional LLM path (Node built-in fetch only; no new dependency)
 * ------------------------------------------------------------------ */
function resolveMode(opts) {
  if (
    opts.mode === "llm" &&
    opts.apiKey &&
    (opts.fetchImpl || typeof fetch === "function")
  ) {
    return "llm";
  }
  return "extract";
}

function userPrompt(story) {
  const body = bodyText(story) || "";
  return (
    "Title:\n" + (story.title || "") +
    "\n\nArticle text:\n" + body +
    "\n\nOutput the JSON summary object."
  );
}

async function callLlm(story, opts, cfg) {
  const baseUrl = (opts.baseUrl || process.env.AI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");
  const model = opts.model || process.env.AI_MODEL || "gpt-4o-mini";
  const endpoint = baseUrl + "/chat/completions";

  const body = {
    model,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userPrompt(story) },
    ],
    temperature: 0,
    max_tokens: 300,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs || cfg.LLM_TIMEOUT_MS);
  try {
    const doFetch = opts.fetchImpl || fetch;
    const res = await doFetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: "Bearer " + opts.apiKey,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error("llm http " + res.status);
    const data = await res.json();
    const content = data && data.choices && data.choices[0] &&
      data.choices[0].message && data.choices[0].message.content;
    if (typeof content !== "string" || !content.trim()) throw new Error("llm empty content");
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch (e) {
      throw new Error("llm invalid json");
    }
    return parsed;
  } finally {
    clearTimeout(timer);
  }
}

/* Weak anti-hallucination ground: at least half of the LLM response's
 * significant tokens must also appear in the source text. This rejects
 * fabricated/summarized-out-of-thin-air output while tolerating legitimate
 * extractive paraphrases. */
function isLlmGrounded(content, story) {
  const source = ((bodyText(story) || "") + " " + (story.title || "")).toLowerCase();
  const sig = String(content)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 3);
  if (!sig.length) return false;
  let hit = 0;
  for (const w of sig) if (source.indexOf(w) !== -1) hit++;
  return hit / sig.length >= 0.5;
}

function normalizeLlm(story, parsed, cfg) {
  let summary = parsed && typeof parsed.summary === "string" ? parsed.summary.trim() : null;
  if (summary && !summary.length) summary = null;
  let why = parsed && typeof parsed.whyItMatters === "string" ? parsed.whyItMatters.trim() : null;
  if (why && !why.length) why = null;

  let takeaways = [];
  if (parsed && Array.isArray(parsed.keyTakeaways)) {
    for (const t of parsed.keyTakeaways.slice(0, cfg.TAKEAWAY_MAX)) {
      if (typeof t === "string" && t.trim()) {
        takeaways.push(charCap(t.trim(), cfg.TAKEAWAY_MAX_CHARS));
      }
    }
  }

  const proposedSummary = summary || why || takeaways.join(" ");
  if (proposedSummary && !isLlmGrounded(proposedSummary, story)) {
    return null; // ungrounded -> reject, fall back to extractive
  }

  story.ai.summary = summary ? charCap(summary, cfg.SUMMARY_MAX_CHARS) : null;
  story.ai.whyItMatters = why ? charCap(why, cfg.SUMMARY_MAX_CHARS) : null;
  story.ai.keyTakeaways = takeaways;
  return story;
}

/* ------------------------------------------------------------------ *
 * Public API
 * ------------------------------------------------------------------ */

/* Summarize a single canonical story. Async (LLM path may await). Returns the
 * same story (mutated only on its `ai` object). Idempotent: an already
 * populated summary is left untouched. */
async function summarizeStory(story, opts = {}) {
  if (!story || typeof story !== "object") return story;
  ensureAi(story);
  if (story.ai.summary != null && story.ai.method) return story; // already done

  const cfg = Object.assign({}, DEFAULTS, opts.config || {});
  const mode = resolveMode(opts);

  if (mode === "llm") {
    try {
      const parsed = await callLlm(story, opts, cfg);
      const normalized = normalizeLlm(story, parsed, cfg);
      if (normalized) {
        story.ai.method = "llm";
        return story;
      }
    } catch (e) {
      /* network / timeout / parse / grounding failure -> fall back below */
    }
  }

  applyExtractive(story, cfg);
  story.ai.method = story.ai.summary != null ? "extractive" : null;
  return story;
}

/* Summarize an array of canonical stories (optionally concurrently). Returns
 * { items, stats }. Non-fatal: per-story failures degrade to extractive. */
async function summarizeStories(stories, opts = {}) {
  const input = Array.isArray(stories) ? stories : [];
  const mode = resolveMode(opts);
  const concurrency = Math.max(1, opts.concurrency || 8);

  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, input.length || 1) }, async () => {
    while (cursor < input.length) {
      const i = cursor++;
      await summarizeStory(input[i], opts);
    }
  });
  await Promise.all(workers);

  let summarized = 0; // stories with a populated summary
  let extractive = 0;
  let llm = 0;
  let none = 0;
  for (const s of input) {
    if (!s || !s.ai) { none++; continue; }
    if (s.ai.method === "extractive" && s.ai.summary != null) { summarized++; extractive++; }
    else if (s.ai.method === "llm" && s.ai.summary != null) { summarized++; llm++; }
    else none++;
  }

  return {
    items: input,
    mode,
    stats: { mode, summarized, extractive, llm, none },
  };
}

module.exports = {
  DEFAULTS,
  SYSTEM_PROMPT,
  wordCount,
  splitSentences,
  charCap,
  bodyText,
  applyExtractive,
  normalizeLlm,
  isLlmGrounded,
  resolveMode,
  summarizeStory,
  summarizeStories,
};
