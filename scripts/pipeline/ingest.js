/*
 * AI RADAR - unified ingestion pipeline (Node).
 *
 *   sources -> fetch -> parse -> normalize basic fields -> suggest back
 *
 * steps:
 *   1. fetch   (scripts/pipeline/http.js)   classified timeouts/http/network errors
 *   2. parse   (scripts/pipeline/feed.js)   RSS + Atom -> generic raw items
 *   3. normalize (js/shared.js Core.enrichItem)  identical to the browser path,
 *              produces stable Stage-1 ids.
 *
 * Graceful failure: one bad feed never aborts the pipeline. Every source is
 * tracked (ok/failed, item count, error type, response time) and reported with
 * [OK]/[WARN]/[ERROR] lines.
 *
 * CLI (dry run, no file writes):  node scripts/pipeline/ingest.js
 */

"use strict";

const { loadEnv, envNumber } = require("./env.js");
const { fetchText } = require("./http.js");
const { parseRssAtom } = require("./feed.js");
const Core = require("../../js/shared.js");

const DEFAULT_CONCURRENCY = 4;

const TAGS = {
  ok: "OK",
  empty: "WARN",
  timeout: "WARN",
  http: "ERROR",
  network: "ERROR",
  parse: "ERROR",
};

async function ingestSource(source, opts = {}) {
  const timeoutMs = opts.timeoutMs || parseInt(process.env.FETCH_TIMEOUT_MS || "15000", 10);
  const record = {
    source,
    ok: false,
    status: "error",
    errorType: null,
    error: null,
    itemCount: 0,
    items: [],
    responseMs: 0,
    startedAt: Date.now(),
  };

  try {
    const { text, responseMs } = await fetchText(source.url, { timeoutMs, headers: opts.headers });
    record.responseMs = responseMs;
    const rawItems = parseRssAtom(text);
    const nowMs = opts.nowMs || Date.now();

    if (rawItems.length === 0) {
      record.status = "empty";
      record.ok = true;
      record.itemCount = 0;
      return record;
    }

    const items = rawItems.map((raw, i) => Core.enrichItem(raw, source, i, nowMs));
    record.ok = true;
    record.status = "ok";
    record.items = items;
    record.itemCount = items.length;
    return record;
  } catch (e) {
    const type = e && e.type ? e.type : "unknown";
    record.status = "error";
    record.errorType = type;
    record.error = (e && e.message) || String(e);
    record.responseMs = Date.now() - record.startedAt;
    return record;
  }
}

function lineFor(record) {
  const tag =
    record.status === "empty"
      ? TAGS.empty
      : record.ok
      ? TAGS.ok
      : TAGS[record.errorType] || "ERROR";
  const name = record.source.name;
  if (record.ok || record.status === "empty") {
    return `[${tag}] ${name} — ${record.itemCount} item${record.itemCount === 1 ? "" : "s"} (${record.responseMs}ms)`;
  }
  const reason = record.error || record.errorType || "unknown";
  return `[${tag}] ${name} — ${reason} (${record.responseMs}ms)`;
}

async function ingestAll(sources, opts = {}) {
  loadEnv();
  const started = Date.now();
  const concurrency =
    opts.concurrency || envNumber("INGEST_CONCURRENCY", DEFAULT_CONCURRENCY);
  const sourceList = Array.isArray(sources) ? sources : [];

  const results = new Array(sourceList.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, sourceList.length || 1) },
    async () => {
      while (cursor < sourceList.length) {
        const i = cursor++;
        results[i] = await ingestSource(sourceList[i], opts);
      }
    }
  );
  await Promise.all(workers);

  const logs = results.map(lineFor);
  const okRecords = results.filter((r) => r.status === "ok");
  const emptyRecords = results.filter((r) => r.status === "empty");
  const failedRecords = results.filter((r) => r.status === "error");
  const allItems = okRecords.reduce((acc, r) => acc.concat(r.items), []);
  const totalMs = Date.now() - started;

  const summary = {
    configured: sourceList.length,
    ok: okRecords.length,
    empty: emptyRecords.length,
    failed: failedRecords.length,
    items: allItems.length,
    totalMs,
  };

  logs.push(
    `[INFO] sources ok=${summary.ok} empty=${summary.empty} failed=${summary.failed} items=${summary.items} (${summary.totalMs}ms)`
  );

  return { results, logs, allItems, okRecords, emptyRecords, failedRecords, summary };
}

/* ---- CLI (dry run / diagnostics) ---- */
if (require.main === module) {
  (async () => {
    const sources = require("../../sources/index.js");
    if (!sources.configValid) {
      sources.validationErrors.forEach((e) =>
        console.log(`[ERROR] config ${e.source || ""} ${e.field}: ${e.message}`)
      );
      process.exit(1);
    }
    console.log(`[INFO] ${sources.enabledSources.length} enabled sources`);
    const report = await ingestAll(sources.enabledSources);
    report.logs.forEach((l) => console.log(l));
    process.exit(report.summary.failed === report.summary.configured ? 1 : 0);
  })().catch((e) => {
    console.error("[ERROR] " + e.message);
    process.exit(1);
  });
}

module.exports = { ingestSource, ingestAll, TAGS, lineFor };