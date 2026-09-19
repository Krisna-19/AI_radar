/*
 * AI RADAR - Stage 5.5: article content extraction (Node).
 *
 * Purpose
 *   Fetch the linked article for a staged canonical Story and return its plain
 *   text (boilerplate stripped). Designed to run AFTER Stage 4 clustering and
 *   BEFORE classification/scoring, but is NOT wired into build-news.js yet.
 *
 *   extractArticle(url, opts)   one URL  -> string|null
 *   extractArticles(stories)    a batch  -> { items, stats }
 *
 * Design guarantees
 *   - ZERO DEPS: HTML is cleaned/extracted with a small hand-rolled scanner
 *     (no cheerio / jsdom).
 *   - FAIL-SAFE: never throws into the pipeline; every failure returns null.
 *   - SKIPS BEFORE NETWORK: obvious non-article hosts/paths (YouTube, Twitter/X,
 *     social media, media binaries) are filtered before any request.
 *   - SOURCE GATING: extractArticles() accepts an allowedSourceIds allowlist;
 *     stories whose source.id is not allowlisted are NEVER extracted (no fetch,
 *     content stays null, counted in stats.disabled). With no allowlist passed,
 *     every source is allowed (backward-compatible standalone behavior).
 *   - PER-HOST CONCURRENCY: at most DEFAULT_HOST_CONCURRENCY (2) simultaneous
 *     fetches per article host, layered UNDER the global pool bound.
 *   - 429 RETRY: HTTP 429 responses are retried with exponential backoff
 *     (500ms -> 1s -> 2s) for up to DEFAULT_MAX_RETRIES (3) retries
 *     (4 total HTTP requests); any other failure returns immediately.
 *   - BYTE/HTML BOUNDS: default 12s timeout and 500KB read cap via
 *     http.fetchBytes() (step-1 approved); only HTML/plain-text bodies accepted.
 *   - BOILERPLATE STRIPPING: structural tags (script/style/nav/header/footer/
 *     form/noscript/... ) plus a curated, bounded set of class/id tokens for
 *     ads, cookie banners, related articles, comments, social sharing and
 *     sidebars. Matching is WHOLE-TOKEN only (exact, "token-", "token_", or a
 *     capitalised camelCase boundary) - never a loose substring, so legitimate
 *     article content is never at risk (e.g. "comment" never matches
 *     "commentary", "ad" never matches "advanced").
 *   - CONTENT PRIORITY: <article> -> <main> -> paragraph cluster -> whole doc.
 *   - 30-WORD MINIMUM applied AFTER removal + extraction; below that => null.
 *
 * Pipeline slot (roadmap 8.extract.js):
 *   ... clusterStories (S4) -> extract (S5.5) -> classify -> score -> store
 */

"use strict";

const { fetchBytes, FeedError } = require("./http.js");

const DEFAULT_TIMEOUT_MS = 12000;
const DEFAULT_MAX_BYTES = 500 * 1024;
const DEFAULT_CONCURRENCY = 4;
/* Keep the global extraction pool at 4 (never higher). */
const DEFAULT_HOST_CONCURRENCY = 2;
/* HTTP 429 retry policy: exponential backoff 500ms -> 1s -> 2s, with at most
 * 3 retries (so a single article URL can be fetched up to 4 times). */
const DEFAULT_MAX_RETRIES = 3;
const RETRY_BACKOFF_MS = [500, 1000, 2000];
const MIN_WORDS = 30;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ------------------------------------------------------------------ *
 * Pre-network URL filtering (obvious non-articles)
 * ------------------------------------------------------------------ */

/* Social / video / short-link hosts. Matched either exactly or as a
 * subdomain suffix (www.youtube.com, m.twitter.com, ...). */
const SKIP_HOSTS = [
  "youtube.com", "youtu.be", "music.youtube.com",
  "twitter.com", "x.com", "t.co",
  "facebook.com", "instagram.com", "threads.net",
  "reddit.com", "tiktok.com", "snapchat.com", "pinterest.com",
  "linkedin.com", "twitch.tv", "vimeo.com", "dailymotion.com",
  "vk.com", "ok.ru", "tumblr.com", "mastodon.social",
];

