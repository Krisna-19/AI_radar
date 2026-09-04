/*
 * AI RADAR - Stage 6: transparent classification + entity extraction (Node).
 *
 * Purpose
 *   Given a staged (deduped + clustered) canonical Story, assign:
 *     - a 12-category taxonomy label (stored in story.subcategory so the
 *       existing 5-bucket story.category is preserved for the current frontend);
 *     - structured entity arrays (companies / models / people / technologies /
 *       countries) populated from approximate (+ phrase) lexicons and a few
 *       deterministic patterns;
 *     - a short ordered tag list (matched entities + topical keywords).
 *
 *   It is fully deterministic - no ML/LLM, no external calls, no randomness, no
 *   wall-clock dependence. It deliberately PRIVILEGES FALSE NEGATIVES: when a
 *   label or entity is ambiguous it is left out (falls back to 'other', and
 *   leaves an entity list empty) rather than risk a confident wrong answer.
 *
 *   The 12-category taxonomy maps 1:1 onto the legacy 5-bucket category that the
 *   current frontend filters on, so nothing in Stages 1-5 or the UI changes.
 *
 * Pipeline slot (roadmap 4.classify.js):
 *   ingest -> normalize -> dedupe -> clusterStories -> classify -> score -> store
 */

"use strict";

const Core = require("../../js/shared.js");

/* ------------------------------------------------------------------ *
 * Taxonomy
 * ------------------------------------------------------------------ */

/* The 12-category taxonomy (canonical, additive). Stories keep the legacy
 * story.category (top-5) for the current frontend; the fine label lives in
 * story.subcategory. */
const TAXONOMY = [
  "research",
  "model",
  "product",
  "tools",
  "funding",
  "business",
  "policy",
  "safety",
  "opensource",
  "partnership",
  "industry",
  "other",
];

/* Ordered rule sets. The first matching rule wins (lower index = more specific).
 * The classifier prefers false negatives: low-signal input falls through to
 * 'other'. */
const CATEGORY_RULES = [
  {
    id: "research",
    words: [
      "arxiv", "paper", "research", "study", "benchmark", "model card",
      "preprint", "dataset", "data set", "sota", "state of the art",
      "experiment", "gpt-4o achieves", "superhuman", "new sota",
    ],
  },
  {
    id: "model",
    words: [
      "introducing gpt", "gpt-4", "gpt-5", "gpt-4o", "claude 3", "claude 4",
      "gemini 2", "llama 3", "llama 4", "new model", "releases",
      "open-sources a", "model release", "checkpoint",
    ],
  },
  {
    id: "funding",
    words: [
      "raises", "raised", "series a", "series b", "series c", "seed round",
      "funding", "valuation", "invests", "investment", "led by", "ipo",
      "acquired", "acquisition", "merger", "million investment", "billion",
    ],
  },
  {
    id: "product",
    words: [
      "launch", "launches", "launched", "releases", "unveils", "unveiled",
      "announces today", "rolling out", "rolls out", "now available", "new app",
      "introduces", "rebuild", "redesign", "update",
    ],
  },
  {
    id: "tools",
    words: [
      "agent", "agents", "tool", "api", "sdk", "plugin", "integration",
      "assistant", "codex", "canvas", "copilot", "notebooklm", "workflow",
    ],
  },
  {
    id: "safety",
    words: [
      "safety", "alignment", "misuse", "jailbreak", "bias", "hallucinat",
      "safeguard", "responsible ai", "security", "vulnerab", "red team",
    ],
  },
  {
    id: "policy",
    words: [
      "regulation", "regulatory", "policy", "government", "ai act", "law",
      "lawmaker", "legislat", "executive order", "federal", "ban", "compliance",
      "oversight", "election", "deepfake law",
    ],
  },
  {
    id: "opensource",
    words: [
      "open source", "open-source", "open weights", "openweight", "openly",
      "code is open", "open-sourced", "opensource", "mit license", "apache",
    ],
  },
  {
    id: "partnership",
    words: [
      "partnership", "partner", "collaborat", "teams up", "team up",
      "joins forces", "strategic alliance", "co-develop", "agreement with",
    ],
  },
  {
    id: "industry",
    words: [
      "industry", "adopt", "adoption", "deploy", "enterprise", "companies",
      "survey", "report finds", "grow", "growth", "market", "revenue", "impact",
    ],
  },
  {
    id: "business",
    words: [
      "appoints", "ceo", "cto", "hires", "workforce", "layoff", "resign",
      "founded", "startup", "earnings", "reaches", "users", "milestone",
    ],
  },
];

/* Map each of the 12 fine labels onto the legacy top-5 bucket the current
 * frontend filters on. Additive: it never changes how a category filters today. */
const LEGACY_BUCKET = {
  research: "research",
  model: "product",
  product: "product",
  tools: "product",
  funding: "funding",
  business: "funding",
  policy: "policy",
  safety: "policy",
  opensource: "product",
  partnership: "news",
  industry: "news",
  other: "news",
};

/* ------------------------------------------------------------------ *
 * Entity lexicons (conservative, by explicit name - no wildcards)
 * ------------------------------------------------------------------ */
