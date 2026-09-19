/*
 * Stage 5.5 gating + transport-safety tests (scripts/pipeline/extract.js).
 *
 * Covers the scratch-trial hardening that was approved for production:
 *   - per-source article-fetch gating (allowedSourceIds allowlist): a disabled
 *     source is NEVER extracted (no network call, content stays null) while an
 *     enabled source is extracted normally;
 *   - per-host concurrency limit (default 2) layered under the global pool;
 *   - HTTP 429 retry with exponential backoff (500ms -> 1s -> 2s, 3 retries =
 *     4 total HTTP requests) and retry exhaustion -> content null;
 *   - non-429 failures are never retried;
 *   - publisherUrl remains the fetch target and wins over the wrapper URL
 *     even when gating is active;
 *   - the title-echo summarizer guard (no fabricated AI summary) is preserved.
 *
 * Uses node:test and deterministic mocks/fakes (fetchImpl / stubbed global
 * fetch) - NO real external websites, NO network access.
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert");

const Core = require("../js/shared.js");
const EX = require("../scripts/pipeline/extract.js");
const { FeedError } = require("../scripts/pipeline/http.js");
const SUM = require("../scripts/pipeline/summarize.js");

const NOW = Date.UTC(2026, 8, 18, 7, 0, 0);

const ARTICLE_WORDS =
  "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.";
const ARTICLE_30 = `<html><body><article><p>${ARTICLE_WORDS}</p></article></body></html>`;

function words(n, prefix) {
  const p = prefix || "w";
  return Array.from({ length: n }, (_, i) => p + i).join(" ");
}

function makeStory(title, link, source, opts = {}) {
  const src = Object.assign(
    { id: "demo", name: "Demo", category: "media", reliability: 6, priority: 100, weight: 3, color: "#666" },
    source || {}
  );
  const s = Core.normalizeItem(
    { title: title || "T", link, description: opts.description || title || "d" },
    src,
    { nowMs: NOW }
  );
  s.content = opts.content != null ? opts.content : null;
  return s;
}

/* ------------------------------------------------------------------ *
 * Per-source fetch gating
 * ------------------------------------------------------------------ */

test("gating: enabled source stories are extracted, disabled source stories are not", async () => {
  const fetched = [];
  const on = makeStory("On A", "https://pub.on.example/a", { id: "on", name: "On" });
  const off = makeStory("Off A", "https://pub.off.example/a", { id: "off", name: "Off" });
  const res = await EX.extractArticles([on, off], {
    allowedSourceIds: ["on"],
    fetchImpl: async (u) => {
      fetched.push(u);
      return { text: ARTICLE_30, contentType: "text/html" };
    },
  });
  assert.deepStrictEqual(fetched, ["https://pub.on.example/a"], "only enabled source is fetched");
  assert.ok(typeof on.content === "string" && on.content.indexOf("Lorem ipsum") !== -1);
  assert.strictEqual(off.content, null, "disabled source content stays null");
  assert.strictEqual(res.stats.extracted, 1);
  assert.strictEqual(res.stats.disabled, 1);
  assert.strictEqual(res.stats.requests, 1);
  assert.strictEqual(res.stats.perSource.on.extracted, 1);
  assert.strictEqual(res.stats.perSource.off.disabled, 1);
  assert.strictEqual(res.stats.perSource.off.fetched, 0, "no fetch attempted for disabled source");
});

test("gating: a disabled source NEVER reaches article extraction (its fetcher would throw)", async () => {
  const off1 = makeStory("Blocked 1", "https://pub.off.example/x", { id: "off", name: "Off" });
  const off2 = makeStory("Blocked 2", "https://pub.off.example/y", { id: "off", name: "Off" });
  const res = await EX.extractArticles([off1, off2], {
    allowedSourceIds: ["on"],
    fetchImpl: async () => {
      throw new Error("extraction must never be called for a disabled source");
    },
  });
  assert.strictEqual(res.stats.fetched, 0);
  assert.strictEqual(res.stats.requests, 0);
  assert.strictEqual(res.stats.disabled, 2);
  assert.strictEqual(off1.content, null);
  assert.strictEqual(off2.content, null);
});

test("gating: an enabled source calls extraction and fills content", async () => {
  const on = makeStory("Go", "https://pub.on.example/story", { id: "on", name: "On" });
  const res = await EX.extractArticles([on], {
    allowedSourceIds: ["on"],
    fetchImpl: async () => ({ text: ARTICLE_30, contentType: "text/html" }),
  });
  assert.ok(typeof on.content === "string" && on.content.indexOf("Lorem ipsum") !== -1);
  assert.strictEqual(res.stats.fetched, 1);
  assert.strictEqual(res.stats.extracted, 1);
  assert.strictEqual(res.stats.disabled, 0);
});

