/*
 * Stage 5.5 tests: article content extraction (scripts/pipeline/extract.js)
 * + the Step-1 fetchBytes() layer it depends on (scripts/pipeline/http.js).
 * Uses node:test and deterministic mocks/fakes (fetchImpl / stubbed global
 * fetch) - NO real external websites, NO network access.
 *
 * Covers: URL validation + pre-network skip lists, <article>/<main>/<p>/
 * whole-doc extraction, whitespace + entity normalization, boilerplate removal
 * (tags + curated class/id tokens, including the no-loose-substring guards),
 * the 30-word minimum, maxBytes/fetchBytes error taxonomy (success, non-HTML,
 * empty, HTTP error, timeout, network, oversize), content safety (never
 * overwrite), cache deduplication, concurrency upper bound and the
 * extractArticles() batch contract.
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert");

const Core = require("../js/shared.js");
const EX = require("../scripts/pipeline/extract.js");
const { fetchBytes, FeedError } = require("../scripts/pipeline/http.js");

const NOW = Date.UTC(2026, 8, 2, 7, 0, 0);

/* Recognizable filler of exactly `n` words. */
function words(n, prefix) {
  const p = prefix || "w";
  return Array.from({ length: n }, (_, i) => p + i).join(" ");
}

/* A normalized canonical Story (mirrors the real pipeline up to extraction). */
function makeStory(title, link, opts = {}) {
  const source = Object.assign(
    { id: "demo", name: "Demo", category: "media", reliability: 6, priority: 100, weight: 3, color: "#666" },
    opts.source || {}
  );
  const s = Core.normalizeItem(
    { title: title || "T", link, description: opts.description || title || "d" },
    source,
    { nowMs: NOW }
  );
  s.content = opts.content != null ? opts.content : null;
  return s;
}

/* fetchImpl resolving a successful HTML response. */
function okFetch(text, contentType) {
  return async () => ({ text, contentType: contentType != null ? contentType : "text/html" });
}

/* An article page (>= 30 words in <article>) with all boilerplate kinds. */
const FULL_ARTICLE_HTML =
  "<html><head><title>Page Title</title></head><body>" +
  "<header><h1>Site Name</h1></header><nav>menu</nav>" +
  '<div class="ads"><p>buy now</p></div>' +
  '<div class="cookie-banner"><p>accept cookies</p></div>' +
  '<div class="related-articles"><p>also read X</p></div>' +
  '<div class="comments"><p>user comment</p></div>' +
  '<div class="share-bar"><p>share me</p></div>' +
  '<div class="sidebar"><p>side news</p></div>' +
  "<form>form junk</form><script>var x=1;</script><style>p{}</style>" +
  "<noscript>enable js</noscript>" +
  '<article class="post-content"><h2>Headline</h2>' +
  `<p class="advanced-model">${words(28, "a")}</p>` +
  `<p class="commentary">${words(4, "c")}</p></article>` +
  "<footer><p>copyright</p></footer></body></html>";

const ARTICLE_30 = `<html><body><article><p>${words(30)}</p></article></body></html>`;
const ARTICLE_29 = `<html><body><article><p>${words(29)}</p></article></body></html>`;

/* ------------------------------------------------------------------ *
 * fetchBytes(): maxBytes / error taxonomy (stubbed global fetch)
 * ------------------------------------------------------------------ */

async function withFetchMock(impl, fn) {
  const orig = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await fn();
  } finally {
    globalThis.fetch = orig;
  }
}

test("fetchBytes: returns text + contentType + status for a successful HTML response", async () => {
  await withFetchMock(
    () => new Response("hello body", { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }),
    async () => {
      const r = await fetchBytes("https://example.com/x", { timeoutMs: 1000 });
      assert.strictEqual(r.text, "hello body");
      assert.ok(r.contentType.indexOf("text/html") === 0);
      assert.strictEqual(r.status, 200);
      assert.ok(typeof r.responseMs === "number");
    }
  );
});

test("fetchBytes: empty response body -> FeedError type 'empty'", async () => {
  await withFetchMock(
    () => new Response("   ", { status: 200 }),
    async () => {
      await assert.rejects(fetchBytes("https://example.com/x", { timeoutMs: 1000 }), (e) => e instanceof FeedError && e.type === "empty");
    }
  );
});