/* Media / binary path suffixes -> never article HTML. */
const SKIP_PATH_SUFFIX_RE =
  /\.(pdf|mp3|mp4|m4a|m4v|mov|avi|zip|tar|gz|rar|7z|png|jpe?g|gif|webp|avif|svg|ico|css|js|json|xml|rss)$/i;

/* Obvious non-article check, applied BEFORE any network request. */
function shouldSkipUrl(u) {
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  for (const h of SKIP_HOSTS) {
    if (host === h || host.endsWith("." + h)) return true;
  }
  if (SKIP_PATH_SUFFIX_RE.test(u.pathname)) return true;
  return false;
}

/* ------------------------------------------------------------------ *
 * Boilerplate removal (tag names + curated class/id tokens)
 * ------------------------------------------------------------------ */

/* Structural tags that never carry article prose. */
const BANNED_TAGS = new Set([
  "script", "style", "noscript", "nav", "header", "footer", "form",
  "head", "title", "meta", "link", "iframe", "embed", "object", "svg", "aside",
]);

const VOID_TAGS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta",
  "param", "source", "track", "wbr",
]);

/* Exact whole-token boilerplate class/id markers. A class token is only
 * treated as boilerplate when it EQUALS one of these, starts with
 * "<token>-" / "<token>_", or starts with the token followed by an uppercase
 * letter (camelCase, e.g. "shareBar"). No loose substring matching. */
const BOILERPLATE_TOKENS = [
  /* ads / sponsorship */
  "ad", "ads", "advert", "adverts", "advertisement", "advertising",
  "adzone", "adslot", "bannerad", "sponsored", "sponsor",
  /* cookies / consent banners */
  "cookie", "cookies", "cookiebanner", "consent", "gdpr", "privacynotice",
  /* related / recommendations / popular */
  "related", "recommended", "recommendations", "readmore", "morefrom",
  "youmayalso", "youmightalso", "popular", "trending", "mostread",
  "mustread", "outbrain", "taboola", "widget",
  /* comments */
  "comment", "comments", "disqus", "commentcount",
  /* social sharing */
  "social", "share", "sharing", "addthis", "sharethis", "sharebar",
  "sharebuttons", "sharelinks", "socialshare", "socialsharing", "sociallinks",
  "twitterwidget", "facebookwidget",
  /* sidebars / scaffolding */
  "sidebar", "sidebox", "newsletter", "signup", "subscribe", "promo",
  "breadcrumb", "pagination", "authorbio", "skip",
];

function isBoilerplateToken(token) {
  if (!token) return false;
  const t = String(token);
  for (const b of BOILERPLATE_TOKENS) {
    if (b.length > t.length) continue;
    if (t === b) return true;
    if (t.startsWith(b + "-") || t.startsWith(b + "_")) return true;
    if (t.startsWith(b) && t.length > b.length && /[A-Z]/.test(t.charAt(b.length))) {
      return true; // camelCase boundary, e.g. "shareBar", "relatedArticles"
    }
  }
  return false;
}

const ATTR_VALUE_RE = /("[^"]*"|'[^']*'|[^\s>]+)/;

