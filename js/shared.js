/*
 * AI RADAR - shared pure helpers.
 * Loaded both in the browser (window.AIRadarCore) and in Node build scripts
 * (module.exports) so aggregation behaves identically everywhere.
 */
(function (root) {
  "use strict";

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

  function parseDate(str) {
    if (!str) return null;
    try {
      const d = new Date(str);
      return isNaN(d.getTime()) ? null : d;
    } catch (e) {
      return null;
    }
  }

  function normalizeTitle(t) {
    return (t || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  /*
   * Stage 12 identity hardening helpers.
   *
   * Some feeds (notably Google News) append the reporting publisher to the
   * headline as a trailing suffix ("… - Reuters", "… | The Washington Post",
   * "… - cnbc.com"). Because a story's stable id/fingerprint are derived from
   * the NORMALISED TITLE, one article reported by two aggregator copies can
   * end up with two different identities ("… - Nature" vs "… - nature.com"),
   * which splits one story across the archive and the radar pages.
   *
   * The fix is deliberately CONSERVATIVE and DETERMINISTIC:
   *   - A trailing section is removed ONLY when it exactly (case-insensitively,
   *     word-normalised) matches a name or site host of a KNOWN, curated
   *     publisher in PUBLISHER_ALIASES. No fuzzy publisher guessing, ever.
   *   - If there is no exact alias match the original title is preserved
   *     verbatim (prefers false negatives, so two unrelated stories can never
   *     collapse merely because their titles are similar).
   *   - Identity stays cleanTitle | canonicalUrl (host + first 2 path
   *     segments), so two different articles on the same site keep different
   *     ids even after any suffix strip.
   */

  /* A trailing section is any text after ONE separator character
   * (- – — | · :) surrounded by optional whitespace. Doubled separators
   * (" - - ") are tolerated. The head text before it is captured greedily so
   * the RIGHTMOST separator is the split point. */
  const TRAILING_ALIAS_RE = /^(.+)[ \t]*[-–—|·:][ \t\-–—|·:]*(.+?)[ \t]*$/;

  /* Curated manifest of known publishers whose title suffixes may be stripped.
   * `name` is the display name; `hosts` are site hosts that also appear as
   * title suffixes. Every entry is a real, identifiable publisher. Seeded from
   * sources/sources.json plus the trailing-title histogram of the archived
   * data/db corpus; extended only by explicit curation (never automatically). */
  const PUBLISHER_ALIASES = [
    /* ---- the 13 configured sources (source of truth: sources/sources.json) ---- */
    { name: "OpenAI", hosts: ["openai.com"] },
    { name: "Google DeepMind", hosts: ["deepmind.google", "deepmind.com"] },
    { name: "Google AI", hosts: ["blog.google"] },
    { name: "Google Research", hosts: ["research.google", "research.google.com"] },
    { name: "Hugging Face", hosts: ["huggingface.co", "huggingface.com"] },
    { name: "arXiv", hosts: ["arxiv.org"] },
    { name: "Nature Mach. Intel.", hosts: ["nature.com"] },
    { name: "Nature", hosts: ["nature.com"] },
    { name: "MIT Tech Review", hosts: ["technologyreview.com"] },
    { name: "MIT Technology Review", hosts: ["technologyreview.com"] },
    { name: "VentureBeat", hosts: ["venturebeat.com"] },
    { name: "The Verge", hosts: ["theverge.com"] },
    { name: "WIRED", hosts: ["wired.com"] },
    { name: "TechCrunch", hosts: ["techcrunch.com"] },
    /* ---- major outlets observed as suffixes in the archived corpus ---- */
    { name: "Yahoo Finance", hosts: ["finance.yahoo.com", "uk.finance.yahoo.com", "ca.finance.yahoo.com"] },
    { name: "Yahoo Finance UK", hosts: ["uk.finance.yahoo.com", "finance.yahoo.com"] },
    { name: "Yahoo News", hosts: ["news.yahoo.com", "ca.news.yahoo.com", "uk.news.yahoo.com"] },
    { name: "Yahoo News Canada", hosts: ["ca.news.yahoo.com"] },
    { name: "The New York Times", hosts: ["nytimes.com"] },
    { name: "NYT", hosts: ["nytimes.com"] },
    { name: "Reuters", hosts: ["reuters.com", "thomsonreuters.com"] },
    { name: "Thomson Reuters", hosts: ["thomsonreuters.com", "reuters.com"] },
    { name: "CNBC", hosts: ["cnbc.com"] },
    { name: "Politico", hosts: ["politico.com"] },
    { name: "The Washington Post", hosts: ["washingtonpost.com"] },
    { name: "Washington Post", hosts: ["washingtonpost.com"] },
    { name: "CBS News", hosts: ["cbsnews.com"] },
    { name: "NBC News", hosts: ["nbcnews.com"] },
    { name: "BBC", hosts: ["bbc.com", "bbc.co.uk"] },
    { name: "ABC News", hosts: ["abcnews.com", "abcnews.go.com"] },
    { name: "CBC", hosts: ["cbc.ca"] },
    { name: "The Guardian", hosts: ["theguardian.com"] },
    { name: "Guardian", hosts: ["theguardian.com"] },
    { name: "PBS", hosts: ["pbs.org"] },
    { name: "The Wall Street Journal", hosts: ["wsj.com"] },
    { name: "Wall Street Journal", hosts: ["wsj.com"] },
    { name: "WSJ", hosts: ["wsj.com"] },
    { name: "Financial Times", hosts: ["ft.com"] },
    { name: "The Economist", hosts: ["economist.com"] },
    { name: "Bloomberg", hosts: ["bloomberg.com"] },
    { name: "Bloomberg.com", hosts: ["bloomberg.com"] },
    { name: "The Atlantic", hosts: ["theatlantic.com"] },
    { name: "The Los Angeles Times", hosts: ["latimes.com"] },
    { name: "Los Angeles Times", hosts: ["latimes.com"] },
    { name: "USA Today", hosts: ["usatoday.com", "usatoday.com"] },
    { name: "The Motley Fool", hosts: ["fool.com"] },
    { name: "Motley Fool", hosts: ["fool.com"] },
    { name: "The Globe and Mail", hosts: ["theglobeandmail.com"] },
    { name: "South China Morning Post", hosts: ["scmp.com"] },
    { name: "SCMP", hosts: ["scmp.com"] },
    { name: "Nikkei Asia", hosts: ["asia.nikkei.com", "nikkei.com"] },
    { name: "Al Jazeera", hosts: ["aljazeera.com"] },
    { name: "The Times of India", hosts: ["timesofindia.com", "timesofindia.indiatimes.com"] },
    { name: "Futurism", hosts: ["futurism.com"] },
    { name: "Gizmodo", hosts: ["gizmodo.com"] },
    { name: "InfoWorld", hosts: ["infoworld.com"] },
    { name: "Computerworld", hosts: ["computerworld.com"] },
    { name: "Network World", hosts: ["networkworld.com"] },
    { name: "The Next Web", hosts: ["thenextweb.com"] },
    { name: "PYMNTS", hosts: ["pymnts.com"] },
    { name: "Radiology Business", hosts: ["radiologybusiness.com"] },
    { name: "Cardiovascular Business", hosts: ["cardiovascularbusiness.com"] },
    { name: "GovTech", hosts: ["govtech.com"] },
    { name: "The Harvard Crimson", hosts: ["thecrimson.com"] },
    { name: "EIN News", hosts: ["einnews.com", "einpresswire.com"] },
    { name: "EIN Presswire", hosts: ["einpresswire.com"] },
    { name: "StartupHub.ai", hosts: ["startuphub.ai"] },
    { name: "EurekAlert", hosts: ["eurekalert.org"] },
    { name: "MIT News", hosts: ["news.mit.edu"] },
    { name: "NIST", hosts: ["nist.gov"] },
    { name: "National Institute of Standards and Technology", hosts: ["nist.gov"] },
    { name: "WBAY", hosts: ["wbay.com"] },
    { name: "MSSP Alert", hosts: ["msspalert.com"] },
    { name: "ExecutiveGov", hosts: ["executivegov.com"] },
    { name: "Wealth Management", hosts: ["wealthmanagement.com"] },
    { name: "McKinsey", hosts: ["mckinsey.com"] },
    { name: "McKinsey & Company", hosts: ["mckinsey.com"] },
    { name: "Tom's Hardware", hosts: ["tomsguidance.com", "tomsfan.com", "tomsguide.com"] },
    { name: "Tom's Hardware", hosts: ["tomsguidance.com"] },
    { name: "Amazon", hosts: ["amazon.com", "aws.amazon.com"] },
    { name: "AWS", hosts: ["aws.amazon.com"] },
    { name: "Amazon Web Services", hosts: ["amazon.com", "aws.amazon.com"] },
    { name: "The Detroit News", hosts: ["detroitnews.com"] },
    { name: "Newsday", hosts: ["newsday.com"] },
    { name: "Cointelegraph", hosts: ["cointelegraph.com"] },
    { name: "Decrypt", hosts: ["decrypt.co"] },
    { name: "The Hacker News", hosts: ["thehackernews.com"] },
    { name: "VentureBeat", hosts: ["venturebeat.com"] },
    { name: "Phys.org", hosts: ["phys.org"] },
    { name: "ScienceDaily", hosts: ["sciencedaily.com"] },
    { name: "News-Medical", hosts: ["news-medical.net"] },
    { name: "CancerNetwork", hosts: ["cancernetwork.com"] },
    { name: "Scientific American", hosts: ["scientificamerican.com"] },
    { name: "New Scientist", hosts: ["newscientist.com"] },
    { name: "WIRED", hosts: ["wired.com"] },
    { name: "Ars Technica", hosts: ["arstechnica.com"] },
    { name: "Engadget", hosts: ["engadget.com"] },
    { name: "The Verge", hosts: ["theverge.com"] },
    { name: "TechCrunch", hosts: ["techcrunch.com"] },
    { name: "Mashable", hosts: ["mashable.com"] },
    { name: "Fast Company", hosts: ["fastcompany.com"] },
    { name: "Fortune", hosts: ["fortune.com"] },
    { name: "Forbes", hosts: ["forbes.com"] },
    { name: "Business Insider", hosts: ["businessinsider.com"] },
    { name: "Barron's", hosts: ["barrons.com"] },
    { name: "MarketWatch", hosts: ["marketwatch.com"] },
    { name: "Yahoo", hosts: ["yahoo.com"] },
    { name: "Silicon Valley Business Journal", hosts: ["bizjournals.com"] },
    { name: "Boston Globe", hosts: ["bostonglobe.com"] },
    { name: "Chicago Tribune", hosts: ["chicagotribune.com"] },
    { name: "Miami Herald", hosts: ["miamiherald.com"] },
    { name: "Dallas Morning News", hosts: ["dallasnews.com"] },
    { name: "Seattle Times", hosts: ["seattletimes.com"] },
    { name: "NPR", hosts: ["npr.org"] },
    { name: "PBS NewsHour", hosts: ["pbs.org"] },
    { name: "AP", hosts: ["apnews.com"] },
    { name: "Associated Press", hosts: ["apnews.com"] },
    { name: "UPI", hosts: ["upi.com"] },
    { name: "HuffPost", hosts: ["huffpost.com"] },
    { name: "The Hill", hosts: ["thehill.com"] },
    { name: "Axios", hosts: ["axios.com"] },
    { name: "Business Insider", hosts: ["businessinsider.com"] },
    { name: "Quartz", hosts: ["qz.com"] },
    { name: "Snopes", hosts: ["snopes.com"] },
    { name: "Ground News", hosts: ["ground.news"] },
    { name: "The Daily Upside", hosts: ["thedailyupside.com"] },
    { name: "The Information", hosts: ["theinformation.com"] },
    { name: "Semafor", hosts: ["semafor.com"] },
    { name: "PopSci", hosts: ["popsci.com"] },
    { name: "Discover Magazine", hosts: ["discovermagazine.com"] },
    { name: "Wired", hosts: ["wired.com"] },
    { name: "The Register", hosts: ["theregister.com"] },
    { name: "Dark Reading", hosts: ["darkreading.com"] },
    { name: "BleepingComputer", hosts: ["bleepingcomputer.com"] },
    { name: "SecurityWeek", hosts: ["securityweek.com"] },
    { name: "SC Media", hosts: ["scmagazine.com"] },
    { name: "Threatpost", hosts: ["threatpost.com"] },
    { name: "CyberScoop", hosts: ["cyberscoop.com"] },
    { name: "Recorded Future", hosts: ["recordedfuture.com"] },
    { name: "Yahoo Finance AU", hosts: ["au.finance.yahoo.com"] },
    { name: "Benzinga", hosts: ["benzinga.com"] },
    { name: "Investopedia", hosts: ["investopedia.com"] },
    { name: "Motley Fool", hosts: ["fool.com"] },
    { name: "Stocktwits", hosts: ["stocktwits.com"] },
    { name: "MarketBeat", hosts: ["marketbeat.com"] },
    { name: "Seeking Alpha", hosts: ["seekingalpha.com"] },
    { name: "TipRanks", hosts: ["tipranks.com"] },
    { name: "Simply Wall St", hosts: ["simplywall.st"] },
    { name: "3G Media", hosts: [] },
  ];

  /* Normalised lookup of every alias (names + hosts) -> canonical display name
   * for the strip rule. Built once. */
  const PUBLISHER_ALIAS_LOOKUP = (function () {
    const map = Object.create(null);
    const add = function (raw) {
      const norm = normalizeTitle(raw);
      if (norm && !map[norm]) map[norm] = true;
    };
    for (const p of PUBLISHER_ALIASES) {
      add(p.name);
      for (const h of p.hosts || []) add(h);
    }
    return map;
  })();

  /* Strip a trailing publisher-alias suffix. Returns { title, publisher } where
   * publisher is the matched canonical name (or null). The title is preserved
   * verbatim whenever no exact alias match is found. Deterministic. */
  function cleanTitleForIdentity(title) {
    let t = String(title == null ? "" : title).trim();
    if (!t) return { title: t, publisher: null };
    let matchedName = null;
    for (let round = 0; round < 3; round++) {
      const m = TRAILING_ALIAS_RE.exec(t);
      if (!m) break;
      const tail = m[2].trim();
      const norm = normalizeTitle(tail);
      if (!norm || norm.length < 2 || !PUBLISHER_ALIAS_LOOKUP[norm]) break;
      let head = m[1].trim();
      /* Doubled separators ("… - - Reuters") leave a dangling separator on the
       * head; drop any residual trailing separator after a successful strip. */
      head = head.replace(/\s*[-–—|·:]+\s*$/g, "").trim();
      if (!head) break;
      t = head;
      if (matchedName === null) matchedName = norm;
    }
    return { title: t, publisher: matchedName };
  }

  function canonicalUrlKey(url) {
    if (!url) return "";
    try {
      const u = new URL(url);
      const host = u.hostname.toLowerCase().replace(/^www\./, "");
      const segs = u.pathname
        .split("/")
        .filter(Boolean)
        .slice(0, 2)
        .map((s) => s.toLowerCase());
      return host + "/" + segs.join("/");
    } catch (e) {
      return "";
    }
  }

  function canonicalKey(title, url) {
    const t = normalizeTitle(title);
    const u = canonicalUrlKey(url);
    return (t + "|" + u).slice(0, 200);
  }

  /* djb2 hash -> 8 hex chars, compact and deterministic. */
  function hashString(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) {
      h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
    }
    return h.toString(16).padStart(8, "0");
  }

  function buildStoryId(title, url) {
    return "s" + hashString(canonicalKey(title, url));
  }

  /* Categorise using the combined title + description text. */
  function categorize(hay) {
    hay = (hay || "").toLowerCase();
    const has = (words) => words.some((w) => hay.includes(w));

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

  function computeScore(weight, date, index) {
    let recency = 0;
    if (date) {
      const hours = Math.max(0, (Date.now() - date.getTime()) / 3600000);
      recency = Math.exp(-hours / 30);
    } else {
      recency = Math.max(0, 0.2 - index * 0.02);
    }
    return recency * weight;
  }

  function dedupe(items) {
    const seen = new Set();
    const out = [];
    for (const it of items) {
      const key = canonicalKey(it.title, it.link) || normalizeTitle(it.title);
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

  /* ---------------- Source configuration ----------------
   * The canonical source definitions live in sources/sources.json.
   * Validation + defaults below are shared by the browser (js/aggregator.js),
   * the Node loader (sources/index.js) and the tests, so every environment
   * accepts exactly the same shape. */

  const SOURCE_CATEGORIES = ["company", "research", "media"];
  const SOURCE_PARSERS = ["rss", "atom", "auto"];
  const DEFAULT_SOURCE_SETTINGS = {
    enabled: true,
    articleFetch: false,
    priority: 100,
    fetchIntervalHours: 3,
    parser: "auto",
    reliability: 5,
    weight: 3,
    color: "#666666",
  };

  function validateSourceConfig(source) {
    const errors = [];
    if (!source || typeof source !== "object") {
      return { valid: false, errors: [{ field: "*", message: "missing source" }] };
    }
    if (
      typeof source.id !== "string" ||
      !/^[a-z0-9][a-z0-9-]*$/.test(source.id)
    ) {
      errors.push({ field: "id", message: "required lowercase slug (a-z, 0-9, -)" });
    }
    if (typeof source.name !== "string" || !source.name.trim()) {
      errors.push({ field: "name", message: "required non-empty string" });
    }
    if (typeof source.url !== "string" || !/^https?:\/\/\S+$/i.test(source.url)) {
      errors.push({ field: "url", message: "required http(s) feed URL" });
    }
    if (!SOURCE_CATEGORIES.includes(source.category)) {
      errors.push({
        field: "category",
        message: "must be one of " + SOURCE_CATEGORIES.join(", "),
      });
    }
    if (source.enabled != null && typeof source.enabled !== "boolean") {
      errors.push({ field: "enabled", message: "must be a boolean" });
    }
    if (source.articleFetch != null && typeof source.articleFetch !== "boolean") {
      errors.push({ field: "articleFetch", message: "must be a boolean" });
    }
    if (
      source.priority != null &&
      (!Number.isFinite(source.priority) || source.priority < 0)
    ) {
      errors.push({ field: "priority", message: "must be a non-negative number" });
    }
    if (
      source.fetchIntervalHours != null &&
      (!Number.isFinite(source.fetchIntervalHours) ||
        source.fetchIntervalHours < 0.5)
    ) {
      errors.push({ field: "fetchIntervalHours", message: "must be >= 0.5 hours" });
    }
    if (source.parser != null && !SOURCE_PARSERS.includes(source.parser)) {
      errors.push({
        field: "parser",
        message: "must be one of " + SOURCE_PARSERS.join(", "),
      });
    }
    if (
      source.reliability != null &&
      (!Number.isFinite(source.reliability) ||
        source.reliability < 0 ||
        source.reliability > 10)
    ) {
      errors.push({ field: "reliability", message: "must be a number 0..10" });
    }
    if (
      source.weight != null &&
      (!Number.isFinite(source.weight) || source.weight < 1 || source.weight > 5)
    ) {
      errors.push({ field: "weight", message: "must be a number 1..5" });
    }
    if (source.color != null && !/^#[0-9a-fA-F]{3,8}$/.test(source.color)) {
      errors.push({ field: "color", message: "must be a hex color (#rgb/#rrggbb)" });
    }
    return { valid: errors.length === 0, errors };
  }

  /* Fill in defaults. Only call after validateSourceConfig() passed. */
  function applySourceDefaults(source) {
    return Object.assign({}, DEFAULT_SOURCE_SETTINGS, source, {
      enabled: source.enabled !== false,
      articleFetch: source.articleFetch === true,
      color: source.color || DEFAULT_SOURCE_SETTINGS.color,
    });
  }

  /* ---------------- Canonical Story (Stage 3) ----------------
   * normalizeItem() is the SINGLE normalization function. Raw parser output
   * (generic {title, link, pubDate, description, image}) becomes a canonical
   * Story conforming to SCHEMA.md (schemaVersion "1.0").
   *
   * The canonical Story carries BOTH:
   *   - the nested canonical fields (source{}, scores{}, publishedAt,
   *     originalUrl/canonicalUrl, entities, ai, …) required by later stages
   *     (dedupe/classify/summarize/store), AND
   *   - the flat legacy compatibility fields (id, title, link, date, score,
   *     sourceId, sourceName, sourceType, sourceColor, sourceWeight, category,
   *     description, image, fingerprint, discoveredAt) that the CURRENT
   *     frontend reads. This keeps Stage 1/2 behavior byte-for-byte stable so
   *     the existing UI, filters, search and date grouping keep working with
   *     zero frontend changes.
   *
   * Determinism: for a given rawItem + source the id, fingerprint and
   * canonicalUrl are always identical (djb2 hash, no randomness). Pass opts.nowMs
   * in tests to pin discoveredAt. */

  const SCHEMA_VERSION = "1.0";

  /* Query parameters that are unambiguous click-tracking noise and can be
   * removed safely when building canonicalUrl. Names are matched case-
   * insensitively; every utm_* parameter (utm_source, utm_campaign, …) is
   * stripped regardless of suffix. Generic parameters whose absence could
   * change the article identity (e.g. ?id=, ?p=, News-Google's googlenews
   * params) are deliberately NOT removed. */
  const TRACKING_PARAMS = [
    "fbclid", "gclid", "msclkid", "yclid", "dclid", "gbraid", "wbraid",
    "mc_cid", "mc_eid", "igshid", "vero_id", "_hsenc", "_hsmi", "ref_src",
    "ref_url", "campaign", "ocid",
  ];

  /* Normalize an article URL: lowercase the host, drop tracking params, and
   * let URL serialization produce a stable, deterministic form. Returns null
   * for unparseable input. The caller keeps the ORIGINAL in originalUrl. */
  function canonicalizeUrl(url) {
    if (!url || typeof url !== "string") return null;
    try {
      const u = new URL(url.trim());
      u.hostname = u.hostname.toLowerCase();
      const keys = Array.from(u.searchParams.keys());
      for (const k of keys) {
        const kl = k.toLowerCase();
        if (kl.indexOf("utm_") === 0 || TRACKING_PARAMS.indexOf(kl) !== -1) {
          u.searchParams.delete(k);
        }
      }
      return u.toString();
    } catch (e) {
      return null;
    }
  }

  /* Normalize any valid date-ish value to UTC ISO-8601; null if unusable.
   * Handles RSS pubDate, Atom updated/published and RDF dc:date alike because
   * they all parse through Date. We never invent a date: if the source is
   * missing/garbage, publishedAt stays null (downstream falls back to
   * discoveredAt where appropriate). */
  function normalizeTimestamp(value) {
    if (value == null || value === "") return null;
    const d = new Date(value);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }

  /* Collapse whitespace and trim a textual field. Returns null for empty. */
  function normalizeText(value) {
    if (value == null) return null;
    const s = String(value).replace(/\s+/g, " ").trim();
    return s.length ? s : null;
  }

  /* Always return an array (never undefined) for list fields. */
  function normalizeArray(value) {
    if (value == null) return [];
    return Array.isArray(value) ? value : [];
  }

  /* Lowest common denominator hostname ('www.' stripped) for wrapper checks. */
  function urlHost(url) {
    try {
      return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    } catch (e) {
      return "";
    }
  }

  const NEWS_WRAPPER_HOST = "news.google.com";

  /* Build a canonical Story from raw parser output + a validated source config. */
  function normalizeItem(rawItem, source, opts) {
    opts = opts || {};
    const raw = rawItem || {};
    const nowMs = opts.nowMs == null ? Date.now() : opts.nowMs;

    const rawTitle = normalizeText(raw.title) || "Untitled";
    /* Stage 12: strip a trailing publisher-alias suffix ("… - Reuters") so the
     * same article fetches one stable identity regardless of which aggregator
     * copy carried it. The original full title fans out below for display. */
    const cleaned = cleanTitleForIdentity(rawTitle);
    const title =
      cleaned.title && cleaned.title.trim() && cleaned.title.trim().length
        ? cleaned.title.trim()
        : rawTitle;
    const description = normalizeText(raw.description);
    const originalUrl = normalizeText(raw.link) || "";
    const canonicalUrl = canonicalizeUrl(originalUrl) || originalUrl;
    let publisherUrl = null;
    if (raw.describedHref && urlHost(canonicalUrl) === NEWS_WRAPPER_HOST) {
      const pub = canonicalizeUrl(raw.describedHref);
      if (pub && urlHost(pub) && urlHost(pub) !== NEWS_WRAPPER_HOST && canonicalUrlKey(pub) !== canonicalUrlKey(canonicalUrl)) {
        publisherUrl = pub;
      }
    }
    const published = normalizeTimestamp(raw.pubDate);
    const discoveredAt = new Date(nowMs).toISOString();

    const category = categorize((title + " " + (description || "")).trim());
    const dateObj = published ? new Date(published) : null;
    const legacyScore = computeScore(source.weight, dateObj, opts.index || 0);

    const story = {
      schemaVersion: SCHEMA_VERSION,
      id: buildStoryId(title, originalUrl),
      fingerprint: canonicalKey(title, originalUrl),

      title,
      description,
      originalUrl,
      canonicalUrl,
      publisherUrl,

      source: {
        id: source.id,
        name: source.name,
        type: source.category,
        reliability: source.reliability,
        priority: source.priority,
        weight: source.weight,
        color: source.color,
      },

      publishedAt: published,
      discoveredAt,

      author: null,
      imageUrl: normalizeText(raw.image),

      category,
      subcategory: null,

      tags: normalizeArray(raw.tags),
      companies: [],
      people: [],
      models: [],
      technologies: [],
      countries: [],

      content: null,

      ai: {
        summary: null,
        whyItMatters: null,
        keyTakeaways: [],
      },

      scores: {
        importance: null,
        impact: null,
        novelty: null,
        credibility: null,
        relevance: null,
        sourceConfidence: null,
      },

      relatedStoryIds: [],
      sources: [],

      createdAt: discoveredAt,
      updatedAt: discoveredAt,

      /* ---- legacy flat compatibility aliases (frontend + Stage 1/2) ---- */
      sourceId: source.id,
      sourceName: source.name,
      sourceType: source.category,
      sourceColor: source.color,
      sourceWeight: source.weight,
      link: originalUrl,
      date: published,
      image: normalizeText(raw.image),
      score: legacyScore,
    };

    return story;
  }

  /* Compatibility wrapper preserved so the Stage 2 pipeline/tests and the
   * browser aggregator keep a stable call shape: enrichItem(raw, source, index,
   * nowMs) === normalizeItem(raw, source, { index, nowMs }). Single source of
   * truth - no second normalizer exists. */
  function enrichItem(rawItem, source, index, nowMs) {
    return normalizeItem(rawItem, source, { index: index || 0, nowMs });
  }

  /* Validate an already-normalized canonical Story. Returns { valid, errors }
   * with { field, message } entries. Used to gate the snapshot and to surface
   * why a story was rejected (never silently dropped). */
  function validateStory(story) {
    const errors = [];
    if (!story || typeof story !== "object") {
      return { valid: false, errors: [{ field: "*", message: "missing story" }] };
    }
    const s = story;
    if (s.schemaVersion !== SCHEMA_VERSION) {
      errors.push({ field: "schemaVersion", message: "expected " + SCHEMA_VERSION + ", got " + s.schemaVersion });
    }
    if (typeof s.id !== "string" || !/^s[0-9a-f]{8}$/.test(s.id)) {
      errors.push({ field: "id", message: "must match s + 8 hex chars" });
    }
    if (typeof s.fingerprint !== "string" || !s.fingerprint) {
      errors.push({ field: "fingerprint", message: "required non-empty string" });
    }
    if (typeof s.title !== "string" || !s.title.trim()) {
      errors.push({ field: "title", message: "required non-empty string" });
    }
    if (!s.originalUrl && !s.canonicalUrl) {
      errors.push({ field: "url", message: "at least one of originalUrl/canonicalUrl required" });
    }
    if (s.originalUrl && !/^https?:\/\//i.test(s.originalUrl)) {
      errors.push({ field: "originalUrl", message: "must be an http(s) URL" });
    }
    if (s.canonicalUrl && !/^https?:\/\//i.test(s.canonicalUrl)) {
      errors.push({ field: "canonicalUrl", message: "must be an http(s) URL" });
    }
    if (s.publisherUrl != null && s.publisherUrl !== "" && !/^https?:\/\//i.test(s.publisherUrl)) {
      errors.push({ field: "publisherUrl", message: "must be an http(s) URL" });
    }
    if (!s.source || typeof s.source !== "object") {
      errors.push({ field: "source", message: "required source object" });
    } else {
      if (typeof s.source.id !== "string" || !s.source.id) {
        errors.push({ field: "source.id", message: "required" });
      }
      if (typeof s.source.name !== "string" || !s.source.name) {
        errors.push({ field: "source.name", message: "required" });
      }
    }
    if (s.publishedAt != null && Number.isNaN(new Date(s.publishedAt).getTime())) {
      errors.push({ field: "publishedAt", message: "invalid date" });
    }
    if (typeof s.discoveredAt !== "string" || Number.isNaN(new Date(s.discoveredAt).getTime())) {
      errors.push({ field: "discoveredAt", message: "required valid date" });
    }
    for (const listField of ["tags", "companies", "people", "models", "technologies", "countries", "relatedStoryIds", "sources"]) {
      if (s[listField] != null && !Array.isArray(s[listField])) {
        errors.push({ field: listField, message: "must be an array" });
      }
    }
    if (s.scores != null && s.scores !== undefined && typeof s.scores !== "object") {
      errors.push({ field: "scores", message: "must be an object" });
    }
    if (s.ai != null && s.ai !== undefined && typeof s.ai !== "object") {
      errors.push({ field: "ai", message: "must be an object" });
    }
    return { valid: errors.length === 0, errors };
  }

  const api = {
    extractText,
    extractFirstImage,
    parseDate,
    normalizeTitle,
    canonicalUrlKey,
    canonicalKey,
    hashString,
    buildStoryId,
    categorize,
    computeScore,
    dedupe,
    isSameDay,
    sourceCategories: SOURCE_CATEGORIES,
    sourceParsers: SOURCE_PARSERS,
    defaultSourceSettings: DEFAULT_SOURCE_SETTINGS,
    validateSourceConfig,
    applySourceDefaults,
    enrichItem,
    SCHEMA_VERSION,
    TRACKING_PARAMS,
    canonicalizeUrl,
    normalizeTimestamp,
    normalizeText,
    normalizeArray,
    normalizeItem,
    validateStory,
    PUBLISHER_ALIASES,
    cleanTitleForIdentity,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.AIRadarCore = api;
})(typeof window !== "undefined" ? window : this);