test("fetchBytes: non-2xx HTTP response -> FeedError type 'http' (403/404/429/5xx all non-ok)", async () => {
  for (const status of [403, 404, 429, 500, 503]) {
    await withFetchMock(
      () => new Response("nope", { status }),
      async () => {
        await assert.rejects(
          fetchBytes("https://example.com/x", { timeoutMs: 1000 }),
          (e) => e instanceof FeedError && e.type === "http" && String(e.message).indexOf(String(status)) !== -1
        );
      }
    );
  }
});

test("fetchBytes: network failure -> FeedError type 'network'", async () => {
  await withFetchMock(
    () => { throw new Error("connect ECONNREFUSED"); },
    async () => {
      await assert.rejects(fetchBytes("https://example.com/x", { timeoutMs: 1000 }), (e) => e instanceof FeedError && e.type === "network");
    }
  );
});

test("fetchBytes: timeout (AbortController) -> FeedError type 'timeout'", async () => {
  await withFetchMock(
    (url, init) =>
      new Promise((resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        });
      }),
    async () => {
      await assert.rejects(fetchBytes("https://example.com/x", { timeoutMs: 40 }), (e) => e instanceof FeedError && e.type === "timeout");
    }
  );
});

test("fetchBytes: response exceeding maxBytes is rejected WHILE reading -> FeedError 'http'", async () => {
  const big = "a".repeat(20 * 1024);
  await withFetchMock(
    () => new Response(big, { status: 200, headers: { "content-type": "text/html" } }),
    async () => {
      await assert.rejects(
        fetchBytes("https://example.com/x", { timeoutMs: 2000, maxBytes: 1024 }),
        (e) => e instanceof FeedError && e.type === "http" && String(e.message).indexOf("exceeded") !== -1
      );
    }
  );
});

test("fetchBytes: bodies under maxBytes are returned whole", async () => {
  const body = words(40); // well under any cap
  await withFetchMock(
    () => new Response(body, { status: 200, headers: { "content-type": "text/plain" } }),
    async () => {
      const r = await fetchBytes("https://example.com/x", { timeoutMs: 1000, maxBytes: 1024 });
      assert.strictEqual(r.text, body);
    }
  );
});

/* ------------------------------------------------------------------ *
 * extractArticle(): URL validation + pre-network skips
 * ------------------------------------------------------------------ */

test("extractArticle: null/empty/non-string inputs -> null without any fetch", async () => {
  let called = false;
  const impl = async () => { called = true; throw new Error("must not be called"); };
  for (const bad of [null, undefined, "", "   ", 123, {}]) {
    assert.strictEqual(await EX.extractArticle(bad, { fetchImpl: impl }), null, String(bad));
  }
  assert.strictEqual(called, false);
});

test("extractArticle: unparseable / non-http(s) URL -> null without any fetch", async () => {
  let called = false;
  const impl = async () => { called = true; throw new Error("must not be called"); };
  for (const bad of ["not-a-url", "mailto:x@y.z", "ftp://example.com/a", "javascript:void(0)", "//no.scheme", "https://"]) {
    assert.strictEqual(await EX.extractArticle(bad, { fetchImpl: impl }), null, bad);
  }
  assert.strictEqual(called, false);
});

test("extractArticle: obvious non-article hosts are skipped BEFORE any network request", async () => {
  let called = 0;
  const impl = async () => { called++; return { text: ARTICLE_30, contentType: "text/html" }; };
  const urls = [
    "https://www.youtube.com/watch?v=abc", "https://youtu.be/abc",
    "https://x.com/elon/status/1", "https://twitter.com/x/status/1", "https://t.co/xyz",
    "https://www.facebook.com/123", "https://instagram.com/p/1", "https://reddit.com/r/ai/comments/1",
    "https://www.tiktok.com/@x/video/1", "https://mastodon.social/@user/1",
  ];
  for (const u of urls) {
    assert.strictEqual(await EX.extractArticle(u, { fetchImpl: impl }), null, u);
  }
  assert.strictEqual(called, 0, "no network request for skipped hosts");
});