/* Does this start-tag's class/id mark it as boilerplate? */
function attrIsBoilerplate(attrs) {
  const cls = new RegExp("(?:^|\\s)class\\s*=\\s*" + ATTR_VALUE_RE.source, "i").exec(attrs);
  const id = new RegExp("(?:^|\\s)id\\s*=\\s*" + ATTR_VALUE_RE.source, "i").exec(attrs);
  for (const m of [cls, id]) {
    if (!m || !m[1]) continue;
    const value = m[1].replace(/^["']|["']$/g, "");
    for (const token of value.split(/[\s]+/)) {
      if (isBoilerplateToken(token)) return true;
    }
  }
  return false;
}

/* Rebuild the HTML with boilerplate subtrees removed. Kept markup is passed
 * through verbatim (open tag at its open position, close tag at its close
 * position) so <article>/<main>/<p> regions can be scanned afterwards. Uses a
 * small balanced-tag scanner (no dependency, no loose substring rules). */
function cleanHtml(html) {
  const out = [];
  const stack = []; // { name, close, removed }
  let removed = 0;  // depth of an enclosing removed subtree
  let i = 0;
  const n = html.length;

  const emitText = (s) => {
    if (s && removed === 0) out.push(s);
  };

  while (i < n) {
    const lt = html.indexOf("<", i);
    if (lt === -1) {
      emitText(html.slice(i));
      break;
    }
    if (lt > i) emitText(html.slice(i, lt));

    const gt = html.indexOf(">", lt + 1);
    if (gt === -1) {
      emitText(html.slice(lt));
      break;
    }
    const raw = html.slice(lt, gt + 1);
    const inner = html.slice(lt + 1, gt);
    i = gt + 1;

    if (/^\s*!--/.test(inner) || /^\s*!/.test(inner) || /^\s*\?/.test(inner)) {
      continue; // comment / doctype / processing instruction
    }

    const close = /^\s*\/\s*([a-zA-Z][\w:-]*)/.exec(inner);
    if (close) {
      const name = close[1].toLowerCase();
      while (stack.length) {
        const top = stack.pop();
        if (top.removed) {
          removed = Math.max(0, removed - 1);
        } else if (removed === 0) {
          out.push(top.close);
        }
        if (top.name === name) break;
      }
      continue;
    }

    const open = /^\s*([a-zA-Z][\w:-]*)([\s\S]*)$/.exec(inner);
    if (!open) {
      emitText(raw);
      continue;
    }
    const name = open[1].toLowerCase();
    const attrs = open[2] || "";
    const selfClosing = /\/\s*$/.test(attrs) || VOID_TAGS.has(name);
    const isBanned = BANNED_TAGS.has(name);
    const doRemove = removed > 0 || isBanned || (!isBanned && attrIsBoilerplate(attrs));

    if (selfClosing) {
      if (removed === 0 && !doRemove) out.push(raw);
      continue;
    }
    const keep = removed === 0 && !doRemove;
    stack.push({ name, close: "</" + name + ">", removed: !keep });
    if (keep) out.push(raw);
    if (removed > 0 || doRemove) removed++;
  }

  /* Flush unclosed kept elements: their open tags were already emitted. */
  while (stack.length) {
    const top = stack.pop();
    if (top.removed) {
      removed = Math.max(0, removed - 1);
    } else if (removed === 0) {
      out.push(top.close);
    }
  }
  return out.join("");
}

/* ------------------------------------------------------------------ *
 * Region extraction (balanced-tag scanner)
 * ------------------------------------------------------------------ */

/* Find every <tag ...> ... </tag> region and return { start, end, text }
 * for each. Nested same-name tags are balanced in the returned HTML text. */
function scanRegions(html, tag) {
  const re = new RegExp("<" + tag + "[\\s>/]", "gi");
  const out = [];
  let m;
  while ((m = re.exec(html))) {
    const start = m.index;
    const openEnd = html.indexOf(">", start);
    if (openEnd === -1) continue;
    const attrsTail = html.slice(start + m[0].length, openEnd);
    if (/\/\s*$/.test(attrsTail)) continue; // self-closing -> no region

    const end = matchToClose(html, openEnd + 1, tag);
    if (end === -1) continue;
    const text = html.slice(start, end);
    out.push({ start, end, text });
  }
  return out;
}

/* Given a tag already opened at html[from-1 ..], return the index just past
 * its matching close tag (tracking nested same-name opens). -1 if unclosed. */
function matchToClose(html, from, tag) {
  let depth = 1;
  let i = from;
  const n = html.length;
  while (i < n) {
    const lt = html.indexOf("<", i);
    if (lt === -1) return -1;
    const gt = html.indexOf(">", lt + 1);
    if (gt === -1) return -1;
    const inner = html.slice(lt + 1, gt);
    i = gt + 1;
    if (/^\s*!--/.test(inner) || /^\s*!/.test(inner) || /^\s*\?/.test(inner)) continue;

    const closeRe = /^\s*\/\s*([a-zA-Z][\w:-]*)/;
    const close = closeRe.exec(inner);
    if (close) {
      if (close[1].toLowerCase() === tag) {
        depth--;
        if (depth === 0) return i;
      }
      continue;
    }
    const openRe = /^\s*([a-zA-Z][\w:-]*)/;
    const open = openRe.exec(inner);
    if (open && open[1].toLowerCase() === tag) {
      const after = inner.slice(open[0].length);
      if (!/\/\s*$/.test(after)) depth++;
    }
  }
  return -1;
}

/* The highest-scoring region for `tag` by cleaned word count. */
function bestRegion(html, tag) {
  let best = null;
  let bestScore = -1;
  for (const r of scanRegions(html, tag)) {
    const score = wordCount(textFrom(r.text));
    if (score > bestScore) {
      bestScore = score;
      best = r;
    }
  }
  return best;
}

/* ------------------------------------------------------------------ *
 * Text conversion
 * ------------------------------------------------------------------ */

function wordCount(text) {
  if (!text) return 0;
  return String(text).trim().split(/\s+/).filter(Boolean).length;
}

function safeCodePoint(n) {
  try {
    return String.fromCodePoint(n);
  } catch (e) {
    return "";
  }
}

function decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeCodePoint(parseInt(d, 10)))
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&hellip;/gi, "\u2026")
    .replace(/&mdash;/gi, "\u2014")
    .replace(/&ndash;/gi, "\u2013")
    .replace(/&copy;/gi, "\u00a9")
    .replace(/&reg;/gi, "\u00ae")
    .replace(/&trade;/gi, "\u2122")
    .replace(/&rsquo;/gi, "\u2019")
    .replace(/&lsquo;/gi, "\u2018")
    .replace(/&ldquo;/gi, "\u201c")
    .replace(/&rdquo;/gi, "\u201d");
}