const LEXICONS = {
  companies: [
    "openai", "anthropic", "google", "google deepmind", "deepmind", "microsoft",
    "meta", "metas", "amazon", "aws", "nvidia", "apple", "ibm", "salesforce",
    "databricks", "cohere", "mistral", "stability", "xai", "x ai", "baidu",
    "alibaba", "tencent", "aliyun", "scale ai", "perplexity", "character ai",
    "elevenlabs", "runway", "midjourney", "hugging face", "huggingface",
    "together ai", "fireworks ai", "groq", "cerebras", "inflection", "h2o ai",
    "ai21", "reka", "walterai", "opal", "mosaic", "ai21 labs",
  ],
  models: [
    "gpt", "gpt-4", "gpt-4o", "gpt-5", "gpt-4.5", "o1", "o3", "gpt-4o-mini",
    "claude", "claude 3", "claude 3.5", "claude 4", "gemini", "gemini 1",
    "gemini 2", "gemini 1.5", "llama", "llama 3", "llama 4", "mistral",
    "mistral 7b", "mixtral", "deepseek", "deepseek v3", "qwen", "delta",
    "stable diffusion", "sora", "veo", "imagen", "grok", "falcon", "nous hermes",
    "command r", "command r+", "dbrx", "mixtral 8x7b",
  ],
  people: [
    "sam altman", "sundar pichai", "demis hassabis", "dario amodei", "daniela amodei",
    "elon musk", "mark zuckerberg", "jensen huang", "satya nadella", "yann lecun",
    "geoffrey hinton", "andrej karpathy", "ilya sutskever", "jim fan", "yang zhou",
    "tim cook", "andrew ng", "fei-fei li", "mustafa suleyman", "aiden gomez",
  ],
  technologies: [
    "transformer", "diffusion", "reinforcement learning", "rlhf", "rag",
    "agent", "multimodal", "computer vision", "nlp", "natural language",
    "autonomous driving", "text-to-image", "text-to-video", "ai chip", "gpu",
    "quantization", "fine-tuning", "fine tuning", "prompt", "inference",
    "token","embedding", "attention", "neural network", "mixture of experts",
  ],
  countries: [
    "united states", "us", "usa", "china", "europe", "eu", "united kingdom",
    "uk", "germany", "france", "japan", "india", "canada", "south korea",
    "israel", "singapore", "australia",
  ],
};

/* ------------------------------------------------------------------ *
 * Helpers (deterministic)
 * ------------------------------------------------------------------ */