test("extractArticle: media/binary path suffixes are skipped before fetch", async () => {
  let called = 0;
  const impl = async () => { called++; return { text: ARTICLE_30, contentType: "text/html" }; };
  for (const u of [
    "https://example.com/report.pdf", "https://example.com/vid.mp4", "https://example.com/a.zip",
    "https://example.com/img.png", "https://example.com/b.jpg", "https://example.com/feed.xml",
    "https://example.com/style.css", "https://example.com/data.json",
  ]) {
    assert.strictEqual(await EX.extractArticle(u, { fetchImpl: impl }), null, u);
  }
  assert.strictEqual(called, 0);
});

test("extractArticle: defaults pass a 12s timeout and 500KB maxBytes to the fetcher", async () => {
  let seen = null;
  const impl = async (url, opts) => { seen = opts; return { text: ARTICLE_30, contentType: "text/html" }; };
  await EX.extractArticle("https://example.com/a", { fetchImpl: impl });
  assert.strictEqual(seen.timeoutMs, 12000);
  assert.strictEqual(seen.maxBytes, 500 * 1024);
});

test("extractArticle: caller can override timeoutMs and maxBytes", async () => {
  let seen = null;
  const impl = async (url, opts) => { seen = opts; return { text: ARTICLE_30, contentType: "text/html" }; };
  await EX.extractArticle("https://example.com/a", { fetchImpl: impl, timeoutMs: 1000, maxBytes: 2048 });
  assert.strictEqual(seen.timeoutMs, 1000);
  assert.strictEqual(seen.maxBytes, 2048);
});

/* ------------------------------------------------------------------ *
 * extractArticle(): HTML/content extraction
 * ------------------------------------------------------------------ */

test("extractArticle: prefers <article> and returns its text only", async () => {
  const copy = FULL_ARTICLE_HTML;
  const r = await EX.extractArticle("https://example.com/full", { fetchImpl: okFetch(copy) });
  assert.ok(r !== null);
  assert.ok(r.indexOf("a0") !== -1, "article paragraph kept (a0 is the first article word)");
  assert.ok(r.indexOf("c0") !== -1, "commentary paragraph kept (c0 is the first of its words)");
  assert.ok(r.indexOf("Headline") !== -1);
  assert.strictEqual(r.indexOf("Site Name"), -1, "no <header> content");
  assert.strictEqual(r.indexOf("menu"), -1, "no <nav> content");
  assert.strictEqual(r.indexOf("Page Title"), -1, "no <head>/<title> content");
});

test("extractArticle: falls back to <main> when no <article> exists", async () => {
  const html = `<html><body><main><p>${words(30)}</p></main></body></html>`;
  const r = await EX.extractArticle("https://example.com/main", { fetchImpl: okFetch(html) });
  assert.ok(r !== null);
  assert.ok(r.indexOf("w0") !== -1, "main text kept (w0 is the first main word)");
  assert.ok(EX.wordCount(r) >= 30);
});

test("extractArticle: falls back to the <p> cluster when neither <article> nor <main> exist", async () => {
  const html = `<html><body><div><p>${words(10, "x")}</p><p>${words(10, "y")}</p><p>${words(10, "z")}</p></div></body></html>`;
  const r = await EX.extractArticle("https://example.com/pcl", { fetchImpl: okFetch(html) });
  assert.ok(r !== null);
  assert.ok(EX.wordCount(r) >= 30);
  assert.ok(r.indexOf("x0") !== -1 && r.indexOf("z9") !== -1, "cluster joins all paragraphs in order");
});

test("extractArticle: falls back to the whole document when no tags are present", async () => {
  const html = `<html><head><title>LEAK</title></head><body><div id="post">${words(30)}</div></body></html>`;
  const r = await EX.extractArticle("https://example.com/no-p", { fetchImpl: okFetch(html) });
  assert.ok(r !== null);
  assert.ok(EX.wordCount(r) >= 30);
  assert.strictEqual(r.indexOf("LEAK"), -1, "head/title must not leak into extracted text");
});

test("extractArticle: a short <article> falls through to <main> / cluster", async () => {
  const html = `<article><p>${words(12)}</p></article><main><p>${words(30)}</p></main>`;
  const r = await EX.extractArticle("https://example.com/short", { fetchImpl: okFetch(html) });
  assert.ok(r !== null);
  assert.ok(EX.wordCount(r) >= 30, "main text must win when the article is too short");
});