test("gating: gating is decided by story.source.id, not by URL host", async () => {
  const fetched = [];
  const a = makeStory("Same host A", "https://shared.example/one", { id: "a", name: "A" });
  const b = makeStory("Same host B", "https://shared.example/two", { id: "b", name: "B" });
  await EX.extractArticles([a, b], {
    allowedSourceIds: ["a"],
    fetchImpl: async (u) => {
      fetched.push(u);
      return { text: ARTICLE_30, contentType: "text/html" };
    },
  });
  assert.deepStrictEqual(fetched, ["https://shared.example/one"], "same host, only source a allowed");
  assert.ok(typeof a.content === "string");
  assert.strictEqual(b.content, null);
});

test("gating: empty allowlist disables everything (global switch on, zero sources eligible)", async () => {
  const on = makeStory("Any", "https://pub.example/x", { id: "on", name: "On" });
  const res = await EX.extractArticles([on], {
    allowedSourceIds: [],
    fetchImpl: async () => {
      throw new Error("must not be called");
    },
  });
  assert.strictEqual(res.stats.disabled, 1);
  assert.strictEqual(res.stats.requests, 0);
  assert.strictEqual(on.content, null);
});

test("gating: existing content is skipped even for an enabled source (never refetched)", async () => {
  const on = makeStory("Has body", "https://pub.on.example/x", { id: "on", name: "On" }, { content: "already extracted body" });
  let called = false;
  const res = await EX.extractArticles([on], {
    allowedSourceIds: ["on"],
    fetchImpl: async () => {
      called = true;
      return { text: ARTICLE_30, contentType: "text/html" };
    },
  });
  assert.strictEqual(called, false);
  assert.strictEqual(on.content, "already extracted body");
  assert.strictEqual(res.stats.skipped, 1);
  assert.strictEqual(res.stats.requests, 0);
});

test("gating: no allowlist passed = every source allowed (backward-compatible)", async () => {
  const a = makeStory("A", "https://example.com/a", { id: "a", name: "A" });
  await EX.extractArticles([a], {
    fetchImpl: async () => ({ text: ARTICLE_30, contentType: "text/html" }),
  });
  assert.ok(typeof a.content === "string");
});

/* ------------------------------------------------------------------ *
 * Per-host concurrency limit
 * ------------------------------------------------------------------ */

test("gating: per-host concurrency never exceeds the configured limit (default 2)", async () => {
  assert.strictEqual(EX.DEFAULT_HOST_CONCURRENCY, 2);
  const hostA = Array.from({ length: 8 }, (_, i) =>
    makeStory("A" + i, "https://hosta.example/n" + i, { id: "a", name: "A" })
  );
  const hostB = Array.from({ length: 8 }, (_, i) =>
    makeStory("B" + i, "https://hostb.example/n" + i, { id: "b", name: "B" })
  );
  const active = { "hosta.example": 0, "hostb.example": 0 };
  const max = { "hosta.example": 0, "hostb.example": 0 };
  const done = new Set();
  const impl = async (url) => {
    const host = EX.hostOf(url);
    active[host]++;
    max[host] = Math.max(max[host], active[host]);
    await new Promise((r) => setTimeout(r, 20));
    active[host]--;
    done.add(url);
    return { text: ARTICLE_30, contentType: "text/html" };
  };
  const res = await EX.extractArticles(hostA.concat(hostB), {
    concurrency: 10, // global pool deliberately above the per-host cap
    fetchImpl: impl,
  });
  assert.strictEqual(done.size, 16, "every article fetched");
  assert.ok(max["hosta.example"] <= 2, "hosta.example saw " + max["hosta.example"] + " concurrent fetches (limit 2)");
  assert.ok(max["hostb.example"] <= 2, "hostb.example saw " + max["hostb.example"] + " concurrent fetches (limit 2)");
  assert.ok(max["hosta.example"] >= 2, "expected some hosta.example parallelism, saw " + max["hosta.example"]);
  assert.ok(max["hostb.example"] >= 2, "expected some hostb.example parallelism, saw " + max["hostb.example"]);
  assert.strictEqual(res.stats.hostConcurrency, 2);
  assert.strictEqual(res.stats.concurrency, 10);
});