/* Strip tags (each tag -> a space, so `ten.</p><p>Beta` never merges into one
 * token) and collapse whitespace to a clean single-space string. */
function textFrom(html) {
  const noTags = String(html).replace(/<[^>]*>/g, " ");
  return decodeEntities(noTags).replace(/\s+/g, " ").trim();
}

/* Paragraph-cluster fallback: join all <p> blocks in document order; if the
 * page has no <p> tags, fall back to the whole (cleaned) document text. */
function paragraphClusterText(html) {
  const paras = scanRegions(html, "p");
  if (paras.length) {
    const parts = paras.map((r) => textFrom(r.text)).filter(Boolean);
    if (parts.length) return parts.join(" ");
  }
  return textFrom(html);
}

/* Accept only HTML-ish or plain-text response bodies. */
function acceptsContentType(contentType) {
  if (!contentType) return true; // absent header -> allowed
  const s = String(contentType).toLowerCase();
  return s.indexOf("html") !== -1 || s.indexOf("text/") === 0;
}

/* ------------------------------------------------------------------ *
 * Cache key (canonicalized URL) + fetch
 * ------------------------------------------------------------------ */

/* Deterministic in-memory cache key for a URL: www-normalized + lowercased
 * host, collapsed pathname, trailing slash dropped, query kept, hash dropped. */
function canonicalCacheKey(url) {
  if (typeof url !== "string" || !url.trim()) return null;
  try {
    const u = new URL(url.trim());
    u.hash = "";
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    let path = u.pathname.replace(/\/+/g, "/");
    if (path.length > 1) path = path.replace(/\/$/, "");
    return host + path.toLowerCase() + u.search;
  } catch (e) {
    return null;
  }
}