test("extractArticle: whitespace is collapsed to single spaces", async () => {
  const html = `<article><p>one   two\n\nthree\tfour</p><p>five\nsix</p><p>${words(24, "n")}</p></article>`;
  const r = await EX.extractArticle("https://example.com/ws", { fetchImpl: okFetch(html) });
  assert.ok(r !== null);
  assert.strictEqual(r.indexOf("  "), -1, "no double spaces");
  assert.strictEqual(r.indexOf("\t"), -1);
  assert.strictEqual(r.indexOf("\n"), -1);
  assert.ok(r.indexOf("one two three four five six") !== -1);
});

test("extractArticle: HTML entities are decoded", async () => {
  const html = `<article><p>&quot;Quoted&quot; &amp; A&amp;B &lt;tag&gt; &#39;apos&#39; ${words(24, "t")} &mdash; done.</p></article>`;
  const r = await EX.extractArticle("https://example.com/ent", { fetchImpl: okFetch(html) });
  assert.ok(r !== null);
  assert.ok(r.indexOf('"Quoted"') !== -1, "&quot; decoded");
  assert.ok(r.indexOf("A&B") !== -1, "&amp; decoded");
  assert.ok(r.indexOf("<tag>") !== -1, "&lt;/&gt; decoded");
  assert.ok(r.indexOf("'apos'") !== -1, "&#39; decoded");
});

test("extractArticle: malformed HTML degrades without crashing", async () => {
  const broken = `<html><body><article><p>${words(30)}<span>no close</article></p>`;
  const r = await EX.extractArticle("https://example.com/broken", { fetchImpl: okFetch(broken) });
  // Either the article region survives (books >= 30 words) or we return null -
  // the point is that it must never throw into the pipeline.
  assert.ok(r === null || EX.wordCount(r) >= 30);

  const stray = `<article><p>${words(30)} is 3 < 4 > ok</p></article>`;
  const r2 = await EX.extractArticle("https://example.com/stray", { fetchImpl: okFetch(stray) });
  assert.ok(typeof r2 === "string" && r2.length > 0);
});

/* ------------------------------------------------------------------ *
 * Boilerplate removal
 * ------------------------------------------------------------------ */

test("boilerplate: structural tags are removed (script/style/nav/header/footer/form/noscript/aside)", async () => {
  const html =
    "<script>var x=1;</script><style>p{}</style><noscript>enable js</noscript>" +
    "<nav>menu</nav><header>Site Name</header><footer>copyright</footer>" +
    "<form>form junk</form><aside>side news</aside>" +
    `<article><p>${words(30)}</p></article>`;
  const r = await EX.extractArticle("https://example.com/tags", { fetchImpl: okFetch(html) });
  assert.ok(r !== null);
  for (const junk of ["var x", "menu", "Site Name", "copyright", "form junk", "enable js", "side news"]) {
    assert.strictEqual(r.indexOf(junk), -1, "must not contain: " + junk);
  }
});

test("boilerplate: curated class/id patterns are removed (ads/cookie/related/comment/share/sidebar)", async () => {
  const html =
    '<div class="ads">buy now</div><div id="cookie-banner">accept cookies</div>' +
    '<div class="related-articles">also read X</div><div id="comments">user comment</div>' +
    '<div class="share-bar">share me</div><div class="sidebar">side news</div>' +
    '<div class="sponsored">sponsored</div><div class="newsletter">sign up</div>' +
    `<article><p>${words(30)}</p></article>`;
  const r = await EX.extractArticle("https://example.com/classes", { fetchImpl: okFetch(html) });
  assert.ok(r !== null);
  for (const junk of ["buy now", "accept cookies", "also read", "user comment", "share me", "side news", "sponsored", "sign up"]) {
    assert.strictEqual(r.indexOf(junk), -1, "must not contain: " + junk);
  }
});

