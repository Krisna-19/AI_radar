/*
 * AI RADAR - snapshot builder (Node, used by GitHub Actions).
 *
 * Fetches every RSS feed directly (no CORS needed server-side), parses with
 * fast-xml-parser, enriches using the same pure helpers the browser uses
 * (js/shared.js) and writes the pre-aggregated feed to data/news.json.
 *
 * The deployed site loads data/news.json instantly - no proxy needed.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { XMLParser } = require("fast-xml-parser");
const { AI_SOURCES } = require("../js/config.js");
const Core = require("../js/shared.js");

const SNAPSHOT_FILE = path.join(__dirname, "..", "data", "news.json");

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  cdataPropName: "__cdata",
  trimValues: true,
});

async function fetchText(url, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || 20000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: "follow" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.toString("utf8");
  } finally {
    clearTimeout(timer);
  }
}

function toArray(x) {
  if (x == null) return [];
  return Array.isArray(x) ? x : [x];
}

function pick(node, ...keys) {
  for (const k of keys) {
    if (node[k] != null && node[k] !== "") {
      const v = node[k];
      if (typeof v === "string") return v;
      if (typeof v === "object" && v.__cdata != null) return v.__cdata;
      if (typeof v === "object" && v["#text"] != null) return v["#text"];
      return JSON.stringify(v);
    }
  }
  return "";
}

function attrs(node) {
  if (!node) return {};
  const out = {};
  for (const k of Object.keys(node)) {
    if (k.startsWith("@_")) out[k.slice(2)] = node[k];
  }
  return out;
}

function parseRawItems(xmlText) {
  const root = parser.parse(xmlText);
  const feed = root.rss ? root.rss.channel : root.feed;
  if (!feed) return [];
  const nodes = feed.item || feed.entry || [];
  const items = [];

  toArray(nodes).forEach((n) => {
    const title = pick(n, "title", "dc:title");
    let link = pick(n, "link");
    if (!link) link = attrs(n.link)["href"] || "";
    const pubDate = pick(n, "pubDate", "published", "updated", "dc:date");
    const content =
      pick(n, "content:encoded") ||
      pick(n, "description") ||
      pick(n, "summary");

    // Image from media/enclosure attrs or from within the content HTML.
    let image = null;
    for (const mediaKey of ["media:content", "media:thumbnail", "enclosure"]) {
      const media = n[mediaKey];
      if (media) {
        const a = attrs(media);
        if (a.url && !a.url.includes("logo")) {
          image = a.url;
          break;
        }
      }
    }
    if (!image) image = Core.extractFirstImage(typeof content === "string" ? content : "");

    const description = Core.extractText(content);
    if (title) items.push({ title, link, pubDate, description, image });
  });

  return items;
}

async function loadSource(source) {
  try {
    const raw = await fetchText(source.url);
    const rawItems = parseRawItems(raw);
    return rawItems.map((it, i) => {
      const date = Core.parseDate(it.pubDate);
      return {
        id: source.id + "-" + i,
        sourceId: source.id,
        sourceName: source.name,
        sourceType: source.type,
        sourceColor: source.color,
        sourceWeight: source.weight,
        title: it.title,
        link: it.link || "#",
        date: date ? date.toISOString() : "",
        description: it.description || "",
        image: it.image || null,
        category: Core.categorize(it.title + " " + it.description),
        score: Core.computeScore(source.weight, date, i),
      };
    });
  } catch (e) {
    console.warn("Failed to load source " + source.name + ": " + e.message);
    return [];
  }
}

async function main() {
  const started = Date.now();

  // concurrency 4 - enough parallelism without tripping feed throttling
  const perSource = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.min(4, AI_SOURCES.length) }, async () => {
    while (cursor < AI_SOURCES.length) {
      const i = cursor++;
      perSource[i] = await loadSource(AI_SOURCES[i]);
    }
  });
  await Promise.all(workers);

  const items = Core.dedupe(perSource.flat());
  items.sort(
    (a, b) =>
      (b.score || 0) - (a.score || 0) ||
      (b.date ? +new Date(b.date) : 0) - (a.date ? +new Date(a.date) : 0)
  );

  fs.mkdirSync(path.dirname(SNAPSHOT_FILE), { recursive: true });
  fs.writeFileSync(
    SNAPSHOT_FILE,
    JSON.stringify({ generatedAt: Date.now(), items }, null, 0)
  );

  const ok = items.length;
  console.log("Saved " + ok + " items to data/news.json in " + ((Date.now() - started) / 1000).toFixed(1) + "s");

  // Fail loudly when nothing was fetched so the workflow catches problems.
  if (ok === 0) process.exitCode = 1;
}

main();