test("gating: per-host limit can be raised/lowered per call (hostConcurrency:1 serializes a host)", async () => {
  const stories = Array.from({ length: 5 }, (_, i) =>
    makeStory("S" + i, "https://serial.example/x" + i, { id: "s", name: "S" })
  );
  let active = 0;
  let maxActive = 0;
  const impl = async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 15));
    active--;
    return { text: ARTICLE_30, contentType: "text/html" };
  };
  await EX.extractArticles(stories, { concurrency: 5, hostConcurrency: 1, fetchImpl: impl });
  assert.strictEqual(maxActive, 1, "hostConcurrency:1 serializes fetches per host");
});

/* ------------------------------------------------------------------ *
 * HTTP 429 retry + backoff
 * ------------------------------------------------------------------ */

test("429: defaults are 3 retries with 500ms -> 1s -> 2s backoff (4 total requests)", () => {
  assert.strictEqual(EX.DEFAULT_MAX_RETRIES, 3);
  assert.deepStrictEqual(EX.RETRY_BACKOFF_MS, [500, 1000, 2000]);
});

test("429: retries with backoff and succeeds on the 4th attempt (3 retries)", async () => {
  const calls = [];
  const impl = async (url, o) => {
    calls.push(url);
    if (calls.length < 4) throw new FeedError("http", "HTTP 429", 429);
    return { text: ARTICLE_30, contentType: "text/html", status: 200 };
  };
  const s = makeStory("R", "https://retry.example/art");
  const res = await EX.extractArticles([s], {
    fetchImpl: impl,
    retryBackoffMs: [1, 1, 1], // tiny delays keep the test fast
  });
  assert.strictEqual(calls.length, 4, "initial + 3 retries");
  assert.ok(typeof s.content === "string" && s.content.indexOf("Lorem ipsum") !== -1);
  assert.strictEqual(res.stats.requests, 4);
  assert.strictEqual(res.stats.retries, 3);
  assert.strictEqual(res.stats.byStatus[429], 3);
  assert.strictEqual(res.stats.byStatus[200], 1);
  assert.strictEqual(res.stats.extracted, 1);
});

test("429: retry exhaustion produces content=null and never throws", async () => {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    throw new FeedError("http", "HTTP 429", 429);
  };
  const s = makeStory("E", "https://retry.example/exhaust");
  const res = await EX.extractArticles([s], { fetchImpl: impl, retryBackoffMs: [1, 1, 1] });
  assert.strictEqual(calls.length, 4, "given up after 4 total HTTP requests");
  assert.strictEqual(s.content, null);
  assert.strictEqual(res.stats.failed, 1);
  assert.strictEqual(res.stats.requests, 4);
  assert.strictEqual(res.stats.retries, 3);
  assert.strictEqual(res.stats.byStatus[429], 4, "all four requests observed 429");
});

test("429: maxRetries:0 answers immediately with a single request", async () => {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    throw new FeedError("http", "HTTP 429", 429);
  };
  const s = makeStory("Z", "https://retry.example/zero");
  const res = await EX.extractArticles([s], { fetchImpl: impl, maxRetries: 0, retryBackoffMs: [1, 1, 1] });
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(res.stats.requests, 1);
  assert.strictEqual(s.content, null);
});

test("non-429 http failures (404/403) are never retried", async () => {
  for (const status of [404, 403]) {
    const calls = [];
    const impl = async (url) => {
      calls.push(url);
      throw new FeedError("http", "HTTP " + status, status);
    };
    const s = makeStory("F" + status, "https://retry.example/f" + status);
    const res = await EX.extractArticles([s], { fetchImpl: impl });
    assert.strictEqual(calls.length, 1, status + " must not retry");
    assert.strictEqual(s.content, null);
    assert.strictEqual(res.stats.requests, 1);
    assert.strictEqual(res.stats.retries, 0);
    assert.strictEqual(res.stats.byStatus[status], 1);
  }
});

test("timeouts and network failures are never retried (single attempt)", async () => {
  for (const [type, label] of [["timeout", "Timeout after 12000ms"], ["network", "ECONNREFUSED"]]) {
    const calls = [];
    const impl = async (url) => {
      calls.push(url);
      throw new FeedError(type, label);
    };
    const s = makeStory("T" + type, "https://retry.example/t" + type);
    const res = await EX.extractArticles([s], { fetchImpl: impl });
    assert.strictEqual(calls.length, 1, type + " must not retry");
    assert.strictEqual(s.content, null);
    assert.strictEqual(res.stats.retries, 0);
    assert.strictEqual(res.stats.byType[type], 1);
  }
});

/* ------------------------------------------------------------------ *
 * publisherUrl priority under gating + diag attribution
 * ------------------------------------------------------------------ */