test("boilerplate: whole-token matching - no unsafe substring false positives", async () => {
  assert.strictEqual(EX.isBoilerplateToken("ad"), true);
  assert.strictEqual(EX.isBoilerplateToken("advanced"), false, "'ad' must not match 'advanced'");
  assert.strictEqual(EX.isBoilerplateToken("comment"), true);
  assert.strictEqual(EX.isBoilerplateToken("commentary"), false, "'comment' must not match 'commentary'");
  assert.strictEqual(EX.isBoilerplateToken("social"), true);
  assert.strictEqual(EX.isBoilerplateToken("socialism"), false);
  assert.strictEqual(EX.isBoilerplateToken("share"), true);
  assert.strictEqual(EX.isBoilerplateToken("shareholder"), false);
  // delimited variants still match (bounded, not loose)
  assert.strictEqual(EX.isBoilerplateToken("ad-container"), true);
  assert.strictEqual(EX.isBoilerplateToken("cookie_banner"), true);
});

test("boilerplate: legitimate article text with ad/comment-adjacent class names is preserved", async () => {
  const html = `<article><p class="advanced-model commentary">the ${words(30)}</p></article>`;
  const r = await EX.extractArticle("https://example.com/legit", { fetchImpl: okFetch(html) });
  assert.ok(r !== null);
  assert.ok(r.indexOf("the") !== -1, "legitimate content is not stripped");
  assert.ok(EX.wordCount(r) >= 30);
});

/* ------------------------------------------------------------------ *
 * Minimum content threshold
 * ------------------------------------------------------------------ */

test("extractArticle: below 30 words after extraction -> null", async () => {
  assert.strictEqual(await EX.extractArticle("https://example.com/29", { fetchImpl: okFetch(ARTICLE_29) }), null);
});

test("extractArticle: at/above 30 words after extraction -> accepted", async () => {
  const r = await EX.extractArticle("https://example.com/30", { fetchImpl: okFetch(ARTICLE_30) });
  assert.ok(r !== null);
  assert.ok(EX.wordCount(r) >= 30);
});

test("extractArticle: threshold applies AFTER boilerplate removal (junk alone is not enough)", async () => {
  const html = `<article><p>${words(5)}</p></article><div class="related-articles">${words(40)}</div>`;
  const r = await EX.extractArticle("https://example.com/rel-heavy", { fetchImpl: okFetch(html) });
  // The heavy text lives in a removed boilerplate block, so the article yields < 30 words.
  assert.strictEqual(r, null);
});

/* ------------------------------------------------------------------ *
 * extractArticle(): error safety (never throws, always null)
 * ------------------------------------------------------------------ */

test("extractArticle: every fetch failure -> null, never rejects", async () => {
  const cases = [
    () => { throw new Error("boom"); },
    () => { throw new FeedError("http", "HTTP 500"); },
    () => { throw new FeedError("timeout", "Timeout after 12000ms"); },
    () => { throw new FeedError("network", "ECONNREFUSED"); },
    () => { throw new FeedError("empty", "Empty response body"); },
    () => null,
    () => ({}),
    () => ({ text: "   " , contentType: "text/html" }),
    () => ({ text: ARTICLE_30, contentType: "application/json" }),
    () => ({ text: ARTICLE_30, contentType: "image/png" }),
    () => ({ text: ARTICLE_30, contentType: "application/pdf" }),
  ];
  for (const impl of cases) {
    assert.strictEqual(await EX.extractArticle("https://example.com/x", { fetchImpl: impl }), null);
  }
});

test("extractArticle: absent content-type header is tolerated (lenient accept)", async () => {
  const impl = async () => ({ text: ARTICLE_30, contentType: undefined });
  const r = await EX.extractArticle("https://example.com/noct", { fetchImpl: impl });
  assert.ok(r !== null);
});

test("extractArticle: unparseable HTML still degrades to null, never throws", async () => {
  const evil = "<" + "x".repeat(6000) + ">" + "<///*>";
  const r = await EX.extractArticle("https://example.com/evil", { fetchImpl: okFetch(evil) });
  assert.strictEqual(r, null);
});

/* ------------------------------------------------------------------ *
 * extractArticles(): batch behavior + content safety + cache
 * ------------------------------------------------------------------ */

