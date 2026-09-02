/*
 * Stage 2 tests: source ingestion pipeline + configuration validation.
 * Uses node:test and a local HTTP fixture server (no external network).
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");

const Core = require("../js/shared.js");
const { parseRssAtom } = require("../scripts/pipeline/feed.js");
const { fetchText, FeedError } = require("../scripts/pipeline/http.js");
const { ingestSource, ingestAll, lineFor } = require("../scripts/pipeline/ingest.js");

/* ---------------- fixtures ---------------- */

const VALID_RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Demo Feed</title>
    <link>http://demo.example/</link>
    <description>demo</description>
    <item>
      <title>OpenAI launches new model</title>
      <link>https://openai.com/blog/new-model</link>
      <pubDate>Mon, 01 Sep 2026 09:00:00 GMT</pubDate>
      <description><![CDATA[<p>A&nbsp;quick&nbsp;summary</p>]]></description>
    </item>
    <item>
      <title>DeepMind unlocks protein folding</title>
      <link>https://deepmind.google/blog/protein</link>
      <pubDate>Tue, 02 Sep 2026 10:00:00 GMT</pubDate>
      <description><![CDATA[<img src="https://x/img.jpg"/><p>study</p>]]></description>
    </item>
  </channel>
</rss>`;

const VALID_ATOM = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Hugging Face Blog</title>
  <entry>
    <title>New transformers release</title>
    <link href="https://huggingface.co/blog/release"/>
    <updated>2026-09-02T08:00:00Z</updated>
    <summary>explainer text for the release</summary>
  </entry>
</feed>`;