/* Fetch + extract a single article URL. Returns plain text or null. NEVER
 * throws: every failure path (bad URL, skip, timeout, http, network, empty,
 * non-HTML, unparseable, under the 30-word minimum) degrades to null.
 *
 * HTTP 429 is retried with exponential backoff (default 500ms -> 1s -> 2s)
 * for up to DEFAULT_MAX_RETRIES retries; after the last retry a 429 is treated
 * like any other failure (null). All other failures return immediately.
 *
 * opts:
 *   fetchImpl, timeoutMs, maxBytes         (as before)
 *   maxRetries      number of 429 retries (default 3)
 *   retryBackoffMs  per-retry delays       (default [500, 1000, 2000])
 *   diag            optional collector { requests, byStatus, byType, retries }
 *                   incremented for diagnostics/reporting (never affects the
 *                   returned value). Events: one `requests` per HTTP attempt,
 *                   `byStatus[code]` per HTTP status seen (2xx + http errors),
 *                   `byType[type]` for timeout/network/empty failures, and one
 *                   `retries` per 429 backoff wait performed.
 */
async function extractArticle(url, opts = {}) {
  if (!url || typeof url !== "string") return null;
  const trimmed = url.trim();
  if (!trimmed) return null;

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch (e) {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (shouldSkipUrl(parsed)) return null;

  const fetchImpl = opts.fetchImpl || fetchBytes;
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes || DEFAULT_MAX_BYTES;
  const backoff = Array.isArray(opts.retryBackoffMs) ? opts.retryBackoffMs : RETRY_BACKOFF_MS;
  const maxRetries =
    Number.isInteger(opts.maxRetries) && opts.maxRetries >= 0
      ? opts.maxRetries
      : DEFAULT_MAX_RETRIES;
  const diag = opts.diag;

  /* Attempt 0 is the first request; each 429 extends us one retry. */
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (diag) {
      diag.requests = (diag.requests || 0) + 1;
    }
    let resp;
    try {
      resp = await fetchImpl(trimmed, { timeoutMs, maxBytes });
    } catch (e) {
      const status = e && e.status;
      if (diag) {
        if (status != null) {
          diag.byStatus[status] = (diag.byStatus[status] || 0) + 1;
        } else {
          const type = (e && e.type) || "network";
          diag.byType[type] = (diag.byType[type] || 0) + 1;
        }
      }
      if (status === 429 && attempt < maxRetries) {
        const delay = backoff[Math.min(attempt, backoff.length - 1)];
        if (diag) diag.retries = (diag.retries || 0) + 1;
        await sleep(delay > 0 ? delay : RETRY_BACKOFF_MS[0]);
        continue;
      }
      return null; // non-429 failure, or the last 429 attempt -> give up
    }
    if (!resp || typeof resp.text !== "string" || !resp.text.trim()) return null;
    if (!acceptsContentType(resp.contentType)) return null;
    if (diag) {
      diag.byStatus[resp.status || 200] = (diag.byStatus[resp.status || 200] || 0) + 1;
    }

    try {
      const cleaned = cleanHtml(resp.text);

      /* 1. <article> (primary) */
      let text = null;
      const art = bestRegion(cleaned, "article");
      if (art) text = textFrom(art.text);

      /* 2. <main> */
      if (!text || wordCount(text) < MIN_WORDS) {
        const main = bestRegion(cleaned, "main");
        if (main) {
          const t = textFrom(main.text);
          if (t && wordCount(t) >= MIN_WORDS) text = t;
        }
      }

      /* 3. paragraph cluster */
      if (!text || wordCount(text) < MIN_WORDS) {
        const cluster = paragraphClusterText(cleaned);
        if (cluster && wordCount(cluster) >= MIN_WORDS) text = cluster;
      }

      if (!text || wordCount(text) < MIN_WORDS) return null;
      return text;
    } catch (e) {
      return null; // parse/extraction failure never breaks the pipeline
    }
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Batch extraction (per-source gating + per-host pool + run cache)
 * ------------------------------------------------------------------ */

/* Smallest article host for the per-host concurrency gate (www normalized,
 * lowercased; "" for unparseable URLs - treated as its own gate bucket). */
function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch (e) {
    return "";
  }
}

/* Process an array of canonical Stories. Fetches a given URL only once per
 * call (Map keyed by canonicalCacheKey). Populates story.content ONLY when
 * currently null/empty; an existing non-empty content is never overwritten;
 * a failure leaves content unchanged/null.
 *
 * opts:
 *   allowedSourceIds  allowlist of source ids eligible for article fetching.
 *                     stories whose story.source.id is NOT in it are skipped
 *                     without a fetch (stats.disabled) and keep content null.
 *                     null/undefined = allow every source (standalone default).
 *   concurrency       global pool upper bound (default 4 - never raised).
 *   hostConcurrency   per-host pool bound (default 2).
 *   maxRetries        HTTP 429 retries (default 3, see extractArticle()).
 *   retryBackoffMs    per-retry delays (default [500, 1000, 2000]).
 *   fetchImpl etc.    forwarded to extractArticle().
 *
 * Returns { items, stats } where stats adds, beyond the legacy counters:
 *   disabled, requests, retries, byStatus, byType, wordsTotal, avgWords,
 *   perSource { [sourceId]: { total, extracted, failed, skipped, disabled,
 *   fetched, cached, requests, retries, words, byStatus, byType } }.
 */
async function extractArticles(stories, opts = {}) {
  const input = Array.isArray(stories) ? stories : [];
  const concurrency = Math.max(1, opts.concurrency || DEFAULT_CONCURRENCY);
  const hostConcurrency = Math.max(1, opts.hostConcurrency || DEFAULT_HOST_CONCURRENCY);
  const allowed = opts.allowedSourceIds != null ? new Set(opts.allowedSourceIds) : null;
  const cache = new Map(); // canonicalCacheKey -> string | null (this run only)
  const inflight = new Map(); // canonicalCacheKey -> Promise<string|null>
  /* Shared resolver: any number of stories with the same key await the SAME
   * fetch (used result is cached once and reused; cached null = failed once).
   * rec is the per-source diagnostics record the triggering story belongs to. */
  const resolve = (key, url, rec) => {
    if (cache.has(key)) {
      stats.cached++;
      if (rec) rec.cached++;
    } else if (inflight.has(key)) {
      stats.cached++;
      if (rec) rec.cached++;
    } else {
      stats.fetched++;
      if (rec) rec.fetched++;
      const p = extractArticle(url, Object.assign({}, opts, { diag: rec }))
        .then((result) => {
          cache.set(key, result);
          inflight.delete(key);
          return result;
        })
        .catch(() => {
          cache.set(key, null);
          inflight.delete(key);
          return null;
        });
      inflight.set(key, p);
      return p;
    }
    return inflight.has(key) ? inflight.get(key) : Promise.resolve(cache.get(key));
  };

  /* Per-host semaphore: at most `hostConcurrency` fetches in flight for the
   * same host across all workers. Slots hand off directly to waiters so a
   * released slot never needs a second bookkeeping pass. */
  const hostSlots = new Map(); // host -> free slots
  const hostWaiters = new Map(); // host -> array of resolvers
  const acquireHost = async (host) => {
    if (!hostSlots.has(host)) hostSlots.set(host, hostConcurrency);
    const free = hostSlots.get(host);
    if (free > 0) {
      hostSlots.set(host, free - 1);
      return;
    }
    await new Promise((resolve) => {
      const q = hostWaiters.get(host) || [];
      q.push(resolve);
      hostWaiters.set(host, q);
    });
  };
  const releaseHost = (host) => {
    const q = hostWaiters.get(host);
    if (q && q.length > 0) q.shift()();
    else hostSlots.set(host, (hostSlots.get(host) || 0) + 1);
  };

  const perSource = new Map(); // sourceId -> diagnostics/stats record
  const ps = (id) => {
    if (!perSource.has(id)) {
      perSource.set(id, {
        total: 0,
        extracted: 0,
        failed: 0,
        skipped: 0,
        disabled: 0,
        fetched: 0,
        cached: 0,
        requests: 0,
        retries: 0,
        words: 0,
        byStatus: {},
        byType: {},
      });
    }
    return perSource.get(id);
  };

  const tasks = input.map((story) => {
    const existing = story && typeof story.content === "string" ? story.content.trim() : "";
    const url =
      story && typeof story === "object"
        ? story.publisherUrl || story.canonicalUrl || story.originalUrl || story.link || null
        : null;
    return {
      story,
      url: typeof url === "string" && url.trim() ? url.trim() : null,
      key: typeof url === "string" && url.trim() ? canonicalCacheKey(url) : null,
      skip: existing.length > 0,
    };
  });

  const stats = {
    total: tasks.length,
    attempted: 0,
    fetched: 0,
    cached: 0,
    extracted: 0,
    failed: 0,
    skipped: 0,
    disabled: 0,
    requests: 0,
    retries: 0,
    wordsTotal: 0,
    avgWords: 0,
    byStatus: {},
    byType: {},
    concurrency,
    hostConcurrency,
  };

  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, tasks.length || 1) },
    async () => {
      while (cursor < tasks.length) {
        const t = tasks[cursor++];
        const srcId = t.story && t.story.source && t.story.source.id;
        const rec = srcId ? ps(srcId) : null;
        if (t.skip) {
          stats.skipped++;
          if (rec) rec.skipped++;
          continue; // never overwrite an existing non-empty story.content
        }
        if (!t.url || !t.story) continue; // no usable URL -> leave unchanged
        if (allowed && !allowed.has(srcId)) {
          stats.disabled++;
          if (rec) rec.disabled++;
          continue; // source not eligible for article fetching -> never fetch
        }

        stats.attempted++;
        if (rec) rec.total++;
        const host = hostOf(t.url);
        await acquireHost(host);
        try {
          let result;
          if (t.key != null) {
            result = await resolve(t.key, t.url, rec);
          } else {
            stats.fetched++;
            if (rec) rec.fetched++;
            result = await extractArticle(t.url, Object.assign({}, opts, { diag: rec }));
          }
          if (result) {
            stats.extracted++;
            stats.wordsTotal += wordCount(result);
            if (rec) {
              rec.extracted++;
              rec.words += wordCount(result);
            }
            t.story.content = result;
          } else {
            stats.failed++;
            if (rec) rec.failed++;
            /* leave story.content unchanged/null */
          }
        } finally {
          releaseHost(host);
        }
      }
    }
  );
  await Promise.all(workers);

  /* Fold per-source diagnostics into the aggregate + perSource map. */
  const perSourceObj = {};
  for (const [id, rec] of perSource) {
    perSourceObj[id] = rec;
    stats.requests += rec.requests;
    stats.retries += rec.retries;
    for (const [s, c] of Object.entries(rec.byStatus)) {
      stats.byStatus[s] = (stats.byStatus[s] || 0) + c;
    }
    for (const [s, c] of Object.entries(rec.byType)) {
      stats.byType[s] = (stats.byType[s] || 0) + c;
    }
  }
  stats.perSource = perSourceObj;
  stats.avgWords = stats.extracted ? Math.round(stats.wordsTotal / stats.extracted) : 0;

  return { items: input, stats };
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_BYTES,
  DEFAULT_CONCURRENCY,
  DEFAULT_HOST_CONCURRENCY,
  DEFAULT_MAX_RETRIES,
  RETRY_BACKOFF_MS,
  MIN_WORDS,
  SKIP_HOSTS,
  BANNED_TAGS,
  BOILERPLATE_TOKENS,
  shouldSkipUrl,
  isBoilerplateToken,
  attrIsBoilerplate,
  cleanHtml,
  scanRegions,
  matchToClose,
  bestRegion,
  wordCount,
  decodeEntities,
  textFrom,
  paragraphClusterText,
  acceptsContentType,
  canonicalCacheKey,
  hostOf,
  extractArticle,
  extractArticles,
};