test("extractArticles: populates null/empty content only, preserves non-empty content", async () => {
  const s1 = makeStory("A", "https://example.com/a", {});            // null content
  const s2 = makeStory("B", "https://example.com/b", { content: "" }); // empty content
  const s3 = makeStory("C", "https://example.com/c", { content: "  custom keep  " }); // existing
  s3.content = "  custom keep  ";
  const res = await EX.extractArticles([s1, s2, s3], { fetchImpl: okFetch(ARTICLE_30) });
  assert.strictEqual(res.items[0], s1);
  assert.ok(typeof s1.content === "string" && s1.content.length > 0, "null content populated");
  assert.ok(typeof s2.content === "string" && s2.content.length > 0, "empty content populated");
  assert.strictEqual(s3.content, "  custom keep  ", "existing non-empty content never overwritten");
  assert.strictEqual(res.stats.extracted, 2);
  assert.strictEqual(res.stats.skipped, 1);
});

test("extractArticles: failed extraction leaves content null/unchanged", async () => {
  const s1 = makeStory("A", "https://example.com/fail1");
  const s2 = makeStory("B", "https://example.com/fail2", { content: "keep me" });
  s2.content = "keep me"; // pre-existing content must survive a failing batch
  const impl = async () => { throw new Error("boom"); };
  const res = await EX.extractArticles([s1, s2], { fetchImpl: impl });
  assert.strictEqual(s1.content, null, "failed extraction leaves null content");
  assert.strictEqual(s2.content, "keep me", "failed extraction never touches existing content");
  assert.strictEqual(res.stats.failed, 1, "only the attempted story failed");
  assert.strictEqual(res.stats.skipped, 1, "existing content is skipped, not refetched");
  assert.strictEqual(res.stats.extracted, 0);
});

test("extractArticles: identical canonical URLs are fetched exactly once and content reused", async () => {
  let calls = 0;
  const impl = async (u) => { calls++; return { text: ARTICLE_30, contentType: "text/html" }; };
  // Same article via two tracking-variant links -> identical canonicalUrl -> one fetch.
  const a = makeStory("A", "https://example.com/s1?utm_source=x");
  const b = makeStory("B", "https://example.com/s1?utm_source=y");
  assert.strictEqual(a.canonicalUrl, b.canonicalUrl, "precondition: same canonical URL");
  const res = await EX.extractArticles([a, b], { fetchImpl: impl });
  assert.strictEqual(calls, 1, "only one network fetch for the shared URL");
  assert.strictEqual(res.stats.fetched, 1);
  assert.strictEqual(res.stats.cached, 1);
  assert.strictEqual(b.content, a.content, "duplicate stories reuse the same extracted content");
});

test("extractArticles: cached null (failed fetch) is reused, not refetched", async () => {
  let calls = 0;
  const impl = async () => { calls++; throw new Error("boom"); };
  const a = makeStory("A", "https://example.com/x");
  const b = makeStory("B", "https://example.com/x");
  await EX.extractArticles([a, b], { fetchImpl: impl });
  assert.strictEqual(calls, 1, "two duplicates of a failing URL fetch once");
  assert.strictEqual(a.content, null);
  assert.strictEqual(b.content, null);
});

test("extractArticles: skipped non-article URLs make no fetch and leave content null", async () => {
  let calls = 0;
  const impl = async () => { calls++; return { text: ARTICLE_30, contentType: "text/html" }; };
  const s = makeStory("Tw", "https://twitter.com/x/status/1");
  const res = await EX.extractArticles([s], { fetchImpl: impl });
  assert.strictEqual(calls, 0, "non-article host must not reach the fetcher");
  assert.strictEqual(s.content, null);
  assert.strictEqual(res.stats.failed, 1, "no-result extraction counts as failed, content stays null");
});

test("extractArticles: stories without a usable URL are left untouched", async () => {
  const s = { content: null }; // no url fields at all
  const res = await EX.extractArticles([s], { fetchImpl: okFetch(ARTICLE_30) });
  assert.strictEqual(s.content, null);
  assert.strictEqual(res.stats.attempted, 0);
  assert.strictEqual(res.stats.total, 1);
});