const EMPTY_RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Empty</title><link>x</link><description>d</description></channel></rss>`;

const MALFORMED = `<rss version="2.0"><channel><item><title>x</title><description><![CDATA[unclosed</description></item></channel></rss>`;

/* Truncated XML that the lenient parser silently accepts as an item stub:
 * it must degrade to an empty/warned result, never crash the pipeline. */
const TRUNCATED_RSS = `<rss version="2.0"><channel><item><title>boom`;

const NOT_A_FEED = `<html><body><p>hello</p></body></html>`;

const VALID_RSS1 = `<?xml version="1.0" encoding="UTF-8"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
         xmlns="http://purl.org/rss/1.0/">
  <channel rdf:about="http://www.nature.com/natmachintell">
    <title>Nature Machine Intelligence</title>
    <link>http://www.nature.com/natmachintell</link>
    <description>Latest research</description>
    <items><rdf:Seq><rdf:li rdf:resource="https://www.nature.com/d41586-026-00001-0"/></rdf:Seq></items>
  </channel>
  <item rdf:about="https://www.nature.com/d41586-026-00001-0">
    <title>AI cracks long-standing protein problem</title>
    <link>https://www.nature.com/d41586-026-00001-0</link>
    <description>A new study shows how large models fold proteins.</description>
  </item>
</rdf:RDF>`;

const SAMPLE_SOURCE = {
  id: "demo",
  name: "Demo Feed",
  url: "http://placeholder.example/feed",
  category: "media",
  enabled: true,
  priority: 1,
  reliability: 6,
  weight: 3,
  parser: "auto",
  color: "#abcdef",
};

/* ---------------- local HTTP fixture server ---------------- */

function startServer(routes) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const route = routes[req.url];
      if (!route) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("not found");
        return;
      }
      if (route.drop) {
        res.socket.destroy();
        return;
      }
      const send = () => {
        res.writeHead(route.status || 200, {
          "Content-Type": route.ctype || "application/rss+xml",
        });
        res.end(route.body);
      };
      if (route.delayMs) setTimeout(send, route.delayMs);
      else send();
    });
    server.listen(0, () =>
      resolve({ server, base: "http://127.0.0.1:" + server.address().port })
    );
  });
}

/* ---------------- parser ---------------- */

test("parseRssAtom: valid RSS feed -> generic items", () => {
  const items = parseRssAtom(VALID_RSS);
  assert.strictEqual(items.length, 2);
  assert.strictEqual(items[0].title, "OpenAI launches new model");
  assert.strictEqual(items[0].link, "https://openai.com/blog/new-model");
  assert.ok(items[0].pubDate.includes("2026"));
  assert.strictEqual(items[0].description, "A quick summary");
  assert.strictEqual(items[1].image, "https://x/img.jpg");
});

test("parseRssAtom: valid Atom feed -> generic items (link from href)", () => {
  const items = parseRssAtom(VALID_ATOM);
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].title, "New transformers release");
  assert.strictEqual(items[0].link, "https://huggingface.co/blog/release");
});

test("parseRssAtom: RSS 1.0 (RDF) feed -> generic items", () => {
  const items = parseRssAtom(VALID_RSS1);
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].title, "AI cracks long-standing protein problem");
  assert.strictEqual(items[0].link, "https://www.nature.com/d41586-026-00001-0");
});

test("parseRssAtom: empty feed -> [] (legitimate, not an error)", () => {
  assert.deepStrictEqual(parseRssAtom(EMPTY_RSS), []);
});

test("parseRssAtom: malformed feed -> throws FeedError(parse)", () => {
  assert.throws(() => parseRssAtom(MALFORMED), (e) => e instanceof FeedError && e.type === "parse");
});

test("parseRssAtom: truncated XML degrades to [] without crashing", () => {
  assert.deepStrictEqual(parseRssAtom(TRUNCATED_RSS), []);
});

test("parseRssAtom: XML that is not a feed -> throws FeedError(parse)", () => {
  assert.throws(() => parseRssAtom(NOT_A_FEED), (e) => e instanceof FeedError && e.type === "parse");
});

/* ---------------- http errors ---------------- */

test("fetchText: HTTP error classified as http", async () => {
  const { server, base } = await startServer({});
  try {
    await assert.rejects(fetchText(base + "/missing"), (e) => e instanceof FeedError && e.type === "http");
  } finally {
    server.close();
  }
});

test("fetchText: connection refused classified as network", async () => {
  const { server } = await startServer({ "/drop": { drop: true } });
  const { base } = { base: "http://127.0.0.1:" + server.address().port };
  try {
    const err = await fetchText(base + "/drop").catch((e) => e);
    assert.ok(err instanceof FeedError, "expected FeedError, got " + err);
    assert.strictEqual(err.type, "network");
  } finally {
    server.close();
  }
});

/* ---------------- ingestSource ---------------- */

test("ingestSource: success -> normalized items with stable stage-1 ids", async () => {
  const { server, base } = await startServer({ "/feed": { body: VALID_RSS } });
  try {
    const src = Object.assign({}, SAMPLE_SOURCE, { url: base + "/feed" });
    const r = await ingestSource(src);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.status, "ok");
    assert.strictEqual(r.itemCount, 2);
    const it = r.items[0];
    assert.ok(/^s[0-9a-f]{8}$/.test(it.id), "stable id format, got " + it.id);
    assert.strictEqual(it.id, Core.buildStoryId(it.title, it.link));
    assert.strictEqual(it.fingerprint, Core.canonicalKey(it.title, it.link));
    assert.strictEqual(it.sourceType, src.category);
    assert.strictEqual(it.sourceName, "Demo Feed");
    assert.ok(it.discoveredAt);
  } finally {
    server.close();
  }
});

test("ingestSource: empty feed -> status empty, ok, no items", async () => {
  const { server, base } = await startServer({ "/feed": { body: EMPTY_RSS } });
  try {
    const src = Object.assign({}, SAMPLE_SOURCE, { url: base + "/feed" });
    const r = await ingestSource(src);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.status, "empty");
    assert.strictEqual(r.itemCount, 0);
  } finally {
    server.close();
  }
});

test("ingestSource: malformed feed -> failure typed parse, pipeline-safe", async () => {
  const { server, base } = await startServer({ "/feed": { body: MALFORMED } });
  try {
    const src = Object.assign({}, SAMPLE_SOURCE, { url: base + "/feed" });
    const r = await ingestSource(src);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.errorType, "parse");
    assert.ok(r.error);
    assert.deepStrictEqual(r.items, []);
  } finally {
    server.close();
  }
});

test("ingestSource: timeout -> failure typed timeout", async () => {
  const { server, base } = await startServer({ "/slow": { body: VALID_RSS, delayMs: 300 } });
  try {
    const src = Object.assign({}, SAMPLE_SOURCE, { url: base + "/slow" });
    const r = await ingestSource(src, { timeoutMs: 60 });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.errorType, "timeout");
  } finally {
    server.close();
  }
});

test("ingestSource: network failure (socket drop) -> typed network", async () => {
  const { server, base } = await startServer({ "/drop": { drop: true } });
  try {
    const src = Object.assign({}, SAMPLE_SOURCE, { url: base + "/drop" });
    const r = await ingestSource(src);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.errorType, "network");
  } finally {
    server.close();
  }
});

/* ---------------- ingestAll (multiple sources, graceful failure) ---------------- */

test("ingestAll: multiple healthy sources", async () => {
  const { server, base } = await startServer({
    "/a": { body: VALID_RSS },
    "/b": { body: VALID_ATOM },
  });
  try {
    const a = Object.assign({}, SAMPLE_SOURCE, { id: "a", name: "AAA", url: base + "/a" });
    const b = Object.assign({}, SAMPLE_SOURCE, { id: "b", name: "BBB", url: base + "/b" });
    const rep = await ingestAll([a, b]);
    assert.strictEqual(rep.summary.configured, 2);
    assert.strictEqual(rep.summary.ok, 2);
    assert.strictEqual(rep.summary.failed, 0);
    assert.strictEqual(rep.summary.items, 3); // 2 rss + 1 atom
    assert.strictEqual(rep.allItems.length, 3);
    assert.ok(rep.logs.some((l) => l.includes("[OK] AAA") && l.includes("2 items")));
    assert.ok(rep.logs.some((l) => l.includes("[OK] BBB") && l.includes("1 item")));
  } finally {
    server.close();
  }
});

test("ingestAll: one failed source does not stop the others", async () => {
  const { server, base } = await startServer({
    "/ok": { body: VALID_RSS },
    "/broken": { body: MALFORMED },
    "/gone": { status: 404, body: "no" },
    "/slow": { body: VALID_ATOM, delayMs: 300 },
  });
  try {
    const ok = Object.assign({}, SAMPLE_SOURCE, { id: "ok", name: "Healthy", url: base + "/ok" });
    const broken = Object.assign({}, SAMPLE_SOURCE, { id: "broken", name: "Bad XML", url: base + "/broken" });
    const gone = Object.assign({}, SAMPLE_SOURCE, { id: "gone", name: "HTTP 404", url: base + "/gone" });
    const slow = Object.assign({}, SAMPLE_SOURCE, { id: "slow", name: "Slow", url: base + "/slow" });

    const rep = await ingestAll([ok, broken, gone, slow], { timeoutMs: 60 });
    assert.strictEqual(rep.summary.configured, 4);
    assert.strictEqual(rep.summary.ok, 1);
    assert.strictEqual(rep.summary.failed, 3);
    assert.strictEqual(rep.summary.items, 2);
    assert.strictEqual(rep.allItems.length, 2);
    assert.ok(rep.allItems.every((i) => i.sourceId === "ok"));

    const byId = Object.fromEntries(rep.results.map((r) => [r.source.id, r]));
    assert.strictEqual(byId.broken.errorType, "parse");
    assert.strictEqual(byId.gone.errorType, "http");
    assert.strictEqual(byId.slow.errorType, "timeout");

    assert.ok(rep.logs.some((l) => l.startsWith("[OK] Healthy")));
    assert.ok(rep.logs.some((l) => l.startsWith("[ERROR] Bad XML")));
    assert.ok(rep.logs.some((l) => l.includes("ok=1") && l.includes("failed=3")));
  } finally {
    server.close();
  }
});

test("lineFor: human-readable [OK]/[WARN]/[ERROR] formats", () => {
  const mk = (src) => ({
    ok: true,
    status: "ok",
    itemCount: 12,
    items: [],
    responseMs: 803,
    errorType: null,
    error: null,
    source: { name: "Demo Feed" },
    ...src,
  });
  assert.ok(lineFor(mk({})).includes("[OK] Demo Feed — 12 items (803ms)"));
  assert.ok(
    lineFor(mk({ ok: false, status: "error", errorType: "timeout", error: "Timeout after 60ms" })).includes(
      "[WARN] Demo Feed — Timeout after 60ms"
    )
  );
  assert.ok(
    lineFor(mk({ ok: false, status: "error", errorType: "parse", error: "Malformed XML: boom" })).includes(
      "[ERROR] Demo Feed — Malformed XML: boom"
    )
  );
});

/* ---------------- source configuration validation ---------------- */

test("validateSourceConfig: accepts a well-formed source", () => {
  assert.strictEqual(Core.validateSourceConfig(SAMPLE_SOURCE).valid, true);
});

test("validateSourceConfig: rejects bad entries per field", () => {
  const cases = [
    [{ ...SAMPLE_SOURCE, id: "Bad Id!" }, "id"],
    [{ id: "badid", url: "https://x/", category: "media" }, "name"],
    [{ ...SAMPLE_SOURCE, url: "not a url" }, "url"],
    [{ ...SAMPLE_SOURCE, category: "spam" }, "category"],
    [{ ...SAMPLE_SOURCE, enabled: "yes" }, "enabled"],
    [{ ...SAMPLE_SOURCE, priority: -1 }, "priority"],
    [{ ...SAMPLE_SOURCE, parser: "yaml" }, "parser"],
    [{ ...SAMPLE_SOURCE, reliability: 99 }, "reliability"],
    [{ ...SAMPLE_SOURCE, weight: 9 }, "weight"],
    [{ ...SAMPLE_SOURCE, color: "blue" }, "color"],
    [null, "*"],
  ];
  for (const [src, field] of cases) {
    const r = Core.validateSourceConfig(src);
    assert.strictEqual(r.valid, false);
    assert.ok(r.errors.some((e) => e.field === field), "expected error on " + field);
  }
});

test("applySourceDefaults: fills every default", () => {
  const src = Core.applySourceDefaults({ id: "x", name: "X", url: "https://x.example/rss", category: "media" });
  assert.strictEqual(src.enabled, true);
  assert.strictEqual(src.priority, 100);
  assert.strictEqual(src.fetchIntervalHours, 3);
  assert.strictEqual(src.parser, "auto");
  assert.strictEqual(src.reliability, 5);
  assert.strictEqual(src.weight, 3);
  assert.ok(/^#/.test(src.color));
});

test("enrichItem: stable id preserved through the pipeline", () => {
  const raw = { title: "OpenAI launches new model", link: "https://openai.com/blog/new-model", pubDate: "2026-09-02T00:00:00Z" };
  const i1 = Core.enrichItem(raw, SAMPLE_SOURCE, 0, 1234567890);
  const i2 = Core.enrichItem(raw, SAMPLE_SOURCE, 0, 9999999999);
  assert.strictEqual(i1.id, i2.id);
  assert.strictEqual(i1.fingerprint, i2.fingerprint);
  assert.strictEqual(i1.id, Core.buildStoryId(raw.title, raw.link));
});

/* ---------------- canonical source configuration ---------------- */

test("sources/index.js: config loads, validates and has 13 unique enabled sources", () => {
  const SRC = require("../sources/index.js");
  assert.strictEqual(SRC.configValid, true);
  assert.deepStrictEqual(SRC.validationErrors, []);
  assert.strictEqual(SRC.enabledSources.length, 13);
  const ids = SRC.enabledSources.map((s) => s.id);
  assert.strictEqual(new Set(ids).size, ids.length);
  for (const s of SRC.enabledSources) {
    assert.strictEqual(Core.validateSourceConfig(s).valid, true, "invalid source: " + s.id);
  }
});