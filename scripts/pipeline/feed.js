/*
 * AI RADAR - RSS/Atom feed parser (Node pipeline).
 * Uses fast-xml-parser (the same library the snapshot builder has always
 * used). Produces generic raw items {title, link, pubDate, description, image}
 * that are normalised by the shared Core.enrichItem step, so browser and
 * Node pipelines end with identical stories and stable ids.
 *
 * Error policy (used by ingest.js for graceful failure):
 *   - valid feed, zero items -> []   (legitimate empty feed)
 *   - malformed / not a feed  -> throws FeedError("parse", ...)
 */

"use strict";

const { XMLParser } = require("fast-xml-parser");
const Core = require("../../js/shared.js");
const { FeedError } = require("./http.js");

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  cdataPropName: "__cdata",
  trimValues: true,
});

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
      return "";
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

function itemMediaImage(n) {
  for (const mediaKey of ["media:content", "media:thumbnail", "enclosure"]) {
    const media = n[mediaKey];
    if (media) {
      const a = attrs(media);
      if (a.url && !a.url.includes("logo")) return a.url;
    }
  }
  return null;
}

function parseRssAtom(xmlText) {
  if (typeof xmlText !== "string" || !xmlText.trim()) {
    throw new FeedError("parse", "Empty feed document");
  }
  let root;
  try {
    root = parser.parse(xmlText);
  } catch (e) {
    throw new FeedError("parse", "Malformed XML: " + e.message);
  }
  if (!root || typeof root !== "object") {
    throw new FeedError("parse", "Could not parse feed document");
  }

  const rdf = root["rdf:RDF"];
  let nodes = null;
  let feed;
  if (root.rss) {
    feed = root.rss.channel;
    if (feed) nodes = feed.item || feed.entry || [];
  } else if (root.feed) {
    feed = root.feed;
    nodes = feed.entry || [];
  } else if (rdf) {
    // RSS 1.0 / RDF: <rdf:RDF> hosts <channel> plus top-level <item> elements.
    feed = rdf;
    nodes = rdf.item || [];
  }
  if (!feed) {
    // It parsed as XML but is not an RSS/Atom/RDF feed.
    throw new FeedError("parse", "Not an RSS/Atom feed");
  }

  const nodeList = toArray(nodes);
  if (nodeList.length === 0) {
    // A legitimately empty feed still carries channel metadata (title/link/
    // description). A feed with NO items AND NO metadata is almost certainly
    // truncated/invalid XML that the lenient parser silently accepted.
    const meta =
      feed.title ||
      feed.description ||
      feed.link ||
      (feed.channel &&
        (feed.channel.title || feed.channel.description || feed.channel.link));
    if (!meta) {
      throw new FeedError("parse", "Feed has no items and no channel metadata (invalid/truncated RSS)");
    }
  }

  const items = [];

  nodeList.forEach((n) => {
    if (!n || typeof n !== "object") return;
    const content = pick(n, "content:encoded") || pick(n, "description") || pick(n, "summary");
    const description = Core.extractText(content);
    const title = pick(n, "title", "dc:title");
    if (!title) return;

    // RSS links are text content; Atom links live in the href attribute.
    const linkNode = n.link;
    let link = "";
    if (typeof linkNode === "string") link = linkNode;
    else if (linkNode && typeof linkNode === "object") link = attrs(linkNode)["href"] || "";
    if (!link) link = pick(n, "link");

    const pubDate = pick(n, "pubDate", "published", "updated", "dc:date");
    let image = itemMediaImage(n);
    if (!image) image = Core.extractFirstImage(typeof content === "string" ? content : "");

    items.push({ title, link, pubDate, description, image });
  });

  return items;
}

module.exports = { parseRssAtom };