/*
 * AI RADAR - Aggregator (browser)
 * Fetches RSS feeds, parses to generic items and normalizes them through the
 * SAME shared Core.enrichItem used by the Node pipeline (stable Stage-1 ids,
 * identical output in every environment). Source definitions are loaded from
 * the canonical sources/sources.json instead of a hardcoded array.
 * Pure helpers (extractText, categorize, …) live in shared.js.
 */
(function () {
  "use strict";

  const Core = window.AIRadarCore;
  const {
    extractText,
    extractFirstImage,
    parseDate,
    computeScore,
    dedupe,
    canonicalKey,
    buildStoryId,
    validateSourceConfig,
    applySourceDefaults,
    enrichItem,
  } = Core;

  /* ---------------- Source configuration (canonical) ---------------- */

  let sourceCache = null;
  let sourceCacheLoaded = false;

  async function ensureSources() {
    if (sourceCacheLoaded) return sourceCache;
    sourceCacheLoaded = true;
    try {
      const raw = await fetchWithTimeout(SOURCES_PATH, 6000);
      const data = JSON.parse(raw);
      const arr = Array.isArray(data) ? data : data.sources;
      sourceCache = (Array.isArray(arr) ? arr : [])
        .filter((s) => validateSourceConfig(s).valid)
        .map(applySourceDefaults)
        .filter((s) => s.enabled);
    } catch (e) {
      sourceCache = [];
    }
    return sourceCache;
  }

  function getSources() {
    return sourceCacheLoaded ? sourceCache : null;
  }

  /* ---------------- Fetch helpers ---------------- */

  function fetchWithTimeout(url, ms) {
    const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = ctrl
      ? setTimeout(function () {
          ctrl.abort();
        }, ms)
      : null;
    return fetch(url, ctrl ? { signal: ctrl.signal } : {})
      .then((res) => {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.text();
      })
      .finally(function () {
        if (timer) clearTimeout(timer);
      });
  }

  async function fetchFeedViaStrategies(sourceUrl) {
    let lastErr = null;
    for (let i = 0; i < PROXY_STRATEGIES.length; i++) {
      const strat = PROXY_STRATEGIES[i];
      try {
        const text = await fetchWithTimeout(strat.build(sourceUrl), FETCH_TIMEOUT_MS);
        if (text && text.length > 200) return text;
        throw new Error("Empty response");
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error("All fetch strategies failed for " + sourceUrl);
  }

  /* ---------------- Parsing helpers ---------------- */

  /* Parse an RSS/Atom XML string into generic items. */
  function parseXmlFeed(xmlText) {
    const doc = new DOMParser().parseFromString(xmlText, "text/xml");
    if (doc.querySelector("parsererror")) {
      throw new Error("Invalid XML");
    }

    const items = [];
    const xmlItems = doc.querySelectorAll("item, entry");
    xmlItems.forEach(function (el) {
      const get = (sel) => {
        let n = null;
        if (sel.indexOf(":") !== -1) {
          // Namespaced tags (content:encoded, dc:date, …) sometimes fail with
          // CSS selectors, so match them by qualified name instead.
          const list = el.getElementsByTagName(sel);
          n = list && list.length ? list[0] : null;
        } else {
          n = el.querySelector(sel);
        }
        return n ? (n.textContent || "").trim() : "";
      };

      let title = get("title");
      let link = get("link");
      // Atom style link (href attribute)
      const atomLink = el.querySelector("link[href]");
      if (!link && atomLink) link = atomLink.getAttribute("href") || "";

      let pubDate =
        get("pubDate") || get("published") || get("updated") || get("dc:date");
      const body =
        get("content:encoded") || get("description") || get("summary") || "";
      const description = extractText(body);
      const image =
        extractFirstImage(get("content:encoded") || get("description")) ||
        (function () {
          const enc =
            el.getElementsByTagName("media:content")[0] ||
            el.getElementsByTagName("media:thumbnail")[0] ||
            el.getElementsByTagName("enclosure")[0];
          if (enc && enc.getAttribute) return enc.getAttribute("url");
          return null;
        })();

      items.push({ title, link, pubDate, description, image });
    });
    return items;
  }

  /* Parse rss2json JSON response into the same item shape. */
  function parseRss2Json(html) {
    let data;
    try {
      data = JSON.parse(html);
    } catch (e) {
      throw new Error("Not rss2json JSON");
    }
    if (!data || !Array.isArray(data.items)) return [];
    return data.items
      .map((it) => ({
        title: (it.title || "").trim(),
        link: it.link || "",
        pubDate: it.pubDate || "",
        description: extractText(it.description || ""),
        image: (function () {
          if (it.thumbnail) return it.thumbnail;
          const body = it.description || "";
          const img = body.match(/<img[^>]+src=["']([^"']+)["']/i);
          return img ? img[1] : null;
        })(),
      }))
      .filter((it) => it.title && it.link);
  }

  /* ---------------- Normalization (shared, stable ids) ---------------- */

  function restoreDates(items) {
    return items.map((it) => ({
      ...it,
      date: it.date ? new Date(it.date) : null,
    }));
  }

  /* ---------------- Dispatcher: fetch + parse + normalize ---------------- */

  async function loadSource(source) {
    try {
      const raw = await fetchFeedViaStrategies(source.url);
      let items;
      try {
        items = parseRss2Json(raw);
        if (items.length === 0) throw new Error("empty");
      } catch (e) {
        items = parseXmlFeed(raw);
      }
      const nowMs = Date.now();
      return items.map((rawIt, i) => enrichItem(rawIt, source, i, nowMs));
    } catch (e) {
      console.warn("Failed to load source " + source.name, e);
      return [];
    }
  }

  /* Run async tasks with limited concurrency (feeds throttle on bursts). */
  function mapLimit(arr, limit, fn) {
    const results = new Array(arr.length);
    let cursor = 0;
    const workers = Array.from({ length: Math.min(limit, arr.length) }, async () => {
      while (cursor < arr.length) {
        const i = cursor++;
        results[i] = await fn(arr[i], i);
      }
    });
    return Promise.all(workers).then(() => results);
  }

  async function loadSourceWithRetry(source) {
    let items = await loadSource(source);
    if (items.length === 0 || !items.some((i) => i.title)) {
      await new Promise((r) => setTimeout(r, 800));
      items = await loadSource(source);
    }
    return items;
  }

  /* ---------------- Snapshot (pre-aggregated by scripts/build-news.js) ---------------- */

  async function trySnapshot() {
    try {
      const raw = await fetchWithTimeout(SNAPSHOT_PATH, 6000);
      const data = JSON.parse(raw);
      if (data && Array.isArray(data.items) && data.items.length) {
        return {
          items: restoreDates(data.items),
          fetchedAt: data.generatedAt || Date.now(),
          mode: "snapshot",
        };
      }
    } catch (e) {
      /* snapshot not available - fall through to live aggregation */
    }
    return null;
  }

  /* ---------------- Cache ---------------- */

  function readCache() {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (e) {
      return null;
    }
  }

  function writeCache(items) {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ fetchedAt: Date.now(), items }));
    } catch (e) {
      /* ignore quota errors */
    }
  }

  /* ---------------- Public API ---------------- */

  async function aggregate({ force = false } = {}) {
    // Parallel: canonical sources + committed snapshot.
    const [snap] = await Promise.all([trySnapshot(), ensureSources()]);
    if (snap) return snap;

    // 2) Fall back to live aggregation with a short cache window.
    const cache = readCache();
    if (!force && cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
      const items = restoreDates(cache.items);
      return { items, fromCache: true, fetchedAt: cache.fetchedAt, mode: "cache" };
    }

    // 3) Live mode must never hang the UI: bound it so the site can always
    //    fall back to the sample/error state instead of spinning forever.
    const LIVE_TIMEOUT_MS = 45000;
    return withTimeout(aggregateLive(force), LIVE_TIMEOUT_MS);
  }

  /* Resolve with whatever the promise yields within ms, else an empty result.
   * The caller decides what to do with an empty set (sample fallback). */
  function withTimeout(promise, ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ items: [], mode: "timeout" }), ms);
      promise.then(resolve, resolve).finally(() => clearTimeout(timer));
    });
  }

  async function aggregateLive(force) {
    const sources = getSources() || [];
    if (sources.length === 0) return { items: [], fromCache: false, fetchedAt: Date.now(), mode: "live" };
    const perSource = await mapLimit(sources, 3, loadSourceWithRetry);
    const merged = dedupe(perSource.flat());
    merged.sort(
      (a, b) =>
        (b.score || 0) - (a.score || 0) ||
        (b.date ? +b.date : 0) - (a.date ? +a.date : 0)
    );

    const items = restoreDates(merged);
    if (!force) writeCache(items);
    return { items, fromCache: false, fetchedAt: Date.now(), mode: "live" };
  }

  function filterByRange(items, range, now) {
    now = now || new Date();
    if (range === "week") {
      return items.filter((it) => {
        if (!it.date) return false;
        return now.getTime() - it.date.getTime() <= 7 * 86400000;
      });
    }
    if (range === "yesterday") {
      const d = new Date(now);
      d.setDate(d.getDate() - 1);
      return items.filter((it) => it.date && Core.isSameDay(it.date, d));
    }
    // "today"
    return items.filter((it) => it.date && Core.isSameDay(it.date, now));
  }

  function statsFor(items, now) {
    now = now || new Date();
    const today = items.filter((it) => it.date && Core.isSameDay(it.date, now));
    return { total: items.length, today: today.length };
  }

  window.AIRadar = {
    aggregate,
    filterByRange,
    statsFor,
    ensureSources,
    getSources,
  };
})();