/* Lowercase text with ASCII-ish normalisation for matching. */
function haystack(story) {
  return [story.title, story.description, story.content]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

/* Order-preserving unique names actually present in the text. Longer names are
 * matched first, and any match that is a token-prefix of a longer matched name
 * is dropped (so "gpt" alone never also fires when "gpt-5" matched). */
function matchLexicon(text, list, label) {
  const sorted = [...list].sort((a, b) => b.length - a.length);
  const matched = [];
  const used = new Set();
  for (const name of sorted) {
    if (used.has(name)) continue;
    // Match as a standalone token (word boundaries) to avoid false positives
    // like "gem" matching "gemini".
    const re = new RegExp("(^|[^a-z0-9])" + escapeRe(name) + "($|[^a-z0-9])");
    if (re.test(text)) {
      matched.push(name);
      used.add(name);
    }
  }
  // Drop subsumed names: if we matched "gpt-5", the shorter "gpt" matched too
  // only because of the token boundary before "-" - remove those names that are
  // themselves a whole standalone token inside a longer matched name.
  const kept = matched.filter((m) =>
    !matched.some((o) => o !== m && o.length > m.length && isStandaloneToken(o, m))
  );
  return kept.map((name) =>
    label === "countries" ? displayName(name)
      : label === "companies" ? displayLabel(name)
        : modelLabel(name)
  );
}

/* Is `short` a whole, standalone token somewhere inside `long`? e.g. "gpt"
 * inside "gpt-5", "deepmind" inside "google deepmind", but NOT "japan" inside
 * "japanese" nor "gem" inside "gemini". */
function isStandaloneToken(long, short) {
  const re = new RegExp("(^|[^a-z0-9])" + escapeRe(short) + "($|[^a-z0-9])");
  return re.test(long);
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/* Whole-token match: `word` must appear surrounded by non-alnum boundaries, so
 * "api" matches the word "api" but never the "api" inside "rapid". Multi-word
 * phrases ("series a") and hyphens ("open-source") work too. */
function hasToken(text, word) {
  if (!word) return false;
  const re = new RegExp("(^|[^a-z0-9])" + escapeRe(word) + "($|[^a-z0-9])");
  return re.test(text);
}

/* Human-facing labels (Word case) for a few entity types. */
function displayName(name) {
  const map = {
    "us": "United States", "usa": "United States", "uk": "United Kingdom",
    "eu": "European Union", "us": "United States",
  };
  return wordCase(map[name] || name);
}

function displayLabel(name) {
  const map = {
    "google": "Google", "google deepmind": "Google DeepMind", "deepmind": "DeepMind",
    "metas": "Meta", "huggingface": "Hugging Face",
    "xai": "xAI", "aws": "AWS", "ibm": "IBM", "nvidia": "NVIDIA",
    "openai": "OpenAI", "microsoft": "Microsoft", "amazon": "Amazon",
    "apple": "Apple", "mosaic": "Mosaic AI",
  };
  return map[name] || wordCase(name);
}

function modelLabel(name) {
  // brand-style model names keep their common capitalisation
  const special = {
    "gpt": "GPT", "gpt-4": "GPT-4", "gpt-4o": "GPT-4o", "gpt-5": "GPT-5",
    "gpt-4.5": "GPT-4.5", "gpt-4o-mini": "GPT-4o Mini", "o1": "OpenAI o1",
    "o3": "OpenAI o3", "claude": "Claude", "claude 3": "Claude 3",
    "claude 3.5": "Claude 3.5", "claude 4": "Claude 4", "gemini": "Gemini",
    "gemini 1.5": "Gemini 1.5", "gemini 2": "Gemini 2", "llama": "Llama",
    "llama 3": "Llama 3", "llama 4": "Llama 4", "mistral": "Mistral",
    "mixtral": "Mixtral", "qwen": "Qwen", "deepseek": "DeepSeek",
    "sora": "Sora", "veo": "Veo", "imagen": "Imagen", "grok": "Grok",
    "falcon": "Falcon", "dbrx": "DBRX", "stable diffusion": "Stable Diffusion",
  };
  if (special[name]) return special[name];
  // generic all-caps-ish model tokens (e.g. "RLHF") are left as-is-ish
  return wordCase(name);
}

function wordCase(s) {
  return s
    .split(" ")
    .map((w) => (w.length ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

/* Topical keyword tags (beyond entities): a small deterministic set of
 * high-signal terms, capped to keep tags short. */
const TOPIC_TAGS = {
  agent: "agents",
  multimodal: "multimodal",
  "reinforcement learning": "RL",
  robotics: "robotics",
  safety: "safety",
  startup: "startup",
  chip: "silicon",
  "open source": "open source",
  regulation: "regulation",
};

/* ------------------------------------------------------------------ *
 * Public API
 * ------------------------------------------------------------------ */

/* Classify a single canonical story. Mutates it to add:
 *   subcategory (12-class), tags[], companies/models/people/technologies/
 *   countries[] (populated), and chip (legacy top-5 bucket via LEGACY_BUCKET -
 *   equal to subcategory unless otherwise mapped). Returns the same story.
 * Pure + deterministic: identical input => identical output. */
function classifyStory(story) {
  if (!story || typeof story !== "object") return story;
  const text = haystack(story);

  let fine = "other";
  for (const rule of CATEGORY_RULES) {
    if (rule.words.some((w) => hasToken(text, w))) {
      fine = rule.id;
      break;
    }
  }
  story.subcategory = fine;
  // The legacy top-5 bucket the frontend filters on is updated to the Stage-6
  // mapping (still one of research/product/funding/policy/news). `chip` is a
  // spec-alias kept in sync with category.
  const bucket = LEGACY_BUCKET[fine] || "news";
  story.category = bucket;
  story.chip = bucket;

  // Entities (deterministic, false-negative-friendly).
  story.companies = matchLexicon(text, LEXICONS.companies, "companies");
  story.models = matchLexicon(text, LEXICONS.models, "models");
  story.people = matchLexicon(text, LEXICONS.people, "people");
  story.technologies = matchLexicon(text, LEXICONS.technologies, "technologies");
  story.countries = matchLexicon(text, LEXICONS.countries, "countries");

  // Tags: matched entities + a few topical keywords, deduped, capped.
  const tags = [];
  const seen = new Set();
  for (const group of [story.models, story.companies, story.technologies,
    story.people, story.countries]) {
    for (const t of group) {
      const k = t.toLowerCase();
      if (!seen.has(k)) { seen.add(k); tags.push(t); }
    }
  }
  for (const term of Object.keys(TOPIC_TAGS)) {
    if (text.indexOf(term) !== -1) {
      const t = TOPIC_TAGS[term];
      if (!seen.has(t)) { seen.add(t); tags.push(t); }
    }
  }
  story.tags = tags.slice(0, 6).map(wordCase);
  return story;
}

/* Classify an array of canonical stories in place; returns the same array.
 * Also returns per-category counts for stats. */
function classifyStories(stories) {
  const input = Array.isArray(stories) ? stories : [];
  for (const s of input) classifyStory(s);
  const perCategory = {};
  const perChip = {};
  for (const s of input) {
    const sub = s && s.subcategory ? s.subcategory : "other";
    perCategory[sub] = (perCategory[sub] || 0) + 1;
    const chip = s && s.chip ? s.chip : "news";
    perChip[chip] = (perChip[chip] || 0) + 1;
  }
  return { items: input, stats: { categories: perCategory, chips: perChip } };
}

module.exports = {
  TAXONOMY,
  LEGACY_BUCKET,
  CATEGORY_RULES,
  LEXICONS,
  classifyStory,
  classifyStories,
};
