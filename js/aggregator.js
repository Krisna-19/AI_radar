/*
 * AI RADAR - Aggregator
 * Fetches RSS feeds, parses to items, dedupes, categorises and caches.
 */
(function () {
  "use strict";

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

  function extractText(html) {
    if (!html) return "";
    return html
      .replace(/<\s*script[\s\S]*?<\s*\/\s*script\s*>/gi, " ")
      .replace(/<\s*style[\s\S]*?<\s*\/\s*style\s*>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"')
      .replace(/&#0?39;/gi, "'")
      .replace(/\s+/g, " ")
      .trim();
  }

  function extractFirstImage(html) {
    if (!html) return null;
    const m = html.match(/<img[^>]+src=["']([^"']+)["']/i);
    return m ? m[1] : null;
  }

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
    // rss2json returns JSON; when re-encoded by allorigins it may come back as text.
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
          const m = it.thumbnail || "";
          if (m) return m;
          const body = it.description || "";
          const img = body.match(/<img[^>]+src=["']([^"']+)["']/i);
          return img ? img[1] : null;
        })(),
      }))
      .filter((it) => it.title && it.link);
  }

  /* ---------------- Normalisation & categorising ---------------- */

  function normalizeTitle(t) {
    return (t || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function categorize(item) {
    const hay = (item.title + " " + item.description).toLowerCase();
    const has = (words) =>
      words.some((w) => hay.includes(w));

    if (
      has([
        "arxiv",
        "paper",
        "research",
        "study",
        "benchmark",
        "model card",
        "preprint",
        "nature",
      ])
    )
      return "research";
    if (
      has([
        "raise",
        "raises",
        "funding",
        "funded",
        "valuation",
        "acqui",
        "investment",
        "million",
        "billion",
        "ipo",
        "series a",
        "series b",
        "series c",
        "startup",
      ])
    )
      return "funding";
    if (
      has([
        "safety",
        "regulation",
        "regulatory",
        "policy",
        "government",
        "law",
        "lawmaker",
        "ai act",
        "legislat",
        "ban",
        "transparency",
        "ethics",
      ])
    )
      return "policy";
    if (
      has([
        "launch",
        "release",
        "releases",
        "announce",
        "introduces",
        "unveils",
        "rollout",
        "upgrade",
        "chatgpt",
        "gpt-",
        "claude",
        "gemini",
        "llama",
        "microsoft",
        "google",
        "openai",
        "anthropic",
        "tool",
        "app",
      ])
    )
      return "product";
    return "news";
  }

  function parseDate(str) {
    if (!str) return null;
    try {
      const d = new Date(str);
      return isNaN(d.getTime()) ? null : d;
    } catch (e) {
      return null;
    }
  }

  /* ---------------- Dispatcher: fetch + parse ---------------- */

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
      return items.map((it, i) => {
        const date = parseDate(it.pubDate);
        return {
          id: source.id + "-" + i,
          sourceId: source.id,
          sourceName: source.name,
          sourceType: source.type,
          sourceColor: source.color,
          sourceWeight: source.weight,
          title: it.title || "Untitled",
          link: it.link || "#",
          date,
          dateLabel: date ? date.toISOString() : "",
          description: it.description || "",
          image: it.image || null,
          category: categorize(it),
          score: computeScore(source, date, i),
        };
      });
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

  function computeScore(source, date, index) {
    let recency = 0;
    if (date) {
      const hours = Math.max(0, (Date.now() - date.getTime()) / 3600000);
      recency = Math.exp(-hours / 30); // decay over ~30h
    } else {
      recency = Math.max(0, 0.2 - index * 0.02);
    }
    return recency * source.weight;
  }

  /* ---------------- Cache ---------------- */

  function readCache() {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      const data = JSON.parse(raw);
      return data;
    } catch (e) {
      return null;
    }
  }

  function writeCache(items) {
    try {
      localStorage.setItem(
        CACHE_KEY,
        JSON.stringify({ fetchedAt: Date.now(), items })
      );
    } catch (e) {
      /* ignore quota errors */
    }
  }

  /* ---------------- Public API ---------------- */

  async function aggregate({ force = false } = {}) {
    const cache = readCache();
    if (!force && cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
      return { items: cache.items, fromCache: true, fetchedAt: cache.fetchedAt };
    }

    const perSource = await mapLimit(AI_SOURCES, 3, loadSourceWithRetry);
    const merged = dedupe(perSource.flat());
    merged.sort((a, b) =>
      (b.score || 0) - (a.score || 0) ||
      (b.date ? b.date.getTime() : 0) - (a.date ? a.date.getTime() : 0)
    );

    writeCache(merged);
    return { items: merged, fromCache: false, fetchedAt: Date.now() };
  }

  function dedupe(items) {
    const seen = new Set();
    const out = [];
    for (const it of items) {
      const key = normalizeTitle(it.title);
      if (!key) continue;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(it);
    }
    return out;
  }

  function isSameDay(d, ref) {
    return (
      d.getFullYear() === ref.getFullYear() &&
      d.getMonth() === ref.getMonth() &&
      d.getDate() === ref.getDate()
    );
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
      return items.filter((it) => it.date && isSameDay(it.date, d));
    }
    // "today"
    return items.filter((it) => it.date && isSameDay(it.date, now));
  }

  function statsFor(items, now) {
    now = now || new Date();
    const today = items.filter((it) => it.date && isSameDay(it.date, now));
    return {
      total: items.length,
      today: today.length,
    };
  }

  window.AIRadar = {
    aggregate,
    filterByRange,
    statsFor,
    aiSources: AI_SOURCES,
  };
})();