test("extractArticles: mixed batch - successes, failures, skips and duplicates", async () => {
  const s1 = makeStory("A", "https://example.com/ok");
  const s2 = makeStory("B", "https://example.com/ok");          // duplicate
  const s3 = makeStory("C", "https://example.com/fail");        // failure
  const s4 = makeStory("D", "https://twitter.com/x/status/1");  // skipped host
  let calls = 0;
  const impl = async (u) => {
    calls++;
    if (u.indexOf("fail") !== -1) throw new Error("boom");
    return { text: ARTICLE_30, contentType: "text/html" };
  };
  const res = await EX.extractArticles([s1, s2, s3, s4], { fetchImpl: impl });
  assert.ok(typeof s1.content === "string" && s1.content === s2.content, "duplicates share content");
  assert.strictEqual(s3.content, null);
  assert.strictEqual(s4.content, null);
  assert.strictEqual(res.stats.extracted, 2, "both duplicate stories carry the extracted text");
  assert.strictEqual(res.stats.failed, 2, "the failing + the skipped story");
  /* fetched = unique URLs resolved through fetchBytes (includes pre-network
     skipped hosts, which resolve as null): ok(1) + fail(1) + twitter(1). */
  assert.strictEqual(res.stats.fetched, 3);
  assert.strictEqual(res.stats.cached, 1);
  assert.strictEqual(calls, 2, "network fetches: ok + fail (twitter never reaches the fetcher)");
});

/* ------------------------------------------------------------------ *
 * Concurrency bound
 * ------------------------------------------------------------------ */

test("extractArticles: concurrency never exceeds the configured upper bound", async () => {
  const stories = Array.from({ length: 8 }, (_, i) => makeStory("S" + i, "https://example.com/c" + i));
  let active = 0;
  let maxActive = 0;
  let done = 0;
  const impl = async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 15));
    active--;
    done++;
    return { text: ARTICLE_30, contentType: "text/html" };
  };
  const res = await EX.extractArticles(stories, { fetchImpl: impl, concurrency: 3 });
  assert.ok(maxActive <= 3, "max concurrent fetches " + maxActive + " must be <= 3");
  assert.ok(maxActive >= 2, "expected some parallelism, saw " + maxActive);
  assert.strictEqual(done, 8);
  assert.strictEqual(res.items, stories);
  assert.ok(stories.every((s) => typeof s.content === "string"));
});

test("extractArticles: default concurrency bound is 4", async () => {
  assert.strictEqual(EX.DEFAULT_CONCURRENCY, 4);
  const stories = Array.from({ length: 10 }, (_, i) => makeStory("S" + i, "https://example.com/d" + i));
  let active = 0;
  let maxActive = 0;
  const impl = async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 20));
    active--;
    return { text: ARTICLE_30, contentType: "text/html" };
  };
  await EX.extractArticles(stories, { fetchImpl: impl });
  assert.ok(maxActive <= 4, "default concurrency must cap at 4, saw " + maxActive);
});

/* ------------------------------------------------------------------ *
 * Pure helpers (internal contracts used by the stages above)
 * ------------------------------------------------------------------ */

test("helpers: canonicalCacheKey normalizes www/case/slash/trailing + drops hash, keeps query", () => {
  assert.strictEqual(EX.canonicalCacheKey("https://www.Example.com/a/"), "example.com/a");
  assert.strictEqual(EX.canonicalCacheKey("https://example.com/a/b/c"), "example.com/a/b/c");
  assert.strictEqual(EX.canonicalCacheKey("https://example.com/a#frag"), "example.com/a");
  assert.strictEqual(EX.canonicalCacheKey("https://example.com/search?q=1"), "example.com/search?q=1");
  assert.strictEqual(EX.canonicalCacheKey("not a url"), null);
  assert.strictEqual(EX.canonicalCacheKey(""), null);
});

test("helpers: different article paths never collide on the cache key", () => {
  const a = EX.canonicalCacheKey("https://example.com/news/one");
  const b = EX.canonicalCacheKey("https://example.com/news/two");
  const c = EX.canonicalCacheKey("https://example.com/other/one");
  assert.notStrictEqual(a, b);
  assert.notStrictEqual(a, c);
});

test("helpers: wordCount counts space-delimited tokens only", () => {
  assert.strictEqual(EX.wordCount(""), 0);
  assert.strictEqual(EX.wordCount("   "), 0);
  assert.strictEqual(EX.wordCount("a b c"), 3);
  assert.strictEqual(EX.wordCount("a  b\n\tc"), 3);
});