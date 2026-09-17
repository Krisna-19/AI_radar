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

const { fetchBytes } = require("./http.js");

const DEFAULT_TIMEOUT_MS = 12000;
const DEFAULT_MAX_BYTES = 500 * 1024;
const DEFAULT_CONCURRENCY = 4;
const MIN_WORDS = 30;

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
 * non-HTML, unparseable, under the 30-word minimum) degrades to null. */
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

  let resp;
  try {
    resp = await fetchImpl(trimmed, { timeoutMs, maxBytes });
  } catch (e) {
    return null; // timeout / http / network / empty / too large -> null
  }
  if (!resp || typeof resp.text !== "string" || !resp.text.trim()) return null;
  if (!acceptsContentType(resp.contentType)) return null;

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

/* ------------------------------------------------------------------ *
 * Batch extraction (concurrency + per-run dedup cache)
 * ------------------------------------------------------------------ */

/* Process an array of canonical Stories. Fetches a given URL only once per
 * call (Map keyed by canonicalCacheKey). Populates story.content ONLY when
 * currently null/empty; an existing non-empty content is never overwritten;
 * a failure leaves content unchanged/null. Returns { items, stats }. */
async function extractArticles(stories, opts = {}) {
  const input = Array.isArray(stories) ? stories : [];
  const concurrency = Math.max(1, opts.concurrency || DEFAULT_CONCURRENCY);
  const cache = new Map(); // canonicalCacheKey -> string | null (this run only)
  const inflight = new Map(); // canonicalCacheKey -> Promise<string|null>
  /* Shared resolver: any number of stories with the same key await the SAME
   * fetch (used result is cached once and reused; cached null = failed once). */
  const resolve = (key, url) => {
    if (cache.has(key)) stats.cached++;
    else if (inflight.has(key)) stats.cached++;
    else {
      stats.fetched++;
      const p = extractArticle(url, opts)
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

  const tasks = input.map((story) => {
    const existing = story && typeof story.content === "string" ? story.content.trim() : "";
    const url =
      story && typeof story === "object"
        ? story.canonicalUrl || story.originalUrl || story.link || null
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
    concurrency,
  };

  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, tasks.length || 1) },
    async () => {
      while (cursor < tasks.length) {
        const t = tasks[cursor++];
        if (t.skip) {
          stats.skipped++;
          continue; // never overwrite an existing non-empty story.content
        }
        if (!t.url || !t.story) continue; // no usable URL -> leave unchanged

        stats.attempted++;
        let result;
        if (t.key != null) {
          result = await resolve(t.key, t.url);
        } else {
          result = await extractArticle(t.url, opts);
          stats.fetched++;
        }
        if (result) {
          stats.extracted++;
          t.story.content = result;
        } else {
          stats.failed++;
          /* leave story.content unchanged/null */
        }
      }
    }
  );
  await Promise.all(workers);

  return { items: input, stats };
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_BYTES,
  DEFAULT_CONCURRENCY,
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
  extractArticle,
  extractArticles,
};