/*
 * AI RADAR - snapshot builder (Node, used by GitHub Actions).
 *
 * Uses the stage-2 ingestion pipeline (sources -> fetch -> parse -> normalize)
 * against the canonical sources/sources.json config, then writes the
 * pre-aggregated feed to data/news.json for GitHub Pages.
 *
 *   - Network/feed failures never abort the run (gracious degradation).
 *   - Invalid source configuration DOES abort (config bugs must be loud).
 *   - The deployed site loads data/news.json instantly - no proxy needed.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const Core = require("../js/shared.js");
const SRC = require("../sources/index.js");
const { ingestAll } = require("./pipeline/ingest.js");
const { clusterStories } = require("./pipeline/dedupe.js");
const { classifyStories } = require("./pipeline/classify.js");
const { scoreStories } = require("./pipeline/score.js");
const { summarizeStories } = require("./pipeline/summarize.js");
const { extractArticles } = require("./pipeline/extract.js");
const { loadEnv } = require("./pipeline/env.js");
const Store = require("./pipeline/store.js");

const SNAPSHOT_FILE = path.join(__dirname, "..", "data", "news.json");
const CONCURRENCY = 4;

async function main() {
  loadEnv();

  // Stage 5.5 article extraction is OPT-IN and OFF by default. It runs only
  // when ARTICLE_FETCH is truthy (1/true/yes/on); unset, empty, or an explicit
  // 0/false/no/off preserves the previous pipeline behavior exactly.
  const articleFetchEnabled =
    !!process.env.ARTICLE_FETCH &&
    !/^(0|false|no|off)$/i.test(String(process.env.ARTICLE_FETCH).trim());
  // Per-source gating: even with ARTICLE_FETCH on, ONLY sources flagged
  // articleFetch:true in sources/sources.json are fetched (see also the config
  // gate in §4 below). Off-by-default sources are never extracted here.
  const articleFetchSourceIds = SRC.enabledSources
    .filter((s) => s.articleFetch)
    .map((s) => s.id);

  if (!SRC.configValid) {
    SRC.validationErrors.forEach((e) =>
      console.log(
        `[ERROR] config ${e.source || ""} ${e.field ? "[" + e.field + "]" : ""}: ${e.message}`
      )
    );
    console.log("[ERROR] Refusing to build snapshot with an invalid source configuration.");
    process.exitCode = 1;
    return;
  }

  const started = Date.now();
  const report = await ingestAll(SRC.enabledSources, { concurrency: CONCURRENCY });
  report.logs.forEach((l) => console.log(l));

  // Per-source health used by BOTH the run log (Stage 11 automation logging)
  // and the snapshot so the two never disagree.
  const sourceStatus = report.results.map((r) => ({
    id: r.source.id,
    name: r.source.name,
    status: r.ok ? r.status : "error",
    itemCount: r.itemCount,
    errorType: r.errorType,
    responseMs: r.responseMs,
  }));

  // Stage 3: validate every normalized canonical story; log + drop rejections
  // (never silently). Valid stories proceed to dedupe.
  const valid = [];
  const rejected = [];
  for (const story of report.allItems) {
    const check = Core.validateStory(story);
    if (check.valid) {
      valid.push(story);
    } else {
      rejected.push({
        id: story && story.id,
        title: story && story.title,
        source: story && story.source && story.source.id,
        errors: check.errors.map((e) => e.field + ": " + e.message),
      });
      console.log(
        `[WARN] rejecting story ${story && story.id ? story.id : "?"} (${story && story.source && story.source.id}: ${(story && story.title) || "untitled"}): ` +
          check.errors.map((e) => e.field + "=" + e.message).join("; ")
      );
    }
  }

  const deduped = Core.dedupe(valid);
  const stage4 = clusterStories(deduped);
  const items = stage4.items;

  // Stage 5.5 (gated): full-article text extraction. Runs AFTER Stage 4
  // clustering and BEFORE classification/scoring so both stages can read
  // story.content. Adds/updates ONLY story.content, and only when a story
  // currently has none; extraction failures leave stories unchanged.
  if (articleFetchEnabled) {
    const extracted = await extractArticles(items, {
      allowedSourceIds: articleFetchSourceIds,
      concurrency: CONCURRENCY, // global pool stays 4 (never raised)
      hostConcurrency: 2, // per-host fetches capped at 2
      maxRetries: 3, // HTTP 429: retry 500ms -> 1s -> 2s, then give up
    });
    console.log(
      `[INFO] article extraction (sources ${articleFetchSourceIds.length}/${SRC.enabledSources.length}): ` +
        `extracted ${extracted.stats.extracted}, failed ${extracted.stats.failed}, cached ${extracted.stats.cached}, ` +
        `skipped ${extracted.stats.skipped}, disabled ${extracted.stats.disabled}, ` +
        `requests ${extracted.stats.requests} (429 retries ${extracted.stats.retries}), ` +
        `avg ${extracted.stats.avgWords} words (${extracted.stats.wordsTotal} total)`
    );
    for (const id of articleFetchSourceIds) {
      const r = (extracted.stats.perSource || {})[id];
      if (!r) continue;
      console.log(
        `[INFO]   ${id}: extracted ${r.extracted}/${r.total}, failed ${r.failed}, cached ${r.cached}, ` +
          `requests ${r.requests}, avg ${r.extracted ? Math.round(r.words / r.extracted) : 0} words, ` +
          `byStatus ${JSON.stringify(r.byStatus)}`
      );
    }
    for (const [sourceId, r] of Object.entries(extracted.stats.perSource || {})) {
      if (articleFetchSourceIds.indexOf(sourceId) !== -1) continue;
      console.log(
        `[INFO]   ${sourceId}: disabled (articleFetch=off) — ${r.total} considered, ${r.skipped} skipped`
      );
    }
  }

  // Stage 6: transparent classification (12-category subcategory + entities +
  // tags, mapped onto the legacy top-5 chip) and the explainable Radar Score
  // (0-100 with stored components). Runs BEFORE sorting and BEFORE Stage 5
  // persistence so both data/news.json and data/db carry the enriched fields.
  const stage6 = classifyStories(items);
  const scored = scoreStories(items);

  // Stage 7: summarization (ai.summary / whyItMatters / keyTakeaways). Default
  // mode is extractive (deterministic, zero credentials). An optional LLM path
  // runs only when SUMMARY_MODE=llm AND AI_API_KEY is present; any failure
  // degrades gracefully to extractive and never breaks the build.
  const summarizeMode = (process.env.SUMMARY_MODE || "extract").toLowerCase();
  const summarized = await summarizeStories(items, {
    mode: summarizeMode,
    apiKey: process.env.AI_API_KEY || null,
    concurrency: Math.max(1, parseInt(process.env.SUMMARY_CONCURRENCY || "8", 10) || 8),
  });

  // Stage 5: persist the staged (deduplicated + clustered + classified +
  // scored + summarized) stories into data/db (per-day NDJSON + index + run
  // log), then enforce the retention window. This is additive - data/news.json
  // below is written unchanged and remains the live snapshot the current
  // frontend reads.
  const runStartedAt = new Date(started).toISOString();
  const stored = Store.upsertStories(items);
  const pruned = Store.prune(Store.DEFAULT_DB_DIR, { retentionDays: Store.DEFAULT_RETENTION_DAYS });

  // Stage 12: hard integrity gates on the ARCHIVE (post-upsert, pre-log).
  // A single duplicate id OR any identity-mismatched row (id != clean-title
  // identity) fails the build so the deployed data can never drift from the
  // radar identity rules. The one-time data/db re-key sweep (rekey-archive.js)
  // restored these invariants once at migration time.
  const dupIds = Store.assertNoDuplicateIds(Store.DEFAULT_DB_DIR);
  const identity = Store.assertIdentityConsistent(Store.DEFAULT_DB_DIR);
  if (dupIds.duplicates.length || identity.inconsistent.length) {
    console.log(
      `[ERROR] archive integrity gate failed (rows=${identity.checked}): ` +
        `duplicate-id groups=${dupIds.duplicates.length} (each must be 0), ` +
        `identity-mismatched=${identity.inconsistent.length} (each must be 0).`
    );
    for (const d of dupIds.duplicates.slice(0, 20)) console.log(`  dup id ${d.id}: ${d.days.join(", ")}`);
    for (const i of identity.inconsistent.slice(0, 20)) {
      console.log(`  mismatched ${i.id} (${i.day}) -> ${i.cleanId}: "${(i.title || "").slice(0, 80)}"`);
    }
    process.exitCode = 1;
    return;
  }
  console.log(
    `[OK] archive integrity gate passed (${identity.checked} rows, 0 duplicate ids, identity-consistent).`
  );

  const runId = Store.runLog(Store.DEFAULT_DB_DIR, {
    startedAt: runStartedAt,
    normalized: report.allItems.length,
    afterExactDedupe: stage4.stats.afterExactDedupe,
    similarityMergedInto: stage4.stats.mergedInto,
    stored: stored.total,
    storedDays: stored.days,
    upserted: stored.upserted,
    updated: stored.updated,
    unchanged: stored.unchanged,
    sources: sourceStatus,
    prunedDays: pruned.prunedDays.length,
    prunedStories: pruned.prunedStories,
    classifiedCategories: Object.keys(stage6.stats.categories).length,
    radarMin: scored.stats.min,
    radarMax: scored.stats.max,
    radarMean: scored.stats.mean,
    summarizeMode: summarized.mode,
    summarized: summarized.stats.summarized,
    summarizedExtractive: summarized.stats.extractive,
    summarizedLlm: summarized.stats.llm,
  });
  items.sort(
    (a, b) =>
      (b.score || 0) - (a.score || 0) ||
      (b.date ? +new Date(b.date) : 0) - (a.date ? +new Date(a.date) : 0)
  );

  fs.mkdirSync(path.dirname(SNAPSHOT_FILE), { recursive: true });
  fs.writeFileSync(
    SNAPSHOT_FILE,
    JSON.stringify(
      {
        generatedAt: Date.now(),
        stats: Object.assign({}, report.summary, {
          totalMs: Date.now() - started,
          normalized: report.allItems.length,
          rejectedValidated: rejected.length,
          afterExactDedupe: stage4.stats.afterExactDedupe,
          similarityMergedInto: stage4.stats.mergedInto,
          multiSourceStories: stage4.stats.multiSource,
          maxClusterSize: stage4.stats.maxClusterSize,
          storeRunId: runId,
          storedDays: stored.days,
          storedStories: stored.total,
          prunedDays: pruned.prunedDays.length,
          classifierCategories: Object.keys(stage6.stats.categories).length,
          subcategoryCounts: stage6.stats.categories,
          radarMin: scored.stats.min,
          radarMax: scored.stats.max,
          radarMean: scored.stats.mean,
          summarizeMode: summarized.mode,
          summarized: summarized.stats.summarized,
          summarizedExtractive: summarized.stats.extractive,
          summarizedLlm: summarized.stats.llm,
        }),
        sources: sourceStatus,
        items,
      },
      null,
      0
    )
  );

  console.log(
    `[INFO] Saved ${items.length} unique stories to data/news.json in ${((Date.now() - started) / 1000).toFixed(1)}s` +
      ` (normalized ${report.allItems.length}, rejected ${rejected.length},` +
      ` exactDedupe ${stage4.stats.afterExactDedupe}, similarityMergedInto ${stage4.stats.mergedInto},` +
      ` multiSource ${stage4.stats.multiSource}, maxCluster ${stage4.stats.maxClusterSize},` +
      ` storeDays ${stored.days}, stored ${stored.total}, prunedDays ${pruned.prunedDays.length},` +
      ` classifyCats ${Object.keys(stage6.stats.categories).length}, radar 0-100 mean ${scored.stats.mean},` +
      ` summarize ${summarized.mode} (${summarized.stats.summarized} of ${items.length}))`
  );

  // Fail loudly when nothing was fetched so the workflow catches problems.
  if (items.length === 0) process.exitCode = 1;
}

main();