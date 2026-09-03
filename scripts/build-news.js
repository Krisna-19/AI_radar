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

const SNAPSHOT_FILE = path.join(__dirname, "..", "data", "news.json");
const CONCURRENCY = 4;

async function main() {
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
        }),
        sources: report.results.map((r) => ({
          id: r.source.id,
          name: r.source.name,
          status: r.ok ? r.status : "error",
          itemCount: r.itemCount,
          errorType: r.errorType,
          responseMs: r.responseMs,
        })),
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
      ` multiSource ${stage4.stats.multiSource}, maxCluster ${stage4.stats.maxClusterSize})`
  );

  // Fail loudly when nothing was fetched so the workflow catches problems.
  if (items.length === 0) process.exitCode = 1;
}

main();