function wrapperStory(title, publisherHref, sourceId) {
  const wrapperLink = "https://news.google.com/rss/articles/CBMiX" + Math.random().toString(16).slice(2);
  const raw = {
    title,
    link: wrapperLink,
    description: title,
    describedHref: publisherHref,
  };
  return Core.normalizeItem(
    raw,
    { id: sourceId || "googlenews", name: "Google News AI", category: "aggregator", reliability: 6, priority: 100, weight: 3, color: "#666" },
    { nowMs: NOW }
  );
}

test("gating + publisherUrl: the publisher URL is fetched (never the wrapper) while gating is active", async () => {
  const s = wrapperStory("Deep learning cracks protein folding - Example", "https://publisher.example/article");
  const fetched = [];
  const res = await EX.extractArticles([s], {
    allowedSourceIds: ["googlenews"],
    fetchImpl: async (u) => {
      fetched.push(u);
      return { text: ARTICLE_30, contentType: "text/html" };
    },
  });
  assert.deepStrictEqual(fetched, ["https://publisher.example/article"], "publisherUrl wins over the news.google.com wrapper");
  assert.ok(typeof s.content === "string" && s.content.indexOf("Lorem ipsum") !== -1);
  assert.strictEqual(res.stats.fetched, 1);
  assert.strictEqual(res.stats.perSource.googlenews.fetched, 1);
  assert.strictEqual(res.stats.perSource.googlenews.extracted, 1);
});

test("diagnostics: per-source byStatus is attributed to the source that triggered the fetch", async () => {
  const a = makeStory("Diag A", "https://diag.example/ok", { id: "a", name: "A" });
  const b = makeStory("Diag B", "https://diag.example/404", { id: "b", name: "B" });
  let calls = 0;
  const res = await EX.extractArticles([a, b], {
    allowedSourceIds: ["a", "b"],
    fetchImpl: async (u) => {
      calls++;
      if (u.indexOf("404") !== -1) throw new FeedError("http", "HTTP 404", 404);
      return { text: ARTICLE_30, contentType: "text/html", status: 200 };
    },
  });
  assert.strictEqual(calls, 2);
  assert.strictEqual(res.stats.perSource.a.byStatus[200], 1);
  assert.strictEqual(res.stats.perSource.a.extracted, 1);
  assert.strictEqual(res.stats.perSource.b.byStatus[404], 1);
  assert.strictEqual(res.stats.perSource.b.failed, 1);
  assert.strictEqual(a.content.indexOf("Lorem ipsum") !== -1, true);
  assert.strictEqual(b.content, null);
});

test("diagnostics: average words are computed over extracted successes only", async () => {
  const s1 = makeStory("Wordy", "https://words.example/a", { id: "a", name: "A" });
  const s2 = makeStory("Short", "https://words.example/b", { id: "a", name: "A" });
  const res = await EX.extractArticles([s1, s2], {
    allowedSourceIds: ["a"],
    fetchImpl: async (u) => {
      const html = u.indexOf("/a") !== -1
        ? `<html><body><article><p>${words(120, "x")}</p></article></body></html>`
        : ARTICLE_30;
      return { text: html, contentType: "text/html", status: 200 };
    },
  });
  assert.strictEqual(res.stats.extracted, 2);
  const expectedAvg = Math.round((EX.wordCount(s1.content) + EX.wordCount(s2.content)) / 2);
  assert.strictEqual(res.stats.avgWords, expectedAvg, "avg_words = round(total extracted words / extracted count)");
});

/* ------------------------------------------------------------------ *
 * title-echo summarizer guard (preserved regression coverage)
 * ------------------------------------------------------------------ */

test("summarize: a title-echo description with no article content never fabricates an AI summary", async () => {
  const s = wrapperStory("AlphaFold wins the Breakthrough Prize - Nature", "https://publisher.example/af", "googlenews");
  s.content = null; // extraction never happened for this story
  await SUM.summarizeStory(s, { mode: "extract" });
  assert.strictEqual(s.ai.summary, null);
  assert.strictEqual(s.ai.whyItMatters, null);
  assert.deepStrictEqual(s.ai.keyTakeaways, []);
  assert.strictEqual(s.ai.method, null);
});

test("summarize: real extracted content still summaries normally under the same guard", async () => {
  const s = wrapperStory("AlphaFold wins the Breakthrough Prize - Nature", "https://publisher.example/af", "googlenews");
  s.content =
    "DeepMind's AlphaFold platform generated high-confidence protein structures for every protein in the human proteome, reshaping structural biology and pharmaceutical research.";
  await SUM.summarizeStory(s, { mode: "extract" });
  assert.ok(s.ai.summary && s.ai.summary.length > 0, "summary drawn from real extracted content");
  assert.strictEqual(s.ai.method, "extractive");
});