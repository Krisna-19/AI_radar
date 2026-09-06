"use strict";

const path = require("path");
const Store = require("./pipeline/store.js");

const TARGET = process.argv[2] ? path.resolve(process.argv[2]) : Store.DEFAULT_DB_DIR;

function run() {
  const before = Store.assertNoDuplicateIds(TARGET);
  if (!before.duplicates.length) {
    console.log(`[OK] Archive is intact - ${before.checked} rows, 0 duplicate ids. Nothing to repair.`);
    return 0;
  }

  const idx = Store.loadIndex(TARGET);
  let removed = 0;
  for (const dup of before.duplicates) {
    const home = (idx.stories && idx.stories[dup.id] && idx.stories[dup.id].day) || dup.days[0];
    for (const day of dup.days) {
      if (day !== home && Store.removeFromDay(TARGET, dup.id, day)) removed++;
    }
  }

  const after = Store.assertNoDuplicateIds(TARGET);
  if (after.duplicates.length) {
    console.log(
      `[WARN] Repaired ${removed} stale row(s) across ${before.duplicates.length} id(s), but ` +
        `${after.duplicates.length} id(s) still have multiple day buckets.`
    );
    for (const d of after.duplicates) console.log(`  ${d.id}: ${d.days.join(", ")}`);
    return 1;
  }

  console.log(
    `[OK] Repaired ${removed} stale row(s) across ${before.duplicates.length} duplicate id(s). ` +
      `Archive now has ${after.checked} rows and 0 duplicate ids.`
  );
  return 0;
}

process.exitCode = run();